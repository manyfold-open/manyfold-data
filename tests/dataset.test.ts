// The stored dataset: built once, kept in parts under D1's row limit, read without touching records,
// refreshed from the records that changed (or built whole once a day), and refreshed by the cron
// before Discord posts. The rows each step reads on real D1 are held to a budget in budget.test.ts.
import { beforeEach, describe, expect, it } from 'vitest';
import fundraising from '../data-apps/ai-fundraising/config';
import hackathons from '../data-apps/ai-hackathons/config';
import type { DatasetResponse, PublicRecord } from '../src/shared/types';
import { ensureSchema } from '../src/worker/db';
import { appSummaries, buildDataset, datasetJson, PART_BYTES, refreshDataset, refreshDatasets, splitParts } from '../src/worker/records';
import { createD1 } from './d1';

let db: D1Database;
let statements: number;

/** The D1 double, counting every statement prepared. */
function counted(inner: D1Database): D1Database {
  return new Proxy(inner, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property !== 'prepare' || typeof value !== 'function') return value;
      return (sql: string) => {
        statements += 1;
        return (value as (sql: string) => unknown).call(target, sql);
      };
    },
  });
}

const insert = (id: string, status: string, updatedAt: string, name = id, app = 'ai-hackathons') =>
  db
    .prepare(
      `INSERT INTO records (id, app_slug, identity_key, status, data_json, source_url, evidence, observed_at, submitted_by,
         created_at, updated_at, verified_at)
       VALUES (?, ?, ?, ?, ?, 'https://example.org/', 'quote', ?, 'seed', ?, ?, ?)`,
    )
    .bind(id, app, id, status, JSON.stringify({ name, format: 'online' }), updatedAt, updatedAt, updatedAt, status === 'verified' ? updatedAt : null)
    .run();

/** A change the way the Worker makes one: status, data and updated_at together. */
const change = (id: string, status: string, at: string, name = id) =>
  db
    .prepare('UPDATE records SET status = ?, data_json = ?, updated_at = ?, verified_at = CASE WHEN ? = ? THEN ? ELSE verified_at END WHERE id = ?')
    .bind(status, JSON.stringify({ name, format: 'online' }), at, status, 'verified', at, id)
    .run();

const now = new Date('2026-10-02T12:00:00Z');
const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
const parse = (json: string) => JSON.parse(json) as DatasetResponse;
const ids = (dataset: DatasetResponse) => dataset.records.map((record) => record.id).sort();
const byId = (records: PublicRecord[]) => [...records].sort((a, b) => a.id.localeCompare(b.id));

beforeEach(async () => {
  db = createD1();
  await ensureSchema(db);
  await insert('rec_a', 'verified', '2026-10-01T10:00:00.000Z');
  await insert('rec_b', 'pending', '2026-10-01T11:00:00.000Z');
  statements = 0;
  db = counted(db);
});

