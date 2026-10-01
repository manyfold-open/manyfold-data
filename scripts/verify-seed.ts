/**
 * Opens every seed record's source page and checks that its evidence quote is on it.
 * Reads the network, changes nothing. Exits 1 when a quote is missing, so a seed that
 * went stale fails here before it is loaded anywhere.
 *
 *   npm run seed:verify
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataApps } from '../data-apps/index.ts';
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

let missing = 0;
let unreachable = 0;
for (const app of dataApps) {
  const file = join(root, 'data-apps', app.slug, 'seed.json');
  if (!existsSync(file)) continue;
  const entries = JSON.parse(readFileSync(file, 'utf8')) as SeedEntry[];
  const outcomes = await Promise.all(entries.map(check));
  entries.forEach((entry, index) => {
    const outcome = outcomes[index]!;
    if (outcome === 'missing') missing += 1;
    else if (outcome !== 'found') unreachable += 1;
    console.log(`${outcome === 'found' ? 'ok  ' : 'FAIL'}  ${app.slug} #${index + 1}  ${String(entry.data.name)}  ${outcome}`);
  });
}

console.log(`\n${missing} quote(s) missing, ${unreachable} page(s) unreachable.`);
if (unreachable > 0) console.log('Unreachable pages need a check by hand.');
process.exit(missing > 0 ? 1 : 0);
