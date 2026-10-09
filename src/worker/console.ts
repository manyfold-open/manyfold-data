/**
 * What the /settings console reads and does, beyond tokens (tokens.ts) and Discord
 * (notify.ts): the overview, the review queue, any record with its full history, the
 * admin's own decisions and edits, reader reports, activity, undoing one token's work,
 * banning a collector, the weekly spot-check, and the precedents the admin's decisions set.
 *
 * Every change to a record writes a revision with actor 'admin', so the admin is as
 * accountable in the history as any agent, and every status change moves the record in its
 * submitter's standing (moveStanding) in the same batch. A decision on a record a maintainer
 * decided, and a spot check marked wrong, count for that maintainer's quality (tokens.ts).
 */

import {
  cleanText,
  identityKey,
  validateProvenance,
  validateRecordData,
  type DataAppConfig,
  type Provenance,
  type RecordData,
} from '../shared/data-app';
import type {
  ActivityItem,
  AdminRecord,
  AdminRecordDetail,
  AdminRevision,
  AppOverview,
  Precedent,
  RecordStatus,
  Report,
  RevertReport,
  ReviewItem,
  SpotCheck,
  UnsureType,
} from '../shared/types';
import { newId, sha256Hex } from './ids';
import { notifyStatus } from './notify';
import { moveStanding, suspendMaintainerIfFailing } from './tokens';
import { HttpError } from './types';
import { resolveWaiting, SYSTEM } from './waits';

const ADMIN = 'admin';
const STATUSES: readonly RecordStatus[] = ['pending', 'verified', 'rejected', 'merged', 'stale'];
const REASON_MAX = 500;
const PAGE_SIZE = 50;
export const SPOT_CHECK_SIZE = 50;

/* ───────── records as the admin sees them ───────── */

interface RecordRow {
  id: string;
  app_slug: string;
  identity_key: string;
  status: RecordStatus;
  data_json: string;
  source_url: string;
  evidence: string;
  observed_at: string;
  submitted_by: string;
  submitter_label: string | null;
  flagged: number;
  merged_into: string | null;
  created_at: string;
  updated_at: string;
  verified_at: string | null;
}

const RECORD_SELECT = `SELECT r.*, t.label AS submitter_label FROM records r LEFT JOIN tokens t ON t.id = r.submitted_by`;

export const actorLabel = (id: string, label: string | null | undefined): string =>
  id === 'seed' ? 'Manyfold team (seed data)' : id === ADMIN ? 'Admin' : id === SYSTEM ? 'Manyfold Data (automatic)' : (label ?? 'Unknown token');

const titleOf = (config: DataAppConfig | undefined, data: RecordData) =>
  String(data[config?.table.columns[0] ?? 'name'] ?? 'Untitled');

function toAdminRecord(row: RecordRow, config?: DataAppConfig): AdminRecord {
  const data = JSON.parse(row.data_json) as RecordData;
  return {
    id: row.id,
    app_slug: row.app_slug,
    status: row.status,
    name: titleOf(config, data),
    data,
    source_url: row.source_url,
    evidence: row.evidence,
    observed_at: row.observed_at,
    submitted_by: { id: row.submitted_by, label: actorLabel(row.submitted_by, row.submitter_label) },
    flagged: row.flagged === 1,
    merged_into: row.merged_into,
    created_at: row.created_at,
    updated_at: row.updated_at,
    verified_at: row.verified_at,
  };
}

async function recordRow(db: D1Database, config: DataAppConfig, id: string): Promise<RecordRow> {
  const row = await db.prepare(`${RECORD_SELECT} WHERE r.app_slug = ? AND r.id = ?`).bind(config.slug, id).first<RecordRow>();
  if (!row) throw new HttpError(404, 'not_found', `No record ${id} in ${config.slug}.`);
  return row;
}

