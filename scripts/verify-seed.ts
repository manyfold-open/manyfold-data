/**
 * Opens every seed record's source page and checks that its evidence quote is on it.
 * Reads the network, changes nothing. Exits 1 when a quote is missing, so a seed that
 * went stale fails here before it is loaded anywhere.
 *
 *   npm run seed:verify
 *
 * A draft seed file can be checked the same way before it is committed, with the
 * submit API's validation as well (fields, provenance, accepted ranges):
 *
 *   npm run seed:verify -- --app ai-fundraising --file draft.json
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataApps } from '../data-apps/index.ts';
import { checkAccept, validateProvenance, validateRecordData, type DataAppConfig } from '../src/shared/data-app.ts';
import type { SeedEntry } from './seed.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * Lowercase text with entities decoded and quotes, dashes and whitespace made uniform.
 * Whitespace before punctuation goes too: removing tags turns "5<sup>th</sup>," into "5th ,".
 */
function normalize(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match)
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/ ([,.;:!?)])/g, '$1')
    .trim()
    .toLowerCase();
}

/** Visible text of a page: scripts and styles dropped, tags turned into spaces. */
const visibleText = (html: string): string =>
  html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

/** Raw page with JSON string escapes undone, for pages that ship their text inside JSON. */
const unescapedHtml = (html: string): string =>
  html
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\n/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/<[^>]+>/g, ' ');

type Outcome = 'found' | 'missing' | `unreachable: ${string}`;

async function check(entry: SeedEntry): Promise<Outcome> {
  let html: string;
  try {
    const response = await fetch(entry.source_url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; manyfold-data seed check)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return `unreachable: HTTP ${response.status}`;
    html = await response.text();
  } catch (error) {
    return `unreachable: ${error instanceof Error ? error.message : String(error)}`;
  }
  const quote = normalize(entry.evidence);
  return normalize(visibleText(html)).includes(quote) || normalize(unescapedHtml(html)).includes(quote)
    ? 'found'
    : 'missing';
}

/** A record's title, for the report: its first Table column. */
const titleOf = (app: DataAppConfig, entry: SeedEntry): string => String(entry.data?.[app.table.columns[0] ?? 'name'] ?? 'untitled');

/** What the submit API would refuse in a draft entry, as readable reasons. */
function refusals(app: DataAppConfig, entry: SeedEntry): string[] {
  const data = validateRecordData(app, entry.data);
  const provenance = validateProvenance(entry, new Date());
  const errors = [...(data.ok ? [] : data.errors), ...(provenance.ok ? [] : provenance.errors)];
  if (data.ok && provenance.ok) errors.push(...checkAccept(app, data.value, provenance.value.observed_at.slice(0, 10)));
  return errors.map((error) => `${error.field} ${error.message}`);
}

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

let missing = 0;
let unreachable = 0;
let invalid = 0;

const draft = option('--file');
const runs: { app: DataAppConfig; entries: SeedEntry[] }[] = [];
if (draft) {
  const app = dataApps.find((candidate) => candidate.slug === option('--app'));
  if (!app) {
    console.error(`--app must name a data app: ${dataApps.map((candidate) => candidate.slug).join(', ')}`);
    process.exit(2);
  }
  runs.push({ app, entries: JSON.parse(readFileSync(draft, 'utf8')) as SeedEntry[] });
} else {
  for (const app of dataApps) {
    const file = join(root, 'data-apps', app.slug, 'seed.json');
    if (existsSync(file)) runs.push({ app, entries: JSON.parse(readFileSync(file, 'utf8')) as SeedEntry[] });
  }
}

for (const { app, entries } of runs) {
  const outcomes = await Promise.all(entries.map(check));
  entries.forEach((entry, index) => {
    const outcome = outcomes[index]!;
    const reasons = draft ? refusals(app, entry) : [];
    if (reasons.length > 0) invalid += 1;
    if (outcome === 'missing') missing += 1;
    else if (outcome !== 'found') unreachable += 1;
    const ok = outcome === 'found' && reasons.length === 0;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${app.slug} #${index + 1}  ${titleOf(app, entry)}  ${outcome}${reasons.map((reason) => `\n        ${reason}`).join('')}`);
  });
}

console.log(`\n${missing} quote(s) missing, ${unreachable} page(s) unreachable${draft ? `, ${invalid} record(s) the API would refuse` : ''}.`);
if (unreachable > 0) console.log('Unreachable pages need a check by hand.');
process.exit(missing > 0 || invalid > 0 ? 1 : 0);
