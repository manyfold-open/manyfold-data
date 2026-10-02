/**
 * The Worker: the API under /api, each data app's SKILL.md, static assets for the rest.
 *
 * Read, open to anyone:
 *   GET  /api/health                 deploy check
 *   GET  /api/apps                   every data app, with its record count
 *   GET  /api/:slug/records          verified records under Table parameters (src/shared/query.ts),
 *                                    plus `limit` (1 to 100, default 50)
 *   GET  /api/:slug/records/:id      one record with its history
 *   GET  /api/:slug/stats            Overview tiles and charts
 *   GET  /:slug/SKILL.md             the public agent skill
 *   GET  /:slug/feed.xml             RSS: the newest verified records
 *   GET  /:slug/export.csv|json      every verified record
 *   POST /api/:slug/records/:id/report   a reader's report on a public record, limited per IP
 *
 * Agents (Authorization: Bearer mfd_...):
 *   POST /api/:slug/join             a collector token; no token needed, limited per IP
 *   GET  /api/me                     the token's role, status and standing
 *   GET  /api/:slug/skill            instructions for the token's role
 *   POST /api/:slug/records          submit up to 20 records (Idempotency-Key supported)
 *   GET  /api/:slug/tasks            maintainers: lease tasks (and list the ones held)
 *   POST /api/:slug/verdicts         maintainers: up to 20 verdicts on leased tasks
 *
 * Admin (x-admin-password, closed until ADMIN_PASSWORD is set):
 *   POST  /api/admin/tokens          issue a maintainer token, shown once
 *   GET   /api/admin/tokens          every token, with its records and verdicts
 *   PATCH /api/admin/tokens/:id      status, caps, expiry
 *   POST  /api/admin/tokens/:id/revert|ban|recheck   undo its work since a time; ban a collector;
 *                                    recheck everything it submitted
 *   GET   /api/admin/overview        per data app: counts, open tasks, review queue, Discord state
 *   GET   /api/admin/:slug/review    unsure verdicts, flagged records, open reports
 *   GET   /api/admin/:slug/records[/:id]   any record in any status, with its full history
 *   POST  /api/admin/:slug/records/:id/decide   set its status; PATCH .../:id corrects fields
 *   POST  /api/admin/reports/:id/resolve
 *   GET   /api/admin/activity        the latest revisions, by data app or actor
 *   GET|PUT|PATCH|DELETE /api/admin/notify[/:slug], POST /api/admin/notify/:slug/test
 *                                    (PATCH sets the delivery state and the public invite link)
 *   GET   /api/admin/:slug/spot-check, POST .../spot-check/:recordId   the weekly accuracy check
 *   POST  /api/admin/maintenance     run the cron now: housekeeping, then the Discord outbox
 *
 * Read routes answer any origin: the data is CC BY 4.0 and meant to be reused. Agents
 * call from servers, and the admin from this site, so neither needs CORS.
 *
 * A cron trigger runs the housekeeping in src/worker/maintenance.ts every five minutes,
 * then sends each data app's newly verified records to Discord.
 */

