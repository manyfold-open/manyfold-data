/**
 * Readers' requests for data to track, from the front page's "Request a data app" card
 * (POST /api/requests in index.ts). Each is stored first. Every cron run then posts the
 * waiting ones to the site's requests channel on Discord (SITE_CHANNEL in notify.ts) as one
 * message, oldest first, and marks only those as sent. With no channel set, or while it is
 * paused, requests wait in the table and go out once it works.
 *
 * What readers wrote is escaped before it reaches Discord, and every line of a post starts
 * with our own bullet, so no text of theirs can begin a line and become a heading or a list.
 */

import type { NewDataRequest } from '../shared/data-request';
import type { DataRequest, DataRequestsAdmin } from '../shared/types';
import { channelStatus, CONTENT_MAX, deliver, escapeDiscord, openChannel, SITE_CHANNEL } from './notify';
import { HttpError, type Env } from './types';

/** Requests the admin sees in /settings, newest first. */
const LIST_MAX = 50;
/** Requests one post carries at most. A run reads one more, to know whether any wait behind them. */
const BATCH_MAX = 50;
/**
 * How much of each field a post carries; /settings shows all of it. Even fully escaped, one
 * request then takes under 1,500 characters, so the first always fits in a post.
 */
const CLIP = { topic: 120, details: 500, contact: 100 } as const;
const MORE = 'More requests wait for the next post.';

type RequestRow = Pick<DataRequest, 'id' | 'topic' | 'details' | 'contact'>;

export async function createRequest(db: D1Database, request: NewDataRequest, now: Date): Promise<void> {
  await db
    .prepare('INSERT INTO data_requests (topic, details, contact, created_at) VALUES (?, ?, ?, ?)')
    .bind(request.topic, request.details, request.contact, now.toISOString())
    .run();
}

/** For a reader who asks to have theirs removed, or spam before it is posted. A post already sent stays in Discord. */
export async function deleteRequest(db: D1Database, id: number): Promise<void> {
  const result = await db.prepare('DELETE FROM data_requests WHERE id = ?').bind(id).run();
  if (!result.meta.changes) throw new HttpError(404, 'not_found', 'No data request has that id.');
}

export async function requestsAdmin(db: D1Database): Promise<DataRequestsAdmin> {
  const { results } = await db
    .prepare('SELECT id, topic, details, contact, created_at, sent_at FROM data_requests ORDER BY id DESC LIMIT ?')
    .bind(LIST_MAX)
    .all<DataRequest>();
  const waiting = await db.prepare('SELECT COUNT(*) AS n FROM data_requests WHERE sent_at IS NULL').first<number>('n');
  return { channel: await channelStatus(db, SITE_CHANNEL, waiting ?? 0), items: results };
}

export const requestsTestMessage = (origin: string): string =>
  `Test message from Manyfold Data. Data requests readers send from <${origin}> will appear here.`;

/** One line of at most `max` characters, ending in … when cut. Counts characters, so an emoji is never split. */
function clip(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

/** One request in a post: • **topic** — details · contact: … */
export function requestLine(item: Pick<DataRequest, 'topic' | 'details' | 'contact'>): string {
  const details = item.details ? clip(item.details, CLIP.details) : '';
  const contact = item.contact ? clip(item.contact, CLIP.contact) : '';
  return [
    `• **${escapeDiscord(clip(item.topic, CLIP.topic))}**`,
    details ? ` — ${escapeDiscord(details)}` : '',
    contact ? ` · contact: ${escapeDiscord(contact)}` : '',
  ].join('');
}

const head = (count: number): string => `**${count} new data ${count === 1 ? 'request' : 'requests'}**`;

/**
 * One post from the waiting requests, oldest first: as many as fit in Discord's 2,000
 * characters. It stops at the first that does not fit, so what it carries is always a prefix
 * and `last` (the id of its newest request) marks exactly those as sent.
 */
export function requestsPost(items: readonly RequestRow[]): { content: string; count: number; last: number } {
  const lines: string[] = [];
  for (const item of items.slice(0, BATCH_MAX)) {
    const line = requestLine(item);
    if ([head(lines.length + 1), ...lines, line, MORE].join('\n').length > CONTENT_MAX) break;
    lines.push(line);
  }
  const count = lines.length;
  return {
    content: [head(count), ...lines, ...(count < items.length ? [MORE] : [])].join('\n'),
    count,
    last: items[count - 1]!.id,
  };
}

/** The cron's step for the requests channel: at most one post, as flushOutbox makes per data app. */
export async function flushRequests(
  db: D1Database,
  env: Env,
  now: Date,
  fetcher: typeof fetch = fetch,
): Promise<{ sent: number; failed: number }> {
  const channel = await openChannel(db, env, SITE_CHANNEL);
  if (!channel) return { sent: 0, failed: 0 };
  const { results } = await db
    .prepare('SELECT id, topic, details, contact FROM data_requests WHERE sent_at IS NULL ORDER BY id LIMIT ?')
    .bind(BATCH_MAX + 1)
    .all<RequestRow>();
  if (results.length === 0) return { sent: 0, failed: 0 };

  const post = requestsPost(results);
  const markSent = db
    .prepare('UPDATE data_requests SET sent_at = ? WHERE sent_at IS NULL AND id <= ?')
    .bind(now.toISOString(), post.last);
  return (await deliver(db, channel, post.content, [markSent], now, fetcher)) ? { sent: 1, failed: 0 } : { sent: 0, failed: 1 };
}
