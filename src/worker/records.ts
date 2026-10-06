/**
 * Reading records for the public: the data app's dataset (every verified record, which the
 * Table and the Overview are computed from), one record with its history, and the catalog.
 */

import type { DataAppConfig } from '../shared/data-app';
import type { AppSummary, DatasetResponse, MergedResponse, PublicRecord, PublicStatus, RecordResponse } from '../shared/types';

interface RecordRow {
  id: string;
  status: string;
  data_json: string;
  source_url: string;
  observed_at: string;
  verified_at: string | null;
  updated_at: string;
}

const LIST_COLUMNS = 'id, status, data_json, source_url, observed_at, verified_at, updated_at';

const toPublic = (row: RecordRow): PublicRecord => ({
  id: row.id,
  status: row.status as PublicStatus,
  data: JSON.parse(row.data_json),
  source_url: row.source_url,
  observed_at: row.observed_at,
  verified_at: row.verified_at,
  updated_at: row.updated_at,
});

/* ───────── the stored dataset ───────── */

/**
 * The longest a stored part of a dataset's JSON may be, in bytes. D1 caps a row at 2 MB, and the
 * largest datasets are past that, so they are kept in several parts.
 */
export const PART_BYTES = 1_500_000;

/**
 * How far before the newest change it saw last time a refresh starts reading. A write takes its
 * updated_at when its request starts, so it can commit after a later write that was already merged.
 */
const OVERLAP_MS = 10 * 60 * 1000;

/** Where a stored dataset's last refresh read up to, and when it was last built whole. */
interface Head {
  records_at: string | null;
  built_at: string;
}

/** What a dataset is built from besides the records: one statement, a handful of index lookups. */
interface Source {
  records_at: string | null;
  invite_at: string | null;
  invite: string | null;
  pending: number;
}

const SOURCE = `SELECT (SELECT MAX(updated_at) FROM records WHERE app_slug = ?1) AS records_at,
  (SELECT updated_at FROM app_settings WHERE app_slug = ?1 AND key = 'discord_invite') AS invite_at,
  (SELECT value FROM app_settings WHERE app_slug = ?1 AND key = 'discord_invite') AS invite,
  (SELECT COUNT(*) FROM records WHERE app_slug = ?1 AND status = 'pending') AS pending`;

