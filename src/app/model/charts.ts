/**
 * How the Overview draws each chart in a config, and the one-line takeaway under it. The
 * same rules serve every data app (AGENTS.md invariant 2): the treatment comes from the
 * chart's kind, the field's type and the config's `accept`, never from a slug.
 *
 *   count                         a tile in the stat strip
 *   over-time                     weekly (or monthly) columns, a Today line when dates look forward
 *   by-category, ≤5 enum values   one proportion bar and a legend
 *   by-category, more, or tags    ranked bars, the top 6 then "Show all N"
 *   histogram                     columns per bin, a coverage line when few records state the value
 *
 * Plain TypeScript with no DOM or React, so tests can run it in Node.
 */

import { valueLabel, type ChartDef, type DataAppConfig } from '../../shared/data-app';
import { monthStart, weekStart } from '../../shared/dates';
import type { ChartResult, StatsResponse } from '../../shared/types';
import { bareLabel, countOf, formatCount, formatShortDate, shortAmount } from '../format';

export type Treatment = 'tile' | 'columns' | 'share' | 'ranked' | 'histogram';

/** Most categories a proportion bar shows; more get ranked bars. */
export const SHARE_MAX = 5;
/** Ranked bars shown before "Show all". */
export const RANKED_TOP = 6;
/** Below this share of records stating a value, a histogram warns about coverage. */
export const COVERAGE_MIN = 0.6;

export function treatmentOf(config: DataAppConfig, chart: Pick<ChartDef, 'kind'> & { field?: string }): Treatment {
  switch (chart.kind) {
    case 'count':
      return 'tile';
    case 'over-time':
      return 'columns';
    case 'histogram':
      return 'histogram';
    case 'by-category': {
      const def = chart.field ? config.fields[chart.field] : undefined;
      return def?.type === 'enum' && def.values.length <= SHARE_MAX ? 'share' : 'ranked';
    }
  }
}

/** True when the config accepts only dates from today on for this field, e.g. a hackathon's deadline. */
export function looksForward(config: DataAppConfig, field: string): boolean {
  const from = config.accept?.[field]?.from;
  return typeof from === 'string' && /^today(\+\d+)?$/.test(from);
}

/** A round top for a count axis, so the gridlines at 0, half and top land on whole numbers. */
export function niceTop(max: number): number {
  const value = Math.max(2, max);
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 3, 4, 5, 6, 8, 10].find((m) => value / power <= m) ?? 10;
  const top = step * power;
  return top % 2 === 0 ? top : Math.ceil(top / 2) * 2;
}

/** A takeaway, as runs of text; strong runs are the numbers. */
export type Takeaway = { text: string; strong?: boolean }[];

export const takeawayText = (takeaway: Takeaway): string => takeaway.map((part) => part.text).join('');

const b = (value: string | number): { text: string; strong: true } => ({
  text: typeof value === 'number' ? formatCount(value) : value,
  strong: true,
});
const t = (text: string): { text: string } => ({ text });

const pct = (part: number, whole: number): string => `${whole > 0 ? Math.round((part / whole) * 100) : 0}%`;

/** First part of a label, for tight places: "Chips, cloud & data centers" → "Chips". */
export const shortLabel = (label: string): string => label.split(',')[0]!.split(' & ')[0]!;

/* ───────── over time ───────── */

type OverTime = Extract<ChartResult, { kind: 'over-time' }>;

