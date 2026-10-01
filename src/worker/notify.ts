/**
 * Discord announcements. A verdict that makes a record public adds it to the outbox; each
 * cron run sends a data app's waiting records as one message, so a busy hour is one post,
 * not a flood. Record text comes from strangers, so it is escaped and pings are switched
 * off (`allowed_mentions`).
 *
 * Per data app, app_settings holds the sealed webhook, a masked copy for display, and the
 * delivery state: active, paused, or failing after 5 failed sends in a row. A failing
 * webhook is still tried each run, so a channel that comes back recovers by itself.
 */

import { valueLabel, type DataAppConfig, type RecordData } from '../shared/data-app';
import type { NotifyStatus } from '../shared/types';
import { seal, unseal, type Sealed } from './crypto';
import { HttpError, type Env } from './types';

const WEBHOOK = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/(\d+)\/([\w-]+)$/;
const FAILING_AFTER = 5;
const LINES_MAX = 10;
const CONTENT_MAX = 2000;
const LINE_MAX = 180;
/** Message flag SUPPRESS_EMBEDS: one link preview per record would bury the list. */
const SUPPRESS_EMBEDS = 4;

type Delivery = Pick<NotifyStatus, 'state' | 'failures' | 'last_sent_at' | 'last_error'>;
const FRESH: Delivery = { state: 'active', failures: 0, last_sent_at: null, last_error: null };

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

async function webhookOf(db: D1Database, env: Env, slug: string): Promise<string | null> {
  const raw = await readSetting(db, slug, 'discord_webhook');
  return raw ? unseal(env, JSON.parse(raw) as Sealed) : null;
}

/* ───────── admin ───────── */

export async function notifyStatus(db: D1Database, apps: readonly DataAppConfig[]): Promise<NotifyStatus[]> {
  return Promise.all(
    apps.map(async (config) => {
      const masked = await readSetting(db, config.slug, 'discord_masked');
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
        configured: masked !== null,
        masked,
        ...(masked ? await delivery(db, config.slug) : { ...FRESH, state: 'off' as const }),
        waiting: waiting ?? 0,
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
  return config.notify.line.replace(/\{(\w+)\}/g, (_, field: string) => {
    const value = data[field];
    if (value === undefined) return '';
    if (Array.isArray(value)) return value.join(', ');
    if (typeof value === 'number') return value.toLocaleString('en-US');
    return valueLabel(config.fields[field], value);
  });
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

export async function sendTest(
  db: D1Database,
  env: Env,
  config: DataAppConfig,
  origin: string,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
  const webhook = await webhookOf(db, env, config.slug);
  if (!webhook) throw new HttpError(409, 'not_configured', 'Set a webhook first.');
  return post(webhook, `Test message from Manyfold Data. Newly verified ${config.noun.other} will appear here: <${origin}/${config.slug}>`, fetcher);
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
    const state = await delivery(db, config.slug);
    if (state.state === 'paused') continue;
    const webhook = await webhookOf(db, env, config.slug).catch(() => null);
    if (!webhook) continue;

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
    const outcome = await post(webhook, content, fetcher);
    const at = now.toISOString();
    if (outcome.ok) {
      const last = results.at(-1)!.outbox_id;
      await db.batch([
        db.prepare('UPDATE outbox SET sent_at = ? WHERE app_slug = ? AND sent_at IS NULL AND id <= ?').bind(at, config.slug, last),
        writeSetting(db, config.slug, 'discord_state', JSON.stringify({ state: 'active', failures: 0, last_sent_at: at, last_error: null }), now),
      ]);
      sent += 1;
    } else {
      // A 429 is Discord asking to wait, not a broken webhook.
      const failures = outcome.status === 429 ? state.failures : state.failures + 1;
      await writeSetting(
        db,
        config.slug,
        'discord_state',
        JSON.stringify({
          ...state,
          failures,
          state: failures >= FAILING_AFTER ? 'failing' : state.state,
          last_error: `${at}: ${outcome.status ? `HTTP ${outcome.status}` : 'no response'}`,
        }),
        now,
      ).run();
      failed += 1;
    }
  }
  return { sent, failed };
}
