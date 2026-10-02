/**
 * Discord. The site posts to two kinds of channel, each through a webhook stored sealed:
 *
 *   - each data app's announcements: a verdict that makes a record public adds it to the
 *     outbox, and each cron run sends a data app's waiting records as one message, so a busy
 *     hour is one post, not a flood;
 *   - the site's requests channel (SITE_CHANNEL), where readers' data requests from the front
 *     page go (src/worker/requests.ts), also at most one post per cron run.
 *
 * Text from strangers is escaped and pings are switched off (`allowed_mentions`).
 *
 * Per channel, app_settings holds the sealed webhook, a masked copy for display, and the
 * delivery state: active, paused, or failing after 5 failed sends in a row. A failing
 * webhook is still tried each run, so a channel that comes back recovers by itself.
 */

import { valueLabel, withUnit, type DataAppConfig, type RecordData } from '../shared/data-app';
import type { DiscordChannel, NotifyStatus } from '../shared/types';
import { seal, unseal, type Sealed } from './crypto';
import { HttpError, type Env } from './types';

/** The requests channel's app_slug: the site's own settings, where db.ts keeps the schema fingerprint. */
export const SITE_CHANNEL = '*';

const WEBHOOK = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/(\d+)\/([\w-]+)$/;
/** A public invite to the channel, shown to readers on the Overview. Never the webhook. */
const INVITE = /^https:\/\/(?:discord\.gg|(?:www\.)?discord(?:app)?\.com\/invite)\/([A-Za-z0-9-]{2,32})\/?$/;
const FAILING_AFTER = 5;
const LINES_MAX = 10;
/** Discord's limit on a message's content. */
export const CONTENT_MAX = 2000;
const LINE_MAX = 180;
/** Message flag SUPPRESS_EMBEDS: one link preview per record would bury the list. */
const SUPPRESS_EMBEDS = 4;

type Delivery = Pick<DiscordChannel, 'state' | 'failures' | 'last_sent_at' | 'last_error'>;
const FRESH: Delivery = { state: 'active', failures: 0, last_sent_at: null, last_error: null };

/** A channel ready to post to: not paused, and its webhook opens. */
export interface Channel {
  slug: string;
  webhook: string;
  state: Delivery;
}

/* ───────── settings ───────── */

async function readSetting(db: D1Database, slug: string, key: string): Promise<string | null> {
  return (
    (await db.prepare('SELECT value FROM app_settings WHERE app_slug = ? AND key = ?').bind(slug, key).first<{ value: string }>())
      ?.value ?? null
  );
}

const writeSetting = (db: D1Database, slug: string, key: string, value: string, now: Date) =>
  db
    .prepare(
      `INSERT INTO app_settings (app_slug, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (app_slug, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(slug, key, value, now.toISOString());

async function delivery(db: D1Database, slug: string): Promise<Delivery> {
  const raw = await readSetting(db, slug, 'discord_state');
  return raw ? { ...FRESH, ...(JSON.parse(raw) as Partial<Delivery>) } : FRESH;
}

/** The channel's public invite link, or null when none is set. */
export const inviteOf = (db: D1Database, slug: string): Promise<string | null> => readSetting(db, slug, 'discord_invite');

async function webhookOf(db: D1Database, env: Env, slug: string): Promise<string | null> {
  const raw = await readSetting(db, slug, 'discord_webhook');
  return raw ? unseal(env, JSON.parse(raw) as Sealed) : null;
}

/** The channel ready to post to, or null when it is paused, has no webhook, or the webhook cannot be opened. */
export async function openChannel(db: D1Database, env: Env, slug: string): Promise<Channel | null> {
  const state = await delivery(db, slug);
  if (state.state === 'paused') return null;
  const webhook = await webhookOf(db, env, slug).catch(() => null);
  return webhook ? { slug, webhook, state } : null;
}

/* ───────── admin ───────── */

/** A channel as the admin sees it; `waiting` is what the caller counted for its next post. */
export async function channelStatus(db: D1Database, slug: string, waiting: number): Promise<DiscordChannel> {
  const masked = await readSetting(db, slug, 'discord_masked');
  return {
    configured: masked !== null,
    masked,
    ...(masked ? await delivery(db, slug) : { ...FRESH, state: 'off' as const }),
    waiting,
  };
}

export async function notifyStatus(db: D1Database, apps: readonly DataAppConfig[]): Promise<NotifyStatus[]> {
  return Promise.all(
    apps.map(async (config) => {
      const waiting = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM outbox o JOIN records r ON r.id = o.record_id
           WHERE o.app_slug = ? AND o.sent_at IS NULL AND r.status = 'verified'`,
        )
        .bind(config.slug)
        .first<number>('n');
      return {
        slug: config.slug,
        title: config.title,
        ...(await channelStatus(db, config.slug, waiting ?? 0)),
        invite_url: await inviteOf(db, config.slug),
      };
    }),
  );
}

