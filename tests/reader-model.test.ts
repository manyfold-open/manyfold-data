// The reader's pure helpers: which treatment each config chart gets, the takeaway under it,
// the links a chart drills into, the filter column's pills and chips, and the smart filter.
// All of it must work for every data app from its config alone.
import { describe, expect, it } from 'vitest';
import aiFundraising from '../data-apps/ai-fundraising/config';
import aiHackathons from '../data-apps/ai-hackathons/config';
import { dataApps } from '../data-apps/index';
import type { DataAppConfig } from '../src/shared/data-app';
import { parseQuery, defaultQuery, type QueryState } from '../src/shared/query';
import type { ChartResult, StatsResponse } from '../src/shared/types';
import { amountParts, shortAmount } from '../src/app/format';
import {
  columnsModel,
  coverageText,
  histogramModel,
  looksForward,
  niceTop,
  takeaway,
  takeawayText,
  treatmentOf,
} from '../src/app/model/charts';
import { binHref, binRange, bucketHref, valueHref } from '../src/app/model/drill';
import {
  activeCount,
  amountPresets,
  chipsOf,
  dateDirection,
  dateFieldOf,
  datePresets,
  popularOf,
  popularToggle,
  presetOf,
  sortOptions,
} from '../src/app/model/filters';
import { normalize, parseSmartFilter, smartExample, smartHint } from '../src/app/model/smart-filter';

const TODAY = '2026-10-01'; // a Thursday; its week starts Monday 2026-09-28
const tiles = (verified: number) => ({ verified, addedLast7Days: 0, pending: 0, lastUpdated: null });
const stats = (verified: number) => ({ today: TODAY, tiles: tiles(verified) });
const blank = (config: DataAppConfig = aiFundraising): QueryState => ({ ...defaultQuery(config), filters: {} });
const query = (href: string) => new URLSearchParams(href.split('?')[1]);

describe('chart treatments', () => {
  it('maps each config chart to the treatment in the spec', () => {
    const kinds = (config: typeof aiFundraising | typeof aiHackathons) =>
      config.charts.map((chart) => `${chart.title}: ${treatmentOf(config, chart)}`);
    expect(kinds(aiFundraising)).toEqual([
      'Rounds in the last 30 days: tile',
      'Rounds by week announced: columns',
      'By round: ranked',
      'By sector: ranked',
      'By region: share',
      'Top cities: ranked',
      'Round size (USD): histogram',
    ]);
    expect(kinds(aiHackathons)).toEqual([
      'Open for entries: tile',
      'Hackathons by start week: columns',
      'By format: share',
      'By region: share',
      'Top cities: ranked',
      'Prize pool (USD): histogram',
    ]);
  });

  it('gives every chart of every data app a treatment', () => {
    for (const config of dataApps) for (const chart of config.charts) expect(treatmentOf(config, chart)).toBeTruthy();
  });

  it('rounds count axes so gridlines land on whole numbers', () => {
    expect(niceTop(0)).toBe(2);
    expect(niceTop(45)).toBe(50);
    expect(niceTop(7)).toBe(8);
    expect(niceTop(130)).toBe(200);
    for (const max of [1, 3, 9, 11, 26, 99, 101, 999]) {
      const top = niceTop(max);
      expect(top).toBeGreaterThanOrEqual(max);
      expect(top % 2).toBe(0);
    }
  });
});

