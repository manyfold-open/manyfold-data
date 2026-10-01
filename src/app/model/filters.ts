/**
 * The Table's filter column, generated from the config: which date field gets pills and in
 * which direction, the amount pills from the histogram's edges, the Popular group, and the
 * removable chips for whatever is applied. Everything reads and writes QueryState, so the
 * URL stays the one source of truth.
 *
 * Plain TypeScript with no DOM or React, so tests can run it in Node.
 */

import { describeDateBound, resolveDateBound, valueLabel, type DataAppConfig } from '../../shared/data-app';
import { withFilter, type FieldFilter, type QueryState } from '../../shared/query';
import type { StatsResponse } from '../../shared/types';
import { bareLabel, formatShortDate, shortAmount } from '../format';
import { looksForward, shortLabel } from './charts';

type RangeFilter = Extract<FieldFilter, { kind: 'range' }>;

export interface Preset {
  key: string;
  label: string;
  /** What the preset writes; null clears the field. */
  filter: RangeFilter | null;
}

/** The date field the pills filter: the one `accept` names, else the first date column. */
export function dateFieldOf(config: DataAppConfig): string | null {
  const fields = Object.entries(config.fields);
  const accepted = Object.keys(config.accept ?? {}).find((field) => config.fields[field]?.type === 'date');
  if (accepted) return accepted;
  const column = config.table.columns.find((field) => config.fields[field]?.type === 'date');
  return column ?? fields.find(([, def]) => def.type === 'date')?.[0] ?? null;
}

/** Past for dates that have happened (a round's announcement), future for ones still ahead (a deadline). */
export const dateDirection = (config: DataAppConfig, field: string): 'past' | 'future' =>
  looksForward(config, field) ? 'future' : 'past';

export function datePresets(config: DataAppConfig, field: string): Preset[] {
  const any: Preset = { key: 'any', label: 'Any time', filter: null };
  if (dateDirection(config, field) === 'future') {
    return [
      any,
      { key: 'upcoming', label: 'Upcoming', filter: { kind: 'range', from: 'today' } },
      { key: 'next7', label: 'Next 7 days', filter: { kind: 'range', from: 'today', to: 'today+7' } },
      { key: 'next30', label: 'Next 30 days', filter: { kind: 'range', from: 'today', to: 'today+30' } },
    ];
  }
  return [
    any,
    { key: 'last7', label: 'Last 7 days', filter: { kind: 'range', from: 'today-7' } },
    { key: 'last30', label: 'Last 30 days', filter: { kind: 'range', from: 'today-30' } },
  ];
}

const sameRange = (a: FieldFilter | null | undefined, b: FieldFilter | null | undefined): boolean => {
  if (!a || !b) return !a && !b;
  return a.kind === 'range' && b.kind === 'range' && a.from === b.from && a.to === b.to;
};

/** The preset a filter matches, or null when it is a custom range. */
export const presetOf = (presets: readonly Preset[], filter: FieldFilter | undefined): Preset | null =>
  presets.find((preset) => sameRange(preset.filter, filter)) ?? null;

/** The number field the amount pills filter: the first histogram's. */
export function amountOf(config: DataAppConfig): { field: string; edges: readonly number[] } | null {
  const chart = config.charts.find((item) => item.kind === 'histogram');
  if (!chart || chart.kind !== 'histogram' || config.fields[chart.field]?.type !== 'number') return null;
  return { field: chart.field, edges: chart.edges ?? [] };
}

/** Up to three "at least" thresholds from the histogram's edges, spread across them. */
export function amountThresholds(edges: readonly number[]): number[] {
  const positive = edges.filter((edge) => edge > 0);
  if (positive.length <= 3) return positive;
  const picks = [2, 4, 6].map((index) => edges[index]).filter((edge): edge is number => edge !== undefined && edge > 0);
  return picks.length > 0 ? picks : positive.slice(0, 3);
}

export function amountPresets(config: DataAppConfig): Preset[] {
  const amount = amountOf(config);
  if (!amount) return [];
  const def = config.fields[amount.field];
  return [
    { key: 'any', label: 'Any', filter: null },
    ...amountThresholds(amount.edges).map((edge) => ({
      key: String(edge),
      label: `${shortAmount(def, edge)}+`,
      filter: { kind: 'range' as const, from: String(edge) },
    })),
  ];
}

/** A range in words: "$10M–$25M", "$25M+", "Up to $5M", "Last 7 days", "Sep 1 – Sep 7". */
export function rangeLabel(config: DataAppConfig, field: string, filter: RangeFilter, today: string): string {
  const def = config.fields[field];
  if (def?.type === 'date') {
    const preset = presetOf(datePresets(config, field), filter);
    if (preset) return preset.label;
    const show = (bound: string) =>
      bound.startsWith('today') ? describeDateBound(bound) : formatShortDate(resolveDateBound(bound, today));
    if (filter.from && filter.to) return `${show(filter.from)} – ${show(filter.to)}`;
    if (filter.from) return `From ${show(filter.from)}`;
    return `Until ${show(filter.to ?? '')}`;
  }
  const show = (bound: string) => shortAmount(def, Number(bound));
  if (filter.from !== undefined && filter.to !== undefined) return `${show(filter.from)}–${show(filter.to)}`;
  if (filter.from !== undefined) return `${show(filter.from)}+`;
  return `Up to ${show(filter.to ?? '0')}`;
}