import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { dataApps, findDataApp } from '../../data-apps/index';
import type { DataAppConfig } from '../shared/data-app';
import { parseQuery } from '../shared/query';
import type { DatasetResponse, IssuedToken, JoinResponse, MeResponse } from '../shared/types';
import { HttpError, type Env } from './types';
import { requireAdmin } from './admin';
import { cachedFor, cachedJson, isDailyLimit, secondsToMidnightUtc } from './cache';
import { listFrom, statsFrom } from '../shared/engine';
import { consentRequiredFor, freshRequest, measurementIdFor, wantsTag, withAnalytics, type InjectionContext } from './analytics';
import {
  activity,
  banCollector,
  createReport,
  decide,
  editRecord,
  listRecords as adminRecordList,
  markSpotCheck,
  overview,
  recheckToken,
  recordDetail,
  resolveReport,
  revertToken,
  reviewQueue,
  spotCheck,
} from './console';
import { csv, json as jsonExport, rss, verifiedRecords } from './feeds';
import { clearWebhook, flushOutbox, notifyStatus, sendTest, setDeliveryState, setInvite, setWebhook } from './notify';
import { ensureSchema } from './db';
import { maintain } from './maintenance';
import { applyVerdicts, LEASE_MAX, leaseTasks, workOf } from './maintainer';
import { enforce, HOUR, RULES, sweep } from './ratelimit';
import { appSummaries, getRecord, loadDataset } from './records';
import { collectorSkill, maintainerSkill, publicSkill } from './skill';
import { idempotencyKey, recall, remember, sourceExists, submitRecords } from './submit';
import {
  adminTokens,
  authenticate,
  createCollectorToken,
  createMaintainerToken,
  PENDING_CAP_START,
  requireApp,
  requireRole,
  standing,
  updateToken,
  type Role,
  type Token,
} from './tokens';

const SERVICE = 'manyfold-data';
const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 100;
const BODY_MAX = 200_000;

type AppContext = Context<{ Bindings: Env }>;

const app = new Hono<{ Bindings: Env }>();

const openCors = cors({ origin: '*', allowMethods: ['GET', 'OPTIONS'] });
app.use('/api/*', (c, next) => (c.req.path.startsWith('/api/admin/') ? next() : openCors(c, next)));

app.use('/api/*', async (c, next) => {
  await ensureSchema(c.env.DB);
  await next();
});

app.onError((error, c) => {
  if (error instanceof HttpError) {
    return c.json({ error: { code: error.code, message: error.message } }, error.status as 400, error.headers);
  }
  if (isDailyLimit(error)) {
    console.error('d1 daily limit', error);
    return c.json(
      { error: { code: 'over_daily_limit', message: 'The data is resting until 00:00 UTC: the database has used its reads for today.' } },
      503,
      { 'retry-after': String(secondsToMidnightUtc()) },
    );
  }
  console.error('unhandled', error);
  return c.json({ error: { code: 'internal', message: 'Something went wrong.' } }, 500);
});

/* ───────── helpers ───────── */

const dataAppFor = (slug: string): DataAppConfig => {
  const config = findDataApp(slug);
  if (!config) throw new HttpError(404, 'unknown_app', `There is no data app called "${slug}".`);
  return config;
};

const parseLimit = (raw: string | null): number => {
  if (raw === null) return LIMIT_DEFAULT;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX) {
    throw new HttpError(422, 'invalid_query', `limit must be a whole number from 1 to ${LIMIT_MAX}; got ${raw}`);
  }
  return limit;
};

const originOf = (c: AppContext): string => new URL(c.req.url).origin;

