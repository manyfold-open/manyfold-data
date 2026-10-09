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
-- The last change to a data app's records, the dataset's version: one row through this index.
CREATE INDEX IF NOT EXISTS records_changed ON records (app_slug, updated_at);
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
-- A maintainer's verdicts today, counted on every lease and skill fetch: a range, not a scan.
CREATE INDEX IF NOT EXISTS revisions_actor_time ON revisions (actor, created_at);
-- The same count for one data app. A token for every app asks it once per app on GET /me, and
-- must not read its whole day for each one.
CREATE INDEX IF NOT EXISTS revisions_actor_app_time ON revisions (actor, app_slug, created_at);

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

-- A token's reviewed records on one data app, by status, for GET /me, its skill and submit: one row
-- instead of a count over everything it ever sent, which was 2,637 rows a call for one collector.
-- Every status change moves these counts in the same batch (moveStanding, src/worker/tokens.ts),
-- and a row a day old is counted again. Pending records are counted live: the cap depends on them.
CREATE TABLE IF NOT EXISTS standings (
  token_id   TEXT NOT NULL,
  app_slug   TEXT NOT NULL,
  verified   INTEGER NOT NULL,
  rejected   INTEGER NOT NULL,
  merged     INTEGER NOT NULL,
  stale      INTEGER NOT NULL,
  counted_at TEXT NOT NULL,
  PRIMARY KEY (token_id, app_slug)
);

-- Maintainer work. A lease reserves a task for one token. Status: open, leased, done, review (waits
-- for the admin), blocked (parked as a duplicate of a record still waiting) or cancelled.
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
-- What a lease takes from, oldest first: the open and leased tasks only. Done ones are kept forever,
-- and a lease that walked them all read 1,611 rows on average.
CREATE INDEX IF NOT EXISTS tasks_open ON tasks (app_slug, created_at, id) WHERE status IN ('open', 'leased');
-- The leases the cron releases, found by expiry instead of a scan of every task.
CREATE INDEX IF NOT EXISTS tasks_leased ON tasks (lease_expires_at) WHERE status = 'leased';
-- A record's tasks: the cron looks for a waiting one before it adds a recheck, once per due record.
CREATE INDEX IF NOT EXISTS tasks_record ON tasks (record_id, status);

-- Each data app's public dataset, built from its records (src/worker/records.ts). Its head holds what
-- it was built from, when it was last built whole, and the totals the catalog shows. The JSON itself
-- is in dataset_parts, cut into pieces under D1's 2 MB row limit, so a reader costs a row or a few,
-- never a scan of records.
CREATE TABLE IF NOT EXISTS dataset_heads (
  app_slug     TEXT PRIMARY KEY,
  records_at   TEXT,
  invite_at    TEXT,
  verified     INTEGER NOT NULL,
  last_updated TEXT,
  built_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dataset_parts (
  app_slug TEXT NOT NULL,
  part     INTEGER NOT NULL,
  json     TEXT NOT NULL,
  PRIMARY KEY (app_slug, part)
);

-- Verified records waiting to be announced.
CREATE TABLE IF NOT EXISTS outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  app_slug   TEXT NOT NULL,
  record_id  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at    TEXT
);
-- Every cron run reads only what is unsent, and its sweep drops old rows by age.
CREATE INDEX IF NOT EXISTS outbox_unsent ON outbox (app_slug, id) WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS outbox_age ON outbox (created_at);

-- Replies to submits that carried an Idempotency-Key, kept for 24 hours.
CREATE TABLE IF NOT EXISTS idempotency (
  token_id      TEXT NOT NULL,
  key           TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (token_id, key)
);
-- The cron drops answers past their day by age instead of reading every one.
CREATE INDEX IF NOT EXISTS idempotency_age ON idempotency (created_at);

-- Reader reports from record pages.
CREATE TABLE IF NOT EXISTS reports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id  TEXT NOT NULL,
  reason     TEXT NOT NULL,
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_open ON reports (status, record_id);

-- Readers' requests for data to track, from the front page (src/worker/requests.ts). The cron
-- posts the unsent ones to the site's requests channel on Discord and stamps sent_at. Kept
-- until the admin deletes one. No IP address or country is stored with them.
CREATE TABLE IF NOT EXISTS data_requests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  topic      TEXT NOT NULL,
  details    TEXT,
  contact    TEXT,
  created_at TEXT NOT NULL,
  sent_at    TEXT
);
CREATE INDEX IF NOT EXISTS data_requests_unsent ON data_requests (id) WHERE sent_at IS NULL;

-- Settings made in /settings, such as the sealed Discord webhook URL. Rows under app_slug '*'
-- belong to the whole site: the schema fingerprint and the requests channel.
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

-- What a token can do beyond its role, such as open pages in a real browser.
CREATE TABLE IF NOT EXISTS token_capabilities (
  token_id   TEXT NOT NULL,
  capability TEXT NOT NULL,
  PRIMARY KEY (token_id, capability)
);

-- A task only some maintainers can do: one whose pages a maintainer could not open goes first to a
-- maintainer with a browser, and to the admin after a day without one.
CREATE TABLE IF NOT EXISTS task_needs (
  task_id TEXT PRIMARY KEY,
  need    TEXT NOT NULL,
  since   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_needs_need ON task_needs (need, since);

-- A task parked (status 'blocked') until another record still waiting for review is decided: a
-- maintainer found its record a duplicate of that one (src/worker/waits.ts).
CREATE TABLE IF NOT EXISTS task_waits (
  task_id    TEXT PRIMARY KEY,
  record_id  TEXT NOT NULL,
  waits_for  TEXT NOT NULL,
  by_token   TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_waits_for ON task_waits (waits_for);

-- The admin's decisions that state a rule, kept until the rule is written into the data app's config.
CREATE TABLE IF NOT EXISTS precedents (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  app_slug   TEXT NOT NULL,
  record_id  TEXT NOT NULL,
  decision   TEXT NOT NULL,
  rule       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  adopted_at TEXT
);
CREATE INDEX IF NOT EXISTS precedents_open ON precedents (created_at) WHERE adopted_at IS NULL;

-- A record's spot checks, read for the quality of the maintainer whose verdict they look at again.
CREATE INDEX IF NOT EXISTS spot_checks_record ON spot_checks (record_id, checked_at);

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
