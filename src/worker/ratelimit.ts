/**
 * Fixed-window counters in D1 (`rate_counters`), the same scheme as tarot's limiter: one
 * upsert per hit returns the new count, so two concurrent requests cannot both read
 * "limit - 1". A burst at a window boundary is the accepted failure mode.
 */

import { HttpError } from './types';

export interface RateRule {
  limit: number;
  windowMs: number;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const RULES = {
  /** New collector tokens per client IP. */
  joinPerHour: { limit: 5, windowMs: HOUR },
  joinPerDay: { limit: 20, windowMs: DAY },
  /** Requests per agent token. */
  tokenPerMinute: { limit: 60, windowMs: MINUTE },
  /** Readers' data requests (POST /api/requests) per client IP. */
  requestPerHour: { limit: 5, windowMs: HOUR },
  /**
   * Data requests the whole site accepts in a day: the bound on the requests channel when many
   * addresses send at once. Counted only for requests that passed the IP limit and the check.
   */
  requestsPerDay: { limit: 100, windowMs: DAY },
} as const satisfies Record<string, RateRule>;

const windowIndex = (nowMs: number, windowMs: number) => Math.floor(nowMs / windowMs);

/** Counts one hit against `scope:subject` and says whether it still fits under the rule. */
export async function consume(
  db: D1Database,
  scope: string,
  subject: string,
  rule: RateRule,
  nowMs: number = Date.now(),
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const index = windowIndex(nowMs, rule.windowMs);
  const row = await db
    .prepare(
      `INSERT INTO rate_counters (bucket, count, window_start) VALUES (?, 1, ?)
       ON CONFLICT (bucket) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(`${scope}:${subject}:${index}`, index * rule.windowMs)
    .first<{ count: number }>();
  return {
    allowed: Number(row?.count ?? 1) <= rule.limit,
    retryAfterSeconds: Math.max(1, Math.ceil(((index + 1) * rule.windowMs - nowMs) / 1000)),
  };
}

/** Counts one hit under every rule and throws 429 when any of them is full. */
export async function enforce(
  db: D1Database,
  checks: { scope: string; subject: string; rule: RateRule }[],
  nowMs: number = Date.now(),
): Promise<void> {
  const outcomes = await Promise.all(
    checks.map((check) => consume(db, check.scope, check.subject, check.rule, nowMs)),
  );
  const wait = Math.max(0, ...outcomes.filter((outcome) => !outcome.allowed).map((outcome) => outcome.retryAfterSeconds));
  if (wait > 0) {
    throw new HttpError(429, 'rate_limited', `Too many requests. Try again in ${wait} seconds.`, {
      'retry-after': String(wait),
    });
  }
}

/** Drops windows nobody reads again. Called now and then rather than on every hit. */
export async function sweep(db: D1Database, nowMs: number = Date.now()): Promise<void> {
  await db.prepare('DELETE FROM rate_counters WHERE window_start < ?').bind(nowMs - 2 * DAY).run();
}
