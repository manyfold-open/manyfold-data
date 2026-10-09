/**
 * Records parked as duplicates of a record still waiting for review. A maintainer who finds a new
 * record to be another record that is itself still pending sends unsure with unsure_type
 * duplicate_pending (src/worker/maintainer.ts): its task is parked, status 'blocked', with a row in
 * task_waits naming the record it waits for. When that record is decided, by a maintainer's verdict
 * or the admin's decision, the statements below go into the same batch:
 *
 *   verified or stale          the parked records are merged into it
 *   merged into another        they wait for that one, or are merged into it when it is live
 *   rejected (or banned)       their tasks open again: each is decided on its own
 *   sent back to pending       they keep waiting
 *
 * A merge the server makes this way is a revision by 'system' that names the record it followed,
 * so undoing the verdict that caused it can undo the merge too (src/worker/console.ts revertToken).
 */

import type { RecordStatus } from '../shared/types';
import { moveStanding } from './tokens';

export const SYSTEM = 'system';

interface Parked {
  task_id: string;
  id: string;
  status: string;
  data_json: string;
}

/** Parked records follow one another this deep at most: A parked on B, parked on C, and so on. */
const CHAIN_MAX = 5;

/**
 * The statements that follow from `record` moving to `to`, for the records parked on it, and for
 * the records parked on those when they are merged. Reads only those.
 */
export async function resolveWaiting(
  db: D1Database,
  record: { id: string; app_slug: string },
  to: RecordStatus,
  at: string,
  options: { mergedInto?: string; mergedIntoLive?: boolean; depth?: number } = {},
): Promise<D1PreparedStatement[]> {
  if (to === 'pending' || (options.depth ?? 0) >= CHAIN_MAX) return [];
  const { results: waiting } = await db
    .prepare(
      `SELECT w.task_id, r.id, r.status, r.data_json
       FROM task_waits w INDEXED BY task_waits_for JOIN tasks t ON t.id = w.task_id JOIN records r ON r.id = w.record_id
       WHERE w.waits_for = ? AND t.status = 'blocked' AND r.status = 'pending'`,
    )
    .bind(record.id)
    .all<Parked>();
  if (waiting.length === 0) return [];
  let into: string | null = null;
  if (to === 'verified' || to === 'stale') into = record.id;
  else if (to === 'merged' && options.mergedInto) {
    // Down a chain, the record merged into is the one this batch makes live, whatever the table says yet.
    const next = options.mergedIntoLive
      ? { status: 'verified' as const }
      : await db.prepare('SELECT status FROM records WHERE id = ?').bind(options.mergedInto).first<{ status: RecordStatus }>();
    if (next?.status === 'verified' || next?.status === 'stale') into = options.mergedInto;
    else {
      return waiting.map((twin) => db.prepare('UPDATE task_waits SET waits_for = ? WHERE task_id = ?').bind(options.mergedInto, twin.task_id));
    }
  }
  const statements: D1PreparedStatement[] = [];
  for (const twin of waiting) {
    statements.push(db.prepare('DELETE FROM task_waits WHERE task_id = ?').bind(twin.task_id));
    if (into) {
      statements.push(
        moveStanding(db, twin.id, 'merged', 'pending'),
        db
          .prepare(
            `INSERT INTO revisions (record_id, app_slug, actor, action, before_json, after_json, reason, created_at)
             VALUES (?, ?, 'system', 'merge', ?, ?, ?, ?)`,
          )
          .bind(
            twin.id,
            record.app_slug,
            JSON.stringify({ status: twin.status, data: JSON.parse(twin.data_json) }),
            JSON.stringify({ status: 'merged', merged_into: into, caused_by: record.id }),
            `A maintainer found it a duplicate of ${record.id}, now decided.`,
            at,
          ),
        db.prepare(`UPDATE records SET status = 'merged', merged_into = ?, updated_at = ? WHERE id = ? AND status = 'pending'`).bind(into, at, twin.id),
        db.prepare(`UPDATE tasks SET status = 'cancelled', done_at = ? WHERE id = ? AND status = 'blocked'`).bind(at, twin.task_id),
        ...(await resolveWaiting(db, { id: twin.id, app_slug: record.app_slug }, 'merged', at, {
          mergedInto: into,
          mergedIntoLive: true,
          depth: (options.depth ?? 0) + 1,
        })),
      );
    } else {
      statements.push(db.prepare(`UPDATE tasks SET status = 'open' WHERE id = ? AND status = 'blocked'`).bind(twin.task_id));
    }
  }
  return statements;
}
