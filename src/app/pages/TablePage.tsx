/**
 * A data app's Table: the filter column, search, removable chips, the records and Load
 * more. The whole state lives in the query string (src/shared/query.ts), so back/forward
 * and shared links restore exactly what was on screen; `page` counts the pages loaded.
 * On a phone the table becomes list rows and the filters and sort move into sheets.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { DataAppConfig } from '../../shared/data-app';
import { defaultQuery, parseQuery, Q_MAX, serializeQuery, type QueryState } from '../../shared/query';
import type { PublicRecord, RecordsResponse, StatsResponse } from '../../shared/types';
import { ApiError, getJson, useApi } from '../api';
import { FilterPanel, type SmartFilterState } from '../components/FilterPanel';
import { RecordList, RecordTable } from '../components/RecordTable';
import { bareLabel, formatCount, nounTitle } from '../format';
import { useIsPhone } from '../hooks';
import { rememberTable } from '../memory';
import { activeCount, chipsOf, popularOf, sortOptions } from '../model/filters';
import { parseSmartFilter, smartExample, smartHint } from '../model/smart-filter';
import { navigate } from '../router';
import { Button, Chip, Icon, Pill, SearchField, Sheet, Skeleton, usePending } from '../ui';

const PAGE_SIZE = 50;

interface Pages {
  /** Every record of every loaded page, in order. */
  records: PublicRecord[];
  first: RecordsResponse | null;
  /** True while any page for the current filters is out; the old rows stay on screen. */
  loading: boolean;
  error: ApiError | null;
}

