/**
 * Maintainers' work: leasing tasks and applying verdicts.
 *
 * A lease reserves a task for one token for 30 minutes; a verdict only counts for a task
 * leased to the token sending it, while the lease lasts, and never for a record the same
 * token submitted. Only this module changes a record's status, and every change writes a
 * revision with the record before and after — the trail revert-by-token replays.
 *
 *   task     verdicts allowed               record
 *   verify   verified rejected duplicate    pending  -> verified | rejected | merged
 *   recheck  verified stale                 verified -> verified (again) | stale
 *   either   unsure                         unchanged; the task waits for the admin
 *
 * A page the maintainer could not read is unsure, never grounds to reject or mark stale:
 * such verdicts are refused with an error that says so.
 *
 * Collectors whose records fail review often are suspended: 10 or more reviewed records
 * with more than half rejected.
 */

import {
  cleanText,
  identityKey,
  validateProvenance,
  validateRecordData,
  type DataAppConfig,
  type FieldError,
  type RecordData,
} from '../shared/data-app';
import type { LeaseResponse, LeasedTask, TaskKind, Verdict, VerdictResult, VerdictsResponse, Work } from '../shared/types';
import { MINUTE } from './ratelimit';
import { DAILY_TASK_LIMIT, VERDICT_ACTIONS, type Token } from './tokens';
import { HttpError } from './types';

export const LEASE_MS = 30 * MINUTE;
export const LEASE_MAX = 10;
export const VERDICTS_MAX = 20;
const REASON_MAX = 300;

/** Collectors are suspended once this many records are reviewed and over half were rejected. */
export const SUSPEND_AFTER = 10;

const VERDICTS: Record<TaskKind, readonly Verdict[]> = {
  verify: ['verified', 'rejected', 'duplicate', 'unsure'],
  recheck: ['verified', 'stale', 'unsure'],
};

