/**
 * Agent tokens. A secret is `mfd_` plus 32 random characters and is shown once; the
 * database keeps only its SHA-256. The role decides what a token may do. `/join` can only
 * ever create collector tokens — maintainer tokens are issued by the admin.
 */

import { cleanText } from '../shared/data-app';
import type { AdminToken, RecordStatus, Standing } from '../shared/types';
import { newId, newSecret, SECRET, sha256Hex } from './ids';
import { HttpError } from './types';

export type Role = 'collector' | 'maintainer';
export type TokenStatus = 'active' | 'suspended' | 'revoked';

export interface Token {
  id: string;
  role: Role;
  label: string;
  apps: string[];
  status: TokenStatus;
  pendingCap: number | null;
  dailyTaskLimit: number | null;
  expiresAt: string | null;
  createdAt: string;
}

interface TokenRow {
  id: string;
  role: string;
  label: string;
  apps_json: string;
  status: string;
  pending_cap: number | null;
  daily_task_limit: number | null;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

/** last_used_at is written at most this often per token: the console needs minutes, not calls. */
const LAST_USED_EVERY_MS = 10 * 60 * 1000;

/** A new collector may have this many records waiting for review... */
export const PENDING_CAP_START = 5;
/** ...and one more per verified record, up to this. */
export const PENDING_CAP_MAX = 50;

const AGENT_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}$/u;

const toToken = (row: TokenRow): Token => ({
  id: row.id,
  role: row.role as Role,
  label: row.label,
  apps: JSON.parse(row.apps_json) as string[],
  status: row.status as TokenStatus,
  pendingCap: row.pending_cap,
  dailyTaskLimit: row.daily_task_limit,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
});

/** A collector token for one data app. Returns the secret, which is never stored. */
export async function createCollectorToken(
  db: D1Database,
  slug: string,
  agentName: unknown,
  now: Date,
): Promise<{ token: Token; secret: string }> {
  const label = typeof agentName === 'string' ? cleanText(agentName) : '';
  if (!AGENT_NAME.test(label)) {
    throw new HttpError(
      422,
      'invalid_agent_name',
      'agent_name must be 1 to 60 characters — letters, digits, spaces, dots, hyphens or underscores — starting with a letter or digit.',
    );
  }
  const secret = newSecret();
  const token: Token = {
    id: newId('tok', now.getTime()),
    role: 'collector',
    label,
    apps: [slug],
    status: 'active',
    pendingCap: PENDING_CAP_START,
    dailyTaskLimit: null,
    expiresAt: null,
    createdAt: now.toISOString(),
  };
  await db
    .prepare(
      `INSERT INTO tokens (id, secret_hash, role, label, apps_json, status, pending_cap, created_at)
       VALUES (?, ?, 'collector', ?, ?, 'active', ?, ?)`,
    )
    .bind(token.id, await sha256Hex(secret), label, JSON.stringify(token.apps), PENDING_CAP_START, token.createdAt)
    .run();
  return { token, secret };
}

/** The token behind an Authorization header, or an error an agent can act on. */
export async function authenticate(db: D1Database, header: string | undefined, now: Date): Promise<Token> {
  const secret = /^Bearer\s+(\S+)$/i.exec((header ?? '').trim())?.[1];
  if (!secret) {
    throw new HttpError(
      401,
      'token_required',
      'Send your token in the header "Authorization: Bearer mfd_...". Get one from POST /api/<data app>/join.',
    );
  }
  if (!SECRET.test(secret)) {
    throw new HttpError(401, 'token_invalid', 'That is not a Manyfold Data token: tokens are mfd_ followed by 32 letters and digits.');
  }
  const row = await db
    .prepare('SELECT * FROM tokens WHERE secret_hash = ?')
    .bind(await sha256Hex(secret))
    .first<TokenRow>();
  if (!row) {
    throw new HttpError(401, 'token_invalid', 'This token is not recognized. Check MANYFOLD_DATA_TOKEN in your .env file.');
  }
  const token = toToken(row);
  if (token.status === 'revoked') {
    throw new HttpError(403, 'token_revoked', 'This token was revoked. Stop using it.');
  }
  if (token.status === 'suspended') {
    throw new HttpError(
      403,
      'token_suspended',
      'This token is suspended because too many of its records were rejected. Your owner can ask the Manyfold team to review it.',
    );
  }
  if (token.expiresAt && token.expiresAt <= now.toISOString()) {
    throw new HttpError(403, 'token_expired', `This token expired on ${token.expiresAt}. Your owner can ask for a new one.`);
  }
  const last = row.last_used_at ? Date.parse(row.last_used_at) : 0;
  if (now.getTime() - last >= LAST_USED_EVERY_MS) {
    await db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').bind(now.toISOString(), token.id).run();
  }
  return token;
}

