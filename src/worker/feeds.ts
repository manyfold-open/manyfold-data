/**
 * The verified records in forms other tools read: an RSS feed of the newest, and every
 * record as CSV or JSON. All three carry the source of each record and the license.
 */

import type { DataAppConfig, FieldValue, RecordData } from '../shared/data-app';
import { fillLine } from './notify';

export interface ExportRecord {
  id: string;
  data: RecordData;
  source_url: string;
  evidence: string;
  observed_at: string;
  verified_at: string;
}

/** Verified records, newest verification first. */
export async function verifiedRecords(db: D1Database, config: DataAppConfig, limit?: number): Promise<ExportRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT id, data_json, source_url, evidence, observed_at, verified_at FROM records
       WHERE app_slug = ? AND status = 'verified' ORDER BY verified_at DESC, id DESC LIMIT ?`,
    )
    .bind(config.slug, limit ?? -1)
    .all<Omit<ExportRecord, 'data'> & { data_json: string }>();
  return results.map(({ data_json, ...row }) => ({ ...row, data: JSON.parse(data_json) as RecordData }));
}

const title = (config: DataAppConfig, data: RecordData) => String(data[config.table.columns[0] ?? 'name'] ?? 'Untitled');

/* ───────── RSS ───────── */

const xml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);

const rfc822 = (iso: string) => new Date(iso).toUTCString();

export function rss(config: DataAppConfig, records: readonly ExportRecord[], origin: string, now: Date): string {
  const home = `${origin}/${config.slug}`;
  const items = records
    .map((record) => {
      const link = `${home}/r/${record.id}`;
      return `    <item>
      <title>${xml(title(config, record.data))}</title>
      <link>${xml(link)}</link>
      <guid isPermaLink="true">${xml(link)}</guid>
      <pubDate>${rfc822(record.verified_at)}</pubDate>
      <description>${xml(`${fillLine(config, record.data)}. Source: ${record.source_url}`)}</description>
    </item>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xml(`${config.title} · Manyfold Data`)}</title>
    <link>${xml(home)}</link>
    <description>${xml(config.description)}</description>
    <atom:link href="${xml(`${home}/feed.xml`)}" rel="self" type="application/rss+xml"/>
    <lastBuildDate>${now.toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}

/* ───────── CSV and JSON ───────── */

const cellText = (value: FieldValue | undefined): string =>
  value === undefined ? '' : Array.isArray(value) ? value.join('; ') : String(value);

/** One CSV cell: quoted when needed, and never read as a formula by a spreadsheet. */
function csvCell(text: string): string {
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function csv(config: DataAppConfig, records: readonly ExportRecord[], origin: string): string {
  const fields = Object.keys(config.fields);
  const header = ['id', ...fields, 'source_url', 'evidence', 'observed_at', 'verified_at', 'record_url'];
  const rows = records.map((record) => [
    record.id,
    ...fields.map((field) => cellText(record.data[field])),
    record.source_url,
    record.evidence,
    record.observed_at,
    record.verified_at,
    `${origin}/${config.slug}/r/${record.id}`,
  ]);
  return `${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function json(config: DataAppConfig, records: readonly ExportRecord[], origin: string, now: Date) {
  return {
    data_app: config.slug,
    title: config.title,
    license: config.license,
    source: `${origin}/${config.slug}`,
    exported_at: now.toISOString(),
    records: records.map((record) => ({ ...record, record_url: `${origin}/${config.slug}/r/${record.id}` })),
  };
}
