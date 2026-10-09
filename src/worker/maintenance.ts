/**
 * Housekeeping, run by the cron trigger every five minutes (and by POST
 * /api/admin/maintenance on demand). Every step is idempotent, so a missed or doubled
 * run does no harm:
 *
 *   - leases that ran out go back to the queue;
 *   - a verified record last checked more than `recheckAfterDays` ago gets a recheck
 *     task, unless it already has a task waiting (tasks_record finds that in one lookup);
 *   - a task that waited a day for a maintainer with a browser goes to the admin, with the
 *     words of the maintainer who could not open its page;
 *   - rate-limit windows, Idempotency-Key answers and outbox rows past their use are
 *     dropped (an announcement more than two days late is not news), and so are the needs
 *     and waits of tasks that no longer wait.
 *
 * Sending the outbox to Discord is separate (src/worker/notify.ts): it needs the secrets.
 */

import type { DataAppConfig } from '../shared/data-app';
import { DAY } from './ratelimit';

export interface MaintenanceReport {
  released: number;
  rechecks: number;
  /** Tasks that waited too long for a maintainer with a browser, sent to the admin. */
  escalated: number;
}

/** How long a task that needs a browser waits for a maintainer with one before the admin gets it. */
export const BROWSER_WAIT_MS = 24 * 60 * 60 * 1000;

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
    // Walked from the small tables, each row looking its task up by id.
    db.prepare(`DELETE FROM task_needs WHERE NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_needs.task_id AND t.status IN ('open', 'leased'))`),
    db.prepare(`DELETE FROM task_waits WHERE NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_waits.task_id AND t.status = 'blocked')`),
  ]);
  return {
    released: changes(released),
    rechecks: rest.slice(0, apps.length).reduce((sum, result) => sum + changes(result), 0),
    escalated: await escalateUnopened(db, now),
  };
}

/**
 * Tasks that waited BROWSER_WAIT_MS for a maintainer with a browser and found none go to the admin,
 * as the maintainer's 'cannot_open' would have without one. The revision carries what that
 * maintainer said, so the review queue shows it.
 */
async function escalateUnopened(db: D1Database, now: Date): Promise<number> {
  const at = now.toISOString();
  const { results } = await db
    .prepare(
      `SELECT t.id AS task_id, r.id, r.app_slug, r.status, r.data_json,
         (SELECT v.reason FROM revisions v INDEXED BY revisions_record WHERE v.record_id = r.id AND v.action = 'defer' ORDER BY v.id DESC LIMIT 1) AS said
       FROM task_needs n INDEXED BY task_needs_need JOIN tasks t ON t.id = n.task_id JOIN records r ON r.id = t.record_id
       WHERE n.need = 'browser' AND n.since <= ? AND t.status = 'open' LIMIT 50`,
    )
    .bind(new Date(now.getTime() - BROWSER_WAIT_MS).toISOString())
    .all<{ task_id: string; id: string; app_slug: string; status: string; data_json: string; said: string | null }>();
  if (results.length === 0) return 0;
  await db.batch(
    results.flatMap((row) => [
      db
        .prepare(
          `INSERT INTO revisions (record_id, app_slug, actor, action, before_json, after_json, reason, created_at)
           VALUES (?, ?, 'system', 'unsure', ?, ?, ?, ?)`,
        )
        .bind(
          row.id,
          row.app_slug,
          JSON.stringify({ status: row.status, data: JSON.parse(row.data_json) }),
          JSON.stringify({ status: row.status, unsure_type: 'cannot_open' }),
          `No maintainer with a browser took it within a day. ${row.said ?? ''}`.trim().slice(0, 500),
          at,
        ),
      db.prepare(`UPDATE tasks SET status = 'review', done_at = ? WHERE id = ? AND status = 'open'`).bind(at, row.task_id),
      db.prepare('DELETE FROM task_needs WHERE task_id = ?').bind(row.task_id),
    ]),
  );
  return results.length;
}
