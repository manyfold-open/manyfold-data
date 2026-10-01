/**
 * The D1 schema. The Worker applies it on the first request of each isolate
 * (src/worker/db.ts), and every seed file starts with it (scripts/seed.ts).
 *
 * There is no migration step: evolve it only with CREATE TABLE / CREATE INDEX IF NOT
 * EXISTS, and keep semicolons out of statement bodies and comments, because
 * schemaStatements() splits on every one. This file imports nothing so Node scripts
 * can load it.
 *
 * Milestone 1 reads only records and revisions. The other tables exist now so later
 * milestones add code rather than schema.
 */

export const SCHEMA = `
-- One row per record. Field values live in data_json, provenance in its own columns.
CREATE TABLE IF NOT EXISTS records (
  id           TEXT PRIMARY KEY,
  app_slug     TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  status       TEXT NOT NULL,
  data_json    TEXT NOT NULL,
  source_url   TEXT NOT NULL,
  evidence     TEXT NOT NULL,
  observed_at  TEXT NOT NULL,
  submitted_by TEXT NOT NULL,
  merged_into  TEXT,
  flagged      INTEGER NOT NULL DEFAULT 0,
  verified_at  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Two live records can never share an identity. Rejected, merged and stale ones can.
CREATE UNIQUE INDEX IF NOT EXISTS records_identity ON records (app_slug, identity_key)
  WHERE status IN ('pending', 'verified');
CREATE INDEX IF NOT EXISTS records_listing ON records (app_slug, status, verified_at);
CREATE INDEX IF NOT EXISTS records_submitter ON records (submitted_by, status);

-- Every change to a record. Reverting a token replays its rows newest first.
CREATE TABLE IF NOT EXISTS revisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id   TEXT NOT NULL,
  app_slug    TEXT NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT NOT NULL,
  reason      TEXT,
  source_url  TEXT,
  evidence    TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS revisions_record ON revisions (record_id, id);
CREATE INDEX IF NOT EXISTS revisions_actor ON revisions (actor, id);

-- Agent credentials. Only a hash of each secret is stored.
CREATE TABLE IF NOT EXISTS tokens (
  id               TEXT PRIMARY KEY,
  secret_hash      TEXT NOT NULL UNIQUE,
  role             TEXT NOT NULL,
  label            TEXT NOT NULL,
  apps_json        TEXT NOT NULL,
  status           TEXT NOT NULL,
  pending_cap      INTEGER,
  daily_task_limit INTEGER,
  expires_at       TEXT,
  last_used_at     TEXT,
  created_at       TEXT NOT NULL
);

-- Maintainer work. A lease reserves a task for one token.
CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  app_slug         TEXT NOT NULL,
  record_id        TEXT NOT NULL,
  kind             TEXT NOT NULL,
  status           TEXT NOT NULL,
  leased_to        TEXT,
  lease_expires_at TEXT,
  created_at       TEXT NOT NULL,
  done_at          TEXT
);
CREATE INDEX IF NOT EXISTS tasks_queue ON tasks (app_slug, status, created_at);

-- Verified records waiting to be announced.
CREATE TABLE IF NOT EXISTS outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  app_slug   TEXT NOT NULL,
  record_id  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at    TEXT
);

-- Replies to submits that carried an Idempotency-Key, kept for 24 hours.
CREATE TABLE IF NOT EXISTS idempotency (
  token_id      TEXT NOT NULL,
  key           TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (token_id, key)
);

-- Reader reports from record pages.
CREATE TABLE IF NOT EXISTS reports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id  TEXT NOT NULL,
  reason     TEXT NOT NULL,
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_open ON reports (status, record_id);

-- Settings made in /settings, such as the sealed Discord webhook URL.
CREATE TABLE IF NOT EXISTS app_settings (
  app_slug   TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_slug, key)
);

-- The admin's weekly accuracy check: one mark per sampled record per ISO week.
CREATE TABLE IF NOT EXISTS spot_checks (
  week       TEXT NOT NULL,
  app_slug   TEXT NOT NULL,
  record_id  TEXT NOT NULL,
  correct    INTEGER NOT NULL,
  note       TEXT,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (week, record_id)
);

-- Fixed-window counters for rate limits, the same shape as tarot_rate.
CREATE TABLE IF NOT EXISTS rate_counters (
  bucket       TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_counters_window ON rate_counters (window_start);
`;

/**
 * Split SQL into statements: drop `--` comment lines first, then split on ';'.
 * Comments go first because they may contain punctuation that would otherwise split a
 * statement in half. Statement bodies may not.
 */
export function schemaStatements(sql: string): string[] {
  return sql
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}
