/**
 * Calls to /api/admin/* for the /settings console. The admin password lives in
 * sessionStorage for this tab only and goes out as x-admin-password. A 401 clears it and
 * locks the console again; components never handle the password themselves.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ApiErrorBody } from '../../shared/types';
import { ApiError } from '../api';

const KEY = 'manyfold-data-admin-password';

export const storedPassword = (): string => sessionStorage.getItem(KEY) ?? '';

let onLock: (() => void) | null = null;
/** The console registers once, to show the password gate whenever a call is refused. */
export const whenLocked = (handler: (() => void) | null): void => {
  onLock = handler;
};

export function storePassword(value: string): void {
  if (value) sessionStorage.setItem(KEY, value);
  else sessionStorage.removeItem(KEY);
}

export async function admin<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/admin${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      'x-admin-password': storedPassword(),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    if (response.status === 401) {
      storePassword('');
      onLock?.();
    }
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'request_failed',
      body?.error?.message ?? `Request failed with HTTP ${response.status}.`,
    );
  }
  return (await response.json()) as T;
}

/** POST/PUT/PATCH/DELETE with a JSON body. */
export const send = <T>(method: string, path: string, payload?: unknown): Promise<T> =>
  admin<T>(path, { method, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });

export interface AdminState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** Fetch again, keeping the current data on screen meanwhile. */
  reload: () => void;
}

export function useAdmin<T>(path: string | null): AdminState<T> {
  const [state, setState] = useState<Omit<AdminState<T>, 'reload'>>({ data: null, error: null, loading: path !== null });
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (path === null) return;
    let live = true;
    setState((previous) => ({ ...previous, loading: true }));
    admin<T>(path)
      .then((data) => live && setState({ data, error: null, loading: false }))
      .catch((error: unknown) => {
        if (!live) return;
        const failure = error instanceof ApiError ? error : new ApiError(0, 'network', 'Could not reach the server.');
        setState((previous) => ({ data: previous.data, error: failure, loading: false }));
      });
    return () => {
      live = false;
    };
  }, [path, round]);

  const reload = useCallback(() => setRound((value) => value + 1), []);
  return { ...state, reload };
}