export interface Chip {
  key: string;
  label: string;
  /** The state without this chip. */
  without: QueryState;
}

/** One removable chip per applied value or range, plus the search text. */
export function chipsOf(config: DataAppConfig, state: QueryState, today: string): Chip[] {
  const chips: Chip[] = [];
  if (state.q) chips.push({ key: 'q', label: `“${state.q}”`, without: { ...state, q: '', page: 1 } });
  for (const field of Object.keys(config.fields)) {
    const filter = state.filters[field];
    const def = config.fields[field];
    if (!filter || !def) continue;
    if (filter.kind === 'in') {
      for (const value of filter.values) {
        const rest = filter.values.filter((item) => item !== value);
        chips.push({
          key: `${field}:${value}`,
          label: shortLabel(valueLabel(def, value)),
          without: withFilter(state, field, rest.length > 0 ? { kind: 'in', values: rest } : null),
        });
      }
    } else {
      const label = rangeLabel(config, field, filter, today);
      const fieldName = bareLabel(def.label);
      chips.push({
        key: field,
        label: def.type === 'number' || label.startsWith('Any') ? `${fieldName} ${label}` : `${fieldName}: ${label}`,
        without: withFilter(state, field, null),
      });
    }
  }
  return chips;
}

/** How many filters are on, search included: the number on the phone's Filters button. */
export const activeCount = (state: QueryState): number =>
  Object.values(state.filters).reduce((sum, filter) => sum + (filter.kind === 'in' ? filter.values.length : 1), 0) +
  (state.q ? 1 : 0);

export type PopularItem =
  | { kind: 'value'; field: string; value: string; label: string; sub: string }
  | { kind: 'range'; field: string; filter: RangeFilter; label: string; sub: string };

/**
 * The Popular group: the top value of each category chart (four at most), one date preset
 * and one amount threshold that at least three records reach.
 */
export function popularOf(config: DataAppConfig, stats: Pick<StatsResponse, 'charts'> | null): PopularItem[] {
  const items: PopularItem[] = [];
  for (const chart of stats?.charts ?? []) {
    if (chart.kind !== 'by-category' || items.length >= 4) continue;
    const def = config.fields[chart.field];
    const top = chart.bars.find((bar) => bar.count > 0);
    if (!def || !top || top.value === 'other') continue;
    items.push({ kind: 'value', field: chart.field, value: top.value, label: valueLabel(def, top.value), sub: def.label });
  }
  const dateField = dateFieldOf(config);
  if (dateField) {
    const presets = datePresets(config, dateField);
    const preset = presets.find((item) => item.key === 'last30' || item.key === 'next30');
    if (preset?.filter) {
      items.push({ kind: 'range', field: dateField, filter: preset.filter, label: preset.label, sub: config.fields[dateField]!.label });
    }
  }
  const amount = amountOf(config);
  const histogram = stats?.charts.find((chart) => chart.kind === 'histogram' && chart.field === amount?.field);
  if (amount && histogram?.kind === 'histogram') {
    const reach = (edge: number) => histogram.bins.filter((bin) => bin.from >= edge).reduce((sum, bin) => sum + bin.count, 0);
    const edge = [...amountThresholds(amount.edges)].reverse().find((item) => reach(item) >= 3);
    if (edge !== undefined) {
      const def = config.fields[amount.field];
      items.push({
        kind: 'range',
        field: amount.field,
        filter: { kind: 'range', from: String(edge) },
        label: `${shortAmount(def, edge)} or more`,
        sub: bareLabel(def?.label ?? amount.field),
      });
    }
  }
  return items;
}

/** Whether a Popular item is applied, and the state after clicking it. */
export function popularToggle(state: QueryState, item: PopularItem): { on: boolean; next: QueryState } {
  const filter = state.filters[item.field];
  if (item.kind === 'value') {
    const values = filter?.kind === 'in' ? filter.values : [];
    const on = values.includes(item.value);
    const rest = on ? values.filter((value) => value !== item.value) : [...values, item.value];
    return { on, next: withFilter(state, item.field, rest.length > 0 ? { kind: 'in', values: rest } : null) };
  }
  const on = sameRange(filter, item.filter);
  return { on, next: withFilter(state, item.field, on ? null : item.filter) };
}

/** Sort choices for the phone's sort sheet: each date and number column, then the title A–Z. */
export function sortOptions(config: DataAppConfig): { field: string; desc: boolean; label: string }[] {
  const options: { field: string; desc: boolean; label: string }[] = [];
  // Every date column runs the way the app's main date does: hackathons start ahead, rounds were announced.
  const main = dateFieldOf(config);
  const future = main !== null && dateDirection(config, main) === 'future';
  for (const field of config.table.columns) {
    const def = config.fields[field];
    if (def?.type === 'date') {
      options.push({ field, desc: !future, label: `${def.label} (${future ? 'soonest' : 'newest'})` });
    } else if (def?.type === 'number') {
      options.push({ field, desc: true, label: `${bareLabel(def.label)} (largest)` });
    }
  }
  const title = config.table.columns[0];
  const def = title ? config.fields[title] : undefined;
  if (title && def && (def.type === 'text' || def.type === 'enum')) options.push({ field: title, desc: false, label: `${def.label} (A–Z)` });
  return options;
}
