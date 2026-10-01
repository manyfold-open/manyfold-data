/**
 * The Overview's numbers: four tiles every data app shows, plus one result per chart in
 * its config. All of it counts verified records only. The bucketing helpers are pure
 * so tests can pin them down.
 */

import type { ChartDef, DataAppConfig } from '../shared/data-app';
import { monthStart, nextBucket, weekStart } from '../shared/dates';
import { rangeFilters, type QueryState } from '../shared/query';
import type { ChartResult, FacetCount, StatsResponse } from '../shared/types';
import { fieldSql } from './db';
import { buildWhere } from './records';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Counts per week or month, every bucket from the first to the last date included —
 * empty ones as zero, so gaps show — keeping the latest `maxBuckets`.
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
    const count = values.filter((value) =>
      (index === 0 ? true : value >= from) && (to === null || value < to),
    ).length;
    return { from, to, count };
  });
}

/** Every value of an enum, zeros included, most frequent first (ties keep config order). */
function enumBars(values: readonly string[], rows: FacetCount[]): FacetCount[] {
  return values
    .map((value) => ({ value, count: rows.find((row) => row.value === value)?.count ?? 0 }))
    .sort((a, b) => b.count - a.count);
}

export async function computeStats(
  db: D1Database,
  config: DataAppConfig,
  now: Date,
): Promise<StatsResponse> {
  const today = now.toISOString().slice(0, 10);
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const verified = "app_slug = ? AND status = 'verified'";

  const chartStatement = (chart: ChartDef): D1PreparedStatement => {
    if (chart.kind === 'count') {
      const state: QueryState = {
        q: '',
        filters: rangeFilters(chart.where),
        sort: { field: '', desc: false },
        page: 1,
      };
      const where = buildWhere(config, state, today);
      return db.prepare(`SELECT COUNT(*) AS n FROM records WHERE ${where.sql}`).bind(...where.params);
    }
    const column = fieldSql(chart.field);
    if (chart.kind === 'by-category' && config.fields[chart.field]?.type === 'tags') {
      return db
        .prepare(
          `SELECT json_each.value AS value, COUNT(*) AS n
           FROM records, json_each(records.data_json, '$.${chart.field}')
           WHERE ${verified} GROUP BY json_each.value ORDER BY n DESC, value LIMIT 10`,
        )
        .bind(config.slug);
    }
    if (chart.kind === 'by-category') {
      return db
        .prepare(
          `SELECT ${column} AS value, COUNT(*) AS n FROM records
           WHERE ${verified} AND ${column} IS NOT NULL GROUP BY value`,
        )
        .bind(config.slug);
    }
    // over-time and histogram bucket in code: one value per record.
    return db.prepare(`SELECT ${column} AS v FROM records WHERE ${verified}`).bind(config.slug);
  };

  const [tiles, pending, ...charts] = await db.batch<unknown>([
    db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(verified_at >= ?), 0) AS recent, MAX(updated_at) AS last
         FROM records WHERE ${verified}`,
      )
      .bind(weekAgo, config.slug),
    db
      .prepare("SELECT COUNT(*) AS n FROM records WHERE app_slug = ? AND status = 'pending'")
      .bind(config.slug),
    ...config.charts.map(chartStatement),
  ]);

  const tileRow = tiles?.results[0] as { n: number; recent: number; last: string | null } | undefined;
  return {
    today,
    tiles: {
      verified: tileRow?.n ?? 0,
      addedLast7Days: tileRow?.recent ?? 0,
      pending: (pending?.results[0] as { n: number } | undefined)?.n ?? 0,
      lastUpdated: tileRow?.last ?? null,
    },
    charts: config.charts.map((chart, index): ChartResult => {
      const rows = (charts[index]?.results ?? []) as Record<string, unknown>[];
      switch (chart.kind) {
        case 'count':
          return { kind: 'count', title: chart.title, value: Number(rows[0]?.n ?? 0) };
        case 'over-time':
          return {
            kind: 'over-time',
            title: chart.title,
            field: chart.field,
            bucket: chart.bucket,
            points: bucketDates(
              rows.map((row) => row.v).filter((v): v is string => typeof v === 'string'),
              chart.bucket,
            ),
          };
        case 'by-category': {
          const counts = rows.map((row) => ({ value: String(row.value), count: Number(row.n) }));
          const def = config.fields[chart.field];
          return {
            kind: 'by-category',
            title: chart.title,
            field: chart.field,
            bars: def?.type === 'enum' ? enumBars(def.values, counts) : counts,
          };
        }
        case 'histogram': {
          const values = rows.map((row) => row.v).filter((v): v is number => typeof v === 'number');
          return {
            kind: 'histogram',
            title: chart.title,
            field: chart.field,
            bins: histogram(values, chart.edges),
            missing: rows.length - values.length,
          };
        }
      }
    }),
  };
}
