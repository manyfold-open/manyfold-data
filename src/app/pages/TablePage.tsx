/**
 * A data app's Table: search, a filter per field, sortable columns and pages. The whole
 * state lives in the query string (src/shared/query.ts), so back/forward and shared
 * links restore exactly what was on screen.
 */

import { useEffect, useMemo, useState } from 'react';
import { valueLabel, type DataAppConfig, type FieldDef } from '../../shared/data-app';
import {
  defaultQuery,
  parseQuery,
  Q_MAX,
  serializeQuery,
  withFilter,
  type FieldFilter,
  type QueryState,
} from '../../shared/query';
import type { FacetCount, RecordsResponse } from '../../shared/types';
import { useApi } from '../api';
import { RecordTable } from '../components/RecordTable';
import { countOf, formatCount } from '../format';
import { navigate } from '../router';

const PAGE_SIZE = 50;
const TAGS_SHOWN = 12;

type RangeFilter = Extract<FieldFilter, { kind: 'range' }>;

const rangeOrNull = (from?: string, to?: string): RangeFilter | null =>
  from === undefined && to === undefined
    ? null
    : { kind: 'range', ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };

/* ───────── filters ───────── */

function ChoiceFilter({
  def,
  filter,
  counts,
  onChange,
}: {
  def: FieldDef;
  filter: FieldFilter | undefined;
  counts: FacetCount[];
  onChange: (filter: FieldFilter | null) => void;
}) {
  const selected = filter?.kind === 'in' ? filter.values : [];
  const values =
    def.type === 'enum'
      ? def.values
      : [...new Set([...selected, ...counts.map((count) => count.value)])].slice(0, TAGS_SHOWN);
  const toggle = (value: string) => {
    const next = selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value];
    onChange(next.length > 0 ? { kind: 'in', values: next } : null);
  };

  return (
    <fieldset className="filter">
      <legend>{def.label}</legend>
      {values.length === 0 ? <p className="muted small">None yet</p> : null}
      {values.map((value) => {
        const count = counts.find((item) => item.value === value)?.count ?? 0;
        const checked = selected.includes(value);
        return (
          <label key={value} className={count === 0 && !checked ? 'choice zero' : 'choice'}>
            <input type="checkbox" checked={checked} onChange={() => toggle(value)} />
            <span className="choice-name">{valueLabel(def, value)}</span>
            <span className="choice-count">{formatCount(count)}</span>
          </label>
        );
      })}
    </fieldset>
  );
}

type Preset = 'any' | 'upcoming' | 'past' | 'custom';

const presetOf = (filter: FieldFilter | undefined): Preset => {
  if (filter?.kind !== 'range') return 'any';
  if (filter.from === 'today' && filter.to === undefined) return 'upcoming';
  if (filter.to === 'today' && filter.from === undefined) return 'past';
  return 'custom';
};

function DateFilter({
  def,
  filter,
  today,
  onChange,
}: {
  def: FieldDef;
  filter: FieldFilter | undefined;
  today: string;
  onChange: (filter: FieldFilter | null) => void;
}) {
  const [custom, setCustom] = useState(presetOf(filter) === 'custom');
  useEffect(() => {
    if (presetOf(filter) === 'custom') setCustom(true);
  }, [filter]);

  const preset = custom ? 'custom' : presetOf(filter);
  const range = filter?.kind === 'range' ? filter : undefined;
  const shown = (value?: string) => (value === 'today' ? today : (value ?? ''));

  const choose = (next: Preset) => {
    setCustom(next === 'custom');
    if (next === 'any') onChange(null);
    if (next === 'upcoming') onChange({ kind: 'range', from: 'today' });
    if (next === 'past') onChange({ kind: 'range', to: 'today' });
  };

  return (
    <fieldset className="filter">
      <legend>{def.label}</legend>
      <select value={preset} onChange={(event) => choose(event.target.value as Preset)} aria-label={`${def.label} dates`}>
        <option value="any">Any date</option>
        <option value="upcoming">Today or later</option>
        <option value="past">Today or earlier</option>
        <option value="custom">Between dates</option>
      </select>
      {preset === 'custom' ? (
        <div className="range-inputs">
          <label>
            From
            <input
              type="date"
              value={shown(range?.from)}
              onChange={(event) => onChange(rangeOrNull(event.target.value || undefined, range?.to))}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={shown(range?.to)}
              onChange={(event) => onChange(rangeOrNull(range?.from, event.target.value || undefined))}
            />
          </label>
        </div>
      ) : null}
    </fieldset>
  );
}

function NumberFilter({
  def,
  filter,
  onChange,
}: {
  def: FieldDef;
  filter: FieldFilter | undefined;
  onChange: (filter: FieldFilter | null) => void;
}) {
  const range = filter?.kind === 'range' ? filter : undefined;
  const [from, setFrom] = useState(range?.from ?? '');
  const [to, setTo] = useState(range?.to ?? '');
  useEffect(() => {
    setFrom(range?.from ?? '');
    setTo(range?.to ?? '');
  }, [range?.from, range?.to]);

  const apply = () => onChange(rangeOrNull(from.trim() || undefined, to.trim() || undefined));
  const min = def.type === 'number' ? def.min : undefined;

  return (
    <fieldset className="filter">
      <legend>{def.label}</legend>
      <form
        className="range-inputs"
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <label>
          Min
          <input type="number" inputMode="numeric" min={min} value={from} onChange={(event) => setFrom(event.target.value)} onBlur={apply} />
        </label>
        <label>
          Max
          <input type="number" inputMode="numeric" min={min} value={to} onChange={(event) => setTo(event.target.value)} onBlur={apply} />
        </label>
      </form>
    </fieldset>
  );
}