async function readJson(c: AppContext): Promise<unknown> {
  const text = await c.req.text();
  if (text.length > BODY_MAX) {
    throw new HttpError(413, 'too_large', `The request body must be at most ${BODY_MAX} bytes.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_json', 'The request body must be JSON.');
  }
}

const DEFAULT_ORIGIN = 'https://data.manyfold.ai';
const REPORTS_PER_HOUR = { limit: 10, windowMs: HOUR };

const markdown = (c: AppContext, text: string) =>
  c.body(text, 200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' });

/** The token behind this request, counted against its per-minute limit. */
async function agentToken(c: AppContext): Promise<Token> {
  const token = await authenticate(c.env.DB, c.req.header('authorization'), new Date());
  await enforce(c.env.DB, [{ scope: 'token', subject: token.id, rule: RULES.tokenPerMinute }]);
  return token;
}

/* ───────── read ───────── */

app.get('/api/health', (c) => c.json({ status: 'ok', service: SERVICE, time: new Date().toISOString() }));

// Public reads: cached at the edge for a minute (src/worker/cache.ts), so a busy page costs
// D1 one query run a minute per data center, not one per view.
const API_CACHE = cachedFor(60);
const FILE_CACHE = cachedFor(300);

app.get('/api/apps', API_CACHE, async (c) => c.json({ apps: await appSummaries(c.env.DB, dataApps) }));

// Whether this visitor is asked about analytics before anything is stored: only when the
// site measures at all, and only where consent is owed (src/worker/analytics.ts).
app.get('/api/consent', (c) =>
  c.json(
    { required: measurementIdFor(c.env) !== null && consentRequiredFor(c.req.header('cf-ipcountry')) },
    200,
    { 'cache-control': 'no-store' },
  ),
);

/**
 * A data app's public dataset, the one read that scans its records: this data center's cached
 * copy when it has one (the /dataset route stores it under the same URL), else one D1 read.
 * The Table's pages and the Overview's stats are computed from it (src/shared/engine.ts).
 */
const datasetOf = (c: AppContext, config: DataAppConfig): Promise<DatasetResponse> =>
  cachedJson(c, `${new URL(c.req.url).origin}/api/${config.slug}/dataset`, 60, () =>
    loadDataset(c.env.DB, config, new Date()),
  );

app.get('/api/:slug/dataset', API_CACHE, async (c) =>
  c.json(await loadDataset(c.env.DB, dataAppFor(c.req.param('slug')), new Date())),
);

app.get('/api/:slug/records', API_CACHE, async (c) => {
  const config = dataAppFor(c.req.param('slug'));
  const params = new URL(c.req.url).searchParams;
  const { state, errors } = parseQuery(config, params);
  if (errors.length > 0) throw new HttpError(422, 'invalid_query', errors.join('; '));
  const limit = parseLimit(params.get('limit'));
  // facets=none skips the per-filter counts, for callers that only show rows.
  const facets = params.get('facets') !== 'none';
  return c.json(listFrom(config, await datasetOf(c, config), state, limit, { facets }));
});

app.get('/api/:slug/records/:id', API_CACHE, async (c) => {
  const config = dataAppFor(c.req.param('slug'));
  const found = await getRecord(c.env.DB, config, c.req.param('id'));
  if (!found) throw new HttpError(404, 'not_found', 'No public record has that id.');
  return c.json(found);
});

app.get('/api/:slug/stats', API_CACHE, async (c) => {
  const config = dataAppFor(c.req.param('slug'));
  return c.json(statsFrom(config, await datasetOf(c, config), new Date()));
});

app.post('/api/:slug/records/:id/report', async (c) => {
  const config = dataAppFor(c.req.param('slug'));
  await enforce(c.env.DB, [{ scope: 'report', subject: c.req.header('cf-connecting-ip') ?? 'unknown', rule: REPORTS_PER_HOUR }]);
  await createReport(c.env.DB, config, c.req.param('id'), ((await readJson(c)) ?? {}) as { reason?: unknown }, new Date());
  return c.json({ ok: true }, 201);
});

/* ───────── agents ───────── */

app.post('/api/:slug/join', async (c) => {
  const config = dataAppFor(c.req.param('slug'));
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  await enforce(c.env.DB, [
    { scope: 'join-hour', subject: ip, rule: RULES.joinPerHour },
    { scope: 'join-day', subject: ip, rule: RULES.joinPerDay },
  ]);
  if (Math.random() < 0.05) await sweep(c.env.DB);
  const body = (await readJson(c)) as { agent_name?: unknown } | null;
  const { token, secret } = await createCollectorToken(c.env.DB, config.slug, body?.agent_name, new Date());
  const reply: JoinResponse = {
    token: secret,
    token_id: token.id,
    role: 'collector',
    pending_cap: PENDING_CAP_START,
    skill_url: `${originOf(c)}/api/${config.slug}/skill`,
    note: 'Your token is the token field (it starts with mfd_). Store it as a secret: it is shown only once.',
  };
  return c.json(reply, 201);
});

app.get('/api/me', async (c) => {
  const token = await agentToken(c);
  const slugs = (token.apps.includes('*') ? dataApps.map((config) => config.slug) : token.apps).filter((slug) =>
    findDataApp(slug),
  );
  const entries = await Promise.all(slugs.map(async (slug) => [slug, await standing(c.env.DB, token, slug)] as const));
  const reply: MeResponse = {
    token_id: token.id,
    role: token.role,
    label: token.label,
    status: token.status,
    apps: token.apps,
    created_at: token.createdAt,
    standing: Object.fromEntries(entries),
  };
  if (token.role === 'maintainer') {
    const now = new Date();
    reply.work = Object.fromEntries(
      await Promise.all(slugs.map(async (slug) => [slug, await workOf(c.env.DB, dataAppFor(slug), token, now)] as const)),
    );
  }
  return c.json(reply);
});

app.get('/api/:slug/skill', async (c) => {
  const config = dataAppFor(c.req.param('slug'));
  const token = await agentToken(c);
  requireApp(token, config.slug);
  const now = new Date();
  return markdown(
    c,
    token.role === 'maintainer'
      ? maintainerSkill(config, originOf(c), token, await workOf(c.env.DB, config, token, now), now)
      : collectorSkill(config, originOf(c), token, await standing(c.env.DB, token, config.slug), now),
  );
});

app.post('/api/:slug/records', async (c) => {
  const config = dataAppFor(c.req.param('slug'));
  const token = await agentToken(c);
  requireApp(token, config.slug);
  requireRole(token, ['collector', 'maintainer']);
  const now = new Date();
  const key = idempotencyKey(c.req.header('idempotency-key'));
  if (key) {
    const earlier = await recall(c.env.DB, token.id, key, now);
    if (earlier) return c.json(earlier);
  }
  const reply = await submitRecords(c.env.DB, config, token, await readJson(c), {
    now,
    sourceExists: (url) => sourceExists(url),
  });
  if (key) await remember(c.env.DB, token.id, key, reply, now);
  return c.json(reply);
});

app.get('/api/:slug/tasks', async (c) => {
  const config = dataAppFor(c.req.param('slug'));
  const token = await agentToken(c);
  requireApp(token, config.slug);
  requireRole(token, ['maintainer']);
  const raw = c.req.query('limit');
  const limit = raw === undefined ? LEASE_MAX : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > LEASE_MAX) {
    throw new HttpError(422, 'invalid_query', `limit must be a whole number from 1 to ${LEASE_MAX}; got ${raw}`);
  }
  return c.json(await leaseTasks(c.env.DB, config, token, limit, new Date()));
});

app.post('/api/:slug/verdicts', async (c) => {
  const config = dataAppFor(c.req.param('slug'));
  const token = await agentToken(c);
  requireApp(token, config.slug);
  requireRole(token, ['maintainer']);
  return c.json(await applyVerdicts(c.env.DB, config, token, await readJson(c), new Date()));
});

/* ───────── admin ───────── */

app.use('/api/admin/*', async (c, next) => {
  await requireAdmin(c.env, c.req.header('x-admin-password'), c.req.header('cf-connecting-ip') ?? 'unknown');
  await next();
});

app.post('/api/admin/tokens', async (c) => {
  const body = ((await readJson(c)) ?? {}) as Record<string, unknown>;
  if (body.role !== undefined && body.role !== 'maintainer') {
    throw new HttpError(422, 'invalid_body', 'The admin API issues maintainer tokens; collectors get theirs from /join.');
  }
  const now = new Date();
  const { token, secret } = await createMaintainerToken(c.env.DB, body, dataApps.map((config) => config.slug), now);
  const [summary] = await adminTokens(c.env.DB, now, { id: token.id });
  const reply: IssuedToken = {
    ...summary!,
    token: secret,
    note: 'Shown once. Send it to the owner privately; they store it as MANYFOLD_DATA_TOKEN in their agent workspace .env.',
  };
  return c.json(reply, 201);
});

app.get('/api/admin/tokens', async (c) => {
  const role = c.req.query('role');
  if (role !== undefined && role !== 'collector' && role !== 'maintainer') {
    throw new HttpError(422, 'invalid_query', 'role must be collector or maintainer.');
  }
  return c.json({ tokens: await adminTokens(c.env.DB, new Date(), { role: role as Role | undefined }) });
});

app.patch('/api/admin/tokens/:id', async (c) =>
  c.json(await updateToken(c.env.DB, c.req.param('id'), ((await readJson(c)) ?? {}) as Record<string, unknown>, new Date())),
);

app.post('/api/admin/tokens/:id/revert', async (c) => {
  const body = ((await readJson(c)) ?? {}) as { since?: unknown };
  return c.json(await revertToken(c.env.DB, dataApps, c.req.param('id'), body.since, new Date()));
});

app.post('/api/admin/tokens/:id/ban', async (c) => c.json(await banCollector(c.env.DB, c.req.param('id'), new Date())));

app.post('/api/admin/tokens/:id/recheck', async (c) => c.json(await recheckToken(c.env.DB, c.req.param('id'), new Date())));

app.get('/api/admin/overview', async (c) => c.json({ apps: await overview(c.env.DB, dataApps) }));

app.get('/api/admin/activity', async (c) => {
  const app = c.req.query('app');
  if (app) dataAppFor(app);
  return c.json({ items: await activity(c.env.DB, dataApps, { app, actor: c.req.query('actor') }) });
});

app.post('/api/admin/reports/:id/resolve', async (c) => {
  await resolveReport(c.env.DB, Number(c.req.param('id')));
  return c.json({ ok: true });
});

app.get('/api/admin/notify', async (c) => c.json({ apps: await notifyStatus(c.env.DB, dataApps) }));

app.put('/api/admin/notify/:slug', async (c) => {
  const config = dataAppFor(c.req.param('slug'));
  const body = ((await readJson(c)) ?? {}) as { webhook_url?: unknown };
  await setWebhook(c.env.DB, c.env, config.slug, body.webhook_url, new Date());
  return c.json({ apps: await notifyStatus(c.env.DB, dataApps) });
});

app.patch('/api/admin/notify/:slug', async (c) => {
  const config = dataAppFor(c.req.param('slug'));
  const body = ((await readJson(c)) ?? {}) as { state?: unknown; invite_url?: unknown };
  if (!('state' in body) && !('invite_url' in body)) {
    throw new HttpError(422, 'invalid_body', 'Send state (active or paused), invite_url (a Discord invite link or null), or both.');
  }
  const now = new Date();
  if ('invite_url' in body) await setInvite(c.env.DB, config.slug, body.invite_url, now);
  if ('state' in body) await setDeliveryState(c.env.DB, config.slug, body.state, now);
  return c.json({ apps: await notifyStatus(c.env.DB, dataApps) });
});

app.delete('/api/admin/notify/:slug', async (c) => {
  await clearWebhook(c.env.DB, dataAppFor(c.req.param('slug')).slug);
  return c.json({ apps: await notifyStatus(c.env.DB, dataApps) });
});

app.post('/api/admin/notify/:slug/test', async (c) =>
  c.json(await sendTest(c.env.DB, c.env, dataAppFor(c.req.param('slug')), c.env.PUBLIC_ORIGIN ?? originOf(c))),
);

app.get('/api/admin/:slug/review', async (c) => c.json({ items: await reviewQueue(c.env.DB, dataAppFor(c.req.param('slug'))) }));

app.get('/api/admin/:slug/records', async (c) =>
  c.json(
    await adminRecordList(c.env.DB, dataAppFor(c.req.param('slug')), {
      status: c.req.query('status'),
      q: c.req.query('q'),
      page: Number(c.req.query('page') ?? 1) || 1,
    }),
  ),
);

app.get('/api/admin/:slug/records/:id', async (c) =>
  c.json(await recordDetail(c.env.DB, dataAppFor(c.req.param('slug')), c.req.param('id'))),
);

app.post('/api/admin/:slug/records/:id/decide', async (c) =>
  c.json(
    await decide(c.env.DB, dataAppFor(c.req.param('slug')), c.req.param('id'), ((await readJson(c)) ?? {}) as Record<string, unknown>, new Date()),
  ),
);

app.patch('/api/admin/:slug/records/:id', async (c) =>
  c.json(
    await editRecord(c.env.DB, dataAppFor(c.req.param('slug')), c.req.param('id'), ((await readJson(c)) ?? {}) as Record<string, unknown>, new Date()),
  ),
);

app.get('/api/admin/:slug/spot-check', async (c) => c.json(await spotCheck(c.env.DB, dataAppFor(c.req.param('slug')), new Date())));

app.post('/api/admin/:slug/spot-check/:recordId', async (c) =>
  c.json(
    await markSpotCheck(c.env.DB, dataAppFor(c.req.param('slug')), c.req.param('recordId'), ((await readJson(c)) ?? {}) as Record<string, unknown>, new Date()),
  ),
);

/** The cron's work, also run from POST /api/admin/maintenance. */
async function runCron(env: Env, origin: string, now: Date) {
  const housekeeping = await maintain(env.DB, dataApps, now);
  const discord = await flushOutbox(env.DB, env, dataApps, origin, now);
  return { ...housekeeping, discord };
}

app.post('/api/admin/maintenance', async (c) => c.json(await runCron(c.env, c.env.PUBLIC_ORIGIN ?? originOf(c), new Date())));

app.all('/api/*', () => {
  throw new HttpError(404, 'not_found', 'No such API route.');
});

/* ───────── skill ───────── */

app.get('/:slug/SKILL.md', (c) => markdown(c, publicSkill(dataAppFor(c.req.param('slug')), originOf(c))));

app.get('/:slug/feed.xml', FILE_CACHE, async (c) => {
  const config = dataAppFor(c.req.param('slug'));
  await ensureSchema(c.env.DB);
  return c.body(rss(config, await verifiedRecords(c.env.DB, config, 50), originOf(c), new Date()), 200, {
    'content-type': 'application/rss+xml; charset=utf-8',
    'cache-control': 'public, max-age=300',
  });
});

app.get('/:slug/export.csv', FILE_CACHE, async (c) => {
  const config = dataAppFor(c.req.param('slug'));
  await ensureSchema(c.env.DB);
  return c.body(csv(config, await verifiedRecords(c.env.DB, config), originOf(c)), 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${config.slug}.csv"`,
  });
});

app.get('/:slug/export.json', FILE_CACHE, async (c) => {
  const config = dataAppFor(c.req.param('slug'));
  await ensureSchema(c.env.DB);
  return c.json(jsonExport(config, await verifiedRecords(c.env.DB, config), originOf(c), new Date()), 200, {
    'content-disposition': `attachment; filename="${config.slug}.json"`,
  });
});

// Anything else is a page of the single-page app, or a static file. Pages get the Google
// tag on the way out (src/worker/analytics.ts); hashed bundles never reach the Worker.
app.all('*', async (c) => {
  const context: InjectionContext = {
    measurementId: measurementIdFor(c.env),
    method: c.req.method,
    url: new URL(c.req.url),
    publicOrigin: c.env.PUBLIC_ORIGIN,
  };
  const response = await c.env.ASSETS.fetch(wantsTag(context) ? freshRequest(c.req.raw) : c.req.raw);
  return withAnalytics(response, context);
});

export { app };

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(ensureSchema(env.DB).then(() => runCron(env, env.PUBLIC_ORIGIN ?? DEFAULT_ORIGIN, new Date())));
  },
} satisfies ExportedHandler<Env>;