describe('over-time columns', () => {
  const past: ChartResult = {
    kind: 'over-time',
    title: 'Rounds by week announced',
    field: 'announced_on',
    bucket: 'week',
    points: [
      { start: '2026-09-07', count: 20 },
      { start: '2026-09-14', count: 45 },
      { start: '2026-09-21', count: 30 },
      { start: '2026-09-28', count: 37 },
    ],
  };
  const ahead: ChartResult = {
    kind: 'over-time',
    title: 'Hackathons by start week',
    field: 'starts_on',
    bucket: 'week',
    points: [
      { start: '2026-09-21', count: 4 },
      { start: '2026-09-28', count: 6 },
      { start: '2026-10-05', count: 12 },
      { start: '2026-10-12', count: 30 },
    ],
  };

  it('marks the current week and sees no future in past dates', () => {
    const model = columnsModel(aiFundraising, past as never, TODAY);
    expect(model.forward).toBe(false);
    expect(model.todayAt).toBeNull();
    expect(model.columns.map((column) => column.now)).toEqual([false, false, false, true]);
    expect(model.labels).toEqual([{ at: 0.125, text: 'Sep' }]);
    expect(takeawayText(takeaway(aiFundraising, past, stats(175)))).toBe('37 this week · busiest week Sep 14 (45)');
  });

  it('draws a Today line and lightens later weeks when dates run ahead', () => {
    expect(looksForward(aiHackathons, 'deadline')).toBe(true);
    expect(looksForward(aiFundraising, 'announced_on')).toBe(false);
    const model = columnsModel(aiHackathons, ahead as never, TODAY);
    expect(model.forward).toBe(true);
    expect(model.columns.map((column) => column.later)).toEqual([false, false, true, true]);
    // Thursday is day 3 of the week starting Monday: (1 + 3.5 / 7) / 4.
    expect(model.todayAt).toBeCloseTo(0.375);
    expect(model.labels.map((label) => label.text)).toEqual(['Sep', 'Oct']);
    expect(takeawayText(takeaway(aiHackathons, ahead, stats(52)))).toBe('42 after this week · busiest week Oct 12 (30)');
  });
});

describe('category takeaways', () => {
  it('says who leads a proportion bar', () => {
    const chart: ChartResult = {
      kind: 'by-category',
      title: 'By region',
      field: 'region',
      bars: [
        { value: 'americas', count: 90 },
        { value: 'asia-pacific', count: 50 },
        { value: 'europe', count: 35 },
        { value: 'africa-middle-east', count: 0 },
      ],
    };
    expect(takeawayText(takeaway(aiFundraising, chart, stats(175)))).toBe('Americas leads with 51%');
  });

  it('sums the top three of ranked bars', () => {
    const chart: ChartResult = {
      kind: 'by-category',
      title: 'By round',
      field: 'stage',
      bars: [
        { value: 'seed', count: 40 },
        { value: 'series-a', count: 35 },
        { value: 'series-b', count: 26 },
        { value: 'angel', count: 99 - 75 - 26 + 74 },
      ].sort((a, b) => b.count - a.count),
    };
    const total = chart.bars.reduce((sum, bar) => sum + bar.count, 0);
    const top3 = chart.bars.slice(0, 3).reduce((sum, bar) => sum + bar.count, 0);
    expect(takeawayText(takeaway(aiFundraising, chart, stats(175)))).toBe(
      `Top 3 make up ${Math.round((top3 / total) * 100)}% of rounds`,
    );
  });

  it('reads tags as a share of all records, since one record can carry several', () => {
    const chart: ChartResult = {
      kind: 'by-category',
      title: 'Top cities',
      field: 'city',
      bars: [
        { value: 'San Francisco', count: 50 },
        { value: 'New York', count: 20 },
      ],
    };
    expect(takeawayText(takeaway(aiFundraising, chart, stats(175)))).toBe('San Francisco leads with 50 rounds (29% of all)');
  });
});