/** Pages 1 to `count` of one query, loaded in parallel and kept while more are added. */
function usePagedRecords(base: string, count: number): Pages {
  const [store, setStore] = useState<{ base: string; pages: RecordsResponse[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const latest = useRef(store);
  latest.current = store;

  useEffect(() => {
    const have = latest.current?.base === base ? latest.current.pages.length : 0;
    if (have >= count) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const wanted = Array.from({ length: count - have }, (_, index) => have + index + 1);
    Promise.all(wanted.map((page) => getJson<RecordsResponse>(`${base}&page=${page}`, controller.signal)))
      .then((results) => {
        setStore((previous) => ({ base, pages: [...(previous?.base === base ? previous.pages : []), ...results] }));
        setError(null);
        setLoading(false);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setError(failure instanceof ApiError ? failure : new ApiError(0, 'network', 'Could not reach the server.'));
        setLoading(false);
      });
    return () => controller.abort();
  }, [base, count]);

  const pages = store?.pages.slice(0, store.base === base ? count : undefined) ?? [];
  return { records: pages.flatMap((page) => page.records), first: pages[0] ?? null, loading, error };
}

/** Search input that waits for a pause in typing before it changes the URL. */
function Search({ value, label, onChange }: { value: string; label: string; onChange: (q: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (text.trim() === value) return;
    const timer = setTimeout(() => onChange(text.trim()), 300);
    return () => clearTimeout(timer);
    // onChange is a fresh closure on every render; restarting the timer for it would
    // never let a pause elapse, so only text and value restart it.
  }, [text, value]);
  return <SearchField value={text} label={label} maxLength={Q_MAX} onChange={setText} onSubmit={() => onChange(text.trim())} />;
}

function TableSkeleton({ config, phone }: { config: DataAppConfig; phone: boolean }) {
  if (phone) {
    return (
      <div className="list" aria-hidden="true">
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="list-row">
            <Skeleton width={32} height={32} round />
            <span className="mid">
              <Skeleton width="60%" height={14} />
              <Skeleton width="40%" height={10} style={{ marginTop: 6 }} />
            </span>
            <Skeleton width={48} height={14} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="dtable-wrap" aria-hidden="true">
      <table className="dtable">
        <thead>
          <tr>
            {config.table.columns.map((field) => (
              <th key={field}>{bareLabel(config.fields[field]?.label ?? field)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 10 }, (_, row) => (
            <tr key={row}>
              {config.table.columns.map((field, index) => (
                <td key={field}>
                  {index === 0 ? (
                    <span className="title-cell">
                      <Skeleton width={24} height={24} round />
                      <Skeleton width={120} height={12} />
                    </span>
                  ) : (
                    <Skeleton width={72} height={12} />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function TablePage({ config, search }: { config: DataAppConfig; search: string }) {
  const phone = useIsPhone();

  // Opened with no parameters: show the default view and write it into the address bar,
  // so the link always names what is on screen.
  useEffect(() => {
    if (!search) navigate(`?${serializeQuery(config, defaultQuery(config))}`, { replace: true });
    else rememberTable(config.slug, search);
  }, [config, search]);

  const state = useMemo(
    () => (search ? parseQuery(config, new URLSearchParams(search)).state : defaultQuery(config)),
    [config, search],
  );
  const baseParams = serializeQuery(config, { ...state, page: 1 });
  baseParams.delete('page');
  baseParams.set('limit', String(PAGE_SIZE));
  const base = `/api/${config.slug}/records?${baseParams}`;
  const { records, first, loading, error } = usePagedRecords(base, state.page);
  const stats = useApi<StatsResponse>(`/api/${config.slug}/stats`);
  const firstPending = usePending(!first && !error);

  const go = (next: QueryState, replace = false) => navigate(`?${serializeQuery(config, next)}`, { replace });
  const sortBy = (field: string) => {
    const desc = state.sort.field === field ? !state.sort.desc : config.fields[field]?.type === 'number';
    go({ ...state, sort: { field, desc }, page: 1 });
  };
  const reset = (from: QueryState = state): QueryState => ({ ...from, q: '', filters: {}, page: 1 });

  const today = first?.today ?? new Date().toISOString().slice(0, 10);
  const total = first?.total ?? 0;
  const chips = chipsOf(config, state, today);
  const popular = useMemo(() => popularOf(config, stats.data), [config, stats.data]);

  // Values of each tags field seen so far, so the smart filter can find "San Francisco".
  const seenTags = useRef<Record<string, Set<string>>>({});
  for (const [field, counts] of Object.entries(first?.facets ?? {})) {
    if (config.fields[field]?.type !== 'tags') continue;
    const set = (seenTags.current[field] ??= new Set());
    counts.forEach((count) => set.add(count.value));
  }
  for (const chart of stats.data?.charts ?? []) {
    if (chart.kind === 'by-category' && config.fields[chart.field]?.type === 'tags') {
      const set = (seenTags.current[chart.field] ??= new Set());
      chart.bars.forEach((bar) => set.add(bar.value));
    }
  }
  const tagValues = () => Object.fromEntries(Object.entries(seenTags.current).map(([field, set]) => [field, [...set]]));

  // The smart filter's sentence stays in this component: never in the URL, never sent.
  const [smartText, setSmartText] = useState('');
  const [smartMessage, setSmartMessage] = useState<SmartFilterState['message']>(null);
  const smartFor = (apply: (next: QueryState) => void, from: QueryState): SmartFilterState => ({
    text: smartText,
    setText: (text) => {
      setSmartText(text);
      setSmartMessage(null);
    },
    message: smartMessage,
    placeholder: smartExample(config),
    apply: () => {
      const result = parseSmartFilter(config, from, smartText, tagValues(), today);
      if (result.applied.length === 0) setSmartMessage({ text: smartHint(config), miss: true });
      else {
        setSmartMessage({ text: `Applied: ${result.applied.join(' · ')}`, miss: false });
        apply(result.state);
      }
    },
  });

  // Phone sheets. The filter sheet edits a draft and counts it before it is applied.
  const [sheet, setSheet] = useState<'filters' | 'sort' | null>(null);
  const [draft, setDraft] = useState<QueryState>(state);
  const draftParams = serializeQuery(config, { ...draft, page: 1 });
  draftParams.set('limit', '1');
  const draftCount = useApi<RecordsResponse>(sheet === 'filters' ? `/api/${config.slug}/records?${draftParams}` : null);
  const openFilters = () => {
    setDraft(state);
    setSmartMessage(null);
    setSheet('filters');
  };

  const shownState = sheet === 'filters' ? draft : state;
  const busy = loading && records.length > 0;
  const pages = first ? Math.ceil(first.total / PAGE_SIZE) : 1;
  const count = (
    <span className="result-count" role="status">
      {first ? (
        <>
          <b>{formatCount(total)}</b> {total === 1 ? 'result' : 'results'}
        </>
      ) : null}
    </span>
  );
  const active = activeCount(state);
  const sortLabel = sortOptions(config).find((option) => option.field === state.sort.field && option.desc === state.sort.desc)?.label;

  const results = (
    <section className={busy ? 'results busy' : 'results'} aria-busy={loading} aria-label={nounTitle(config)}>
      {error ? <p className="notice">{error.message}</p> : null}
      <div className="results-body">
        {firstPending.pending || !first ? (
          error ? null : (
            <div className={firstPending.visible ? 'sk-on' : undefined}>
              <TableSkeleton config={config} phone={phone} />
            </div>
          )
        ) : records.length > 0 ? (
          phone ? (
            <RecordList config={config} records={records} />
          ) : (
            <RecordTable config={config} records={records} columns={config.table.columns} sort={state.sort} onSort={sortBy} />
          )
        ) : (
          <div className="empty-state">
            <b>No {config.noun.other} match</b>
            <span>Try removing a filter, or search for something else.</span>
            {active > 0 ? <Button onClick={() => go(reset())}>Reset filters</Button> : null}
          </div>
        )}
      </div>
      {first && state.page < pages && records.length > 0 ? (
        <div className="load-more">
          <Button onClick={() => go({ ...state, page: state.page + 1 }, true)} disabled={loading}>
            {loading ? 'Loading…' : `Load more · ${formatCount(total - records.length)} left`}
          </Button>
        </div>
      ) : null}
    </section>
  );

  const chipRow = (
    <div className="chips" aria-label="Applied filters">
      {chips.map((chip) => (
        <Chip key={chip.key} label={chip.label} onRemove={() => go(chip.without)} />
      ))}
      {chips.length > 1 ? (
        <button type="button" className="chip clear" onClick={() => go(reset())}>
          Clear all
        </button>
      ) : null}
    </div>
  );

  const searchBox = <Search value={state.q} label={`Search ${config.noun.other}`} onChange={(q) => go({ ...state, q, page: 1 }, true)} />;

  return (
    <>
      <section className="page-head">
        <h1>{nounTitle(config)}</h1>
        {phone ? null : <p className="desc">{config.title} · every record checked against its source.</p>}
      </section>

      {phone ? (
        <>
          <div style={{ marginTop: 16 }}>{searchBox}</div>
          <div className="toolbar">
            <Pill icon="filter" active={active > 0} onClick={openFilters} aria-haspopup="dialog">
              Filters{active > 0 ? ` · ${active}` : ''}
            </Pill>
            <Pill icon="sort" onClick={() => setSheet('sort')} aria-haspopup="dialog">
              {sortLabel ?? bareLabel(config.fields[state.sort.field]?.label ?? state.sort.field)}
            </Pill>
            {count}
          </div>
          {chipRow}
          {results}

          <Sheet
            open={sheet === 'filters'}
            title="Filters"
            onClose={() => setSheet(null)}
            action={
              <button type="button" className="link-button" onClick={() => setDraft(reset(draft))}>
                Reset
              </button>
            }
            footer={
              <Button
                variant="primary"
                onClick={() => {
                  go({ ...draft, q: state.q, page: 1 });
                  setSheet(null);
                }}
              >
                {draftCount.data
                  ? `Show ${formatCount(draftCount.data.total)} ${draftCount.data.total === 1 ? 'result' : 'results'}`
                  : 'Show results'}
              </Button>
            }
          >
            <FilterPanel
              inSheet
              config={config}
              state={shownState}
              facets={draftCount.data?.facets ?? first?.facets}
              popular={popular}
              smart={smartFor(setDraft, draft)}
              today={today}
              onChange={setDraft}
            />
          </Sheet>

          <Sheet open={sheet === 'sort'} title="Sort by" onClose={() => setSheet(null)}>
            <div role="radiogroup" aria-label="Sort by">
              {sortOptions(config).map((option) => {
                const on = state.sort.field === option.field && state.sort.desc === option.desc;
                return (
                  <button
                    key={`${option.field}:${option.desc}`}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    className="option"
                    onClick={() => {
                      go({ ...state, sort: { field: option.field, desc: option.desc }, page: 1 });
                      setSheet(null);
                    }}
                  >
                    {option.label}
                    <Icon name="check" size={18} />
                  </button>
                );
              })}
            </div>
          </Sheet>
        </>
      ) : (
        <div className="table-layout">
          <aside className="filter-column" aria-label="Filters">
            <FilterPanel
              config={config}
              state={state}
              facets={first?.facets}
              popular={popular}
              smart={smartFor((next) => go(next), state)}
              today={today}
              onChange={(next) => go(next)}
              onReset={() => go(reset())}
            />
          </aside>
          <div style={{ minWidth: 0 }}>
            <div className="toolbar">
              {searchBox}
              {count}
            </div>
            {chipRow}
            {results}
          </div>
        </div>
      )}
    </>
  );
}
