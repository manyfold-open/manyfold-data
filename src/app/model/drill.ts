/**
 * Links from a chart to the Table, in the Table's own query format (src/shared/query.ts):
 * a bar opens `?stage=seed`, a histogram bin `?amount_usd_from=…&amount_usd_to=…`. Each
 * link starts from a clean state rather than the Table's default view, so the rows it
 * opens are the ones the chart counted.
 *
 * Plain TypeScript with no DOM or React, so tests can run it in Node.
 */

import { type DataAppConfig } from '../../shared/data-app';
import { nextBucket } from '../../shared/dates';
import { serializeQuery, type FieldFilter, type QueryState } from '../../shared/query';

const DAY_MS = 86_400_000;

/** The day before a YYYY-MM-DD date. */
const dayBefore = (date: string): string => new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);

/** A state with only these filters, sorted the config's default way. */
export function stateWith(config: DataAppConfig, filters: Record<string, FieldFilter>): QueryState {
  const sort = config.table.defaultSort;
  return { q: '', filters, sort: { field: sort.replace(/^-/, ''), desc: sort.startsWith('-') }, page: 1 };
}

/** The Table, opened on a state. */
export const tableHref = (config: DataAppConfig, state: QueryState): string =>
  `/${config.slug}/table?${serializeQuery(config, state)}`;

/** The Table showing records whose enum or tags field holds `value`. */
export const valueHref = (config: DataAppConfig, field: string, value: string): string =>
  tableHref(config, stateWith(config, { [field]: { kind: 'in', values: [value] } }));

/**
 * The inclusive range a histogram bin covers. Bins are [from, to): the Table's ranges are
 * inclusive, so a whole-number top stops one short and a $25M round stays in the next bin.
 */
export function binRange(bin: { from: number; to: number | null }): { from: string; to?: string } {
  if (bin.to === null) return { from: String(bin.from) };
  const to = Number.isInteger(bin.to) && Number.isInteger(bin.from) ? bin.to - 1 : bin.to;
  return { from: String(bin.from), to: String(to) };
}

/** The Table showing records whose number field falls in a histogram bin. */
export const binHref = (config: DataAppConfig, field: string, bin: { from: number; to: number | null }): string =>
  tableHref(config, stateWith(config, { [field]: { kind: 'range', ...binRange(bin) } }));

/** The first and last day of the week or month that starts on `start`. */
export function bucketRange(start: string, bucket: 'week' | 'month'): { from: string; to: string } {
  return { from: start, to: dayBefore(nextBucket(start, bucket)) };
}

/** The Table showing records whose date field falls in one week or month of an over-time chart. */
export const bucketHref = (config: DataAppConfig, field: string, start: string, bucket: 'week' | 'month'): string =>
  tableHref(config, stateWith(config, { [field]: { kind: 'range', ...bucketRange(start, bucket) } }));