describe('histograms', () => {
  const prizes: ChartResult = {
    kind: 'histogram',
    title: 'Prize pool (USD)',
    field: 'prize_usd',
    bins: [
      { from: 0, to: 1000, count: 2 },
      { from: 1000, to: 5000, count: 10 },
      { from: 5000, to: 10000, count: 8 },
      { from: 10000, to: null, count: 5 },
    ],
    missing: 131,
  };

  it('labels bins by their upper edge and warns when few records state a value', () => {
    const model = histogramModel(aiHackathons, prizes as never);
    expect(model.bins.map((bin) => bin.tick)).toEqual(['<$1K', '<$5K', '<$10K', '$10K+']);
    expect(model.bins.map((bin) => bin.label)).toEqual(['Under $1K', '$1K to under $5K', '$5K to under $10K', '$10K or more']);
    expect(model.lowCoverage).toBe(true);
    expect(coverageText(aiHackathons, prizes as never)).toBe('Only 16% of hackathons state a prize pool');
    // The coverage line carries the warning; the takeaway still says where the stated values sit.
    expect(takeawayText(takeaway(aiHackathons, prizes, stats(156)))).toBe('Median in $5K–$10K · stated for 25 of 156 hackathons');
  });

  it('names the median bin when coverage is good', () => {
    const rounds: ChartResult = { ...prizes, field: 'amount_usd', title: 'Round size (USD)', missing: 3 } as ChartResult;
    expect(takeawayText(takeaway(aiFundraising, rounds, stats(28)))).toBe('Median in $5K–$10K · stated for 25 of 28 rounds');
  });

  it('formats amounts as a number and a small unit', () => {
    const usd = aiFundraising.fields.amount_usd;
    expect(amountParts(usd, 9_500_000)).toEqual({ number: '9.5', unit: 'M USD' });
    expect(amountParts(usd, 1_250_000_000)).toEqual({ number: '1.25', unit: 'B USD' });
    expect(amountParts(usd, 25_000)).toEqual({ number: '25', unit: 'K USD' });
    expect(amountParts(usd, 500)).toEqual({ number: '500', unit: 'USD' });
    expect(shortAmount(usd, 24_999_999)).toBe('$25M');
  });
});

describe('drill-down links', () => {
  it('opens the Table on one value, in the existing query format', () => {
    const href = valueHref(aiFundraising, 'stage', 'seed');
    expect(href).toBe('/ai-fundraising/table?stage=seed&sort=-announced_on');
    expect(parseQuery(aiFundraising, query(href))).toEqual({
      state: { q: '', filters: { stage: { kind: 'in', values: ['seed'] } }, sort: { field: 'announced_on', desc: true }, page: 1 },
      errors: [],
    });
  });

  it('drops the default filter so the rows match what the chart counted', () => {
    expect(valueHref(aiHackathons, 'format', 'online')).toBe('/ai-hackathons/table?format=online&sort=deadline');
    expect(valueHref(aiHackathons, 'city', 'San Francisco')).toBe('/ai-hackathons/table?city=San+Francisco&sort=deadline');
  });

  it('turns a histogram bin into an inclusive range', () => {
    expect(binRange({ from: 10_000_000, to: 25_000_000 })).toEqual({ from: '10000000', to: '24999999' });
    expect(binRange({ from: 1_000_000_000, to: null })).toEqual({ from: '1000000000' });
    const href = binHref(aiFundraising, 'amount_usd', { from: 10_000_000, to: 25_000_000 });
    expect(href).toBe('/ai-fundraising/table?amount_usd_from=10000000&amount_usd_to=24999999&sort=-announced_on');
    expect(parseQuery(aiFundraising, query(href)).errors).toEqual([]);
  });

  it('turns a week into its seven days', () => {
    expect(bucketHref(aiHackathons, 'starts_on', '2026-09-28', 'week')).toBe(
      '/ai-hackathons/table?starts_on_from=2026-09-28&starts_on_to=2026-10-04&sort=deadline',
    );
    expect(bucketHref(aiFundraising, 'announced_on', '2026-02-01', 'month')).toContain('announced_on_to=2026-02-28');
  });
});

