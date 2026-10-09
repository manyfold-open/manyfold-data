// D1's free tier caps the rows read in a day for the whole account, and D1 counts every row a
// statement steps through, index entries included. These tests run the Worker's busiest statements
// on workerd's own D1 (workerd.mjs), which counts rows read as production bills them, at production's
// sizes, and hold each to a budget. Before these budgets, on 2026-10-06: one collector's standing
// read 2,637 rows a call, every five-minute refresh of AI Company Fundraising 2,767, a lease 1,611 on
// average, and GET /me for a token on every app read its whole day of verdicts once per app.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fundraising from '../data-apps/ai-fundraising/config';
import hackathons from '../data-apps/ai-hackathons/config';
import { dataApps } from '../data-apps/index';
import { leaseTasks, workOf } from '../src/worker/maintainer';
import { maintain } from '../src/worker/maintenance';
import { DAY, MINUTE } from '../src/worker/ratelimit';
import { appSummaries, buildDataset, datasetJson, refreshDatasets } from '../src/worker/records';
import { SCHEMA, schemaStatements } from '../src/worker/schema';
import { moveStanding, standing, type Token } from '../src/worker/tokens';
import { openWorkerdD1 } from './workerd.mjs';

let raw: D1Database;
let db: D1Database;
let close: () => Promise<void>;
let rowsRead = 0;

const add = <T extends D1Result>(result: T): T => {
  rowsRead += result.meta.rows_read ?? 0;
  return result;
};

/** The binding, adding up D1's own count of rows read for every statement run through it. */
function counting(binding: D1Database): D1Database {
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
        if (property === 'all') return async () => add(await target.all());
        if (property === 'run') return async () => add(await target.run());
        // first() returns no meta: read the same rows through all().
        if (property === 'first') {
          return async (column?: string) => {
            const row = add(await target.all<Record<string, unknown>>()).results[0];
            return row === undefined ? null : column === undefined ? row : row[column];
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    real.set(proxy, statement);
    return proxy;
  };
  return new Proxy(binding, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql));
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) =>
          (await target.batch(statements.map((statement) => real.get(statement) ?? statement))).map(add);
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** What `work` costs D1 in rows read. */
async function reads<T>(work: () => Promise<T>): Promise<{ value: T; rows: number }> {
  rowsRead = 0;
  const value = await work();
  return { value, rows: rowsRead };
}

beforeAll(async () => {
  ({ db: raw, close } = await openWorkerdD1());
  await raw.batch(schemaStatements(SCHEMA).map((statement) => raw.prepare(statement)));
  db = counting(raw);
}, 60_000);

afterAll(async () => {
  await close?.();
});

const TABLES = [
  'records',
  'revisions',
  'tokens',
  'standings',
  'tasks',
  'dataset_heads',
  'dataset_parts',
  'outbox',
  'idempotency',
  'app_settings',
  'token_capabilities',
  'task_needs',
  'task_waits',
];

beforeEach(async () => {
  await raw.batch(TABLES.map((table) => raw.prepare(`DELETE FROM ${table}`)));
});

/* ───────── fixtures, written past the counter ───────── */

const now = new Date('2026-10-06T12:00:00.000Z');
const ago = (minutes: number) => new Date(now.getTime() - minutes * MINUTE).toISOString();
const many = <T>(count: number, make: (n: number) => T): T[] => Array.from({ length: count }, (_, n) => make(n));

async function inBatches(statements: D1PreparedStatement[]): Promise<void> {
  for (let start = 0; start < statements.length; start += 250) await raw.batch(statements.slice(start, start + 250));
}

interface SeedRecord {
  id: string;
  app: string;
  status: string;
  by: string;
  at: string;
  data?: Record<string, unknown>;
}

const seedRecords = (rows: SeedRecord[]) =>
  inBatches(
    rows.map((row) =>
      raw
        .prepare(
          `INSERT INTO records (id, app_slug, identity_key, status, data_json, source_url, evidence, observed_at, submitted_by,
             created_at, updated_at, verified_at)
           VALUES (?1, ?2, ?1, ?3, ?4, 'https://example.org/', 'A passage from the page.', ?5, ?6, ?5, ?5,
             CASE WHEN ?3 = 'verified' THEN ?5 END)`,
        )
        .bind(row.id, row.app, row.status, JSON.stringify(row.data ?? { name: row.id }), row.at, row.by),
    ),
  );

