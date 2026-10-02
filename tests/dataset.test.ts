// The stored dataset: built once, read as one row, rebuilt only when the app's records or its
// invite change (or it is a day old), and refreshed by the cron before Discord posts.
import { beforeEach, describe, expect, it } from 'vitest';
import hackathons from '../data-apps/ai-hackathons/config';
import type { DatasetResponse } from '../src/shared/types';
import { ensureSchema } from '../src/worker/db';
import { datasetJson, datasetVersion, refreshDataset } from '../src/worker/records';
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

const insert = (id: string, status: string, updatedAt: string, name = id) =>
  db
    .prepare(
      `INSERT INTO records (id, app_slug, identity_key, status, data_json, source_url, evidence, observed_at, submitted_by,
         created_at, updated_at, verified_at)
       VALUES (?, 'ai-hackathons', ?, ?, ?, 'https://example.org/', 'quote', ?, 'seed', ?, ?, ?)`,
    )
    .bind(id, id, status, JSON.stringify({ name, format: 'online' }), updatedAt, updatedAt, updatedAt, status === 'verified' ? updatedAt : null)
    .run();

const now = new Date('2026-10-02T12:00:00Z');
const parse = (json: string) => JSON.parse(json) as DatasetResponse;

beforeEach(async () => {
  db = createD1();
  await ensureSchema(db);
  await insert('rec_a', 'verified', '2026-10-01T10:00:00Z');
  await insert('rec_b', 'pending', '2026-10-01T11:00:00Z');
  statements = 0;
  db = counted(db);
});

describe('the stored dataset', () => {
  it('is built and stored on the first read, then read as one row', async () => {
    const first = parse(await datasetJson(db, hackathons, now));
    expect(first.records.map((record) => record.id)).toEqual(['rec_a']);
    expect(first.pending).toBe(1);
    statements = 0;
    expect(parse(await datasetJson(db, hackathons, now))).toEqual(first);
    expect(statements).toBe(1);
  });

  it('is rebuilt only when the records or the invite change, or once a day', async () => {
    expect(await refreshDataset(db, hackathons, now)).toBe(true);
    expect(await refreshDataset(db, hackathons, now)).toBe(false);

    await db.prepare("UPDATE records SET status = 'verified', updated_at = ?, verified_at = ? WHERE id = 'rec_b'").bind('2026-10-02T09:00:00Z', '2026-10-02T09:00:00Z').run();
    expect(await refreshDataset(db, hackathons, now)).toBe(true);
    expect(parse(await datasetJson(db, hackathons, now)).records).toHaveLength(2);

    const before = await datasetVersion(db, 'ai-hackathons');
    await db
      .prepare("INSERT INTO app_settings (app_slug, key, value, updated_at) VALUES ('ai-hackathons', 'discord_invite', 'https://discord.gg/abc', ?)")
      .bind(now.toISOString())
      .run();
    expect(await datasetVersion(db, 'ai-hackathons')).not.toBe(before);
    expect(await refreshDataset(db, hackathons, now)).toBe(true);
    expect(parse(await datasetJson(db, hackathons, now)).discordInvite).toBe('https://discord.gg/abc');

    expect(await refreshDataset(db, hackathons, new Date(now.getTime() + 25 * 60 * 60 * 1000))).toBe(true);
  });

  it('costs an unchanged cron run three single-row reads', async () => {
    await refreshDataset(db, hackathons, now);
    statements = 0;
    expect(await refreshDataset(db, hackathons, now)).toBe(false);
    expect(statements).toBe(2); // the version (one statement, two index lookups) and the stored row
  });
});