export interface ColumnsModel {
  columns: { start: string; count: number; now: boolean; later: boolean }[];
  /** Whether the dates run into the future: a Today line splits past from upcoming. */
  forward: boolean;
  /** Where today falls across the plot, 0 to 1; null when there is no Today line. */
  todayAt: number | null;
  peak: { start: string; count: number } | null;
  /** One axis label at the first bucket of each month. */
  labels: { at: number; text: string }[];
  top: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayIndex = (date: string): number => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

export function columnsModel(config: DataAppConfig, chart: OverTime, today: string): ColumnsModel {
  const current = chart.bucket === 'week' ? weekStart(today) : monthStart(today);
  const points = chart.points;
  const forward = looksForward(config, chart.field) || points.some((point) => point.start > current);
  const n = points.length;
  const columns = points.map((point) => ({
    start: point.start,
    count: point.count,
    now: point.start === current,
    later: forward && point.start > current,
  }));

  let todayAt: number | null = null;
  if (forward && n > 0) {
    const index = points.findIndex((point) => point.start === current);
    if (index >= 0) {
      const span = chart.bucket === 'week' ? 7 : 30.5;
      todayAt = (index + Math.min(1, (dayIndex(today) - dayIndex(current) + 0.5) / span)) / n;
    } else if (points[0]!.start > current) todayAt = 0;
  }

  const peak = points.reduce<{ start: string; count: number } | null>(
    (best, point) => (best === null || point.count > best.count ? point : best),
    null,
  );

  const labels: { at: number; text: string }[] = [];
  let lastMonth = -1;
  const every = chart.bucket === 'month' ? Math.max(1, Math.ceil(n / 12)) : 1;
  points.forEach((point, index) => {
    const month = Number(point.start.slice(5, 7)) - 1;
    if (chart.bucket === 'month' ? index % every === 0 : month !== lastMonth) {
      labels.push({ at: (index + 0.5) / n, text: MONTHS[month]! });
    }
    lastMonth = month;
  });

  return { columns, forward, todayAt, peak, labels, top: niceTop(Math.max(0, ...points.map((p) => p.count))) };
}

function overTimeTakeaway(config: DataAppConfig, chart: OverTime, today: string): Takeaway {
  const model = columnsModel(config, chart, today);
  if (!model.peak) return [t('No dates yet.')];
  const unit = chart.bucket;
  const when = (start: string) => (unit === 'week' ? formatShortDate(start) : `${MONTHS[Number(start.slice(5, 7)) - 1]} ${start.slice(0, 4)}`);
  const busiest = [t(` · busiest ${unit} ${when(model.peak.start)} (`), b(model.peak.count), t(')')];
  if (model.forward) {
    const later = model.columns.filter((column) => column.later).reduce((sum, column) => sum + column.count, 0);
    return [b(later), t(` after this ${unit}`), ...busiest];
  }
  const now = model.columns.find((column) => column.now)?.count ?? 0;
  return [b(now), t(` this ${unit}`), ...busiest];
}

/* ───────── categories ───────── */

type ByCategory = Extract<ChartResult, { kind: 'by-category' }>;

function categoryTakeaway(config: DataAppConfig, chart: ByCategory, verified: number): Takeaway {
  const def = config.fields[chart.field];
  const bars = chart.bars.filter((bar) => bar.count > 0);
  const first = bars[0];
  if (!first) return [t('No values yet.')];
  const total = bars.reduce((sum, bar) => sum + bar.count, 0);
  const label = shortLabel(valueLabel(def, first.value));
  if (def?.type === 'tags') {
    return [t(`${label} leads with `), b(first.count), t(` ${first.count === 1 ? config.noun.one : config.noun.other} (`), b(pct(first.count, verified)), t(' of all)')];
  }
  if (treatmentOf(config, chart) === 'share') return [t(`${label} leads with `), b(pct(first.count, total))];
  const top3 = bars.slice(0, 3).reduce((sum, bar) => sum + bar.count, 0);
  return [t(`Top ${Math.min(3, bars.length)} make up `), b(pct(top3, total)), t(` of ${config.noun.other}`)];
}

/* ───────── histogram ───────── */

type Histogram = Extract<ChartResult, { kind: 'histogram' }>;

export interface HistogramModel {
  bins: { from: number; to: number | null; count: number; tick: string; label: string }[];
  stated: number;
  total: number;
  coverage: number;
  /** Fewer than COVERAGE_MIN of the records state the value. */
  lowCoverage: boolean;
  top: number;
}

export function histogramModel(config: DataAppConfig, chart: Histogram): HistogramModel {
  const def = config.fields[chart.field];
  const short = (value: number) => shortAmount(def, value);
  const stated = chart.bins.reduce((sum, bin) => sum + bin.count, 0);
  const total = stated + chart.missing;
  const coverage = total > 0 ? stated / total : 1;
  return {
    bins: chart.bins.map((bin, index) => ({
      ...bin,
      tick: bin.to === null ? `${short(bin.from)}+` : `<${short(bin.to)}`,
      label:
        bin.to === null
          ? `${short(bin.from)} or more`
          : index === 0
            ? `Under ${short(bin.to)}`
            : `${short(bin.from)} to under ${short(bin.to)}`,
    })),
    stated,
    total,
    coverage,
    lowCoverage: total > 0 && coverage < COVERAGE_MIN,
    top: niceTop(Math.max(0, ...chart.bins.map((bin) => bin.count))),
  };
}

/**
 * The sentence a coverage line says: "Only 16% of hackathons state a prize pool", "… state an
 * investment", "… state their attendees" (a plural label takes no "a").
 */
export function coverageText(config: DataAppConfig, chart: Histogram): string {
  const model = histogramModel(config, chart);
  const label = bareLabel(config.fields[chart.field]?.label ?? chart.field).toLowerCase();
  const article = /[^s]s$/.test(label) ? 'their' : /^[aeiou]/.test(label) ? 'an' : 'a';
  return `Only ${pct(model.stated, model.total)} of ${config.noun.other} state ${article} ${label}`;
}

function histogramTakeaway(config: DataAppConfig, chart: Histogram): Takeaway {
  const model = histogramModel(config, chart);
  if (model.stated === 0) return [t('No values yet.')];
  let seen = 0;
  const median = model.bins.find((bin) => (seen += bin.count) >= model.stated / 2) ?? model.bins[0]!;
  const range = median.to === null ? `${median.tick}` : median.label.replace(' to under ', '–').replace(/^Under /, '<');
  return [t('Median in '), b(range), t(' · stated for '), b(model.stated), t(` of ${countOf(config, model.total)}`)];
}

/* ───────── any chart ───────── */

export function takeaway(config: DataAppConfig, chart: ChartResult, stats: Pick<StatsResponse, 'today' | 'tiles'>): Takeaway {
  switch (chart.kind) {
    case 'count':
      return [b(pct(chart.value, stats.tiles.verified)), t(` of all ${config.noun.other}`)];
    case 'over-time':
      return overTimeTakeaway(config, chart, stats.today);
    case 'by-category':
      return categoryTakeaway(config, chart, stats.tiles.verified);
    case 'histogram':
      return histogramTakeaway(config, chart);
  }
}
