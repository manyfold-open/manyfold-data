/**
 * A D1Database double on node:sqlite. D1 is SQLite, so the Worker's real SQL — JSON
 * functions, partial indexes, upserts with RETURNING — runs unchanged; only this async
 * wrapper is ours. Each call gives a fresh in-memory database.
 */

import { DatabaseSync } from 'node:sqlite';

export function createD1(): D1Database {
  const sqlite = new DatabaseSync(':memory:');

  const statement = (sql: string, params: unknown[] = []) => ({
    sql,
    bind: (...values: unknown[]) => statement(sql, values),
    first: async (column?: string) => {
      const row = sqlite.prepare(sql).get(...params);
      if (!row) return null;
      return column ? row[column] : row;
    },
    all: async () => ({ results: sqlite.prepare(sql).all(...params), success: true, meta: {} }),
    run: async () => {
      const info = sqlite.prepare(sql).run(...params);
      return { results: [], success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    },
    raw: async () => sqlite.prepare(sql).all(...params).map((row) => Object.values(row)),
  });

  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: { sql: string; all: () => Promise<unknown>; run: () => Promise<unknown> }[]) => {
      // D1 runs a batch as one transaction; so does this. Writes report their changes.
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const item of statements) {
          results.push(await (/^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(item.sql) ? item.all() : item.run()));
        }
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;
}
