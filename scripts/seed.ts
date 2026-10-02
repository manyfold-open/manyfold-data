/**
 * Builds .wrangler/seed.sql: the schema, then each data app's seed records as verified
 * rows with a two-step history (submit, verify). Loaded by `npm run db:seed:local` and
 * `npm run db:seed:remote`.
 *
 * Seeds pass the same validation the submit API uses. Record ids come from each
 * record's identity, and every statement is insert-if-absent, so loading the seed
 * twice adds nothing and never overwrites a record that has changed since.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataApps } from '../data-apps/index.ts';
import {
  identityKey,
  validateConfig,
  validateProvenance,
  validateRecordData,
} from '../src/shared/data-app.ts';
import { SCHEMA } from '../src/worker/schema.ts';

export interface SeedEntry {
  data: Record<string, unknown>;
  source_url: string;
  evidence: string;
  observed_at: string;
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.wrangler', 'seed.sql');

const text = (value: string | null): string => (value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`);
const recordId = (slug: string, key: string): string =>
  `rec_${createHash('sha256').update(`${slug}|${key}`).digest('hex').slice(0, 24)}`;

// No trailing semicolon: statements are joined with one below, and remote D1 rejects an empty statement.
const statements: string[] = [SCHEMA.trim().replace(/;$/, '')];
const problems: string[] = [];
let count = 0;

for (const app of dataApps) {
  problems.push(...validateConfig(app));
  const file = join(root, 'data-apps', app.slug, 'seed.json');
  if (!existsSync(file)) continue;

  const entries = JSON.parse(readFileSync(file, 'utf8')) as SeedEntry[];
  const keys = new Map<string, number>();

  entries.forEach((entry, index) => {
    const label = `${app.slug} seed #${index + 1} (${String(entry.data?.[app.table.columns[0] ?? 'name'] ?? 'untitled')})`;
    const data = validateRecordData(app, entry.data);
    const provenance = validateProvenance(entry);
    if (!data.ok || !provenance.ok) {
      for (const error of [...(data.ok ? [] : data.errors), ...(provenance.ok ? [] : provenance.errors)]) {
        problems.push(`${label}: ${error.field} ${error.message}`);
      }
      return;
    }

    const key = identityKey(app, data.value);
    const twin = keys.get(key);
    if (twin !== undefined) {
      problems.push(`${label}: same identity as seed #${twin + 1} (${key})`);
      return;
    }
    keys.set(key, index);

    const id = recordId(app.slug, key);
    const { source_url, evidence, observed_at } = provenance.value;
    const dataJson = JSON.stringify(data.value);
    statements.push(
      `INSERT OR IGNORE INTO records (id, app_slug, identity_key, status, data_json, source_url, evidence,
  observed_at, submitted_by, verified_at, created_at, updated_at)
VALUES (${[id, app.slug, key, 'verified', dataJson, source_url, evidence, observed_at, 'seed', observed_at, observed_at, observed_at].map(text).join(', ')})`,
    );
    const history: [string, string, string | null][] = [
      ['submit', JSON.stringify({ status: 'pending', data: data.value }), null],
      ['verify', JSON.stringify({ status: 'verified' }), 'Seed record, checked against its source page before launch.'],
    ];
    for (const [action, after, reason] of history) {
      statements.push(
        `INSERT INTO revisions (record_id, app_slug, actor, action, before_json, after_json, reason, source_url,
  evidence, created_at)
SELECT ${[id, app.slug, 'seed', action].map(text).join(', ')}, NULL, ${[after, reason, source_url, evidence, observed_at].map(text).join(', ')}
WHERE NOT EXISTS (SELECT 1 FROM revisions WHERE record_id = ${text(id)} AND actor = 'seed' AND action = ${text(action)})`,
      );
    }
    count += 1;
  });
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} problem(s); no seed file written.`);
  process.exit(1);
}

mkdirSync(dirname(out), { recursive: true });
// Seeded rows carry the time they were checked, which can be older than the newest record, so
// the stored datasets' versions would not see them: drop the datasets and let them rebuild.
statements.push('DELETE FROM datasets');
writeFileSync(out, `${statements.join(';\n\n')};\n`);
console.log(`${count} seed record(s) from ${dataApps.length} data app(s) → ${out}`);
