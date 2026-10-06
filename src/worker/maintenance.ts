/**
 * Housekeeping, run by the cron trigger every five minutes (and by POST
 * /api/admin/maintenance on demand). Every step is idempotent, so a missed or doubled
 * run does no harm:
 *
 *   - leases that ran out go back to the queue;
 *   - a verified record last checked more than `recheckAfterDays` ago gets a recheck
 *     task, unless it already has a task waiting (tasks_record finds that in one lookup);
 *   - rate-limit windows, Idempotency-Key answers and outbox rows past their use are
 *     dropped (an announcement more than two days late is not news).
 *
 * Sending the outbox to Discord is separate (src/worker/notify.ts): it needs the secrets.
 */

import type { DataAppConfig } from '../shared/data-app';
import { DAY } from './ratelimit';

export interface MaintenanceReport {
  released: number;
  rechecks: number;
}

/**
 * Each run looks for rechecks among the records that came due in the last hour. The ones due
 * longer either have a task already, waiting on a maintainer, or were missed: reading that backlog
 * every five minutes would cost it again and again. `everyDueRecord` (the first run of each UTC
 * day, and the admin's) reads them all and catches the missed ones.
 */
const RECHECK_WINDOW_MS = 60 * 60 * 1000;

const changes = (result: D1Result | undefined): number => Number(result?.meta?.changes ?? 0);

export async function maintain(
  db: D1Database,
  apps: readonly DataAppConfig[],
  now: Date,
  options: { everyDueRecord?: boolean } = {},
): Promise<MaintenanceReport> {
  const at = now.toISOString();
  const [released, ...rest] = await db.batch([
    db
      .prepare(`UPDATE tasks SET status = 'open', leased_to = NULL, lease_expires_at = NULL WHERE status = 'leased' AND lease_expires_at <= ?`)
      .bind(at),
    ...apps.map((app) => {
      const due = now.getTime() - app.recheckAfterDays * DAY;
      return db
        .prepare(
          `INSERT INTO tasks (id, app_slug, record_id, kind, status, created_at)
           SELECT 'tsk_' || lower(hex(randomblob(13))), r.app_slug, r.id, 'recheck', 'open', ?
           FROM records r
           WHERE r.app_slug = ? AND r.status = 'verified' AND r.verified_at > ? AND r.verified_at <= ?
             AND NOT EXISTS (
               SELECT 1 FROM tasks t WHERE t.record_id = r.id AND t.status IN ('open', 'leased', 'review'))`,
        )
        .bind(at, app.slug, options.everyDueRecord ? '' : new Date(due - RECHECK_WINDOW_MS).toISOString(), new Date(due).toISOString());
    }),
    db.prepare('DELETE FROM rate_counters WHERE window_start < ?').bind(now.getTime() - 2 * DAY),
    db.prepare('DELETE FROM idempotency WHERE created_at < ?').bind(new Date(now.getTime() - DAY).toISOString()),
    db.prepare('DELETE FROM outbox WHERE created_at < ?').bind(new Date(now.getTime() - 2 * DAY).toISOString()),
  ]);
  return {
    released: changes(released),
    rechecks: rest.slice(0, apps.length).reduce((sum, result) => sum + changes(result), 0),
  };
}
