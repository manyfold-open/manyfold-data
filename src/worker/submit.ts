/**
 * Taking records from agents. Every record in a batch gets its own answer — accepted,
 * duplicate, invalid (with each field's error), source_not_found or over_cap — so an
 * agent can fix its batch in the same run. Checks run cheapest first, so junk is turned
 * away before anyone spends time on it:
 *
 *   1. field values, accepted ranges, provenance     no I/O
 *   2. duplicates already in the dataset             one query
 *   3. does each source exist (DNS, then 404/410)    one fetch per distinct URL
 *   4. the token's pending cap, duplicates in batch  in order, as records are stored
 *
 * An accepted record is stored as pending with its first revision and a verify task, in
 * one D1 batch. Text that looks aimed at agents is accepted but flagged: it waits for the
 * admin instead of a maintainer, and gets no verify task.
 */

import {
  checkAccept,
  identityKey,
  validateProvenance,
  validateRecordData,
  type DataAppConfig,
  type FieldError,
  type Provenance,
  type RecordData,
} from '../shared/data-app';
import type { SubmitResponse, SubmitResult } from '../shared/types';
import { newId } from './ids';
import { DAY } from './ratelimit';
import { standing, type Token } from './tokens';
import { HttpError } from './types';

export const BATCH_MAX = 20;

// Phrases that address an AI instead of describing the record, and markup that has no
// business in a field value.
const AIMED_AT_AGENTS: readonly RegExp[] = [
  /\bignore (all |any |the )?(previous|prior|above|earlier) (instructions|prompts|messages)\b/i,
  /\bdisregard (all |any |the )?(previous|prior|above|earlier)\b/i,
  /\b(system|developer) prompt\b/i,
  /\byou are (now )?(an? )?(ai|assistant|agent|language model|llm)\b/i,
  /\b(mark|set|label) (this|it|them|all|every)( records?)? (as )?(verified|approved|valid)\b/i,
  /<\/?(script|iframe|object|embed|img)\b/i,
  /\[\/?INST\]|<\|im_(start|end)\|>/i,
];

export const looksAimedAtAgents = (texts: readonly string[]): boolean =>
  texts.some((text) => AIMED_AT_AGENTS.some((pattern) => pattern.test(text)));

/**
 * False only when a source plainly does not exist: its domain has no DNS record, or the
 * page answers 404 or 410. Everything else passes — many sites block automated requests,
 * and a maintainer opens every source anyway.
 */
export async function sourceExists(url: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const host = new URL(url).hostname;
  try {
    const dns = await fetcher(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(3000),
    });
    if (dns.ok && ((await dns.json()) as { Status?: number }).Status === 3) return false; // NXDOMAIN
  } catch {
    // No DNS answer in time: the page request decides.
  }
  try {
    const page = await fetcher(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; ManyfoldData/0.1; +https://data.manyfold.ai)' },
      signal: AbortSignal.timeout(5000),
    });
    await page.body?.cancel();
    return page.status !== 404 && page.status !== 410;
  } catch {
    return true;
  }
}

interface Candidate {
  index: number;
  data: RecordData;
  provenance: Provenance;
  key: string;
  flagged: boolean;
}

const textsOf = (data: RecordData, provenance: Provenance): string[] => [
  ...Object.values(data).flatMap((value) => (typeof value === 'string' ? [value] : Array.isArray(value) ? value : [])),
  provenance.evidence,
];

