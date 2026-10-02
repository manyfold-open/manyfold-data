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

/**
 * The public dataset of one data app, built from D1: every verified record, the count waiting for
 * review and the Discord invite, in one round trip. This is the only public read that scans the
 * app's records, and it runs only when they changed (refreshDataset) or nothing is stored yet.
 */
export async function buildDataset(db: D1Database, config: DataAppConfig, now: Date): Promise<DatasetResponse> {
  const [rows, pending, invite] = await db.batch<unknown>([
    db.prepare(`SELECT ${LIST_COLUMNS} FROM records WHERE app_slug = ? AND status = 'verified'`).bind(config.slug),
    db.prepare("SELECT COUNT(*) AS n FROM records WHERE app_slug = ? AND status = 'pending'").bind(config.slug),
    db.prepare("SELECT value FROM app_settings WHERE app_slug = ? AND key = 'discord_invite'").bind(config.slug),
  ]);
  return {
    today: now.toISOString().slice(0, 10),
    generated_at: now.toISOString(),
    records: ((rows?.results ?? []) as RecordRow[]).map(toPublic),
    pending: (pending?.results[0] as { n: number } | undefined)?.n ?? 0,
    discordInvite: (invite?.results[0] as { value: string } | undefined)?.value ?? null,
  };
}

/** Datasets larger than this are not stored (D1 caps a row at 2 MB); they are built on demand. */
export const DATASET_STORE_MAX = 1_800_000;
/** A stored dataset is rebuilt at least this often, whatever its version says. */
const DATASET_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * What the dataset is built from, in two index lookups: the latest change to the app's records,
 * and to its Discord invite. Equal versions mean an equal dataset.
 */
export async function datasetVersion(db: D1Database, slug: string): Promise<string> {
  const row = await db
    .prepare(
      `SELECT (SELECT MAX(updated_at) FROM records WHERE app_slug = ?1) AS records_at,
              (SELECT updated_at FROM app_settings WHERE app_slug = ?1 AND key = 'discord_invite') AS invite_at`,
    )
    .bind(slug)
    .first<{ records_at: string | null; invite_at: string | null }>();
  return `${row?.records_at ?? '-'}|${row?.invite_at ?? '-'}`;
}

async function storeDataset(db: D1Database, slug: string, version: string, json: string, now: Date): Promise<boolean> {
  if (json.length > DATASET_STORE_MAX) {
    console.warn(`dataset ${slug} is ${json.length} characters: too large to store, built on demand`);
    return false;
  }
  await db
    .prepare(
      `INSERT INTO datasets (app_slug, version, json, built_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (app_slug) DO UPDATE SET version = excluded.version, json = excluded.json, built_at = excluded.built_at`,
    )
    .bind(slug, version, json, now.toISOString())
    .run();
  return true;
}

/**
 * Rebuilds the stored dataset when the app's records or invite changed, or it is a day old. The
 * cron runs this every five minutes, before Discord posts, so an announced record is already in
 * the Table. Unchanged data costs three single-row reads.
 */
export async function refreshDataset(db: D1Database, config: DataAppConfig, now: Date): Promise<boolean> {
  const [version, stored] = await Promise.all([
    datasetVersion(db, config.slug),
    db.prepare('SELECT version, built_at FROM datasets WHERE app_slug = ?').bind(config.slug).first<{ version: string; built_at: string }>(),
  ]);
  const fresh = stored && stored.version === version && now.getTime() - Date.parse(stored.built_at) < DATASET_MAX_AGE_MS;
  if (fresh) return false;
  const json = JSON.stringify(await buildDataset(db, config, now));
  await storeDataset(db, config.slug, version, json, now);
  return true;
}

/**
 * The dataset as JSON text, for readers: the stored copy (one row), or — when none is stored yet,
 * as on a fresh deploy — a build, which is then stored.
 */
export async function datasetJson(db: D1Database, config: DataAppConfig, now: Date): Promise<string> {
  const stored = await db.prepare('SELECT json FROM datasets WHERE app_slug = ?').bind(config.slug).first<{ json: string }>();
  if (stored) return stored.json;
  const version = await datasetVersion(db, config.slug);
  const json = JSON.stringify(await buildDataset(db, config, now));
  await storeDataset(db, config.slug, version, json, now);
  return json;
}

/** Drops the stored dataset of one data app (or all), so the next read rebuilds it at once. */
export async function forgetDataset(db: D1Database, slug?: string): Promise<void> {
  await (slug ? db.prepare('DELETE FROM datasets WHERE app_slug = ?').bind(slug) : db.prepare('DELETE FROM datasets')).run();
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

/** Every data app with its count of verified records and the time its data last changed. */
export async function appSummaries(
  db: D1Database,
  apps: readonly DataAppConfig[],
): Promise<AppSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT app_slug, COUNT(*) AS n, MAX(updated_at) AS last FROM records
       WHERE status = 'verified' GROUP BY app_slug`,
    )
    .all<{ app_slug: string; n: number; last: string | null }>();
  return apps.map((app) => {
    const row = results.find((result) => result.app_slug === app.slug);
    return {
      slug: app.slug,
      title: app.title,
      description: app.description,
      license: app.license,
      verified: row?.n ?? 0,
      lastUpdated: row?.last ?? null,
    };
  });
}
