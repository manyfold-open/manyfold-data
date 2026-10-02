/**
 * Queries over one data app's public records, in memory: the Table's filters, search, sort,
 * pages and facet counts, and the Overview's tiles and charts.
 *
 * A data app is small (hundreds of records, a few hundred kilobytes), so the whole public
 * dataset travels as one cached file (GET /api/:slug/dataset) and every view is computed from
 * it: in the browser for the site's own pages, and in the Worker for the public API. Neither
 * scans D1 per view; D1 is read once per dataset rebuild. The same code runs in both places,
 * so the API and the pages cannot disagree.
 *
 * Semantics match what the SQL used to do: verified records only; the text search matches text
 * fields and lists of names, without case; filters on enum and tags fields keep a record that has
 * any of the chosen values; ranges are inclusive and skip records without a value, except that
 * an open-ended date without one passes a lower bound (a rolling program is still open); sorting puts
 * missing values last either way and compares text without case, then by id; facet counts for a
 * field apply every other active filter.
 *
 * Runs in the browser, the Worker and plain Node, so it sticks to syntax Node can strip.
 */

import { resolveDateBound, type DataAppConfig, type FieldValue } from './data-app.ts';
import { monthStart, nextBucket, weekStart } from './dates.ts';
import { rangeFilters, type QueryState } from './query.ts';
import type { ChartResult, DatasetResponse, FacetCount, PublicRecord, RecordsResponse, StatsResponse } from './types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Facet values kept per tags field, most common first. */
export const FACET_TAGS_MAX = 200;
/** Bars kept for a by-category chart of a tags field, most common first. */
export const CHART_TAGS_MAX = 10;

/** A list field's items; a legacy single string reads as one item. */
const itemsOf = (value: FieldValue | undefined): string[] =>
  Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];

const missing = (value: FieldValue | undefined): boolean => value === undefined || value === null || value === '';

/** Fields the text search looks in: text, and lists of names such as cities. */
function searchFields(config: DataAppConfig): string[] {
  return Object.keys(config.fields).filter((field) => {
    const def = config.fields[field];
    return def?.type === 'text' || (def?.type === 'tags' && def.names === true);
  });
}

/** Whether a record passes the query; `skip` leaves one field's filter out, for its own facet. */
export function matches(
  config: DataAppConfig,
  record: PublicRecord,
  state: QueryState,
  today: string,
  skip?: string,
): boolean {
  if (state.q) {
    const q = state.q.toLowerCase();
    const found = searchFields(config).some((field) =>
      itemsOf(record.data[field]).some((text) => text.toLowerCase().includes(q)),
    );
    if (!found) return false;
  }
  for (const [field, filter] of Object.entries(state.filters)) {
    const def = config.fields[field];
    if (!def || field === skip) continue;
    const value = record.data[field];
    if (filter.kind === 'in') {
      if (filter.values.length === 0) continue;
      const items = def.type === 'tags' ? itemsOf(value) : typeof value === 'string' ? [value] : [];
      if (!items.some((item) => filter.values.includes(item))) return false;
      continue;
    }
    for (const end of ['from', 'to'] as const) {
      const raw = filter[end];
      if (raw === undefined) continue;
      if (missing(value) || Array.isArray(value)) {
        // An open-ended date has no end: it is on or after any day, and on or before none.
        if (end === 'from' && def.type === 'date' && def.openEnded && missing(value)) continue;
        return false;
      }
      const bound = def.type === 'number' ? Number(raw) : resolveDateBound(raw, today);
      if (end === 'from' ? (value as string | number) < bound : (value as string | number) > bound) return false;
    }
  }
  return true;
}