export async function setWebhook(db: D1Database, env: Env, slug: string, url: unknown, now: Date): Promise<void> {
  const match = typeof url === 'string' ? WEBHOOK.exec(url.trim()) : null;
  if (!match) {
    throw new HttpError(422, 'invalid_webhook', 'webhook_url must be a Discord webhook URL: https://discord.com/api/webhooks/<id>/<token>');
  }
  const sealed = await seal(env, url as string);
  await db.batch([
    writeSetting(db, slug, 'discord_webhook', JSON.stringify(sealed), now),
    writeSetting(db, slug, 'discord_masked', `https://discord.com/api/webhooks/${match[1]}/…`, now),
    writeSetting(db, slug, 'discord_state', JSON.stringify(FRESH), now),
  ]);
}

export async function clearWebhook(db: D1Database, slug: string): Promise<void> {
  await db
    .prepare("DELETE FROM app_settings WHERE app_slug = ? AND key IN ('discord_webhook', 'discord_masked', 'discord_state')")
    .bind(slug)
    .run();
}

/** Sets the invite link readers see (stored as https://discord.gg/<code>), or removes it with null. */
export async function setInvite(db: D1Database, slug: string, url: unknown, now: Date): Promise<void> {
  if (url === null || url === '') {
    await db.prepare("DELETE FROM app_settings WHERE app_slug = ? AND key = 'discord_invite'").bind(slug).run();
    return;
  }
  const match = typeof url === 'string' ? INVITE.exec(url.trim()) : null;
  if (!match) {
    throw new HttpError(422, 'invalid_invite', 'invite_url must be a Discord invite link, such as https://discord.gg/abc123, or null to remove it.');
  }
  await writeSetting(db, slug, 'discord_invite', `https://discord.gg/${match[1]}`, now).run();
}

export async function setDeliveryState(db: D1Database, slug: string, state: unknown, now: Date): Promise<void> {
  if (state !== 'active' && state !== 'paused') throw new HttpError(422, 'invalid_body', 'state must be active or paused.');
  if (!(await readSetting(db, slug, 'discord_masked'))) throw new HttpError(409, 'not_configured', 'Set a webhook first.');
  await writeSetting(db, slug, 'discord_state', JSON.stringify({ ...(await delivery(db, slug)), state, failures: 0 }), now).run();
}

/* ───────── messages ───────── */

/** Discord Markdown and mention syntax made literal. */
export const escapeDiscord = (text: string): string => text.replace(/[\\*_~`|>[\]()<]/g, '\\$&');

/** The config's notify line with a record's values; enums by their labels. */
export function fillLine(config: DataAppConfig, data: RecordData): string {
  return config.notify.line
    .split(' · ')
    .map((segment) => {
      let filled = 0;
      const text = segment.replace(/\{(\w+)\}/g, (_, field: string) => {
        const value = data[field];
        if (value === undefined) return '';
        filled += 1;
        if (Array.isArray(value)) return value.join(', ');
        if (typeof value === 'number') {
          const def = config.fields[field];
          const usd = def?.type === 'number' && def.display === 'usd';
          return usd ? `$${value.toLocaleString('en-US')}` : withUnit(def, value.toLocaleString('en-US'));
        }
        return valueLabel(config.fields[field], value);
      });
      // A segment whose fields are all missing ("deadline {deadline}") goes, label and all.
      return /\{\w+\}/.test(segment) && filled === 0 ? '' : text;
    })
    .filter((segment) => segment.trim() !== '')
    .join(' · ');
}

/** One post: a count, up to ten lines with links, and how many more wait on the site. */
export function announcement(
  config: DataAppConfig,
  records: readonly { id: string; data: RecordData }[],
  total: number,
  origin: string,
): string {
  const head = `**${total} new in ${escapeDiscord(config.title)}**`;
  const home = `<${origin}/${config.slug}>`;
  const lines: string[] = [];
  for (const record of records.slice(0, LINES_MAX)) {
    const text = fillLine(config, record.data);
    const line = `• ${escapeDiscord(text.length > LINE_MAX ? `${text.slice(0, LINE_MAX - 1)}…` : text)} <${origin}/${config.slug}/r/${record.id}>`;
    if ([head, ...lines, line, `and ${total} more: ${home}`].join('\n').length > CONTENT_MAX) break;
    lines.push(line);
  }
  const more = total - lines.length;
  return [head, ...lines, more > 0 ? `and ${more} more: ${home}` : home].join('\n');
}

async function post(webhook: string, content: string, fetcher: typeof fetch): Promise<{ ok: boolean; status: number }> {
  try {
    const response = await fetcher(`${webhook}?wait=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] }, flags: SUPPRESS_EMBEDS }),
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/**
 * Posts one message to a channel and keeps its delivery state. When Discord accepts it,
 * `onSent` (marking what the message carried as sent) commits in one batch with the state,
 * so nothing is marked sent that was not posted. True when the post went out.
 */
