/**
 * The Table's state as URL parameters. The browser keeps it in the address bar and the
 * Worker turns the same parameters into SQL, so a shared link always means the same rows.
 *
 *   ?q=agents                 text search across every text field
 *   ?format=online,hybrid     enum: any of these values
 *   ?tags=agents,llm          tags: any of these tags
 *   ?deadline_from=today      date or number range, inclusive; the Worker resolves 'today'
 *   ?prize_usd_to=50000
 *   ?sort=-prize_usd          a field; a leading '-' sorts descending
 *   ?page=2                   1-based
 */

import { isIsoDate, SORTABLE, TAG, type DataAppConfig, type RangeCondition } from './data-app.ts';

export type FieldFilter =
  | { kind: 'in'; values: string[] }
  | { kind: 'range'; from?: string; to?: string };

export interface QueryState {
  q: string;
  /** Active filters only, keyed by field name. */
  filters: Record<string, FieldFilter>;
  sort: { field: string; desc: boolean };
  page: number;
}

export const Q_MAX = 100;

const parseSort = (value: string) => ({ field: value.replace(/^-/, ''), desc: value.startsWith('-') });

/** Range conditions written in a config, as query filters. */
export function rangeFilters(conditions: Readonly<Record<string, RangeCondition>> = {}): Record<string, FieldFilter> {
  const filters: Record<string, FieldFilter> = {};
  for (const [field, range] of Object.entries(conditions)) {
    filters[field] = {
      kind: 'range',
      ...(range.from !== undefined ? { from: String(range.from) } : {}),
      ...(range.to !== undefined ? { to: String(range.to) } : {}),
    };
  }
  return filters;
}

/** The state a Table opens with when its URL carries no parameters at all. */
export function defaultQuery(config: DataAppConfig): QueryState {
  return {
    q: '',
    filters: rangeFilters(config.table.defaultFilter),
    sort: parseSort(config.table.defaultSort),
    page: 1,
  };
}

/**
 * Reads Table parameters. Values that do not fit the config are skipped and reported in
 * `errors`, so the browser can ignore a stale link while the API refuses a bad request.
 */
export function parseQuery(
  config: DataAppConfig,
  params: URLSearchParams,
): { state: QueryState; errors: string[] } {
  const errors: string[] = [];
  const state: QueryState = { q: '', filters: {}, sort: parseSort(config.table.defaultSort), page: 1 };

  const q = (params.get('q') ?? '').trim();
  if (q.length > Q_MAX) errors.push(`q must be at most ${Q_MAX} characters`);
  else state.q = q;

  for (const [field, def] of Object.entries(config.fields)) {
    if (def.type === 'enum' || def.type === 'tags') {
      const raw = params.get(field);
      if (!raw) continue;
      const values = [...new Set(raw.split(',').map((value) => value.trim()).filter(Boolean))];
      const bad = values.filter((value) => (def.type === 'enum' ? !def.values.includes(value) : !TAG.test(value)));
      if (bad.length > 0) {
        errors.push(
          def.type === 'enum'
            ? `${field} must be one or more of ${def.values.join(', ')}; got ${bad.join(', ')}`
            : `${field} must list lowercase tags; got ${bad.join(', ')}`,
        );
        continue;
      }
      if (values.length > 0) state.filters[field] = { kind: 'in', values };
    } else if (def.type === 'date' || def.type === 'number') {
      const range: { kind: 'range'; from?: string; to?: string } = { kind: 'range' };
      for (const end of ['from', 'to'] as const) {
        const raw = (params.get(`${field}_${end}`) ?? '').trim();
        if (!raw) continue;
        const ok = def.type === 'date' ? raw === 'today' || isIsoDate(raw) : Number.isFinite(Number(raw));
        if (!ok) {
          errors.push(
            def.type === 'date'
              ? `${field}_${end} must be a date written YYYY-MM-DD, or today; got ${raw}`
              : `${field}_${end} must be a number; got ${raw}`,
          );
          continue;
        }
        range[end] = raw;
      }
      if (range.from !== undefined || range.to !== undefined) state.filters[field] = range;
    }
  }

  const sort = params.get('sort');
  if (sort) {
    const parsed = parseSort(sort);
    const def = config.fields[parsed.field];
    if (def && SORTABLE.includes(def.type)) state.sort = parsed;
    else errors.push(`sort must name a sortable field, optionally with a leading '-'; got ${sort}`);
  }

  const page = params.get('page');
  if (page) {
    const number = Number(page);
    if (Number.isInteger(number) && number >= 1) state.page = number;
    else errors.push(`page must be a whole number from 1; got ${page}`);
  }

  return { state, errors };
}

/** Writes Table state as parameters. `sort` is always written, so the result is never empty. */
export function serializeQuery(config: DataAppConfig, state: QueryState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  for (const field of Object.keys(config.fields)) {
    const filter = state.filters[field];
    if (!filter) continue;
    if (filter.kind === 'in') {
      if (filter.values.length > 0) params.set(field, filter.values.join(','));
    } else {
      if (filter.from !== undefined) params.set(`${field}_from`, filter.from);
      if (filter.to !== undefined) params.set(`${field}_to`, filter.to);
    }
  }
  params.set('sort', `${state.sort.desc ? '-' : ''}${state.sort.field}`);
  if (state.page > 1) params.set('page', String(state.page));
  return params;
}

/** A copy of the state with one field's filter set or cleared, back on page 1. */
export function withFilter(state: QueryState, field: string, filter: FieldFilter | null): QueryState {
  const filters = { ...state.filters };
  if (filter) filters[field] = filter;
  else delete filters[field];
  return { ...state, filters, page: 1 };
}
