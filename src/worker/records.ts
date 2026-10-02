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
 * The public dataset of one data app: every verified record, the count waiting for review and
 * the Discord invite, in one D1 round trip. Everything readers see is computed from it
 * (src/shared/engine.ts), so this is the only public read that scans the app's records.
 */
export async function loadDataset(db: D1Database, config: DataAppConfig, now: Date): Promise<DatasetResponse> {
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
