/**
 * Public reads, cached at the edge for a short while.
 *
 * Every Table view runs a count, a page and one facet query per filter, each scanning the
 * data app's records, and the Overview adds the stats. Without a cache every view pays that
 * again, and on 2026-10-01 the account ran out of D1's daily row reads by evening. Within the
 * window an identical request is answered from the data center's cache and never reaches D1.
 *
 * Only public, token-free GETs go through here, and only 200 answers are kept. A change shows
 * within `seconds` (a minute for the API), which is soon enough for a dataset that moves when
 * maintainers verify. The admin console reads its own, uncached routes.
 */

import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from './types';

/** The cache this Worker can use, or null where there is none (tests, some local runtimes). */
const edgeCache = (): Cache | null =>
  typeof caches === 'undefined' ? null : ((caches as unknown as { default?: Cache }).default ?? null);

export function cachedFor(seconds: number): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const cache = edgeCache();
    if (!cache || c.req.method !== 'GET') return next();

    // The URL alone is the key: these answers never depend on headers or cookies.
    const key = new Request(c.req.url, { method: 'GET' });
    const hit = await cache.match(key);
    if (hit) {
      const answer = new Response(hit.body, hit);
      // A copy served from the cache comes back with the zone's Browser Cache TTL (4 hours on
      // manyfold.ai) in place of ours; browsers must keep it no longer than the edge does.
      answer.headers.set('cache-control', `public, max-age=${seconds}`);
      answer.headers.set('x-cache', 'hit');
      return answer;
    }

    await next();
    if (c.res.status !== 200) return;
    c.res.headers.set('cache-control', `public, max-age=${seconds}`);
    const copy = c.res.clone();
    const stored = new Response(copy.body, copy);
    stored.headers.delete('vary');
    stored.headers.delete('set-cookie');
    const put = cache.put(key, stored);
    try {
      c.executionCtx.waitUntil(put);
    } catch {
      await put; // no execution context (tests): finish the write before answering
    }
  };
}

/**
 * A JSON value cached under `url` for `seconds`: this data center's copy when it has one, else
 * `load()` once and keep it. The /dataset route stores its answer under the same URL, so the
 * computed reads (/records, /stats) reuse whichever of them read D1 first.
 */
export async function cachedJson<T>(c: Context, url: string, seconds: number, load: () => Promise<T>): Promise<T> {
  const cache = edgeCache();
  const key = new Request(url, { method: 'GET' });
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return (await hit.json()) as T;
  }
  const value = await load();
  if (cache) {
    const response = new Response(JSON.stringify(value), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${seconds}` },
    });
    const put = cache.put(key, response);
    try {
      c.executionCtx.waitUntil(put);
    } catch {
      await put;
    }
  }
  return value;
}

/**
 * Whether an error is D1 refusing work for the day (the free tier's daily limits). Reads come
 * back at midnight UTC, so the caller can say when instead of "something went wrong".
 */
export const isDailyLimit = (error: unknown): boolean =>
  /D1_ERROR/.test(String(error)) && /daily .*limit/i.test(String(error));

/** Seconds until the next midnight UTC, when D1's daily limits reset. */
export function secondsToMidnightUtc(now: Date = new Date()): number {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000));
}
