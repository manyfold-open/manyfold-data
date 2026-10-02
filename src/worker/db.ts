/**
 * D1 access shared by every route. The schema is applied on the first request rather
 * than through migrations, so `npm run dev` works with no setup and a fresh production
 * database needs no extra step. Every statement is idempotent.
 *
 * A database already at this schema skips the statements: a fingerprint of SCHEMA is stored
 * once it is applied, so a new Worker instance pays one small read instead of every CREATE.
 * Change SCHEMA and the fingerprint changes with it; there is nothing to bump by hand.
 */

import { SCHEMA, schemaStatements } from './schema';

/** FNV-1a over the schema text: different SQL, different fingerprint. */
function fingerprintOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export const SCHEMA_FINGERPRINT = fingerprintOf(SCHEMA);

const ready = new WeakMap<D1Database, Promise<void>>();

async function apply(db: D1Database): Promise<void> {
  try {
    const stored = await db
      .prepare("SELECT value FROM app_settings WHERE app_slug = '*' AND key = 'schema'")
      .first<{ value: string }>();
    if (stored?.value === SCHEMA_FINGERPRINT) return;
  } catch {
    // A new database has no app_settings table yet: apply everything.
  }
  await db.batch([
    ...schemaStatements(SCHEMA).map((statement) => db.prepare(statement)),
    db
      .prepare(
        `INSERT INTO app_settings (app_slug, key, value, updated_at) VALUES ('*', 'schema', ?, ?)
         ON CONFLICT (app_slug, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(SCHEMA_FINGERPRINT, new Date().toISOString()),
  ]);
}

/** Idempotent; runs once per database binding, and retries on the next request if it fails. */
export function ensureSchema(db: D1Database): Promise<void> {
  let applied = ready.get(db);
  if (!applied) {
    applied = apply(db).catch((error) => {
      ready.delete(db);
      throw error;
    });
    ready.set(db, applied);
  }
  return applied;
}