const seedTasks = (rows: { id: string; app: string; record: string; kind: string; status: string; at: string }[]) =>
  inBatches(
    rows.map((row) =>
      raw
        .prepare(
          `INSERT INTO tasks (id, app_slug, record_id, kind, status, created_at, done_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, CASE WHEN ?5 = 'done' THEN ?6 END)`,
        )
        .bind(row.id, row.app, row.record, row.kind, row.status, row.at),
    ),
  );

const seedVerdicts = (actor: string, app: string, count: number, at: (n: number) => string) =>
  inBatches(
    many(count, (n) =>
      raw
        .prepare(`INSERT INTO revisions (record_id, app_slug, actor, action, after_json, created_at) VALUES (?, ?, ?, 'verify', '{}', ?)`)
        .bind(`rec_${app}_${n}`, app, actor, at(n)),
    ),
  );

const token = (id: string, role: Token['role'], apps: string[]): Token => ({
  id,
  role,
  label: id,
  apps,
  status: 'active',
  pendingCap: role === 'collector' ? 5 : 50,
  dailyTaskLimit: role === 'maintainer' ? 2_000 : null,
  expiresAt: null,
  createdAt: now.toISOString(),
});

/* ───────── budgets ───────── */

describe('agent calls', { timeout: 30_000 }, () => {
  it('read a busy collector’s standing from its waiting records and one row, not its history', async () => {
    const busy = token('tok_busy', 'collector', ['ai-fundraising']);
    // antigravity-collector on 2026-10-06, and another collector's records beside them.
    await seedRecords([
      ...many(8, (n) => ({ id: `rec_p${n}`, app: 'ai-fundraising', status: 'pending', by: busy.id, at: ago(n) })),
      ...many(2_607, (n) => ({ id: `rec_v${n}`, app: 'ai-fundraising', status: 'verified', by: busy.id, at: ago(100 + n) })),
      ...many(17, (n) => ({ id: `rec_r${n}`, app: 'ai-fundraising', status: 'rejected', by: busy.id, at: ago(n) })),
      ...many(5, (n) => ({ id: `rec_m${n}`, app: 'ai-fundraising', status: 'merged', by: busy.id, at: ago(n) })),
      ...many(300, (n) => ({ id: `rec_o${n}`, app: 'ai-fundraising', status: n % 3 ? 'verified' : 'pending', by: 'tok_other', at: ago(n) })),
    ]);
    const expected = { pending: 8, verified: 2_607, rejected: 17, merged: 5, stale: 0, pending_cap: 50, warnings: [] };

    // The first call of the day counts the token's records once and keeps the counts.
    const first = await reads(() => standing(db, busy, 'ai-fundraising', now));
    expect(first.value).toEqual(expected);
    expect(first.rows).toBeLessThan(2_637 + 20);

    const again = await reads(() => standing(db, busy, 'ai-fundraising', now));
    expect(again.value).toEqual(expected);
    expect(again.rows).toBeLessThanOrEqual(12); // its 8 waiting records, and one row

    // A verdict moves the counts in its own batch, for a few rows more.
    const verdict = await reads(() =>
      db.batch([
        moveStanding(db, 'rec_p0', 'verified', 'pending'),
        db.prepare("UPDATE records SET status = 'verified', updated_at = ? WHERE id = ? AND status = 'pending'").bind(now.toISOString(), 'rec_p0'),
      ]),
    );
    expect(verdict.rows).toBeLessThanOrEqual(6);
    expect(await standing(db, busy, 'ai-fundraising', now)).toMatchObject({ pending: 7, verified: 2_608 });
  });

  it('answer GET /me for a token on every data app from a few rows an app, plus its own day', async () => {
    const everywhere = token('tok_maintainer', 'maintainer', ['*']);
    // mf-gemini-01's and mf-gemini-02's days on 2026-10-06, as one token, and an earlier day.
    await seedVerdicts(everywhere.id, 'ai-fundraising', 121, (n) => ago(n));
    await seedVerdicts(everywhere.id, 'ai-hackathons', 70, (n) => ago(n));
    await seedVerdicts(everywhere.id, 'ai-hackathons', 500, () => ago(2 * 24 * 60));
    const me = () =>
      Promise.all(dataApps.map(async (config) => [await standing(db, everywhere, config.slug, now), await workOf(db, config, everywhere, now)]));
    await me(); // the day's first: one count of each app's records

    const call = await reads(me);
    expect(call.value.find((_, index) => dataApps[index] === hackathons)?.[1]).toMatchObject({ done_today: 70 });
    expect(call.rows).toBeLessThanOrEqual(121 + 70 + 5 * dataApps.length);
  });

  it('lease from the open tasks, however many are done', async () => {
    const author = 'tok_busy';
    // AI Company Fundraising's queue on 2026-10-06: 2,662 done, 8 waiting for the admin, 3 open.
    await seedRecords(many(2_673, (n) => ({ id: `rec_${n}`, app: 'ai-fundraising', status: n < 2_662 ? 'verified' : 'pending', by: author, at: ago(3_000 - n) })));
    await seedTasks(
      many(2_673, (n) => ({
        id: `tsk_${String(n).padStart(5, '0')}`,
        app: 'ai-fundraising',
        record: `rec_${n}`,
        kind: 'verify',
        status: n < 2_662 ? 'done' : n < 2_670 ? 'review' : 'open',
        at: ago(3_000 - n),
      })),
    );
    const lease = await reads(() => leaseTasks(db, fundraising, token('tok_maintainer', 'maintainer', ['*']), 10, now));
    expect(lease.value.tasks.map((task) => task.record.id)).toEqual(['rec_2670', 'rec_2671', 'rec_2672']);
    expect(lease.rows).toBeLessThanOrEqual(30); // the open tasks and their records, twice: to lease, then to list
  });

  it('lease the tasks that need a browser first, through their own index, to a maintainer with one', async () => {
    const author = 'tok_busy';
    // The same queue, two of its open tasks waiting for a maintainer with a browser.
    await seedRecords(many(2_673, (n) => ({ id: `rec_${n}`, app: 'ai-fundraising', status: n < 2_662 ? 'verified' : 'pending', by: author, at: ago(3_000 - n) })));
    await seedTasks(
      many(2_673, (n) => ({
        id: `tsk_${String(n).padStart(5, '0')}`,
        app: 'ai-fundraising',
        record: `rec_${n}`,
        kind: 'verify',
        status: n < 2_662 ? 'done' : n < 2_670 ? 'review' : 'open',
        at: ago(3_000 - n),
      })),
    );
    await raw.batch([
      raw.prepare("INSERT INTO task_needs (task_id, need, since) VALUES ('tsk_02671', 'browser', ?)").bind(ago(30)),
      raw.prepare("INSERT INTO task_needs (task_id, need, since) VALUES ('tsk_02672', 'browser', ?)").bind(ago(20)),
      raw.prepare("INSERT INTO token_capabilities (token_id, capability) VALUES ('tok_browser', 'browser')"),
    ]);
    const plain = await reads(() => leaseTasks(db, fundraising, token('tok_plain', 'maintainer', ['*']), 10, now));
    expect(plain.value.tasks.map((task) => task.record.id)).toEqual(['rec_2670']);
    expect(plain.rows).toBeLessThanOrEqual(30);
    await raw.prepare("UPDATE tasks SET status = 'open', leased_to = NULL, lease_expires_at = NULL WHERE status = 'leased'").run();

    const browser = await reads(() => leaseTasks(db, fundraising, token('tok_browser', 'maintainer', ['*']), 2, now));
    expect(browser.value.tasks.map((task) => [task.record.id, task.needs])).toEqual([
      ['rec_2671', 'browser'],
      ['rec_2672', 'browser'],
    ]);
    expect(browser.rows).toBeLessThanOrEqual(30);
  });
});