export async function deliver(
  db: D1Database,
  channel: Channel,
  content: string,
  onSent: D1PreparedStatement[],
  now: Date,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const outcome = await post(channel.webhook, content, fetcher);
  const at = now.toISOString();
  if (outcome.ok) {
    await db.batch([
      ...onSent,
      writeSetting(db, channel.slug, 'discord_state', JSON.stringify({ state: 'active', failures: 0, last_sent_at: at, last_error: null }), now),
    ]);
    return true;
  }
  // A 429 is Discord asking to wait, not a broken webhook.
  const failures = outcome.status === 429 ? channel.state.failures : channel.state.failures + 1;
  await writeSetting(
    db,
    channel.slug,
    'discord_state',
    JSON.stringify({
      ...channel.state,
      failures,
      state: failures >= FAILING_AFTER ? 'failing' : channel.state.state,
      last_error: `${at}: ${outcome.status ? `HTTP ${outcome.status}` : 'no response'}`,
    }),
    now,
  ).run();
  return false;
}

/** A data app channel's test message. */
export const testMessage = (config: DataAppConfig, origin: string): string =>
  `Test message from Manyfold Data. Newly verified ${config.noun.other} will appear here: <${origin}/${config.slug}>`;

/** Posts `content` to a channel now, paused or not; the delivery state is left as it is. */
export async function sendTest(
  db: D1Database,
  env: Env,
  slug: string,
  content: string,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
  const webhook = await webhookOf(db, env, slug);
  if (!webhook) throw new HttpError(409, 'not_configured', 'Set a webhook first.');
  return post(webhook, content, fetcher);
}

/**
 * Sends each data app's waiting records as one message. Rows are marked sent only after
 * Discord accepts the post; a failed post leaves them for the next run.
 */
export async function flushOutbox(
  db: D1Database,
  env: Env,
  apps: readonly DataAppConfig[],
  origin: string,
  now: Date,
  fetcher: typeof fetch = fetch,
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const config of apps) {
    const channel = await openChannel(db, env, config.slug);
    if (!channel) continue;

    const { results } = await db
      .prepare(
        `SELECT o.id AS outbox_id, r.id, r.data_json FROM outbox o JOIN records r ON r.id = o.record_id
         WHERE o.app_slug = ? AND o.sent_at IS NULL AND r.status = 'verified' ORDER BY o.id`,
      )
      .bind(config.slug)
      .all<{ outbox_id: number; id: string; data_json: string }>();
    if (results.length === 0) continue;

    const content = announcement(
      config,
      results.map((row) => ({ id: row.id, data: JSON.parse(row.data_json) as RecordData })),
      results.length,
      origin,
    );
    const last = results.at(-1)!.outbox_id;
    const markSent = db
      .prepare('UPDATE outbox SET sent_at = ? WHERE app_slug = ? AND sent_at IS NULL AND id <= ?')
      .bind(now.toISOString(), config.slug, last);
    if (await deliver(db, channel, content, [markSent], now, fetcher)) sent += 1;
    else failed += 1;
  }
  return { sent, failed };
}
