/**
 * Reading the public API. useApi keeps the previous answer on screen while a new one
 * loads, so filters and pages change without a flash.
 */

import { useEffect, useState } from 'react';
import type { ApiErrorBody } from '../shared/types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export const getJson = async <T>(path: string, signal?: AbortSignal): Promise<T> =>
  read<T>(await fetch(path, { signal, headers: { accept: 'application/json' } }));

export const postJson = async <T>(path: string, payload: unknown): Promise<T> =>
  read<T>(
    await fetch(path, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );

async function read<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'request_failed',
      body?.error?.message ?? `Request failed with HTTP ${response.status}.`,
    );
  }
  return (await response.json()) as T;
}

export interface ApiState<T> {
  data: T | null;
  error: ApiError | null;
  /** True while a request is out; `data` still holds the previous answer. */
  loading: boolean;
}

export function useApi<T>(path: string | null): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>({ data: null, error: null, loading: path !== null });

  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    setState((previous) => ({ ...previous, loading: true }));
    getJson<T>(path, controller.signal)
      .then((data) => setState({ data, error: null, loading: false }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const failure =
          error instanceof ApiError ? error : new ApiError(0, 'network', 'Could not reach the server.');
        setState((previous) => ({ data: previous.data, error: failure, loading: false }));
      });
    return () => controller.abort();
  }, [path]);

  return state;
}
