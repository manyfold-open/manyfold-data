import { describe, expect, it } from 'vitest';
import hackathons from '../data-apps/ai-hackathons/config';
import { defaultQuery, parseQuery, serializeQuery, withFilter } from '../src/shared/query';
import { buildWhere, orderBy } from '../src/worker/records';

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

describe('buildWhere', () => {
  it('binds every value and resolves today', () => {
    const { state } = parse('q=50%_off&format=online&tags=llm,agents&deadline_from=today&prize_usd_from=1000');
    const where = buildWhere(hackathons, state, '2026-10-01');
    expect(where.sql).toContain("status = 'verified'");
    expect(where.sql).toContain("json_extract(data_json, '$.format') IN (?)");
    expect(where.sql).toContain("json_each(records.data_json, '$.tags') WHERE json_each.value IN (?, ?)");
    expect(where.params).toEqual([
      'ai-hackathons',
      '%50\\%\\_off%',
      '%50\\%\\_off%',
      '%50\\%\\_off%',
      '2026-10-01',
      'online',
      1000,
      'llm',
      'agents',
    ]);
  });

  it('filters by names as written, and finds them with the text search', () => {
    const { state, errors } = parse('city=San Francisco,Zürich&q=london');
    expect(errors).toEqual([]);
    expect(state.filters.city).toEqual({ kind: 'in', values: ['San Francisco', 'Zürich'] });
    const where = buildWhere(hackathons, state, '2026-10-01');
    expect(where.sql).toContain("json_each(records.data_json, '$.city')");
    expect(where.sql).toContain("json_extract(data_json, '$.city') LIKE ?");
  });

  it('leaves out one field for its own facet counts', () => {
    const { state } = parse('format=online&region=europe');
    const where = buildWhere(hackathons, state, '2026-10-01', 'format');
    expect(where.sql).not.toContain('$.format');
    expect(where.params).toEqual(['ai-hackathons', 'europe']);
  });

  it('sorts missing values last and text without case', () => {
    expect(orderBy(hackathons, parse('sort=-prize_usd').state)).toBe(
      "json_extract(data_json, '$.prize_usd') IS NULL, json_extract(data_json, '$.prize_usd') DESC, id",
    );
    expect(orderBy(hackathons, parse('sort=name').state)).toContain('COLLATE NOCASE ASC');
  });
});
