// Public reads are answered from the edge cache inside their window, so repeated views cost
// D1 nothing; and when D1 refuses work for the day, readers get a 503 that says until when.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDailyLimit, secondsToMidnightUtc } from '../src/worker/cache';
import { app } from '../src/worker/index';
import { createD1 } from './d1';

/** Enough of the Workers Cache API for match and put, keyed by URL. */
class FakeCache {
  readonly store = new Map<string, Response>();
  async match(request: Request): Promise<Response | undefined> {
    return this.store.get(request.url)?.clone();
  }
  async put(request: Request, response: Response): Promise<void> {
    this.store.set(request.url, response.clone());
  }
}

let cache: FakeCache;
let queries: number;
let env: { DB: D1Database; ASSETS: Fetcher };

beforeEach(() => {
  cache = new FakeCache();
  vi.stubGlobal('caches', { default: cache });
  const db = createD1();
  queries = 0;
  // Count every statement the Worker prepares: a cache hit prepares none.
  const counted = new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property !== 'prepare' || typeof value !== 'function') return value;
      return (sql: string) => {
        queries += 1;
        return (value as (sql: string) => unknown).call(target, sql);
      };
    },
  });
  env = { DB: counted as D1Database, ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const get = (path: string) => app.request(`https://data.test${path}`, {}, env);

describe('the edge cache', () => {
  it('answers a repeated public read without touching the database', async () => {
    const first = await get('/api/ai-hackathons/stats');
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('public, max-age=60');
    const before = queries;
    expect(before).toBeGreaterThan(0);
    const second = await get('/api/ai-hackathons/stats');
    expect(second.status).toBe(200);
    expect(second.headers.get('x-cache')).toBe('hit');
    expect(second.headers.get('cache-control')).toBe('public, max-age=60');
    expect(await second.json()).toEqual(await first.json());
    expect(queries).toBe(before);
  });

  it('keeps feeds and exports for five minutes, and never keeps an error', async () => {
    expect((await get('/ai-hackathons/feed.xml')).headers.get('cache-control')).toBe('public, max-age=300');
    expect((await get('/api/ai-hackathons/records/rec_missing')).status).toBe(404);
    expect([...cache.store.keys()].some((url) => url.includes('rec_missing'))).toBe(false);
  });

  it('skips the per-filter counts when asked, for callers that only show rows', async () => {
    await get('/api/consent'); // creates the schema, so only the list's own queries are counted
    queries = 0;
    await get('/api/ai-hackathons/records?limit=6&facets=none');
    const lean = queries;
    queries = 0;
    const full = await (await get('/api/ai-hackathons/records?limit=6')).json();
    expect(lean).toBeLessThan(queries);
    expect(Object.keys((full as { facets: object }).facets).length).toBeGreaterThan(0);
  });
});

describe('a database out of reads for the day', () => {
  it('answers 503 with the time it comes back, not a bare 500', async () => {
    const refusal = new Error(
      "D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.",
    );
    expect(isDailyLimit(refusal)).toBe(true);
    expect(isDailyLimit(new Error('D1_ERROR: no such table: records'))).toBe(false);
    env.DB = {
      prepare: () => {
        throw refusal;
      },
      batch: async () => {
        throw refusal;
      },
      exec: async () => {
        throw refusal;
      },
    } as unknown as D1Database;
    const response = await get('/api/ai-fundraising/stats');
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('over_daily_limit');
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('counts down to midnight UTC', () => {
    expect(secondsToMidnightUtc(new Date('2026-10-01T23:16:00Z'))).toBe(44 * 60);
    expect(secondsToMidnightUtc(new Date('2026-10-02T00:00:00Z'))).toBe(24 * 60 * 60);
  });
});