describe('the stored dataset', () => {
  it('is built and stored on the first read, then read as one statement', async () => {
    const first = parse(await datasetJson(db, hackathons, now));
    expect(first.records.map((record) => record.id)).toEqual(['rec_a']);
    expect(first.pending).toBe(1);
    statements = 0;
    expect(parse(await datasetJson(db, hackathons, now))).toEqual(first);
    expect(statements).toBe(1);
  });

  it('is refreshed only when the records or the invite change, or on a new UTC day', async () => {
    expect(await refreshDataset(db, hackathons, now)).toBe(true);
    expect(await refreshDataset(db, hackathons, now)).toBe(false);

    await change('rec_b', 'verified', '2026-10-02T09:00:00.000Z');
    expect(await refreshDataset(db, hackathons, now)).toBe(true);
    expect(parse(await datasetJson(db, hackathons, now)).records).toHaveLength(2);
    expect(await refreshDataset(db, hackathons, now)).toBe(false);

    await db
      .prepare("INSERT INTO app_settings (app_slug, key, value, updated_at) VALUES ('ai-hackathons', 'discord_invite', 'https://discord.gg/abc', ?)")
      .bind(now.toISOString())
      .run();
    expect(await refreshDataset(db, hackathons, now)).toBe(true);
    expect(parse(await datasetJson(db, hackathons, now)).discordInvite).toBe('https://discord.gg/abc');

    expect(await refreshDataset(db, hackathons, new Date('2026-10-02T23:59:00Z'))).toBe(false);
    const tomorrow = new Date('2026-10-03T00:00:00Z');
    expect(await refreshDataset(db, hackathons, tomorrow)).toBe(true);
    expect(parse(await datasetJson(db, hackathons, tomorrow)).today).toBe('2026-10-03');
  });

  it('merges what changed: new verified records in, corrections over, the rest out', async () => {
    await insert('rec_c', 'verified', '2026-10-01T12:00:00.000Z');
    await refreshDataset(db, hackathons, now);

    await change('rec_b', 'verified', '2026-10-02T09:00:00.000Z'); // newly verified
    await change('rec_a', 'stale', '2026-10-02T09:01:00.000Z'); // no longer public
    await change('rec_c', 'verified', '2026-10-02T09:02:00.000Z', 'Renamed'); // corrected
    await insert('rec_d', 'pending', '2026-10-02T09:03:00.000Z'); // waiting
    expect(await refreshDataset(db, hackathons, now)).toBe(true);

    const merged = parse(await datasetJson(db, hackathons, now));
    expect(ids(merged)).toEqual(['rec_b', 'rec_c']);
    expect(merged.records.find((record) => record.id === 'rec_c')?.data.name).toBe('Renamed');
    expect(merged.pending).toBe(1);

    // Exactly what a build from scratch gives.
    const whole = parse(await buildDataset(db, hackathons, now));
    expect(byId(merged.records)).toEqual(byId(whole.records));
    expect({ ...merged, records: [] }).toEqual({ ...whole, records: [] });
  });

  it('picks up a write that committed after a later one was merged', async () => {
    await refreshDataset(db, hackathons, now);
    await change('rec_b', 'verified', '2026-10-02T09:05:00.000Z');
    await refreshDataset(db, hackathons, now);
    // A verdict whose request began a few seconds earlier lands now, with the earlier time.
    await insert('rec_late', 'verified', '2026-10-02T09:04:57.000Z');
    await insert('rec_next', 'pending', '2026-10-02T09:06:00.000Z');
    await refreshDataset(db, hackathons, now);
    expect(ids(parse(await datasetJson(db, hackathons, now)))).toEqual(['rec_a', 'rec_b', 'rec_late']);
  });

  it('checks every app in one statement, and an unchanged one costs nothing more', async () => {
    const apps = [hackathons, fundraising];
    expect(await refreshDatasets(db, apps, now)).toBe(2);
    statements = 0;
    expect(await refreshDatasets(db, apps, now)).toBe(0);
    expect(statements).toBe(1);
  });

  it('builds it whole again when its head is gone, as after a seed', async () => {
    await refreshDataset(db, hackathons, now);
    await insert('rec_seeded', 'verified', '2026-09-01T00:00:00.000Z'); // older than anything merged
    expect(await refreshDataset(db, hackathons, now)).toBe(false);
    await db.prepare('DELETE FROM dataset_heads').run();
    expect(await refreshDataset(db, hackathons, now)).toBe(true);
    expect(ids(parse(await datasetJson(db, hackathons, now)))).toEqual(['rec_a', 'rec_seeded']);
  });

  it('keeps a dataset past D1’s row limit in parts, and reads it back whole', async () => {
    const quote = 'A sentence that a page states, with “curly quotes”, an é and a 🚀. '.repeat(10);
    for (let n = 0; n < 2_400; n += 100) {
      await db.batch(
        Array.from({ length: 100 }, (_, offset) =>
          db
            .prepare(
              `INSERT INTO records (id, app_slug, identity_key, status, data_json, source_url, evidence, observed_at,
                 submitted_by, created_at, updated_at, verified_at)
               VALUES (?, 'ai-fundraising', ?, 'verified', ?, 'https://example.org/', 'quote', ?, 'seed', ?, ?, ?)`,
            )
            .bind(`rec_${n + offset}`, `key-${n + offset}`, JSON.stringify({ company: `Company ${n + offset}`, note: quote }), now.toISOString(),
              now.toISOString(), now.toISOString(), now.toISOString()),
        ),
      );
    }
    const json = await buildDataset(db, fundraising, now);
    const { results: parts } = await db
      .prepare('SELECT length(CAST(json AS BLOB)) AS bytes FROM dataset_parts WHERE app_slug = ? ORDER BY part')
      .bind('ai-fundraising')
      .all<{ bytes: number }>();
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.bytes).toBeLessThanOrEqual(PART_BYTES);
    expect(await datasetJson(db, fundraising, now)).toBe(json);
    expect(parse(json).records).toHaveLength(2_400);

    // A merge into a dataset in parts keeps every record.
    await change('rec_7', 'verified', later(1).toISOString(), 'Seven');
    expect(await refreshDataset(db, fundraising, later(2))).toBe(true);
    const merged = parse(await datasetJson(db, fundraising, later(2)));
    expect(merged.records).toHaveLength(2_400);
    expect(merged.records.find((record) => record.id === 'rec_7')?.data.name).toBe('Seven');
  });

  it('still serves a dataset it could not store, and stores it on the next try', async () => {
    const failing = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'batch') {
          return async (statements: { sql?: string }[]) => {
            if (statements.some((statement) => statement.sql?.includes('dataset_parts'))) throw new Error('D1_ERROR: too large');
            return target.batch(statements as D1PreparedStatement[]);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(parse(await datasetJson(failing, hackathons, now)).records.map((record) => record.id)).toEqual(['rec_a']);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM dataset_heads').first('n')).toBe(0);
    expect(await refreshDataset(db, hackathons, now)).toBe(true);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM dataset_heads').first('n')).toBe(1);
  });

  it('cuts between characters, so the parts join back exactly', () => {
    const text = JSON.stringify({ text: 'aé€😀'.repeat(50) });
    for (const max of [4, 5, 6, 7, 11, 64]) {
      const parts = splitParts(text, max);
      expect(parts.join('')).toBe(text);
      for (const part of parts) expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(max);
    }
    expect(splitParts('{}')).toEqual(['{}']);
  });
});

describe('the catalog', () => {
  it('reads each app’s totals from its stored dataset, building the ones not stored yet', async () => {
    const apps = [hackathons, fundraising];
    const summaries = await appSummaries(db, apps, now);
    expect(summaries.map(({ slug, verified, lastUpdated }) => ({ slug, verified, lastUpdated }))).toEqual([
      { slug: 'ai-hackathons', verified: 1, lastUpdated: '2026-10-01T10:00:00.000Z' },
      { slug: 'ai-fundraising', verified: 0, lastUpdated: null },
    ]);
    statements = 0;
    expect(await appSummaries(db, apps, now)).toEqual(summaries);
    expect(statements).toBe(1);
  });
});