/** Refuses a token that was not issued for this data app. */
export function requireApp(token: Token, slug: string): void {
  if (!token.apps.includes('*') && !token.apps.includes(slug)) {
    throw new HttpError(
      403,
      'wrong_app',
      `This token works on ${token.apps.join(', ')}, not ${slug}. Join ${slug} to get a token for it.`,
    );
  }
}

/** Refuses a token whose role cannot do this. */
export function requireRole(token: Token, roles: readonly Role[]): void {
  if (!roles.includes(token.role)) {
    throw new HttpError(403, 'wrong_role', `Only ${roles.join(' or ')} tokens can do this; this is a ${token.role} token.`);
  }
}

/**
 * The most records a token may have waiting for review: its base plus one per verified
 * record, up to PENDING_CAP_MAX. A base the admin set above that ceiling stands.
 */
export function pendingCap(token: Token, verified: number): number {
  const base = token.pendingCap ?? PENDING_CAP_START;
  return Math.max(base, Math.min(PENDING_CAP_MAX, base + verified));
}

/** A token's reviewed records on one data app, as the standings table keeps them. */
export interface Tally {
  verified: number;
  rejected: number;
  merged: number;
  stale: number;
}

/** A standings row older than this is counted again from records, in case a change ever slipped past moveStanding. */
const RECOUNT_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Counts a token's reviewed records on one data app from scratch and stores the counts: one read of
 * each record it submitted there, through records_submitter (left alone, SQLite may walk every record
 * of the app instead). One statement, so a status change can never land between the count and the write.
 */
async function recount(db: D1Database, tokenId: string, slug: string, now: Date): Promise<Tally> {
  const row = await db
    .prepare(
      `INSERT INTO standings (token_id, app_slug, verified, rejected, merged, stale, counted_at)
       SELECT ?1, ?2, COUNT(*) FILTER (WHERE status = 'verified'), COUNT(*) FILTER (WHERE status = 'rejected'),
         COUNT(*) FILTER (WHERE status = 'merged'), COUNT(*) FILTER (WHERE status = 'stale'), ?3
       FROM records INDEXED BY records_submitter WHERE submitted_by = ?1 AND app_slug = ?2
       ON CONFLICT (token_id, app_slug) DO UPDATE SET verified = excluded.verified, rejected = excluded.rejected,
         merged = excluded.merged, stale = excluded.stale, counted_at = excluded.counted_at
       RETURNING verified, rejected, merged, stale`,
    )
    .bind(tokenId, slug, now.toISOString())
    .first<Tally>();
  return row ?? { verified: 0, rejected: 0, merged: 0, stale: 0 };
}

type StoredTally = { [K in keyof Tally]: number | null } & { counted_at: string | null };

/** The stored counts, or null when there is no row or it is due to be counted again. */
const current = (row: StoredTally | null, now: Date): Tally | null =>
  row?.counted_at && now.getTime() - Date.parse(row.counted_at) < RECOUNT_AFTER_MS
    ? { verified: row.verified ?? 0, rejected: row.rejected ?? 0, merged: row.merged ?? 0, stale: row.stale ?? 0 }
    : null;

/** A token's reviewed records on one data app: its standings row, counted again when missing or a day old. */
export async function tallyOf(db: D1Database, tokenId: string, slug: string, now: Date): Promise<Tally> {
  const row = await db
    .prepare('SELECT verified, rejected, merged, stale, counted_at FROM standings WHERE token_id = ? AND app_slug = ?')
    .bind(tokenId, slug)
    .first<StoredTally>();
  return current(row, now) ?? recount(db, tokenId, slug, now);
}

/**
 * The statement that moves one record in its submitter's standing from the status it has now to `to`.
 * Put it in the batch that changes the record, before the UPDATE: it reads the status the UPDATE is
 * about to replace. `from` repeats that UPDATE's own status guard, so the counts move exactly when the
 * record does. A submitter with no standings row yet (the seed, a token never asked) is left alone.
 */
