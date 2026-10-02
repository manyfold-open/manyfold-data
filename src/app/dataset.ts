/**
 * A data app's public dataset in the browser. It is fetched once — again only when older than a
 * minute — and every Table page, facet count, chart and the phone filter sheet's count is then
 * computed from it (src/shared/engine.ts) without another request. Filtering, sorting, searching
 * and "load more" cost the database nothing.
 */

import { useEffect, useState } from 'react';
import type { DatasetResponse } from '../shared/types';
import { ApiError, getJson } from './api';

const FRESH_MS = 60_000;
const loaded = new Map<string, { at: number; promise: Promise<DatasetResponse> }>();

/** The dataset, from memory when it is fresh; `force` fetches again (after an error). */
export function fetchDataset(slug: string, force = false): Promise<DatasetResponse> {
  const known = loaded.get(slug);
  if (known && !force && Date.now() - known.at < FRESH_MS) return known.promise;
  const promise = getJson<DatasetResponse>(`/api/${encodeURIComponent(slug)}/dataset`);
  loaded.set(slug, { at: Date.now(), promise });
  promise.catch(() => {
    if (loaded.get(slug)?.promise === promise) loaded.delete(slug);
  });
  return promise;
}

export interface DatasetState {
  data: DatasetResponse | null;
  error: ApiError | null;
  loading: boolean;
  retry: () => void;
}

export function useDataset(slug: string): DatasetState {
  const [state, setState] = useState<{ slug: string; data: DatasetResponse | null; error: ApiError | null; loading: boolean }>({
    slug,
    data: null,
    error: null,
    loading: true,
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setState((previous) => ({ ...previous, slug, loading: true }));
    fetchDataset(slug, attempt > 0).then(
      (data) => {
        if (live) setState({ slug, data, error: null, loading: false });
      },
      (failure: unknown) => {
        if (!live) return;
        const error = failure instanceof ApiError ? failure : new ApiError(0, 'network', 'Could not reach the server.');
        setState((previous) => ({ ...previous, error, loading: false }));
      },
    );
    return () => {
      live = false;
    };
  }, [slug, attempt]);

  // Never hand one data app's records to another's page while the new ones load.
  const data = state.slug === slug ? state.data : null;
  return { data, error: state.error, loading: state.loading, retry: () => setAttempt((value) => value + 1) };
}
