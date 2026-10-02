import { describe, expect, it } from 'vitest';
import hackathons from '../data-apps/ai-hackathons/config';
import { defaultQuery, parseQuery, serializeQuery, withFilter } from '../src/shared/query';
import { facetsOf, listFrom, matches } from '../src/shared/engine';
import type { PublicRecord } from '../src/shared/types';

const parse = (search: string) => parseQuery(hackathons, new URLSearchParams(search));

describe('parseQuery', () => {
  it('reads every kind of filter', () => {
    const { state, errors } = parse(
      'q=agents&format=online,hybrid&tags=llm&deadline_from=today&prize_usd_to=50000&sort=-prize_usd&page=2',
    );
    expect(errors).toEqual([]);
    expect(state).toEqual({
      q: 'agents',
      filters: {
        deadline: { kind: 'range', from: 'today' },
        format: { kind: 'in', values: ['online', 'hybrid'] },
        prize_usd: { kind: 'range', to: '50000' },
        tags: { kind: 'in', values: ['llm'] },
      },
      sort: { field: 'prize_usd', desc: true },
      page: 2,
    });
  });

  it('reports values that do not fit, and skips them', () => {
    const { state, errors } = parse('format=remote&deadline_from=soon&sort=tags&page=0');
    expect(state.filters).toEqual({});
    expect(state.sort).toEqual({ field: 'deadline', desc: false });
    expect(errors).toHaveLength(4);
  });

  it('treats an empty bound as no bound', () => {
    expect(parse('deadline_from=&sort=deadline').state.filters).toEqual({});
  });
});

describe('serializeQuery', () => {
  it('round-trips through parseQuery', () => {
    const { state } = parse('q=x&format=online&deadline_from=2026-10-01&sort=-name&page=3');
    expect(parseQuery(hackathons, serializeQuery(hackathons, state)).state).toEqual(state);
  });

  it('always writes sort, so a cleared table never falls back to the defaults', () => {
    const cleared = { ...defaultQuery(hackathons), filters: {} };
    expect(serializeQuery(hackathons, cleared).toString()).toBe('sort=deadline');
  });
});

describe('defaultQuery and withFilter', () => {
  it('opens on hackathons still open, soonest deadline first', () => {
    expect(defaultQuery(hackathons)).toEqual({
      q: '',
      filters: { deadline: { kind: 'range', from: 'today' } },
      sort: { field: 'deadline', desc: false },
      page: 1,
    });
  });

  it('goes back to page 1 when a filter changes', () => {
    const state = { ...defaultQuery(hackathons), page: 4 };
    expect(withFilter(state, 'format', { kind: 'in', values: ['online'] }).page).toBe(1);
    expect(withFilter(state, 'deadline', null).filters).toEqual({});
  });
});

/** A verified record with these field values. */
const rec = (id: string, data: Record<string, unknown>): PublicRecord => ({
  id,
  status: 'verified',
  data: data as PublicRecord['data'],
  source_url: 'https://example.org/',
  observed_at: '2026-10-01T00:00:00Z',
  verified_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
});

const records = [
  rec('a', { name: 'Agents 50%_off Jam', format: 'online', tags: ['llm', 'agents'], deadline: '2026-10-20', prize_usd: 5000 }),
  rec('b', { name: 'London Build', format: 'in-person', city: ['London'], region: 'europe', deadline: '2026-10-05', prize_usd: 20000 }),
  rec('c', { name: 'zürich hack', format: 'hybrid', city: ['Zürich', 'Bern'], region: 'europe', deadline: '2026-09-30' }),
  rec('d', { name: 'Berlin Sprint', format: 'online', tags: ['robotics'], deadline: '2026-11-01', prize_usd: 1000 }),
];
const today = '2026-10-01';
const ids = (search: string) => records.filter((record) => matches(hackathons, record, parse(search).state, today)).map((r) => r.id);

describe('the in-memory query engine', () => {
  it('applies every kind of filter, resolving today', () => {
    expect(ids('format=online')).toEqual(['a', 'd']);
    expect(ids('tags=llm,robotics')).toEqual(['a', 'd']);
    expect(ids('deadline_from=today')).toEqual(['a', 'b', 'd']);
    expect(ids('deadline_from=today&deadline_to=today%2B10')).toEqual(['b']);
    expect(ids('prize_usd_from=1000&prize_usd_to=6000')).toEqual(['a', 'd']);
    // A record without the value never passes a range.
    expect(ids('prize_usd_to=100000')).toEqual(['a', 'b', 'd']);
  });

  it('searches text and lists of names without case, and takes the query literally', () => {
    expect(ids('q=50%_off')).toEqual(['a']);
    expect(ids('q=london')).toEqual(['b']);
    expect(ids('q=BERN')).toEqual(['c']);
    expect(ids('city=Zürich')).toEqual(['c']);
  });

  it('counts each facet under every other filter', () => {
    const facets = facetsOf(hackathons, records, parse('format=online&region=europe').state, today);
    // format's own counts ignore the format filter: europe has one in-person and one hybrid.
    expect(facets.format).toEqual([
      { value: 'hybrid', count: 1 },
      { value: 'in-person', count: 1 },
    ]);
    expect(facets.region).toEqual([]);
  });

  it('sorts missing values last both ways, text without case, then by id', () => {
    const order = (search: string) => listFrom(hackathons, { records, today }, parse(search).state, 10).records.map((r) => r.id);
    expect(order('sort=-prize_usd')).toEqual(['b', 'a', 'd', 'c']);
    expect(order('sort=prize_usd')).toEqual(['d', 'a', 'b', 'c']);
    expect(order('sort=name')).toEqual(['a', 'd', 'b', 'c']);
  });

  it('pages after sorting and leaves facets out when asked', () => {
    const page = listFrom(hackathons, { records, today }, parse('sort=name&page=2').state, 3, { facets: false });
    expect(page).toMatchObject({ total: 4, page: 2, limit: 3, today, facets: {} });
    expect(page.records.map((r) => r.id)).toEqual(['c']);
  });
});