const PARTS = 'SELECT json FROM dataset_parts WHERE app_slug = ? ORDER BY part';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** JSON in parts of at most `max` bytes, each cut between characters: joined, they are the JSON again. */
export function splitParts(json: string, max = PART_BYTES): string[] {
  const bytes = encoder.encode(json);
  if (bytes.length <= max) return [json];
  const parts: string[] = [];
  for (let start = 0; start < bytes.length; ) {
    let end = Math.min(start + max, bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1; // not inside a UTF-8 sequence
    parts.push(decoder.decode(bytes.subarray(start, end)));
    start = end;
  }
  return parts;
}

const lastUpdated = (records: readonly PublicRecord[]): string | null =>
  records.reduce<string | null>((last, record) => (last === null || record.updated_at > last ? record.updated_at : last), null);

/**
 * Stores a dataset, its parts and its head, in one batch, so a reader never sees half of one. When
 * that fails, the caller still gets the JSON to serve, and the next refresh tries again.
 */
async function store(db: D1Database, slug: string, dataset: DatasetResponse, source: Source, builtAt: string): Promise<string> {
  const json = JSON.stringify(dataset);
  const parts = splitParts(json);
  const statements = [
    ...parts.map((text, part) =>
      db
        .prepare('INSERT INTO dataset_parts (app_slug, part, json) VALUES (?, ?, ?) ON CONFLICT (app_slug, part) DO UPDATE SET json = excluded.json')
        .bind(slug, part, text),
    ),
    db.prepare('DELETE FROM dataset_parts WHERE app_slug = ? AND part >= ?').bind(slug, parts.length),
    db
      .prepare(
        `INSERT INTO dataset_heads (app_slug, records_at, invite_at, verified, last_updated, built_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (app_slug) DO UPDATE SET records_at = excluded.records_at, invite_at = excluded.invite_at,
           verified = excluded.verified, last_updated = excluded.last_updated, built_at = excluded.built_at`,
      )
      .bind(slug, source.records_at, source.invite_at, dataset.records.length, lastUpdated(dataset.records), builtAt),
  ];
  try {
    await db.batch(statements);
  } catch (error) {
    console.error(`could not store the ${slug} dataset, ${json.length} characters in ${parts.length} parts`, error);
  }
  return json;
}

const datasetFrom = (records: PublicRecord[], source: Source, now: Date): DatasetResponse => ({
  today: now.toISOString().slice(0, 10),
  generated_at: now.toISOString(),
  records,
  pending: source.pending,
  discordInvite: source.invite,
});

/**
 * Builds a data app's dataset whole and stores it: every verified record, the count waiting for
 * review and the Discord invite, read in one batch. The only read that scans the app's verified
 * records: once a day for each app, and when nothing is stored yet.
 */
export async function buildDataset(db: D1Database, config: DataAppConfig, now: Date): Promise<string> {
  const [source, rows] = await db.batch<unknown>([
    db.prepare(SOURCE).bind(config.slug),
    db.prepare(`SELECT ${LIST_COLUMNS} FROM records WHERE app_slug = ? AND status = 'verified'`).bind(config.slug),
  ]);
  const from = source?.results[0] as Source;
  return store(db, config.slug, datasetFrom(((rows?.results ?? []) as RecordRow[]).map(toPublic), from, now), from, now.toISOString());
}

/**
 * Brings a stored dataset up to date from the records changed since it was last refreshed, found
 * through records_changed: a verified one goes in, replacing its old copy, and any other comes out.
 * Reads the changed records and the stored parts, not the app's records. With no parts to merge
 * into, it builds the dataset whole.
 */
async function mergeDataset(db: D1Database, config: DataAppConfig, head: Head, now: Date): Promise<string> {
  const since = head.records_at ? new Date(Date.parse(head.records_at) - OVERLAP_MS).toISOString() : '';
  const [source, changed, parts] = await db.batch<unknown>([
    db.prepare(SOURCE).bind(config.slug),
    db.prepare(`SELECT ${LIST_COLUMNS} FROM records WHERE app_slug = ? AND updated_at > ?`).bind(config.slug, since),
    db.prepare(PARTS).bind(config.slug),
  ]);
  let stored: DatasetResponse;
  try {
    stored = JSON.parse(((parts?.results ?? []) as { json: string }[]).map((row) => row.json).join('')) as DatasetResponse;
  } catch {
    return buildDataset(db, config, now);
  }
  const records = new Map(stored.records.map((record) => [record.id, record]));
  for (const row of (changed?.results ?? []) as RecordRow[]) {
    if (row.status === 'verified') records.set(row.id, toPublic(row));
    else records.delete(row.id);
  }
  const from = source?.results[0] as Source;
  return store(db, config.slug, datasetFrom([...records.values()], from, now), from, head.built_at);
}

/**
 * Brings the stored datasets of `apps` up to date, checking them all in one statement by the latest
 * change to each app's records and invite: two index lookups an app. One that changed is merged;
 * one with nothing stored, or last built whole on an earlier UTC day, is built whole, which also
 * moves its `today` and mends anything a merge could have missed. The cron runs this every five
 * minutes, before Discord posts, so an announced record is already in the Table, and the admin
 * after each change. Returns how many datasets it refreshed.
 */
export async function refreshDatasets(db: D1Database, apps: readonly DataAppConfig[], now: Date): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT a.value AS app_slug,
         (SELECT MAX(updated_at) FROM records WHERE app_slug = a.value) AS records_at,
         (SELECT updated_at FROM app_settings WHERE app_slug = a.value AND key = 'discord_invite') AS invite_at,
         h.records_at AS stored_records_at, h.invite_at AS stored_invite_at, h.built_at
       FROM json_each(?) a LEFT JOIN dataset_heads h ON h.app_slug = a.value`,
    )
    .bind(JSON.stringify(apps.map((app) => app.slug)))
    .all<{
      app_slug: string;
      records_at: string | null;
      invite_at: string | null;
      stored_records_at: string | null;
      stored_invite_at: string | null;
      built_at: string | null;
    }>();
  const today = now.toISOString().slice(0, 10);
  let refreshed = 0;
  for (const row of results) {
    const config = apps.find((app) => app.slug === row.app_slug)!;
    const builtToday = row.built_at !== null && row.built_at.slice(0, 10) === today;
    if (builtToday && row.records_at === row.stored_records_at && row.invite_at === row.stored_invite_at) continue;
    if (builtToday) {
      await mergeDataset(db, config, { records_at: row.stored_records_at, built_at: row.built_at! }, now);
    } else {
      await buildDataset(db, config, now);
    }
    refreshed += 1;
  }
  return refreshed;
}

/** Brings one data app's stored dataset up to date (refreshDatasets); true when it changed. */
export async function refreshDataset(db: D1Database, config: DataAppConfig, now: Date): Promise<boolean> {
  return (await refreshDatasets(db, [config], now)) > 0;
}

/**
 * The dataset as JSON text, for readers: its stored parts, one row for most data apps and a few for
 * the largest, or — when nothing is stored yet, as just after a deploy — a build, which is stored.
 */
export async function datasetJson(db: D1Database, config: DataAppConfig, now: Date): Promise<string> {
  const { results } = await db.prepare(PARTS).bind(config.slug).all<{ json: string }>();
  return results.length > 0 ? results.map((row) => row.json).join('') : buildDataset(db, config, now);
}

/** Who a revision's actor is, in words a reader understands. */
const actorLabel = (actor: string, tokenLabel: string | null): string =>
  actor === 'seed' ? 'Manyfold team (seed data)' : actor === 'admin' ? 'Admin' : (tokenLabel ?? 'An agent');

/**
 * One record with its history. Null when it does not exist or is not public; a pointer
 * when it was merged into another record. `unsure` notes are working notes for the
 * admin, so the public history leaves them out.
 */
export async function getRecord(
  db: D1Database,
  config: DataAppConfig,
  id: string,
): Promise<RecordResponse | MergedResponse | null> {
  const row = await db
    .prepare(
      `SELECT ${LIST_COLUMNS}, evidence, created_at, merged_into FROM records
       WHERE app_slug = ? AND id = ?`,
    )
    .bind(config.slug, id)
    .first<RecordRow & { evidence: string; created_at: string; merged_into: string | null }>();
  if (!row) return null;
  if (row.status === 'merged' && row.merged_into) return { merged_into: row.merged_into };
  if (row.status !== 'verified' && row.status !== 'stale') return null;

  const revisions = await db
    .prepare(
      `SELECT r.action, r.actor, r.reason, r.created_at, t.label
       FROM revisions r LEFT JOIN tokens t ON t.id = r.actor
       WHERE r.record_id = ? AND r.action != 'unsure' ORDER BY r.id`,
    )
    .bind(id)
    .all<{ action: string; actor: string; reason: string | null; created_at: string; label: string | null }>();

  return {
    record: { ...toPublic(row), evidence: row.evidence, created_at: row.created_at },
    revisions: revisions.results.map((revision) => ({
      action: revision.action,
      actor: actorLabel(revision.actor, revision.label),
      reason: revision.reason,
      created_at: revision.created_at,
    })),
  };
}

/**
 * Every data app with its count of verified records and the time its data last changed, from the
 * stored datasets' heads: a row an app, as current as the Table. An app with nothing stored yet is
 * built first.
 */
export async function appSummaries(db: D1Database, apps: readonly DataAppConfig[], now: Date): Promise<AppSummary[]> {
  const heads = async () =>
    (await db.prepare('SELECT app_slug, verified, last_updated FROM dataset_heads').all<{ app_slug: string; verified: number; last_updated: string | null }>())
      .results;
  let rows = await heads();
  const missing = apps.filter((app) => !rows.some((row) => row.app_slug === app.slug));
  if (missing.length > 0) {
    await refreshDatasets(db, missing, now);
    rows = await heads();
  }
  return apps.map((app) => {
    const row = rows.find((result) => result.app_slug === app.slug);
    return {
      slug: app.slug,
      title: app.title,
      description: app.description,
      license: app.license,
      verified: row?.verified ?? 0,
      lastUpdated: row?.last_updated ?? null,
    };
  });
}