function store(db: D1Database, config: DataAppConfig, token: Token, candidate: Candidate, id: string, now: Date) {
  const at = now.toISOString();
  const { source_url, evidence, observed_at } = candidate.provenance;
  const statements = [
    db
      .prepare(
        `INSERT INTO records (id, app_slug, identity_key, status, data_json, source_url, evidence, observed_at,
           submitted_by, flagged, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, config.slug, candidate.key, JSON.stringify(candidate.data), source_url, evidence, observed_at,
        token.id, candidate.flagged ? 1 : 0, at, at),
    db
      .prepare(
        `INSERT INTO revisions (record_id, app_slug, actor, action, after_json, source_url, evidence, created_at)
         VALUES (?, ?, ?, 'submit', ?, ?, ?, ?)`,
      )
      .bind(id, config.slug, token.id, JSON.stringify({ status: 'pending', data: candidate.data }), source_url,
        evidence, at),
  ];
  if (!candidate.flagged) {
    statements.push(
      db
        .prepare(`INSERT INTO tasks (id, app_slug, record_id, kind, status, created_at) VALUES (?, ?, ?, 'verify', 'open', ?)`)
        .bind(newId('tsk', now.getTime()), config.slug, id, at),
    );
  }
  return db.batch(statements);
}

export async function submitRecords(
  db: D1Database,
  config: DataAppConfig,
  token: Token,
  body: unknown,
  options: { now: Date; sourceExists: (url: string) => Promise<boolean> },
): Promise<SubmitResponse> {
  const items = (body as { records?: unknown } | null)?.records;
  if (!Array.isArray(items) || items.length === 0 || items.length > BATCH_MAX) {
    throw new HttpError(422, 'invalid_body', `Send JSON like {"records": [...]} with 1 to ${BATCH_MAX} records.`);
  }
  const { now } = options;
  const today = now.toISOString().slice(0, 10);
  const results: SubmitResult[] = [];

  // 1. Values, accepted ranges and provenance.
  const candidates: Candidate[] = [];
  items.forEach((item, index) => {
    const entry = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const data = validateRecordData(config, entry.data);
    const provenance = validateProvenance(entry, now);
    const errors: FieldError[] = [
      ...(data.ok ? checkAccept(config, data.value, today) : data.errors),
      ...(provenance.ok ? [] : provenance.errors),
    ];
    if (!data.ok || !provenance.ok || errors.length > 0) {
      results[index] = { index, status: 'invalid', errors };
      return;
    }
    candidates.push({
      index,
      data: data.value,
      provenance: provenance.value,
      key: identityKey(config, data.value),
      flagged: looksAimedAtAgents(textsOf(data.value, provenance.value)),
    });
  });

  // 2. Records already in the dataset.
  const known = new Map<string, string>();
  const keys = [...new Set(candidates.map((candidate) => candidate.key))];
  if (keys.length > 0) {
    const { results: rows } = await db
      .prepare(
        `SELECT id, identity_key FROM records WHERE app_slug = ? AND status IN ('pending', 'verified')
         AND identity_key IN (${keys.map(() => '?').join(', ')})`,
      )
      .bind(config.slug, ...keys)
      .all<{ id: string; identity_key: string }>();
    for (const row of rows) known.set(row.identity_key, row.id);
  }

  // 3. Sources, once per distinct URL, for records that are not known already.
  const urls = [...new Set(candidates.filter((c) => !known.has(c.key)).map((c) => c.provenance.source_url))];
  const exists = new Map(await Promise.all(urls.map(async (url) => [url, await options.sourceExists(url)] as const)));

  // 4. Store in order until the cap is reached.
  const before = await standing(db, token, config.slug, now);
  let pending = before.pending;
  for (const candidate of candidates) {
    const { index } = candidate;
    const twin = known.get(candidate.key);
    if (twin) {
      results[index] = { index, status: 'duplicate', existing_id: twin };
      continue;
    }
    if (exists.get(candidate.provenance.source_url) === false) {
      results[index] = {
        index,
        status: 'source_not_found',
        message: `${candidate.provenance.source_url} returned 404, or its domain does not exist. Find the page that states these facts.`,
      };
      continue;
    }
    if (pending >= before.pending_cap) {
      results[index] = {
        index,
        status: 'over_cap',
        message: `You have ${pending} records waiting for review, which is your limit. Stop for this run.`,
      };
      continue;
    }
    const id = newId('rec', now.getTime());
    try {
      await store(db, config, token, candidate, id, now);
    } catch (error) {
      // Another submit stored the same identity a moment ago.
      if (!/UNIQUE/i.test(String(error))) throw error;
      const row = await db
        .prepare(`SELECT id FROM records WHERE app_slug = ? AND identity_key = ? AND status IN ('pending', 'verified')`)
        .bind(config.slug, candidate.key)
        .first<{ id: string }>();
      results[index] = { index, status: 'duplicate', existing_id: row?.id ?? '' };
      continue;
    }
    known.set(candidate.key, id);
    results[index] = { index, status: 'accepted', id };
    pending += 1;
  }

  return {
    results,
    pending,
    pending_cap: before.pending_cap,
    warnings:
      pending >= before.pending_cap
        ? [`You have ${pending} records waiting for review, which is your limit. Send more once maintainers have reviewed some.`]
        : [],
  };
}

/* ───────── idempotency ───────── */

const KEY = /^[\x21-\x7e]{1,100}$/;

/** Checks an Idempotency-Key header; null when there is none. */
export function idempotencyKey(header: string | undefined): string | null {
  if (header === undefined) return null;
  if (!KEY.test(header)) {
    throw new HttpError(422, 'invalid_idempotency_key', 'Idempotency-Key must be 1 to 100 visible ASCII characters.');
  }
  return header;
}

/** The answer already given for this key in the last 24 hours, if any. */
export async function recall(db: D1Database, tokenId: string, key: string, now: Date): Promise<SubmitResponse | null> {
  const row = await db
    .prepare('SELECT response_json, created_at FROM idempotency WHERE token_id = ? AND key = ?')
    .bind(tokenId, key)
    .first<{ response_json: string; created_at: string }>();
  if (!row || Date.parse(row.created_at) < now.getTime() - DAY) return null;
  return JSON.parse(row.response_json) as SubmitResponse;
}

export async function remember(
  db: D1Database,
  tokenId: string,
  key: string,
  response: SubmitResponse,
  now: Date,
): Promise<void> {
  await db
    .prepare('INSERT OR REPLACE INTO idempotency (token_id, key, response_json, created_at) VALUES (?, ?, ?, ?)')
    .bind(tokenId, key, JSON.stringify(response), now.toISOString())
    .run();
}