describe('the stored dataset', { timeout: 30_000 }, () => {
  it('is read as its parts, refreshed from what changed, and built whole once a day', async () => {
    // AI Company Fundraising on 2026-10-06: 2,767 verified rounds, more than a D1 row holds.
    const round = (n: number) => ({
      company: `Company ${n}`,
      round: 'Series A',
      amount_usd: 12_000_000 + n,
      announced_on: '2026-09-30',
      investors: ['First Fund', 'Second Fund', 'Third Fund'],
      city: ['San Francisco'],
      country: 'United States',
      summary: 'The company said the round will fund hiring and its first product. '.repeat(5),
    });
    await seedRecords([
      ...many(2_767, (n) => ({ id: `rec_v${n}`, app: 'ai-fundraising', status: 'verified', by: 'tok_busy', at: ago(5_000 + n), data: round(n) })),
      ...many(8, (n) => ({ id: `rec_p${n}`, app: 'ai-fundraising', status: 'pending', by: 'tok_busy', at: ago(10 + n), data: round(n) })),
    ]);

    const build = await reads(() => buildDataset(db, fundraising, now));
    expect(build.rows).toBeLessThan(2_767 + 30); // once a day
    const parts = (await raw.prepare("SELECT COUNT(*) AS n FROM dataset_parts WHERE app_slug = 'ai-fundraising'").first<number>('n'))!;
    expect(parts).toBeGreaterThan(1);

    const read = await reads(() => datasetJson(db, fundraising, now));
    expect(read.rows).toBeLessThanOrEqual(parts + 1);
    expect(JSON.parse(read.value).records).toHaveLength(2_767);

    const unchanged = await reads(() => refreshDatasets(db, [fundraising], now));
    expect(unchanged.value).toBe(0);
    expect(unchanged.rows).toBeLessThanOrEqual(4);

    // Five minutes of work: five rounds verified, three submitted.
    const at = new Date(now.getTime() + MINUTE).toISOString();
    await raw.batch(many(5, (n) => raw.prepare("UPDATE records SET status = 'verified', verified_at = ?1, updated_at = ?1 WHERE id = ?2").bind(at, `rec_p${n}`)));
    await seedRecords(many(3, (n) => ({ id: `rec_new${n}`, app: 'ai-fundraising', status: 'pending', by: 'tok_busy', at })));
    const later = new Date(now.getTime() + 5 * MINUTE);
    const merge = await reads(() => refreshDatasets(db, [fundraising], later));
    expect(merge.value).toBe(1);
    expect(merge.rows).toBeLessThanOrEqual(parts + 50);
    const merged = JSON.parse(await datasetJson(raw, fundraising, later));
    expect(merged.records).toHaveLength(2_772);
    expect(merged.pending).toBe(6);
  });

  it('gives the catalog each app’s totals from one row an app', async () => {
    await seedRecords(dataApps.flatMap((config) => many(20, (n) => ({ id: `rec_${config.slug}_${n}`, app: config.slug, status: 'verified', by: 'seed', at: ago(n) }))));
    await refreshDatasets(db, dataApps, now);
    const catalog = await reads(() => appSummaries(db, dataApps, now));
    expect(catalog.value.every((summary) => summary.verified === 20)).toBe(true);
    expect(catalog.rows).toBeLessThanOrEqual(dataApps.length + 1);
  });
});