export function moveStanding(db: D1Database, recordId: string, to: RecordStatus, from: string | null = null): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE standings SET
         verified = verified + (?2 = 'verified') - (r.status = 'verified'),
         rejected = rejected + (?2 = 'rejected') - (r.status = 'rejected'),
         merged = merged + (?2 = 'merged') - (r.status = 'merged'),
         stale = stale + (?2 = 'stale') - (r.status = 'stale')
       FROM (SELECT submitted_by, app_slug, status FROM records WHERE id = ?1 AND status = coalesce(?3, status)) AS r
       WHERE standings.token_id = r.submitted_by AND standings.app_slug = r.app_slug`,
    )
    .bind(recordId, to, from);
}

/**
 * A token's records on one data app by status, its cap, and what it should change. Agents ask on every
 * skill fetch, submit and GET /me, so this reads the token's waiting records, which its cap keeps few
 * (through records_submitter), and one standings row: never its whole history.
 */
export async function standing(db: D1Database, token: Token, slug: string, now: Date): Promise<Standing> {
  // One statement: GET /me asks this for every data app a token works on.
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM records INDEXED BY records_submitter
                WHERE submitted_by = ?1 AND status = 'pending' AND app_slug = ?2) AS pending,
              s.verified, s.rejected, s.merged, s.stale, s.counted_at
       FROM (SELECT 1) LEFT JOIN standings s ON s.token_id = ?1 AND s.app_slug = ?2`,
    )
    .bind(token.id, slug)
    .first<StoredTally & { pending: number }>();
  const tally = current(row, now) ?? (await recount(db, token.id, slug, now));
  const counts = { pending: row?.pending ?? 0, ...tally };
  const cap = pendingCap(token, counts.verified);
  const warnings: string[] = [];
  if (counts.pending >= cap) {
    warnings.push(
      `You have ${counts.pending} records waiting for review, which is your limit. Send more once maintainers have reviewed some.`,
    );
  }
  const decided = counts.verified + counts.rejected;
  if (decided >= 5 && counts.rejected / decided > 0.3) {
    warnings.push(
      `${counts.rejected} of your ${decided} reviewed records were rejected. Check every value against its source before submitting: a token is suspended once more than half of 10 or more reviewed records are rejected.`,
    );
  }
  return { ...counts, pending_cap: cap, warnings };
}

/* ───────── admin ───────── */

/** Revision actions that count as a maintainer's verdicts. */
export const VERDICT_ACTIONS = ['verify', 'reject', 'merge', 'stale', 'unsure'] as const;
const VERDICT_SQL = VERDICT_ACTIONS.map((action) => `'${action}'`).join(', ');

/** Tasks a maintainer may take in one UTC day, unless the admin sets another number. */
export const DAILY_TASK_LIMIT = 100;
/** Maintainers may also submit records, with a higher cap than a new collector. */
const MAINTAINER_PENDING_CAP = PENDING_CAP_MAX;

const LABEL_MAX = 80;