export async function listRecords(
  db: D1Database,
  config: DataAppConfig,
  query: { status?: string; q?: string; page?: number },
): Promise<{ total: number; page: number; records: AdminRecord[] }> {
  const status = query.status && STATUSES.includes(query.status as RecordStatus) ? query.status : null;
  const like = query.q ? `%${query.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%` : null;
  const page = Math.max(1, query.page ?? 1);
  const where = `r.app_slug = ? AND (? IS NULL OR r.status = ?) AND (? IS NULL OR r.data_json LIKE ? ESCAPE '\\')`;
  const params = [config.slug, status, status, like, like];
  const [count, rows] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n FROM records r WHERE ${where}`).bind(...params),
    db.prepare(`${RECORD_SELECT} WHERE ${where} ORDER BY r.updated_at DESC, r.id LIMIT ? OFFSET ?`).bind(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE),
  ]);
  return {
    total: (count?.results[0] as { n: number } | undefined)?.n ?? 0,
    page,
    records: ((rows?.results ?? []) as RecordRow[]).map((row) => toAdminRecord(row, config)),
  };
}

export async function recordDetail(db: D1Database, config: DataAppConfig, id: string): Promise<AdminRecordDetail> {
  const row = await recordRow(db, config, id);
  const [revisions, tasks, reports] = await db.batch([
    db
      .prepare(
        `SELECT v.*, t.label FROM revisions v LEFT JOIN tokens t ON t.id = v.actor WHERE v.record_id = ? ORDER BY v.id`,
      )
      .bind(id),
    db.prepare('SELECT id, kind, status, leased_to, created_at FROM tasks WHERE record_id = ? ORDER BY created_at').bind(id),
    db.prepare('SELECT * FROM reports WHERE record_id = ? ORDER BY id').bind(id),
  ]);
  return {
    record: toAdminRecord(row, config),
    revisions: ((revisions?.results ?? []) as Record<string, string | number | null>[]).map(
      (revision): AdminRevision => ({
        id: Number(revision.id),
        action: String(revision.action),
        actor: { id: String(revision.actor), label: actorLabel(String(revision.actor), revision.label as string | null) },
        reason: (revision.reason as string | null) ?? null,
        before: revision.before_json ? JSON.parse(String(revision.before_json)) : null,
        after: JSON.parse(String(revision.after_json)),
        source_url: (revision.source_url as string | null) ?? null,
        evidence: (revision.evidence as string | null) ?? null,
        created_at: String(revision.created_at),
      }),
    ),
    tasks: (tasks?.results ?? []) as AdminRecordDetail['tasks'],
    reports: (reports?.results ?? []) as Report[],
  };
}

/* ───────── overview and review queue ───────── */

export async function overview(db: D1Database, apps: readonly DataAppConfig[]): Promise<AppOverview[]> {
  const notify = await notifyStatus(db, apps);
  return Promise.all(
    apps.map(async (config, index) => {
      const [counts, tasks, review, waiting] = await db.batch([
        db.prepare('SELECT status, COUNT(*) AS n FROM records WHERE app_slug = ? GROUP BY status').bind(config.slug),
        db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE app_slug = ? AND status IN ('open', 'leased')").bind(config.slug),
        db
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM tasks WHERE app_slug = ?1 AND status = 'review')
             + (SELECT COUNT(*) FROM records WHERE app_slug = ?1 AND status = 'pending' AND flagged = 1)
             + (SELECT COUNT(*) FROM reports p JOIN records r ON r.id = p.record_id WHERE r.app_slug = ?1 AND p.status = 'open') AS n`,
          )
          .bind(config.slug),
        db
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM task_needs n JOIN tasks t ON t.id = n.task_id
                  WHERE n.need = 'browser' AND t.app_slug = ?1 AND t.status IN ('open', 'leased')) AS browser,
               (SELECT COUNT(*) FROM tasks WHERE app_slug = ?1 AND status = 'blocked') AS parked,
               (SELECT MIN(done_at) FROM tasks WHERE app_slug = ?1 AND status = 'review') AS oldest`,
          )
          .bind(config.slug),
      ]);
      const wait = (waiting?.results[0] ?? {}) as { browser?: number; parked?: number; oldest?: string | null };
      const byStatus = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<RecordStatus, number>;
      for (const row of (counts?.results ?? []) as { status: RecordStatus; n: number }[]) byStatus[row.status] = row.n;
      return {
        slug: config.slug,
        title: config.title,
        counts: byStatus,
        open_tasks: (tasks?.results[0] as { n: number } | undefined)?.n ?? 0,
        review: (review?.results[0] as { n: number } | undefined)?.n ?? 0,
        needs_browser: wait.browser ?? 0,
        parked: wait.parked ?? 0,
        oldest_review_at: wait.oldest ?? null,
        notify: notify[index]!,
      };
    }),
  );
}

/** What waits for the admin: unsure verdicts, records flagged at submit, open reader reports. */
export async function reviewQueue(db: D1Database, config: DataAppConfig): Promise<ReviewItem[]> {
  const [unsure, flagged, reports] = await db.batch([
    db
      .prepare(
        `${RECORD_SELECT.replace('SELECT r.*', `SELECT r.*, k.id AS task_id,
           (SELECT reason FROM revisions WHERE record_id = r.id AND action = 'unsure' ORDER BY id DESC LIMIT 1) AS note,
           (SELECT actor FROM revisions WHERE record_id = r.id AND action = 'unsure' ORDER BY id DESC LIMIT 1) AS note_by,
           (SELECT after_json FROM revisions WHERE record_id = r.id AND action = 'unsure' ORDER BY id DESC LIMIT 1) AS note_after,
           k.done_at AS at`)}
         JOIN tasks k ON k.record_id = r.id WHERE r.app_slug = ? AND k.status = 'review'`,
      )
      .bind(config.slug),
    db.prepare(`${RECORD_SELECT} WHERE r.app_slug = ? AND r.status = 'pending' AND r.flagged = 1`).bind(config.slug),
    db
      .prepare(
        `${RECORD_SELECT.replace('SELECT r.*', 'SELECT r.*, p.id AS report_id, p.reason AS note, p.created_at AS at')}
         JOIN reports p ON p.record_id = r.id WHERE r.app_slug = ? AND p.status = 'open'`,
      )
      .bind(config.slug),
  ]);
  type Row = RecordRow & { task_id?: string; report_id?: number; note?: string; note_by?: string; note_after?: string | null; at?: string };
  const items: ReviewItem[] = [
    ...((unsure?.results ?? []) as Row[]).map((row) => ({
      kind: 'unsure' as const,
      record: toAdminRecord(row, config),
      reason: row.note ?? '',
      unsure_type: row.note_after ? ((JSON.parse(row.note_after) as { unsure_type?: UnsureType }).unsure_type ?? null) : null,
      by: row.note_by ?? null,
      at: row.at ?? row.updated_at,
      task_id: row.task_id ?? null,
      report_id: null,
    })),
    ...((flagged?.results ?? []) as Row[]).map((row) => ({
      kind: 'flagged' as const,
      record: toAdminRecord(row, config),
      reason: 'Text that looks aimed at AI agents',
      unsure_type: null,
      by: row.submitted_by,
      at: row.created_at,
      task_id: null,
      report_id: null,
    })),
    ...((reports?.results ?? []) as Row[]).map((row) => ({
      kind: 'report' as const,
      record: toAdminRecord(row, config),
      reason: row.note ?? '',
      unsure_type: null,
      by: null,
      at: row.at ?? row.updated_at,
      task_id: null,
      report_id: row.report_id ?? null,
    })),
  ];
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

/* ───────── the admin's own changes ───────── */

const reasonOf = (value: unknown, required: boolean): string | null => {
  const reason = typeof value === 'string' ? cleanText(value) : '';
  if (reason.length > REASON_MAX) throw new HttpError(422, 'invalid_body', `reason must be at most ${REASON_MAX} characters.`);
  if (!reason && required) throw new HttpError(422, 'invalid_body', 'reason is required for this decision.');
  return reason || null;
};

const adminRevision = (
  db: D1Database,
  row: RecordRow,
  action: string,
  after: unknown,
  reason: string | null,
  at: string,
  provenance: Provenance | null = null,
) =>
  db
    .prepare(
      `INSERT INTO revisions (record_id, app_slug, actor, action, before_json, after_json, reason, source_url, evidence, created_at)
       VALUES (?, ?, 'admin', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(row.id, row.app_slug, action, JSON.stringify({ status: row.status, data: JSON.parse(row.data_json) }),
      JSON.stringify(after), reason, provenance?.source_url ?? null, provenance?.evidence ?? null, at);

/** Tasks waiting on a record stop waiting. */
const cancelTasks = (db: D1Database, recordId: string, at: string) =>
  db
    .prepare(`UPDATE tasks SET status = 'cancelled', done_at = ? WHERE record_id = ? AND status IN ('open', 'leased', 'review', 'blocked')`)
    .bind(at, recordId);

/** The admin's own passage for a decision, checked like a maintainer's, or null when none was sent. */
function provenanceOf(body: { source_url?: unknown; evidence?: unknown; observed_at?: unknown }, now: Date): Provenance | null {
  if (body.source_url === undefined && body.evidence === undefined) return null;
  const checked = validateProvenance({ source_url: body.source_url, evidence: body.evidence, observed_at: body.observed_at ?? now.toISOString() }, now);
  if (!checked.ok) throw new HttpError(422, 'invalid_body', checked.errors.map((error) => `${error.field} ${error.message}`).join('; '));
  return checked.value;
}

/** A precedent the admin wants written into the rules, checked for length. */
function precedentOf(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const rule = typeof value === 'string' ? cleanText(value) : '';
  if (rule.length < 10 || rule.length > 300) throw new HttpError(422, 'invalid_body', 'precedent must state the rule in 10 to 300 characters.');
  return rule;
}

/**
 * After the admin decides a record a maintainer had decided, or marks it wrong in a spot check, that
 * maintainer's quality is read again: one whose checked verdicts are mostly overturned is suspended.
 */
async function checkMaintainerOf(db: D1Database, recordId: string, now: Date): Promise<void> {
  const last = await db
    .prepare(
      `SELECT v.actor FROM revisions v INDEXED BY revisions_record JOIN tokens t ON t.id = v.actor
       WHERE v.record_id = ? AND t.role = 'maintainer' AND v.action IN ('verify', 'reject', 'merge', 'stale') ORDER BY v.id DESC LIMIT 1`,
    )
    .bind(recordId)
    .first<{ actor: string }>();
  if (last) await suspendMaintainerIfFailing(db, last.actor, now);
}

const newVerifyTask = (db: D1Database, row: RecordRow, now: Date) =>
  db
    .prepare(`INSERT INTO tasks (id, app_slug, record_id, kind, status, created_at) VALUES (?, ?, ?, 'verify', 'open', ?)`)
    .bind(newId('tsk', now.getTime()), row.app_slug, row.id, now.toISOString());

/**
 * The admin sets a record's status: verified, rejected, stale, merged (with duplicate_of),
 * or pending, which sends it back to the maintainers. Open reports on it are resolved, and
 * records parked as its duplicates follow it (src/worker/waits.ts).
 *
 * The admin may send a passage of its own (source_url, evidence), checked like a maintainer's
 * and kept with the revision; a record verified with one takes it as its source. A `precedent`
 * states the rule the decision follows, until the rule is written into the data app's config.
 */
export async function decide(
  db: D1Database,
  config: DataAppConfig,
  id: string,
  body: { status?: unknown; reason?: unknown; duplicate_of?: unknown; source_url?: unknown; evidence?: unknown; observed_at?: unknown; precedent?: unknown },
  now: Date,
): Promise<AdminRecordDetail> {
  const row = await recordRow(db, config, id);
  const at = now.toISOString();
  const status = body.status;
  const statements: D1PreparedStatement[] = [];
  const provenance = provenanceOf(body, now);
  const precedent = precedentOf(body.precedent);
  const waiting = (to: RecordStatus, options: { mergedInto?: string } = {}) =>
    row.status === 'pending' ? resolveWaiting(db, { id, app_slug: row.app_slug }, to, at, options) : Promise.resolve([]);

  if (status === 'verified') {
    statements.push(
      moveStanding(db, id, 'verified'),
      provenance
        ? db
            .prepare(
              `UPDATE records SET status = 'verified', flagged = 0, merged_into = NULL, source_url = ?, evidence = ?, observed_at = ?,
                 verified_at = ?, updated_at = ? WHERE id = ?`,
            )
            .bind(provenance.source_url, provenance.evidence, provenance.observed_at, at, at, id)
        : db.prepare(`UPDATE records SET status = 'verified', flagged = 0, merged_into = NULL, verified_at = ?, updated_at = ? WHERE id = ?`).bind(at, at, id),
      adminRevision(db, row, 'verify', { status: 'verified' }, reasonOf(body.reason, false), at, provenance),
      cancelTasks(db, id, at),
      ...(await waiting('verified')),
    );
    if (row.status !== 'verified') {
      statements.push(db.prepare('INSERT INTO outbox (app_slug, record_id, created_at) VALUES (?, ?, ?)').bind(row.app_slug, id, at));
    }
  } else if (status === 'rejected' || status === 'stale') {
    statements.push(
      moveStanding(db, id, status),
      db.prepare('UPDATE records SET status = ?, updated_at = ? WHERE id = ?').bind(status, at, id),
      adminRevision(db, row, status === 'rejected' ? 'reject' : 'stale', { status }, reasonOf(body.reason, true), at, provenance),
      cancelTasks(db, id, at),
      ...(await waiting(status)),
    );
  } else if (status === 'merged') {
    const target = typeof body.duplicate_of === 'string' ? body.duplicate_of : '';
    const original = await db
      .prepare(`SELECT id FROM records WHERE id = ? AND app_slug = ? AND status = 'verified' AND id != ?`)
      .bind(target, config.slug, id)
      .first<{ id: string }>();
    if (!original) throw new HttpError(422, 'invalid_body', 'duplicate_of must be the id of another verified record.');
    statements.push(
      moveStanding(db, id, 'merged'),
      db.prepare(`UPDATE records SET status = 'merged', merged_into = ?, updated_at = ? WHERE id = ?`).bind(original.id, at, id),
      adminRevision(db, row, 'merge', { status: 'merged', merged_into: original.id }, reasonOf(body.reason, false), at),
      cancelTasks(db, id, at),
      ...(await waiting('merged', { mergedInto: original.id })),
    );
  } else if (status === 'pending') {
    statements.push(
      moveStanding(db, id, 'pending'),
      db.prepare(`UPDATE records SET status = 'pending', flagged = 0, verified_at = NULL, updated_at = ? WHERE id = ?`).bind(at, id),
      adminRevision(db, row, 'reopen', { status: 'pending' }, reasonOf(body.reason, false), at),
      cancelTasks(db, id, at),
      newVerifyTask(db, row, now),
    );
  } else {
    throw new HttpError(422, 'invalid_body', 'status must be verified, rejected, stale, merged or pending.');
  }
  statements.push(db.prepare(`UPDATE reports SET status = 'resolved' WHERE record_id = ? AND status = 'open'`).bind(id));
  if (precedent) {
    statements.push(
      db
        .prepare('INSERT INTO precedents (app_slug, record_id, decision, rule, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(row.app_slug, id, String(status), precedent, at),
    );
  }
  try {
    await db.batch(statements);
  } catch (error) {
    if (!/UNIQUE/i.test(String(error))) throw error;
    throw new HttpError(409, 'conflict', 'Another live record already has this identity. Merge this one into it instead.');
  }
  await checkMaintainerOf(db, id, now);
  return recordDetail(db, config, id);
}

/** The admin corrects field values; status stays. `corrections` work like a maintainer's. */
export async function editRecord(
  db: D1Database,
  config: DataAppConfig,
  id: string,
  body: { corrections?: unknown; reason?: unknown },
  now: Date,
): Promise<AdminRecordDetail> {
  const row = await recordRow(db, config, id);
  if (typeof body.corrections !== 'object' || body.corrections === null || Array.isArray(body.corrections)) {
    throw new HttpError(422, 'invalid_body', 'corrections must be an object of the fields to change, with null to remove one.');
  }
  const merged: Record<string, unknown> = { ...(JSON.parse(row.data_json) as RecordData) };
  for (const [field, value] of Object.entries(body.corrections)) {
    if (value === null) delete merged[field];
    else merged[field] = value;
  }
  const checked = validateRecordData(config, merged);
  if (!checked.ok) {
    throw new HttpError(422, 'invalid_body', checked.errors.map((error) => `${error.field} ${error.message}`).join('; '));
  }
  const at = now.toISOString();
  try {
    await db.batch([
      db
        .prepare('UPDATE records SET data_json = ?, identity_key = ?, updated_at = ? WHERE id = ?')
        .bind(JSON.stringify(checked.value), identityKey(config, checked.value), at, id),
      adminRevision(db, row, 'admin_edit', { status: row.status, data: checked.value }, reasonOf(body.reason, false), at),
    ]);
  } catch (error) {
    if (!/UNIQUE/i.test(String(error))) throw error;
    throw new HttpError(409, 'conflict', 'Another live record already has this identity.');
  }
  return recordDetail(db, config, id);
}

/* ───────── reader reports ───────── */

/** A reader's report on a public record. */
export async function createReport(db: D1Database, config: DataAppConfig, recordId: string, body: { reason?: unknown }, now: Date): Promise<void> {
  const reason = typeof body.reason === 'string' ? cleanText(body.reason) : '';
  if (reason.length < 3 || reason.length > REASON_MAX) {
    throw new HttpError(422, 'invalid_body', `Say what is wrong, in 3 to ${REASON_MAX} characters.`);
  }
  const record = await db
    .prepare(`SELECT id FROM records WHERE id = ? AND app_slug = ? AND status IN ('verified', 'stale')`)
    .bind(recordId, config.slug)
    .first<{ id: string }>();
  if (!record) throw new HttpError(404, 'not_found', 'No public record has that id.');
  await db
    .prepare(`INSERT INTO reports (record_id, reason, status, created_at) VALUES (?, ?, 'open', ?)`)
    .bind(recordId, reason, now.toISOString())
    .run();
}

export async function resolveReport(db: D1Database, id: number): Promise<void> {
  const result = await db.prepare(`UPDATE reports SET status = 'resolved' WHERE id = ? AND status = 'open'`).bind(id).run();
  if (!result.meta.changes) throw new HttpError(404, 'not_found', 'No open report has that id.');
}

/* ───────── activity ───────── */

export async function activity(
  db: D1Database,
  apps: readonly DataAppConfig[],
  filter: { app?: string; actor?: string; limit?: number },
): Promise<ActivityItem[]> {
  const { results } = await db
    .prepare(
      `SELECT v.id, v.app_slug, v.record_id, v.action, v.actor, v.reason, v.created_at, r.data_json, t.label
       FROM revisions v JOIN records r ON r.id = v.record_id LEFT JOIN tokens t ON t.id = v.actor
       WHERE (? IS NULL OR v.app_slug = ?) AND (? IS NULL OR v.actor = ?)
       ORDER BY v.id DESC LIMIT ?`,
    )
    .bind(filter.app ?? null, filter.app ?? null, filter.actor ?? null, filter.actor ?? null, Math.min(200, filter.limit ?? 100))
    .all<{ id: number; app_slug: string; record_id: string; action: string; actor: string; reason: string | null; created_at: string; data_json: string; label: string | null }>();
  return results.map((row) => ({
    id: row.id,
    app_slug: row.app_slug,
    record_id: row.record_id,
    record_name: titleOf(apps.find((app) => app.slug === row.app_slug), JSON.parse(row.data_json) as RecordData),
    action: row.action,
    actor: { id: row.actor, label: actorLabel(row.actor, row.label) },
    reason: row.reason,
    created_at: row.created_at,
  }));
}

/* ───────── undoing a token's work ───────── */

/**
 * Undoes everything a token changed since `since`, newest state first: each record it
 * touched goes back to how it was before the token's first change in that window. A
 * record the token created is rejected. A record someone else has changed since is left
 * alone and listed in `skipped`, for the admin to settle by hand. Unsure verdicts and tasks
 * handed on changed no record and are passed over; records the server merged into a record
 * this undoes (parked duplicates, src/worker/waits.ts) go back to waiting for review.
 */
export async function revertToken(
  db: D1Database,
  apps: readonly DataAppConfig[],
  tokenId: string,
  since: unknown,
  now: Date,
): Promise<RevertReport> {
  const from = typeof since === 'string' ? Date.parse(since) : Number.NaN;
  if (!Number.isFinite(from)) throw new HttpError(422, 'invalid_body', 'since must be a date or time in ISO 8601.');
  const token = await db.prepare('SELECT label FROM tokens WHERE id = ?').bind(tokenId).first<{ label: string }>();
  if (!token) throw new HttpError(404, 'not_found', 'No token has that id.');
  const sinceIso = new Date(from).toISOString();
  const at = now.toISOString();

  const { results: touched } = await db
    .prepare(`SELECT DISTINCT record_id FROM revisions WHERE actor = ? AND created_at >= ? AND action NOT IN ('revert', 'unsure', 'defer')`)
    .bind(tokenId, sinceIso)
    .all<{ record_id: string }>();

  const report: RevertReport = { reverted: 0, skipped: [] };
  const noLongerLive = new Set<string>();
  for (const { record_id } of touched) {
    const { results: history } = await db
      .prepare('SELECT id, actor, action, before_json, created_at FROM revisions WHERE record_id = ? ORDER BY id')
      .bind(record_id)
      .all<{ id: number; actor: string; action: string; before_json: string | null; created_at: string }>();
    const changes = history.filter((revision) => revision.action !== 'unsure' && revision.action !== 'defer');
    const last = changes.at(-1);
    if (!last || last.actor !== tokenId) {
      report.skipped.push({ record_id, reason: 'changed by someone else since; settle it by hand' });
      continue;
    }
    const first = changes.find((revision) => revision.actor === tokenId && revision.created_at >= sinceIso && revision.action !== 'revert')!;
    const row = await db.prepare(`${RECORD_SELECT} WHERE r.id = ?`).bind(record_id).first<RecordRow>();
    if (!row) continue;
    const config = apps.find((app) => app.slug === row.app_slug);

    // Created by this token: there is no earlier state, so the record is withdrawn.
    const target = first.before_json
      ? (JSON.parse(first.before_json) as { status: RecordStatus; data: RecordData; merged_into?: string })
      : { status: 'rejected' as RecordStatus, data: JSON.parse(row.data_json) as RecordData };
    const statements: D1PreparedStatement[] = [
      moveStanding(db, record_id, target.status),
      db
        .prepare(
          `UPDATE records SET status = ?, data_json = ?, identity_key = ?, merged_into = ?,
             verified_at = CASE WHEN ? = 'verified' THEN verified_at ELSE NULL END, updated_at = ?
           WHERE id = ?`,
        )
        .bind(target.status, JSON.stringify(target.data), config ? identityKey(config, target.data) : row.identity_key,
          target.merged_into ?? null, target.status, at, record_id),
      adminRevision(db, row, 'revert', { status: target.status, data: target.data }, `Undid changes by ${token.label} since ${sinceIso}`, at),
      cancelTasks(db, record_id, at),
    ];
    if (target.status === 'pending') statements.push(newVerifyTask(db, row, now));
    if (target.status !== 'verified') {
      statements.push(db.prepare('DELETE FROM outbox WHERE record_id = ? AND sent_at IS NULL').bind(record_id));
    }
    try {
      await db.batch(statements);
      report.reverted += 1;
      if (target.status !== 'verified' && target.status !== 'stale') noLongerLive.add(record_id);
    } catch (error) {
      if (!/UNIQUE/i.test(String(error))) throw error;
      report.skipped.push({ record_id, reason: 'its earlier version would duplicate another live record' });
    }
  }
  if (noLongerLive.size > 0) await unmergeFollowers(db, noLongerLive, sinceIso, token.label, now, report);
  return report;
}

/**
 * Records the server merged into one of `records` since `since`, because a maintainer had found
 * them its duplicates and it was then verified, go back to waiting for review once that verdict
 * is undone. Reads the server's own merges of that window, which are few.
 */
async function unmergeFollowers(db: D1Database, records: Set<string>, since: string, label: string, now: Date, report: RevertReport): Promise<void> {
  const at = now.toISOString();
  const { results } = await db
    .prepare(`SELECT id, record_id, after_json FROM revisions INDEXED BY revisions_actor_time WHERE actor = ? AND created_at >= ? AND action = 'merge'`)
    .bind(SYSTEM, since)
    .all<{ id: number; record_id: string; after_json: string }>();
  for (const merge of results) {
    const cause = (JSON.parse(merge.after_json) as { caused_by?: string }).caused_by;
    if (!cause || !records.has(cause)) continue;
    const later = await db
      .prepare('SELECT 1 AS yes FROM revisions INDEXED BY revisions_record WHERE record_id = ? AND id > ? LIMIT 1')
      .bind(merge.record_id, merge.id)
      .first<{ yes: number }>();
    const row = await db.prepare(`${RECORD_SELECT} WHERE r.id = ?`).bind(merge.record_id).first<RecordRow>();
    if (!row || row.status !== 'merged' || later) {
      report.skipped.push({ record_id: merge.record_id, reason: 'merged by the server after an undone verdict, and changed since; settle it by hand' });
      continue;
    }
    try {
      await db.batch([
        moveStanding(db, row.id, 'pending'),
        db.prepare(`UPDATE records SET status = 'pending', merged_into = NULL, updated_at = ? WHERE id = ? AND status = 'merged'`).bind(at, row.id),
        adminRevision(db, row, 'revert', { status: 'pending' }, `Undid the merge that followed ${cause}, whose verdict by ${label} was undone`, at),
        newVerifyTask(db, row, now),
      ]);
      report.reverted += 1;
    } catch (error) {
      if (!/UNIQUE/i.test(String(error))) throw error;
      report.skipped.push({ record_id: row.id, reason: 'its earlier version would duplicate another live record' });
    }
  }
}

/** Revokes a collector and rejects every record it has waiting for review. */
export async function banCollector(db: D1Database, tokenId: string, now: Date): Promise<{ rejected: number }> {
  const token = await db.prepare('SELECT label, role FROM tokens WHERE id = ?').bind(tokenId).first<{ label: string; role: string }>();
  if (!token) throw new HttpError(404, 'not_found', 'No token has that id.');
  if (token.role !== 'collector') throw new HttpError(422, 'invalid_body', 'Only collectors are banned; revoke a maintainer instead.');
  const at = now.toISOString();
  const { results: pending } = await db
    .prepare(`${RECORD_SELECT} WHERE r.submitted_by = ? AND r.status = 'pending'`)
    .bind(tokenId)
    .all<RecordRow>();
  const followers = await Promise.all(pending.map((row) => resolveWaiting(db, { id: row.id, app_slug: row.app_slug }, 'rejected', at)));
  await db.batch([
    db.prepare(`UPDATE tokens SET status = 'revoked' WHERE id = ?`).bind(tokenId),
    ...pending.flatMap((row, index) => [
      moveStanding(db, row.id, 'rejected'),
      db.prepare(`UPDATE records SET status = 'rejected', updated_at = ? WHERE id = ?`).bind(at, row.id),
      adminRevision(db, row, 'reject', { status: 'rejected' }, `Banned ${token.label}`, at),
      cancelTasks(db, row.id, at),
      ...followers[index]!,
    ]),
  ]);
  return { rejected: pending.length };
}

/** Queues a recheck of every verified record a token submitted. */
export async function recheckToken(db: D1Database, tokenId: string, now: Date): Promise<{ queued: number }> {
  const result = await db
    .prepare(
      `INSERT INTO tasks (id, app_slug, record_id, kind, status, created_at)
       SELECT 'tsk_' || lower(hex(randomblob(13))), r.app_slug, r.id, 'recheck', 'open', ?
       FROM records r WHERE r.submitted_by = ? AND r.status = 'verified'
         AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.record_id = r.id AND t.status IN ('open', 'leased', 'review'))`,
    )
    .bind(now.toISOString(), tokenId)
    .run();
  return { queued: Number(result.meta.changes ?? 0) };
}

/* ───────── spot-check ───────── */

/** ISO 8601 week, such as 2026-W40: weeks start on Monday, and week 1 holds January 4. */
export function isoWeek(now: Date): string {
  const thursdayOf = (date: Date) => {
    const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7) + 3);
    return day;
  };
  const thursday = thursdayOf(now);
  const year = thursday.getUTCFullYear();
  const week = 1 + Math.round((thursday.getTime() - thursdayOf(new Date(Date.UTC(year, 0, 4))).getTime()) / 604_800_000);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * This week's sample: 50 verified records chosen by hashing each id with the week, so
 * the sample is random but the same for the whole week, plus the marks given so far.
 */
export async function spotCheck(db: D1Database, config: DataAppConfig, now: Date): Promise<SpotCheck> {
  const week = isoWeek(now);
  const { results } = await db
    .prepare(`${RECORD_SELECT} WHERE r.app_slug = ? AND r.status = 'verified'`)
    .bind(config.slug)
    .all<RecordRow>();
  const ranked = await Promise.all(results.map(async (row) => ({ row, rank: await sha256Hex(`${week}:${row.id}`) })));
  const sample = ranked.sort((a, b) => a.rank.localeCompare(b.rank)).slice(0, SPOT_CHECK_SIZE).map((entry) => entry.row);
  const { results: marks } = await db
    .prepare('SELECT record_id, correct, note, checked_at FROM spot_checks WHERE week = ? AND app_slug = ?')
    .bind(week, config.slug)
    .all<{ record_id: string; correct: number; note: string | null; checked_at: string }>();
  const items = sample.map((row) => {
    const mark = marks.find((entry) => entry.record_id === row.id);
    return {
      record: toAdminRecord(row, config),
      mark: mark ? { correct: mark.correct === 1, note: mark.note, checked_at: mark.checked_at } : null,
    };
  });
  const marked = items.filter((item) => item.mark);
  return { week, items, marked: marked.length, correct: marked.filter((item) => item.mark!.correct).length };
}

export async function markSpotCheck(
  db: D1Database,
  config: DataAppConfig,
  recordId: string,
  body: { correct?: unknown; note?: unknown },
  now: Date,
): Promise<SpotCheck> {
  if (typeof body.correct !== 'boolean') throw new HttpError(422, 'invalid_body', 'correct must be true or false.');
  const check = await spotCheck(db, config, now);
  if (!check.items.some((item) => item.record.id === recordId)) {
    throw new HttpError(422, 'invalid_body', "That record is not in this week's sample.");
  }
  const note = typeof body.note === 'string' ? cleanText(body.note).slice(0, REASON_MAX) : '';
  await db
    .prepare(
      `INSERT INTO spot_checks (week, app_slug, record_id, correct, note, checked_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (week, record_id) DO UPDATE SET correct = excluded.correct, note = excluded.note, checked_at = excluded.checked_at`,
    )
    .bind(check.week, config.slug, recordId, body.correct ? 1 : 0, note || null, now.toISOString())
    .run();
  if (!body.correct) await checkMaintainerOf(db, recordId, now);
  return spotCheck(db, config, now);
}

/* ───────── precedents ───────── */

/** The admin's decisions that state a rule, newest first: the ones not yet in the rules, or all. */
export async function listPrecedents(db: D1Database, all: boolean): Promise<Precedent[]> {
  const { results } = await db
    .prepare(
      `SELECT id, app_slug, record_id, decision, rule, created_at, adopted_at FROM precedents
       WHERE (? = 1 OR adopted_at IS NULL) ORDER BY id DESC LIMIT 200`,
    )
    .bind(all ? 1 : 0)
    .all<Precedent>();
  return results;
}

/** A precedent now written into its data app's config (scope, field help), so agents read it. */
export async function adoptPrecedent(db: D1Database, id: number, now: Date): Promise<Precedent[]> {
  const result = await db.prepare('UPDATE precedents SET adopted_at = ? WHERE id = ? AND adopted_at IS NULL').bind(now.toISOString(), id).run();
  if (!Number(result.meta.changes ?? 0)) throw new HttpError(404, 'not_found', 'No open precedent has that id.');
  return listPrecedents(db, false);
}

