/**
 * D1 access shared by every route. The schema is applied on the first request rather
 * than through migrations, so `npm run dev` works with no setup and a fresh production
 * database needs no extra step. Every statement is idempotent.
 */

import { SCHEMA, schemaStatements } from './schema';

const ready = new WeakMap<D1Database, Promise<void>>();

/** Idempotent; runs once per database binding, and retries on the next request if it fails. */
export function ensureSchema(db: D1Database): Promise<void> {
  let applied = ready.get(db);
  if (!applied) {
    applied = db
      .batch(schemaStatements(SCHEMA).map((statement) => db.prepare(statement)))
      .then(() => undefined)
      .catch((error) => {
        ready.delete(db);
        throw error;
      });
    ready.set(db, applied);
  }
  return applied;
}

/** A field value read out of a record's JSON. `field` must come from a config. */
export const fieldSql = (field: string): string => `json_extract(data_json, '$.${field}')`;