const dayStart = (now: Date) => `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;

function wholeNumber(value: unknown, field: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    throw new HttpError(422, 'invalid_body', `${field} must be a whole number from 0 to ${max}.`);
  }
  return value;
}

function expiry(value: unknown, now: Date): string | null {
  if (value === null || value === undefined) return null;
  const time = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(time) || time <= now.getTime()) {
    throw new HttpError(422, 'invalid_body', 'expires_at must be a future date or time in ISO 8601, or null for no expiry.');
  }
  return new Date(time).toISOString();
}

/** A maintainer token, issued by the admin. Returns the secret, which is never stored. */
export async function createMaintainerToken(
  db: D1Database,
  input: { label?: unknown; apps?: unknown; daily_task_limit?: unknown; expires_at?: unknown },
  knownSlugs: readonly string[],
  now: Date,
): Promise<{ token: Token; secret: string }> {
  const label = typeof input.label === 'string' ? cleanText(input.label) : '';
  if (!label || label.length > LABEL_MAX) {
    throw new HttpError(422, 'invalid_body', `label must name who the token is for, in 1 to ${LABEL_MAX} characters.`);
  }
  const apps = input.apps === undefined ? ['*'] : input.apps;
  if (
    !Array.isArray(apps) ||
    apps.length === 0 ||
    !apps.every((slug) => slug === '*' || (typeof slug === 'string' && knownSlugs.includes(slug)))
  ) {
    throw new HttpError(422, 'invalid_body', `apps must list data apps (${knownSlugs.join(', ')}) or be ["*"] for all.`);
  }
  const dailyTaskLimit =
    input.daily_task_limit === undefined ? DAILY_TASK_LIMIT : wholeNumber(input.daily_task_limit, 'daily_task_limit', 10_000);
  const secret = newSecret();
  const token: Token = {
    id: newId('tok', now.getTime()),
    role: 'maintainer',
    label,
    apps: apps as string[],
    status: 'active',
    pendingCap: MAINTAINER_PENDING_CAP,
    dailyTaskLimit,
    expiresAt: expiry(input.expires_at, now),
    createdAt: now.toISOString(),
  };
  await db
    .prepare(
      `INSERT INTO tokens (id, secret_hash, role, label, apps_json, status, pending_cap, daily_task_limit, expires_at, created_at)
       VALUES (?, ?, 'maintainer', ?, ?, 'active', ?, ?, ?, ?)`,
    )
    .bind(token.id, await sha256Hex(secret), label, JSON.stringify(token.apps), token.pendingCap, dailyTaskLimit,
      token.expiresAt, token.createdAt)
    .run();
  return { token, secret };
}

interface AdminTokenRow extends TokenRow {
  last_used_at: string | null;
  pending: number;
  verified: number;
  rejected: number;
  verdicts_total: number;
  verdicts_today: number;
}

/** Tokens as the admin sees them, newest first: no secrets, with their records and verdicts. */
export async function adminTokens(
  db: D1Database,
  now: Date,
  filter: { role?: Role; id?: string } = {},
): Promise<AdminToken[]> {
  const { results } = await db
    .prepare(
      `SELECT t.id, t.role, t.label, t.apps_json, t.status, t.pending_cap, t.daily_task_limit, t.expires_at,
         t.last_used_at, t.created_at,
         (SELECT COUNT(*) FROM records r WHERE r.submitted_by = t.id AND r.status = 'pending') AS pending,
         (SELECT COUNT(*) FROM records r WHERE r.submitted_by = t.id AND r.status IN ('verified', 'stale')) AS verified,
         (SELECT COUNT(*) FROM records r WHERE r.submitted_by = t.id AND r.status = 'rejected') AS rejected,
         (SELECT COUNT(*) FROM revisions v WHERE v.actor = t.id AND v.action IN (${VERDICT_SQL})) AS verdicts_total,
         (SELECT COUNT(*) FROM revisions v WHERE v.actor = t.id AND v.action IN (${VERDICT_SQL})
            AND v.created_at >= ?) AS verdicts_today
       FROM tokens t
       WHERE (? IS NULL OR t.role = ?) AND (? IS NULL OR t.id = ?)
       ORDER BY t.created_at DESC`,
    )
    .bind(dayStart(now), filter.role ?? null, filter.role ?? null, filter.id ?? null, filter.id ?? null)
    .all<AdminTokenRow>();
  return results.map((row) => {
    const token = toToken(row);
    return {
      id: token.id,
      role: token.role,
      label: token.label,
      apps: token.apps,
      status: token.status,
      pending_cap: token.pendingCap,
      daily_task_limit: token.dailyTaskLimit,
      expires_at: token.expiresAt,
      last_used_at: row.last_used_at,
      created_at: token.createdAt,
      records: { pending: row.pending, verified: row.verified, rejected: row.rejected },
      verdicts: { total: row.verdicts_total, today: row.verdicts_today },
    };
  });
}

/**
 * Changes a token's status, caps or expiry. A maintainer that stops being active hands
 * its leased tasks back to the queue at once.
 */
export async function updateToken(
  db: D1Database,
  id: string,
  patch: { label?: unknown; status?: unknown; pending_cap?: unknown; daily_task_limit?: unknown; expires_at?: unknown },
  now: Date,
): Promise<AdminToken> {
  const [current] = await adminTokens(db, now, { id });
  if (!current) throw new HttpError(404, 'not_found', 'No token has that id.');
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  // A new name shows everywhere at once: histories and the activity log read it from here.
  if (patch.label !== undefined) {
    const label = typeof patch.label === 'string' ? cleanText(patch.label) : '';
    if (!label || label.length > LABEL_MAX) {
      throw new HttpError(422, 'invalid_body', `label must be a name of 1 to ${LABEL_MAX} characters.`);
    }
    sets.push('label = ?');
    values.push(label);
  }
  if (patch.status !== undefined) {
    if (patch.status !== 'active' && patch.status !== 'suspended' && patch.status !== 'revoked') {
      throw new HttpError(422, 'invalid_body', 'status must be active, suspended or revoked.');
    }
    sets.push('status = ?');
    values.push(patch.status);
  }
  if (patch.pending_cap !== undefined) {
    sets.push('pending_cap = ?');
    values.push(patch.pending_cap === null ? null : wholeNumber(patch.pending_cap, 'pending_cap', 1_000));
  }
  if (patch.daily_task_limit !== undefined) {
    sets.push('daily_task_limit = ?');
    values.push(patch.daily_task_limit === null ? null : wholeNumber(patch.daily_task_limit, 'daily_task_limit', 10_000));
  }
  if (patch.expires_at !== undefined) {
    sets.push('expires_at = ?');
    values.push(expiry(patch.expires_at, now));
  }
  if (sets.length === 0) {
    throw new HttpError(422, 'invalid_body', 'Send at least one of label, status, pending_cap, daily_task_limit or expires_at.');
  }
  const statements = [db.prepare(`UPDATE tokens SET ${sets.join(', ')} WHERE id = ?`).bind(...values, id)];
  if (patch.status === 'suspended' || patch.status === 'revoked') {
    statements.push(
      db
        .prepare(`UPDATE tasks SET status = 'open', leased_to = NULL, lease_expires_at = NULL WHERE leased_to = ? AND status = 'leased'`)
        .bind(id),
    );
  }
  await db.batch(statements);
  const [updated] = await adminTokens(db, now, { id });
  return updated!;
}