describe('filter column', () => {
  it('picks the date field and its direction from accept', () => {
    expect(dateFieldOf(aiFundraising)).toBe('announced_on');
    expect(dateDirection(aiFundraising, 'announced_on')).toBe('past');
    expect(dateFieldOf(aiHackathons)).toBe('deadline');
    expect(dateDirection(aiHackathons, 'deadline')).toBe('future');
    expect(datePresets(aiFundraising, 'announced_on').map((preset) => preset.label)).toEqual(['Any time', 'Last 7 days', 'Last 30 days']);
    expect(datePresets(aiHackathons, 'deadline').map((preset) => preset.label)).toEqual(['Any time', 'Upcoming', 'Next 7 days', 'Next 30 days']);
  });

  it('recognizes the hackathons default view as the Upcoming pill', () => {
    const state = defaultQuery(aiHackathons);
    expect(presetOf(datePresets(aiHackathons, 'deadline'), state.filters.deadline)?.label).toBe('Upcoming');
  });

  it('builds amount pills from the histogram edges', () => {
    expect(amountPresets(aiFundraising).map((preset) => preset.label)).toEqual(['Any', '$5M+', '$25M+', '$100M+']);
    expect(amountPresets(aiHackathons).map((preset) => preset.label)).toEqual(['Any', '$5K+', '$25K+', '$100K+']);
  });

  it('turns applied filters into removable chips', () => {
    const state: QueryState = {
      ...blank(),
      q: 'robots',
      filters: {
        stage: { kind: 'in', values: ['seed', 'series-a'] },
        announced_on: { kind: 'range', from: 'today-7' },
        amount_usd: { kind: 'range', from: '10000000', to: '24999999' },
      },
    };
    const chips = chipsOf(aiFundraising, state, TODAY);
    expect(chips.map((chip) => chip.label)).toEqual(['“robots”', 'Seed', 'Series A', 'Announced: Last 7 days', 'Amount $10M–$25M']);
    expect(chips[1]!.without.filters.stage).toEqual({ kind: 'in', values: ['series-a'] });
    expect(chips[4]!.without.filters.amount_usd).toBeUndefined();
    expect(activeCount(state)).toBe(5);
  });

  it('builds Popular from the stats and toggles each item', () => {
    const response: Pick<StatsResponse, 'charts'> = {
      charts: [
        { kind: 'by-category', title: 'By round', field: 'stage', bars: [{ value: 'seed', count: 40 }] },
        { kind: 'by-category', title: 'By region', field: 'region', bars: [{ value: 'americas', count: 90 }] },
        {
          kind: 'histogram',
          title: 'Round size (USD)',
          field: 'amount_usd',
          bins: [
            { from: 0, to: 100_000_000, count: 100 },
            { from: 100_000_000, to: null, count: 4 },
          ],
          missing: 0,
        },
      ],
    };
    const items = popularOf(aiFundraising, response);
    expect(items.map((item) => item.label)).toEqual(['Seed', 'Americas', 'Last 30 days', '$100M or more']);
    const toggled = popularToggle(blank(), items[0]!);
    expect(toggled.on).toBe(false);
    expect(toggled.next.filters.stage).toEqual({ kind: 'in', values: ['seed'] });
    expect(popularToggle(toggled.next, items[0]!).on).toBe(true);
  });

  it('offers sorts that run the way each app reads its dates', () => {
    expect(sortOptions(aiHackathons).map((option) => option.label)).toEqual([
      'Deadline (soonest)',
      'Starts (soonest)',
      'Prize pool (largest)',
      'Name (A–Z)',
    ]);
    expect(sortOptions(aiFundraising)[0]).toEqual({ field: 'amount_usd', desc: true, label: 'Amount (largest)' });
  });
});