/* ───────── search and pages ───────── */

/** Search input that waits for a pause in typing before it changes the URL. */
function SearchBox({ value, label, onChange }: { value: string; label: string; onChange: (q: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (text.trim() === value) return;
    const timer = setTimeout(() => onChange(text.trim()), 300);
    return () => clearTimeout(timer);
    // onChange is a fresh closure on every render; restarting the timer for it would
    // never let a pause elapse, so only text and value restart it.
  }, [text, value]);

  return (
    <input
      type="search"
      className="search"
      placeholder={label}
      aria-label={label}
      maxLength={Q_MAX}
      value={text}
      onChange={(event) => setText(event.target.value)}
    />
  );
}

function Pagination({ page, pages, onPage }: { page: number; pages: number; onPage: (page: number) => void }) {
  return (
    <nav className="pagination" aria-label="Pages">
      <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </button>
      <span>
        Page {page} of {pages}
      </span>
      <button type="button" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next
      </button>
    </nav>
  );
}

/* ───────── page ───────── */

export default function TablePage({ config, search }: { config: DataAppConfig; search: string }) {
  // Opened with no parameters: show the default view and write it into the address bar,
  // so the link always names what is on screen.
  useEffect(() => {
    if (!search) navigate(`?${serializeQuery(config, defaultQuery(config))}`, { replace: true });
  }, [config, search]);

  const state = useMemo(
    () => (search ? parseQuery(config, new URLSearchParams(search)).state : defaultQuery(config)),
    [config, search],
  );
  const apiParams = serializeQuery(config, state);
  apiParams.set('limit', String(PAGE_SIZE));
  const { data, error, loading } = useApi<RecordsResponse>(`/api/${config.slug}/records?${apiParams}`);

  const [filtersOpen, setFiltersOpen] = useState(false);
  const go = (next: QueryState, replace = false) => navigate(`?${serializeQuery(config, next)}`, { replace });
  const setFilter = (field: string, filter: FieldFilter | null) => go(withFilter(state, field, filter));
  const sortBy = (field: string) => {
    const desc = state.sort.field === field ? !state.sort.desc : config.fields[field]?.type === 'number';
    go({ ...state, sort: { field, desc }, page: 1 });
  };
  const clear = () => go({ ...state, q: '', filters: {}, page: 1 });

  const active = Object.keys(state.filters).length + (state.q ? 1 : 0);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;
  const today = data?.today ?? new Date().toISOString().slice(0, 10);

  return (
    <>
      <section className="page-head compact">
        <h1>{config.title}</h1>
        <p className="meta" role="status">
          {data ? `${countOf(config, data.total)} ${data.total === 1 ? 'matches' : 'match'}` : 'Loading'}
          {active > 0 ? (
            <>
              {' · '}
              <button type="button" className="link-button" onClick={clear}>
                Clear filters
              </button>
            </>
          ) : null}
        </p>
      </section>

      <div className="table-layout">
        <button
          type="button"
          className="quiet-button filters-toggle"
          aria-expanded={filtersOpen}
          aria-controls="filters"
          onClick={() => setFiltersOpen(!filtersOpen)}
        >
          {filtersOpen ? 'Hide filters' : 'Filters'}
          {active > 0 ? ` (${active})` : ''}
        </button>
        <aside id="filters" className={filtersOpen ? 'filters open' : 'filters'} aria-label="Filters">
          {Object.entries(config.fields).map(([field, def]) => {
            const filter = state.filters[field];
            const onChange = (next: FieldFilter | null) => setFilter(field, next);
            if (def.type === 'enum' || def.type === 'tags') {
              return <ChoiceFilter key={field} def={def} filter={filter} counts={data?.facets[field] ?? []} onChange={onChange} />;
            }
            if (def.type === 'date') {
              return <DateFilter key={field} def={def} filter={filter} today={today} onChange={onChange} />;
            }
            if (def.type === 'number') {
              return <NumberFilter key={field} def={def} filter={filter} onChange={onChange} />;
            }
            return null;
          })}
        </aside>

        <section className="results" aria-busy={loading}>
          <div className="results-bar">
            <SearchBox
              value={state.q}
              label={`Search ${config.noun.other}`}
              onChange={(q) => go({ ...state, q, page: 1 }, true)}
            />
          </div>

          {error ? <p className="notice">{error.message}</p> : null}

          <div className={loading && data ? 'dimmed' : undefined}>
            {data && data.records.length > 0 ? (
              <RecordTable
                config={config}
                records={data.records}
                columns={config.table.columns}
                sort={state.sort}
                onSort={sortBy}
              />
            ) : null}
            {data && data.records.length === 0 ? (
              <div className="empty-state">
                {data.total > 0 ? (
                  <>
                    <p>Page {state.page} is past the last page.</p>
                    <button type="button" className="quiet-button" onClick={() => go({ ...state, page: 1 })}>
                      Go to page 1
                    </button>
                  </>
                ) : (
                  <>
                    <p>No {config.noun.other} match these filters.</p>
                    {active > 0 ? (
                      <button type="button" className="quiet-button" onClick={clear}>
                        Clear filters
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}
          </div>

          {data && pages > 1 ? <Pagination page={state.page} pages={pages} onPage={(page) => go({ ...state, page })} /> : null}
        </section>
      </div>
    </>
  );
}