/** The Table's order: missing values last in both directions, text without case, then id. */
export function compareFor(config: DataAppConfig, sort: QueryState['sort']): (a: PublicRecord, b: PublicRecord) => number {
  const text = config.fields[sort.field]?.type === 'text';
  const key = (record: PublicRecord) => {
    const value = record.data[sort.field];
    if (missing(value) || Array.isArray(value)) return null;
    return text && typeof value === 'string' ? value.toLowerCase() : value;
  };
  return (a, b) => {
    const x = key(a);
    const y = key(b);
    let order = 0;
    if (x === null || y === null) order = x === null && y === null ? 0 : x === null ? 1 : -1;
    else {
      order = x < y ? -1 : x > y ? 1 : 0;
      if (sort.desc) order = -order;
    }
    return order !== 0 ? order : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

/** Counts per value, most common first, then by value. */
function countsOf(values: Iterable<string>): FacetCount[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

/** Facet counts of every enum and tags field, each under all the other active filters. */
export function facetsOf(
  config: DataAppConfig,
  records: readonly PublicRecord[],
  state: QueryState,
  today: string,
): Record<string, FacetCount[]> {
  const facets: Record<string, FacetCount[]> = {};
  for (const [field, def] of Object.entries(config.fields)) {
    if (def.type !== 'enum' && def.type !== 'tags') continue;
    const values = records
      .filter((record) => matches(config, record, state, today, field))
      .flatMap((record) => (def.type === 'tags' ? itemsOf(record.data[field]) : typeof record.data[field] === 'string' ? [record.data[field] as string] : []));
    const counts = countsOf(values);
    facets[field] = def.type === 'tags' ? counts.slice(0, FACET_TAGS_MAX) : counts;
  }
  return facets;
}

/** One page of the Table: the total, the page's records and (unless left out) facet counts. */
export function listFrom(
  config: DataAppConfig,
  dataset: Pick<DatasetResponse, 'records' | 'today'>,
  state: QueryState,
  limit: number,
  options: { facets?: boolean } = {},
): RecordsResponse {
  const { today } = dataset;
  const found = dataset.records.filter((record) => matches(config, record, state, today)).sort(compareFor(config, state.sort));
  const offset = (state.page - 1) * limit;
  return {
    total: found.length,
    page: state.page,
    limit,
    today,
    records: found.slice(offset, offset + limit),
    facets: options.facets === false ? {} : facetsOf(config, dataset.records, state, today),
  };
}

/**
 * Counts per week or month, every bucket from the first to the last date included — empty
 * ones as zero, so gaps show — keeping the latest `maxBuckets`.
 */
export function bucketDates(
  dates: readonly string[],
  bucket: 'week' | 'month',
  maxBuckets = 52,
): { start: string; count: number }[] {
  if (dates.length === 0) return [];
  const startOf = bucket === 'week' ? weekStart : monthStart;
  const counts = new Map<string, number>();
  for (const date of dates) {
    const start = startOf(date);
    counts.set(start, (counts.get(start) ?? 0) + 1);
  }
  const starts = [...counts.keys()].sort();
  const points: { start: string; count: number }[] = [];
  for (let start = starts[0]!; start <= starts.at(-1)!; start = nextBucket(start, bucket)) {
    points.push({ start, count: counts.get(start) ?? 0 });
  }
  return points.slice(-maxBuckets);
}

/** Round step for about `bins` equal buckets across [0, max]. */
function niceEdges(values: readonly number[], bins = 6): number[] {
  const max = Math.max(0, ...values);
  if (max === 0) return [0];
  const raw = max / bins;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((candidate) => candidate >= raw) ?? raw;
  return Array.from({ length: Math.ceil(max / step) }, (_, i) => i * step);
}

/** Counts per bucket. `edges` are lower bounds, ascending; the last bucket has no top. */
export function histogram(
  values: readonly number[],
  edges?: readonly number[],
): { from: number; to: number | null; count: number }[] {
  const lows = edges && edges.length > 0 ? edges : niceEdges(values);
  return lows.map((from, index) => {
    const to = lows[index + 1] ?? null;
    const count = values.filter((value) => (index === 0 ? true : value >= from) && (to === null || value < to)).length;
    return { from, to, count };
  });
}

/** Every value of an enum, zeros included, most frequent first (ties keep config order). */
function enumBars(values: readonly string[], counts: FacetCount[]): FacetCount[] {
  return values
    .map((value) => ({ value, count: counts.find((row) => row.value === value)?.count ?? 0 }))
    .sort((a, b) => b.count - a.count);
}

/** The Overview's tiles and one result per chart in the config, from the public dataset. */
export function statsFrom(config: DataAppConfig, dataset: DatasetResponse, now: Date): StatsResponse {
  const today = now.toISOString().slice(0, 10);
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const { records } = dataset;
  const values = (field: string) => records.map((record) => record.data[field]);

  const charts = config.charts.map((chart): ChartResult => {
    switch (chart.kind) {
      case 'count': {
        const state: QueryState = { q: '', filters: rangeFilters(chart.where), sort: { field: '', desc: false }, page: 1 };
        return { kind: 'count', title: chart.title, value: records.filter((record) => matches(config, record, state, today)).length };
      }
      case 'over-time':
        return {
          kind: 'over-time',
          title: chart.title,
          field: chart.field,
          bucket: chart.bucket,
          points: bucketDates(
            values(chart.field).filter((value): value is string => typeof value === 'string' && value !== ''),
            chart.bucket,
          ),
        };
      case 'by-category': {
        const def = config.fields[chart.field];
        if (def?.type === 'tags') {
          const bars = countsOf(values(chart.field).flatMap(itemsOf)).slice(0, CHART_TAGS_MAX);
          return { kind: 'by-category', title: chart.title, field: chart.field, bars };
        }
        const counts = countsOf(values(chart.field).filter((value): value is string => typeof value === 'string' && value !== ''));
        return {
          kind: 'by-category',
          title: chart.title,
          field: chart.field,
          bars: def?.type === 'enum' ? enumBars(def.values, counts) : counts,
        };
      }
      case 'histogram': {
        const numbers = values(chart.field).filter((value): value is number => typeof value === 'number');
        return {
          kind: 'histogram',
          title: chart.title,
          field: chart.field,
          bins: histogram(numbers, chart.edges),
          missing: records.length - numbers.length,
        };
      }
    }
  });

  return {
    today,
    tiles: {
      verified: records.length,
      addedLast7Days: records.filter((record) => record.verified_at !== null && record.verified_at >= weekAgo).length,
      pending: dataset.pending,
      lastUpdated: records.reduce<string | null>((last, record) => (last === null || record.updated_at > last ? record.updated_at : last), null),
    },
    charts,
    discordInvite: dataset.discordInvite,
  };
}