describe('smart filter', () => {
  const tags = { city: ['San Francisco', 'New York', 'Zürich', 'Paris'] };
  const read = (config: DataAppConfig, text: string) =>
    parseSmartFilter(config, blank(config), text, tags, TODAY);

  it('normalizes case, accents and punctuation', () => {
    expect(normalize('Series-A rounds in Zürich, $5M+.')).toBe(' series a rounds in zurich $5m+ ');
    expect(normalize('$1-5m')).toBe(' $1 to 5m ');
  });

  it('reads enum labels, tags, amounts and dates from the config', () => {
    const result = read(aiFundraising, 'Seed robotics rounds in San Francisco over $5M in the last 30 days');
    expect(result.state.filters).toEqual({
      sector: { kind: 'in', values: ['robotics'] },
      stage: { kind: 'in', values: ['seed'] },
      announced_on: { kind: 'range', from: 'today-30' },
      amount_usd: { kind: 'range', from: '5000000' },
      city: { kind: 'in', values: ['San Francisco'] },
    });
    expect(result.applied).toEqual(['Robotics', 'Seed', 'Last 30 days', '$5M+', 'San Francisco']);
  });

  it('takes the longest phrase first', () => {
    expect(read(aiFundraising, 'pre-seed and pre-series a').state.filters.stage).toEqual({
      kind: 'in',
      values: ['pre-series-a', 'pre-seed'],
    });
    expect(read(aiFundraising, 'series e and later').state.filters.stage).toEqual({ kind: 'in', values: ['series-e-plus'] });
  });

  it('reads ranges, ceilings and bare amounts', () => {
    expect(read(aiFundraising, 'between $10m and $25m').state.filters.amount_usd).toEqual({ kind: 'range', from: '10000000', to: '25000000' });
    expect(read(aiFundraising, '$1-5m').state.filters.amount_usd).toEqual({ kind: 'range', from: '1000000', to: '5000000' });
    expect(read(aiFundraising, 'under 2.5 million').state.filters.amount_usd).toEqual({ kind: 'range', to: '2500000' });
    expect(read(aiFundraising, '$50M').state.filters.amount_usd).toEqual({ kind: 'range', from: '50000000' });
    expect(read(aiFundraising, 'top 3 rounds').state.filters.amount_usd).toBeUndefined();
  });

  it('looks ahead for hackathons and back for rounds', () => {
    expect(read(aiHackathons, 'online hackathons in the next 7 days').state.filters).toEqual({
      deadline: { kind: 'range', from: 'today', to: 'today+7' },
      format: { kind: 'in', values: ['online'] },
    });
    expect(read(aiHackathons, 'in person in Europe closing soon').state.filters).toEqual({
      deadline: { kind: 'range', from: 'today', to: 'today+7' },
      format: { kind: 'in', values: ['in-person'] },
      region: { kind: 'in', values: ['europe'] },
    });
    expect(read(aiHackathons, 'upcoming hybrid prizes over $10k').state.filters).toEqual({
      deadline: { kind: 'range', from: 'today' },
      format: { kind: 'in', values: ['hybrid'] },
      prize_usd: { kind: 'range', from: '10000' },
    });
    expect(read(aiFundraising, 'last week').state.filters.announced_on).toEqual({ kind: 'range', from: 'today-7' });
    // An explicit direction wins over the field's own.
    expect(read(aiHackathons, 'past month').state.filters.deadline).toEqual({ kind: 'range', from: 'today-30', to: 'today' });
    expect(read(aiFundraising, 'next 7 days').state.filters.announced_on).toEqual({ kind: 'range', from: 'today', to: 'today+7' });
    expect(read(aiHackathons, 'within 14 days').state.filters.deadline).toEqual({ kind: 'range', from: 'today', to: 'today+14' });
  });

  it('keeps the search and sort, and leaves the filters alone when it finds nothing', () => {
    const base: QueryState = { ...blank(), q: 'agents', filters: { stage: { kind: 'in', values: ['seed'] } }, page: 3 };
    const nothing = parseSmartFilter(aiFundraising, base, 'something vague', tags, TODAY);
    expect(nothing.applied).toEqual([]);
    expect(nothing.state.filters).toEqual(base.filters);
    const found = parseSmartFilter(aiFundraising, base, 'Europe', tags, TODAY);
    expect(found.state).toEqual({ ...base, filters: { region: { kind: 'in', values: ['europe'] } }, page: 1 });
  });

  it('describes itself from the config', () => {
    expect(smartHint(aiFundraising)).toBe('No filters found in that. Try naming a sector, round or city, an amount or a time range.');
    expect(smartExample(aiFundraising)).toBe('Seed developer rounds in the last 30 days over $10M');
    expect(smartExample(aiHackathons)).toBe('Europe hybrid hackathons in the next 30 days over $10K');
    for (const config of dataApps) {
      // The example it shows must parse into at least one filter.
      expect(parseSmartFilter(config, blank(config), smartExample(config), {}, TODAY).applied.length).toBeGreaterThan(0);
    }
  });
});