const dayStart = (now: Date) => `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;

/** What a maintainer token holds and has done today on one data app. */
export async function workOf(db: D1Database, config: DataAppConfig, token: Token, now: Date): Promise<Work> {
  const [done, leased] = await db.batch<{ n: number }>([
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM revisions WHERE actor = ? AND app_slug = ? AND created_at >= ?
         AND action IN (${VERDICT_ACTIONS.map(() => '?').join(', ')})`,
      )
      .bind(token.id, config.slug, dayStart(now), ...VERDICT_ACTIONS),
    db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE leased_to = ? AND app_slug = ? AND status = 'leased' AND lease_expires_at > ?`)
      .bind(token.id, config.slug, now.toISOString()),
  ]);
  return {
    leased: leased?.results[0]?.n ?? 0,
    done_today: done?.results[0]?.n ?? 0,
    daily_task_limit: token.dailyTaskLimit ?? DAILY_TASK_LIMIT,
  };
}

interface HeldRow {
  task_id: string;
  kind: TaskKind;
  lease_expires_at: string;
  id: string;
  status: 'pending' | 'verified';
  data_json: string;
  source_url: string;
  evidence: string;
  observed_at: string;
  created_at: string;
  verified_at: string | null;
}

/**
 * Leases open tasks — and tasks whose lease ran out — until the token holds `limit`,
 * within its daily limit, oldest first, skipping records it submitted itself. Returns
 * every task the token holds now, so an agent that lost its place picks up where it was.
 */
export async function leaseTasks(
  db: D1Database,
  config: DataAppConfig,
  token: Token,
  limit: number,
  now: Date,
): Promise<LeaseResponse> {
  const at = now.toISOString();
  const work = await workOf(db, config, token, now);
  const room = Math.max(0, Math.min(limit - work.leased, work.daily_task_limit - work.done_today - work.leased));
  if (room > 0) {
    // One statement, so two maintainers leasing at once can never get the same task.
    await db
      .prepare(
        `UPDATE tasks SET status = 'leased', leased_to = ?, lease_expires_at = ?
         WHERE id IN (
           SELECT t.id FROM tasks t JOIN records r ON r.id = t.record_id
           WHERE t.app_slug = ? AND r.submitted_by != ? AND r.flagged = 0
             AND (t.status = 'open' OR (t.status = 'leased' AND t.lease_expires_at <= ?))
           ORDER BY t.created_at, t.id
           LIMIT ?)`,
      )
      .bind(token.id, new Date(now.getTime() + LEASE_MS).toISOString(), config.slug, token.id, at, room)
      .run();
  }
  const { results } = await db
    .prepare(
      `SELECT t.id AS task_id, t.kind, t.lease_expires_at, r.id, r.status, r.data_json, r.source_url, r.evidence,
         r.observed_at, r.created_at, r.verified_at
       FROM tasks t JOIN records r ON r.id = t.record_id
       WHERE t.leased_to = ? AND t.app_slug = ? AND t.status = 'leased' AND t.lease_expires_at > ?
       ORDER BY t.created_at, t.id`,
    )
    .bind(token.id, config.slug, at)
    .all<HeldRow>();
  const tasks: LeasedTask[] = results.map((row) => ({
    id: row.task_id,
    kind: row.kind,
    lease_expires_at: row.lease_expires_at,
    record: {
      id: row.id,
      status: row.status,
      data: JSON.parse(row.data_json) as RecordData,
      source_url: row.source_url,
      evidence: row.evidence,
      observed_at: row.observed_at,
      submitted_at: row.created_at,
      verified_at: row.verified_at,
    },
  }));
  return { ...work, leased: tasks.length, tasks };
}

interface TaskRow {
  task_id: string;
  kind: TaskKind;
  task_status: string;
  leased_to: string | null;
  lease_expires_at: string | null;
  id: string;
  status: string;
  identity_key: string;
  data_json: string;
  submitted_by: string;
}

/** The record's data with corrections applied: a value replaces, null removes. */
function corrected(data: RecordData, corrections: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...data };
  for (const [field, value] of Object.entries(corrections)) {
    if (value === null) delete merged[field];
    else merged[field] = value;
  }
  return merged;
}

const reasonOf = (value: unknown): string => (typeof value === 'string' ? cleanText(value) : '');

/**
 * Reasons that say the maintainer could not read the page, rather than that the page
 * contradicts the record: a timeout, a refused or blocked request, a login or paywall.
 * A page that will not load for one agent says nothing about the facts, so such a task is
 * unsure, for a person to check. On 2026-10-01 ten real rounds were rejected because
 * GlobeNewswire refused a maintainer's requests. A page that is gone (404, 410) is another
 * matter: that can make a record stale.
 */
const COULD_NOT_READ: readonly RegExp[] = [
  /\bunreachable\b/i,
  /\b(?:could ?n[o']t|cannot|can ?not|unable to|failed to|fails to)\s+(?:be\s+)?(?:load|reach|fetch|access|open|retrieve|connect)/i,
  /\b(?:did ?n[o']t|does ?n[o']t|will not|won't|would ?n[o']t)\s+load\b/i,
  /\btim(?:ed|es|ing)?[ -]?out\b|\btimeouts?\b/i,
  /\b(?:HTTP|status|code|error)\s*(?:status\s*)?(?:code\s*)?:?\s*(?:0|403|429|5\d\d)\b/i,
  /\breturned\s+(?:an?\s+)?(?:HTTP\s+)?(?:403|429|5\d\d)\b/i,
  /\b(?:forbidden|access denied|captcha|rate[ -]limit(?:ed)?|too many requests|bot (?:check|protection|challenge|detection))\b/i,
  /\b(?:connection (?:refused|reset|error|failed)|network error|fetch failed|ssl error|certificate error)\b/i,
  /\bblock(?:s|ed|ing)?\b[^.]{0,40}\b(?:requests?|crawlers?|bots?|automated|fetch)\b/i,
  /\b(?:requires?|needs?)\s+(?:a\s+)?(?:log ?in|sign[ -]?in)\b|\b(?:login|sign[ -]?in)\s+(?:wall|required)\b|\bpaywall/i,
];

export const couldNotRead = (reason: string): boolean => COULD_NOT_READ.some((pattern) => pattern.test(reason));

/**
 * Checks one verdict and, when it holds, the statements that apply it. Errors name the
 * field and what to change, like submit errors do.
 */
async function prepareVerdict(
  db: D1Database,
  config: DataAppConfig,
  token: Token,
  item: Record<string, unknown>,
  now: Date,
): Promise<{ task: TaskRow; verdict: Verdict; statements: D1PreparedStatement[]; recordStatus: string } | { errors: FieldError[] }> {
  const at = now.toISOString();
  const taskId = typeof item.task_id === 'string' ? item.task_id : '';
  const task = await db
    .prepare(
      `SELECT t.id AS task_id, t.kind, t.status AS task_status, t.leased_to, t.lease_expires_at,
         r.id, r.status, r.identity_key, r.data_json, r.submitted_by
       FROM tasks t JOIN records r ON r.id = t.record_id WHERE t.id = ? AND t.app_slug = ?`,
    )
    .bind(taskId, config.slug)
    .first<TaskRow>();
  if (!task) return { errors: [{ field: 'task_id', message: `no task ${JSON.stringify(taskId)} in ${config.slug}` }] };
  if (task.task_status !== 'leased' || task.leased_to !== token.id) {
    return { errors: [{ field: 'task_id', message: 'this task is not leased to you; lease tasks with GET /tasks first' }] };
  }
  if (!task.lease_expires_at || task.lease_expires_at <= at) {
    return { errors: [{ field: 'task_id', message: `your lease ran out at ${task.lease_expires_at}; lease the task again` }] };
  }
  if (task.submitted_by === token.id) {
    return { errors: [{ field: 'task_id', message: 'you cannot give a verdict on a record you submitted' }] };
  }

  const allowed = VERDICTS[task.kind];
  const verdict = item.verdict as Verdict;
  if (!allowed.includes(verdict)) {
    return {
      errors: [{ field: 'verdict', message: `must be one of ${allowed.join(', ')} for a ${task.kind} task; got ${JSON.stringify(item.verdict)}` }],
    };
  }

  const data = JSON.parse(task.data_json) as RecordData;
  const before = JSON.stringify({ status: task.status, data });
  const revision = (action: string, after: unknown, extra: { reason?: string; source_url?: string; evidence?: string } = {}) =>
    db
      .prepare(
        `INSERT INTO revisions (record_id, app_slug, actor, action, before_json, after_json, reason, source_url, evidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(task.id, config.slug, token.id, action, before, JSON.stringify(after), extra.reason ?? null,
        extra.source_url ?? null, extra.evidence ?? null, at);
  const closeTask = (status: 'done' | 'review') =>
    db.prepare('UPDATE tasks SET status = ?, done_at = ? WHERE id = ?').bind(status, at, task.task_id);

  if (verdict === 'verified') {
    const errors: FieldError[] = [];
    const provenance = validateProvenance(
      { source_url: item.source_url, evidence: item.evidence, observed_at: item.observed_at ?? at },
      now,
    );
    if (!provenance.ok) errors.push(...provenance.errors);
    let next: RecordData = data;
    if (item.corrections !== undefined) {
      if (typeof item.corrections !== 'object' || item.corrections === null || Array.isArray(item.corrections)) {
        errors.push({ field: 'corrections', message: 'must be an object of the fields to change, with null to remove one' });
      } else {
        const checked = validateRecordData(config, corrected(data, item.corrections as Record<string, unknown>));
        if (checked.ok) next = checked.value;
        else errors.push(...checked.errors.map((error) => ({ field: `corrections.${error.field}`, message: error.message })));
      }
    }
    if (errors.length > 0 || !provenance.ok) return { errors };

    const key = identityKey(config, next);
    if (key !== task.identity_key) {
      const twin = await db
        .prepare(`SELECT id FROM records WHERE app_slug = ? AND identity_key = ? AND status IN ('pending', 'verified') AND id != ?`)
        .bind(config.slug, key, task.id)
        .first<{ id: string }>();
      if (twin) {
        return {
          errors: [{ field: 'corrections', message: `the corrected record matches ${twin.id}; send verdict duplicate with duplicate_of ${twin.id}` }],
        };
      }
    }
    const { source_url, evidence, observed_at } = provenance.value;
    const statements = [
      db
        .prepare(
          `UPDATE records SET status = 'verified', data_json = ?, identity_key = ?, source_url = ?, evidence = ?,
             observed_at = ?, verified_at = ?, updated_at = ?
           WHERE id = ? AND status = ?`,
        )
        .bind(JSON.stringify(next), key, source_url, evidence, observed_at, at, at, task.id, task.status),
      revision('verify', { status: 'verified', data: next }, { source_url, evidence }),
      closeTask('done'),
    ];
    // Newly public records are announced; a passed recheck is not news.
    if (task.kind === 'verify') {
      statements.push(db.prepare('INSERT INTO outbox (app_slug, record_id, created_at) VALUES (?, ?, ?)').bind(config.slug, task.id, at));
    }
    return { task, verdict, statements, recordStatus: 'verified' };
  }

  if (verdict === 'duplicate') {
    const original = typeof item.duplicate_of === 'string' ? item.duplicate_of : '';
    const target = await db
      .prepare(`SELECT id FROM records WHERE id = ? AND app_slug = ? AND status = 'verified' AND id != ?`)
      .bind(original, config.slug, task.id)
      .first<{ id: string }>();
    if (!target) {
      return { errors: [{ field: 'duplicate_of', message: `must be the id of another verified record in ${config.slug}` }] };
    }
    return {
      task,
      verdict,
      recordStatus: 'merged',
      statements: [
        db
          .prepare(`UPDATE records SET status = 'merged', merged_into = ?, updated_at = ? WHERE id = ? AND status = 'pending'`)
          .bind(target.id, at, task.id),
        revision('merge', { status: 'merged', merged_into: target.id }),
        closeTask('done'),
      ],
    };
  }

  // rejected, stale and unsure carry a reason and nothing else.
  const reason = reasonOf(item.reason);
  if (!reason || reason.length > REASON_MAX) {
    return { errors: [{ field: 'reason', message: `must say why, in 1 to ${REASON_MAX} characters` }] };
  }
  if (verdict === 'unsure') {
    return {
      task,
      verdict,
      recordStatus: task.status,
      statements: [revision('unsure', { status: task.status }, { reason }), closeTask('review')],
    };
  }
  if (couldNotRead(reason)) {
    return {
      errors: [
        {
          field: 'verdict',
          message:
            'the reason says you could not read the page, which says nothing about the record; send verdict unsure with this reason, and a person will check the page',
        },
      ],
    };
  }
  const status = verdict === 'rejected' ? 'rejected' : 'stale';
  return {
    task,
    verdict,
    recordStatus: status,
    statements: [
      db
        .prepare('UPDATE records SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
        .bind(status, at, task.id, task.status),
      revision(verdict === 'rejected' ? 'reject' : 'stale', { status }, { reason }),
      closeTask('done'),
    ],
  };
}

/** Suspends active collectors among `tokenIds` whose reviewed records are mostly rejected. */
export async function suspendIfFailing(db: D1Database, tokenIds: Iterable<string>): Promise<void> {
  for (const id of tokenIds) {
    const row = await db
      .prepare(
        `SELECT SUM(status IN ('verified', 'stale')) AS good, SUM(status = 'rejected') AS bad
         FROM records WHERE submitted_by = ?`,
      )
      .bind(id)
      .first<{ good: number | null; bad: number | null }>();
    const good = row?.good ?? 0;
    const bad = row?.bad ?? 0;
    if (good + bad >= SUSPEND_AFTER && bad / (good + bad) > 0.5) {
      await db.prepare(`UPDATE tokens SET status = 'suspended' WHERE id = ? AND role = 'collector' AND status = 'active'`).bind(id).run();
    }
  }
}

export async function applyVerdicts(
  db: D1Database,
  config: DataAppConfig,
  token: Token,
  body: unknown,
  now: Date,
): Promise<VerdictsResponse> {
  const items = (body as { verdicts?: unknown } | null)?.verdicts;
  if (!Array.isArray(items) || items.length === 0 || items.length > VERDICTS_MAX) {
    throw new HttpError(422, 'invalid_body', `Send JSON like {"verdicts": [...]} with 1 to ${VERDICTS_MAX} verdicts.`);
  }
  const results: VerdictResult[] = [];
  const reviewed = new Set<string>();

  // One at a time: a later verdict may depend on an earlier one, e.g. duplicate_of a
  // record verified earlier in the same batch.
  for (const [index, raw] of items.entries()) {
    const item = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const taskId = typeof item.task_id === 'string' ? item.task_id : null;
    const prepared = await prepareVerdict(db, config, token, item, now);
    if ('errors' in prepared) {
      results.push({ index, task_id: taskId, status: 'error', errors: prepared.errors });
      continue;
    }
    try {
      await db.batch(prepared.statements);
    } catch (error) {
      if (!/UNIQUE/i.test(String(error))) throw error;
      results.push({
        index,
        task_id: taskId,
        status: 'error',
        errors: [{ field: 'corrections', message: 'another live record already has this identity; send verdict duplicate instead' }],
      });
      continue;
    }
    if (prepared.verdict === 'verified' || prepared.verdict === 'rejected') reviewed.add(prepared.task.submitted_by);
    results.push({ index, task_id: prepared.task.task_id, status: 'applied', record_status: prepared.recordStatus });
  }

  await suspendIfFailing(db, reviewed);
  return { ...(await workOf(db, config, token, now)), results };
}