describe('the cron', { timeout: 30_000 }, () => {
  it('reads the records that just came due, not the queued backlog or every task ever done', async () => {
    // 400 records due for a recheck two days ago, each already queued, beside 3,000 done tasks.
    const dueSince = new Date(now.getTime() - (hackathons.recheckAfterDays + 2) * DAY).toISOString();
    await seedRecords([
      ...many(400, (n) => ({ id: `rec_due${n}`, app: 'ai-hackathons', status: 'verified', by: 'tok_scout', at: dueSince })),
      ...many(3_000, (n) => ({ id: `rec_done${n}`, app: 'ai-hackathons', status: 'verified', by: 'tok_scout', at: ago(n) })),
    ]);
    await seedTasks([
      ...many(400, (n) => ({ id: `tsk_due${n}`, app: 'ai-hackathons', record: `rec_due${n}`, kind: 'recheck', status: 'open', at: ago(60) })),
      ...many(3_000, (n) => ({ id: `tsk_done${n}`, app: 'ai-hackathons', record: `rec_done${n}`, kind: 'verify', status: 'done', at: ago(n) })),
    ]);
    // A day of Idempotency-Key answers, three of them past it.
    await inBatches(
      many(120, (n) =>
        raw
          .prepare("INSERT INTO idempotency (token_id, key, response_json, created_at) VALUES ('tok_scout', ?, '{}', ?)")
          .bind(`key-${n}`, n < 3 ? ago(25 * 60) : ago(n)),
      ),
    );

    const run = await reads(() => maintain(db, [hackathons], now));
    expect(run.value).toEqual({ released: 0, rechecks: 0, escalated: 0 });
    // A row or two more than before the routing tables (task_needs, task_waits), which the run walks
    // whole: they hold only the tasks waiting for a browser or for a duplicate, never the history.
    expect(run.rows).toBeLessThanOrEqual(14);

    // The day's first run looks at every due record: each one, and a lookup of its tasks for each
    // waiting status (open, leased, review), however many tasks the record has had.
    const daily = await reads(() => maintain(db, [hackathons], now, { everyDueRecord: true }));
    expect(daily.value.rechecks).toBe(0);
    expect(daily.rows).toBeLessThanOrEqual(4 * 400 + 12);

    // A record that comes due gets its recheck from the next run.
    await raw.prepare('UPDATE records SET verified_at = ? WHERE id = ?').bind(new Date(now.getTime() - hackathons.recheckAfterDays * DAY - MINUTE).toISOString(), 'rec_done0').run();
    expect((await maintain(db, [hackathons], now)).rechecks).toBe(1);
  });
});
