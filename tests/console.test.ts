// The admin console's server side and what readers get besides pages: Discord delivery,
// the feed and exports, reader reports, admin decisions, undoing a token's work, banning,
// and the weekly spot-check — on a real SQLite database, with Discord stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import hackathons from '../data-apps/ai-hackathons/config';
import { isoWeek } from '../src/worker/console';
import { seal, unseal } from '../src/worker/crypto';
import { announcement, escapeDiscord, fillLine } from '../src/worker/notify';
import { app } from '../src/worker/index';
import { createD1 } from './d1';

const PASSWORD = 'test-admin-password';
const WEBHOOK = 'https://discord.com/api/webhooks/123456/secret-part';
let env: { DB: D1Database; ASSETS: Fetcher; ADMIN_PASSWORD: string; CONFIG_ENCRYPTION_KEY?: string; PUBLIC_ORIGIN: string };
let discord: { url: string; body: any }[];
let discordStatus: number;

beforeEach(() => {
  env = {
    DB: createD1(),
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    ADMIN_PASSWORD: PASSWORD,
    CONFIG_ENCRYPTION_KEY: 'k'.repeat(40),
    PUBLIC_ORIGIN: 'https://data.test',
  };
  discord = [];
  discordStatus = 200;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://discord.com/')) {
        discord.push({ url, body: JSON.parse(String(init?.body)) });
        return new Response('{}', { status: discordStatus });
      }
      if (url.startsWith('https://cloudflare-dns.com/')) return Response.json({ Status: 0 });
      return new Response('page');
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Replies are untyped JSON here; each test checks the fields it cares about.
const body = async (response: Response): Promise<any> => response.json();
const call = (path: string, init: RequestInit = {}) => app.request(`https://data.test${path}`, init, env);
const sql = (query: string, ...values: unknown[]) => env.DB.prepare(query).bind(...values);
const json = (method: string, payload?: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', ...headers },
  ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
});
const asAdmin = (path: string, init: RequestInit = {}) =>
  call(path, { ...init, headers: { ...(init.headers as Record<string, string>), 'x-admin-password': PASSWORD } });
const as = (token: string, path: string, init: RequestInit = {}) =>
  call(path, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` } });

async function collector(name = 'collector'): Promise<{ token: string; id: string }> {
  const reply = await body(await call('/api/ai-hackathons/join', json('POST', { agent_name: name }, { 'cf-connecting-ip': name })));
  return { token: reply.token, id: reply.token_id };
}

async function maintainer(label = 'house maintainer'): Promise<{ token: string; id: string }> {
  const reply = await body(await asAdmin('/api/admin/tokens', json('POST', { label })));
  return { token: reply.token, id: reply.id };
}

const record = (n: number, name = `Test Hackathon ${n}`) => ({
  data: {
    name,
    organizer: 'Test Labs',
    url: `https://example.org/hack-${n}`,
    deadline: '2099-11-15',
    starts_on: '2099-11-21',
    ends_on: '2099-11-23',
    format: 'online',
    region: 'global',
  },
  source_url: `https://example.org/hack-${n}`,
  evidence: 'Registration closes on November 15, 2099.',
  observed_at: new Date().toISOString(),
});

async function submit(token: string, ...records: ReturnType<typeof record>[]): Promise<string[]> {
  const reply = await body(await as(token, '/api/ai-hackathons/records', json('POST', { records })));
  return reply.results.map((result: { id: string }) => result.id);
}

/** Leases everything and verifies it. */
async function verifyAll(token: string) {
  const { tasks } = await body(await as(token, '/api/ai-hackathons/tasks'));
  return body(
    await as(
      token,
      '/api/ai-hackathons/verdicts',
      json('POST', {
        verdicts: tasks.map((task: any) => ({
          task_id: task.id,
          verdict: 'verified',
          source_url: task.record.source_url,
          evidence: 'Registration closes on November 15, 2099.',
        })),
      }),
    ),
  );
}

const cron = () => asAdmin('/api/admin/maintenance', { method: 'POST' });
const setWebhook = (url = WEBHOOK) => asAdmin('/api/admin/notify/ai-hackathons', json('PUT', { webhook_url: url }));

describe('encryption', () => {
  it('seals and opens again, and refuses without a key', async () => {
    const sealed = await seal(env, WEBHOOK);
    expect(sealed.ciphertext).not.toContain('secret-part');
    expect(await unseal(env, sealed)).toBe(WEBHOOK);
    await expect(seal({ ...env, CONFIG_ENCRYPTION_KEY: 'short' }, 'x')).rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('Discord', () => {
  it('escapes what strangers wrote and caps the post', () => {
    expect(escapeDiscord('*bold* [x](https://evil.test) <@1> `code`')).toBe('\\*bold\\* \\[x\\]\\(https://evil.test\\) \\<@1\\> \\`code\\`');
    const records = Array.from({ length: 14 }, (_, n) => ({ id: `rec_${n}`, data: { ...record(n).data, name: 'x'.repeat(300) } }));
    const text = announcement(hackathons, records, 14, 'https://data.test');
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text.split('\n')[0]).toBe('**14 new in AI Hackathons**');
    expect(text).toMatch(/and \d+ more: <https:\/\/data\.test\/ai-hackathons>$/);
  });

  it('writes each line from the config, with dollars, dropping parts with no value', () => {
    const config = {
      ...hackathons,
      notify: { line: '{name} · {prize_usd} · deadline {deadline} · {city}' },
    };
    expect(fillLine(config, { name: 'A', prize_usd: 25000, deadline: '2026-11-15' })).toBe('A · $25,000 · deadline 2026-11-15');
    expect(fillLine(config, { name: 'A', city: ['Paris', 'Lyon'] })).toBe('A · Paris, Lyon');
  });

  it('keeps a public invite link per data app, apart from the webhook, and puts it on the Overview', async () => {
    const patch = (payload: unknown) => asAdmin('/api/admin/notify/ai-hackathons', json('PATCH', payload));
    expect((await patch({ invite_url: WEBHOOK })).status).toBe(422);
    expect((await patch({})).status).toBe(422);
    const reply = await body(await patch({ invite_url: 'https://discord.com/invite/AbC123' }));
    expect(reply.apps[0]).toMatchObject({ slug: 'ai-hackathons', invite_url: 'https://discord.gg/AbC123', configured: false });
    expect((await body(await call('/api/ai-hackathons/stats'))).discordInvite).toBe('https://discord.gg/AbC123');
    await patch({ invite_url: null });
    expect((await body(await call('/api/ai-hackathons/stats'))).discordInvite).toBeNull();
  });

  it('stores the webhook sealed and shows it masked', async () => {
    expect((await setWebhook('https://example.com/hook')).status).toBe(422);
    const reply = await body(await setWebhook());
    expect(reply.apps[0]).toMatchObject({ configured: true, masked: 'https://discord.com/api/webhooks/123456/…', state: 'active' });
    const stored = JSON.stringify((await sql('SELECT value FROM app_settings').all()).results);
    expect(stored).not.toContain('secret-part');
  });

  it('posts newly verified records once, with pings off', async () => {
    await setWebhook();
    await submit((await collector()).token, record(1, '@everyone free *money*'), record(2));
    await verifyAll((await maintainer()).token);

    expect((await body(await cron())).discord).toEqual({ sent: 1, failed: 0 });
    expect(discord).toHaveLength(1);
    expect(discord[0]!.url).toBe(`${WEBHOOK}?wait=true`);
    expect(discord[0]!.body.allowed_mentions).toEqual({ parse: [] });
    expect(discord[0]!.body.content).toContain('**2 new in AI Hackathons**');
    expect(discord[0]!.body.content).toContain('@everyone free \\*money\\*');
    expect(discord[0]!.body.content).toContain('<https://data.test/ai-hackathons/r/rec_');

    expect((await body(await cron())).discord).toEqual({ sent: 0, failed: 0 });
  });

  it('keeps records after a failed post, marks a webhook failing after 5, and ignores 429', async () => {
    await setWebhook();
    await submit((await collector()).token, record(1));
    await verifyAll((await maintainer()).token);
    discordStatus = 429;
    await cron();
    discordStatus = 500;
    for (let n = 0; n < 5; n += 1) await cron();
    const [status] = (await body(await asAdmin('/api/admin/notify'))).apps;
    expect(status).toMatchObject({ state: 'failing', failures: 5, waiting: 1 });
    expect(status.last_error).toMatch(/HTTP 500$/);

    discordStatus = 200;
    await cron();
    expect((await body(await asAdmin('/api/admin/notify'))).apps[0]).toMatchObject({ state: 'active', failures: 0, waiting: 0 });
  });

  it('sends nothing while paused, and a test message on request', async () => {
    await setWebhook();
    await asAdmin('/api/admin/notify/ai-hackathons', json('PATCH', { state: 'paused' }));
    await submit((await collector()).token, record(1));
    await verifyAll((await maintainer()).token);
    await cron();
    expect(discord).toHaveLength(0);

    expect(await body(await asAdmin('/api/admin/notify/ai-hackathons/test', { method: 'POST' }))).toEqual({ ok: true, status: 200 });
    expect(discord[0]!.body.content).toMatch(/^Test message from Manyfold Data/);
  });
});

describe('feed and exports', () => {
  it('serve verified records only, escaped, with their sources', async () => {
    const [, hidden] = await submit((await collector()).token, record(1, '=HYPERLINK("https://evil.test") & <b>'), record(2));
    await verifyAll((await maintainer()).token);
    await sql("UPDATE records SET status = 'pending' WHERE id = ?", hidden).run();

    const feed = await call('/ai-hackathons/feed.xml');
    expect(feed.headers.get('content-type')).toContain('application/rss+xml');
    const xml = await feed.text();
    expect(xml).toContain('<title>=HYPERLINK(&quot;https://evil.test&quot;) &amp; &lt;b&gt;</title>');
    expect(xml.match(/<item>/g)).toHaveLength(1);

    const sheet = await (await call('/ai-hackathons/export.csv')).text();
    expect(sheet.split('\r\n')[0]).toMatch(/^id,name,organizer,url,deadline/);
    expect(sheet).toContain(`"'=HYPERLINK(""https://evil.test"") & <b>"`);

    const data = await body(await call('/ai-hackathons/export.json'));
    expect(data).toMatchObject({ data_app: 'ai-hackathons', license: 'CC-BY-4.0' });
    expect(data.records).toHaveLength(1);
    expect(data.records[0].record_url).toMatch(/^https:\/\/data\.test\/ai-hackathons\/r\/rec_/);
  });
});

describe('reader reports', () => {
  it('reach the review queue for public records only', async () => {
    const [shown, waiting] = await submit((await collector()).token, record(1), record(2));
    const { token } = await maintainer();
    const { tasks } = await body(await as(token, '/api/ai-hackathons/tasks?limit=1'));
    await as(token, '/api/ai-hackathons/verdicts', json('POST', { verdicts: [{ task_id: tasks[0].id, verdict: 'verified', source_url: 'https://example.org/hack-1', evidence: 'Registration closes.' }] }));

    const report = (id: string, reason: string) => call(`/api/ai-hackathons/records/${id}/report`, json('POST', { reason }));
    expect((await report(waiting!, 'Looks wrong')).status).toBe(404);
    expect((await report(shown!, 'no')).status).toBe(422);
    expect((await report(shown!, 'The deadline moved to December 1.')).status).toBe(201);

    const { items } = await body(await asAdmin('/api/admin/ai-hackathons/review'));
    expect(items).toEqual([expect.objectContaining({ kind: 'report', reason: 'The deadline moved to December 1.', report_id: 1 })]);
    await asAdmin('/api/admin/reports/1/resolve', { method: 'POST' });
    expect((await body(await asAdmin('/api/admin/ai-hackathons/review'))).items).toEqual([]);
  });
});

describe('admin decisions', () => {
  it('verify, send back, merge and edit, each with a revision', async () => {
    const [first, second] = await submit((await collector()).token, record(1), record(2));
    const decide = (id: string, payload: unknown) => asAdmin(`/api/admin/ai-hackathons/records/${id}/decide`, json('POST', payload));

    const verified = await body(await decide(first!, { status: 'verified' }));
    expect(verified.record.status).toBe('verified');
    expect(verified.tasks.map((task: any) => task.status)).toEqual(['cancelled']);
    expect(await sql('SELECT COUNT(*) AS n FROM outbox WHERE record_id = ?', first).first('n')).toBe(1);

    expect((await decide(second!, { status: 'rejected' })).status).toBe(422);
    const reopened = await body(await decide(first!, { status: 'pending', reason: 'Check the prize again.' }));
    expect(reopened.record.status).toBe('pending');
    expect(reopened.tasks.map((task: any) => `${task.kind}:${task.status}`)).toEqual(['verify:cancelled', 'verify:open']);

    await decide(first!, { status: 'verified' });
    const merged = await body(await decide(second!, { status: 'merged', duplicate_of: first }));
    expect(merged.record).toMatchObject({ status: 'merged', merged_into: first });

    const edit = (payload: unknown) => asAdmin(`/api/admin/ai-hackathons/records/${first}`, json('PATCH', payload));
    expect((await edit({ corrections: { format: 'remote' } })).status).toBe(422);
    const edited = await body(await edit({ corrections: { prize_usd: 5000 }, reason: 'Prize on the page.' }));
    expect(edited.record.data.prize_usd).toBe(5000);
    expect(edited.revisions.map((revision: any) => `${revision.actor.label}:${revision.action}`)).toEqual([
      'collector:submit',
      'Admin:verify',
      'Admin:reopen',
      'Admin:verify',
      'Admin:admin_edit',
    ]);
  });
});

describe('undoing a token', () => {
  it('reverts what it changed, and leaves what others changed since', async () => {
    const author = await collector();
    const [kept, withdrawn] = await submit(author.token, record(1), record(2));
    const reviewer = await maintainer();
    const { tasks } = await body(await as(reviewer.token, '/api/ai-hackathons/tasks?limit=1'));
    await as(reviewer.token, '/api/ai-hackathons/verdicts', json('POST', { verdicts: [{ task_id: tasks[0].id, verdict: 'verified', source_url: 'https://example.org/hack-1', evidence: 'Registration closes.' }] }));

    // The collector: its untouched submission is withdrawn; the reviewed one is not its alone to undo.
    const collectorReport = await body(await asAdmin(`/api/admin/tokens/${author.id}/revert`, json('POST', { since: '2000-01-01' })));
    expect(collectorReport.reverted).toBe(1);
    expect(collectorReport.skipped).toEqual([{ record_id: kept, reason: expect.stringMatching(/someone else/) }]);
    expect(await sql('SELECT status FROM records WHERE id = ?', withdrawn).first('status')).toBe('rejected');

    // The maintainer: its verification is undone, and the record waits for review again.
    const reviewerReport = await body(await asAdmin(`/api/admin/tokens/${reviewer.id}/revert`, json('POST', { since: '2000-01-01' })));
    expect(reviewerReport).toEqual({ reverted: 1, skipped: [] });
    expect(await sql('SELECT status FROM records WHERE id = ?', kept).first('status')).toBe('pending');
    expect(await sql("SELECT COUNT(*) AS n FROM tasks WHERE record_id = ? AND status = 'open'", kept).first('n')).toBe(1);
    expect(await sql('SELECT COUNT(*) AS n FROM outbox WHERE record_id = ?', kept).first('n')).toBe(0);
    expect((await call(`/api/ai-hackathons/records/${kept}`)).status).toBe(404);
  });

  it('bans a collector and rejects what it has waiting; rechecks a token’s verified records', async () => {
    const author = await collector();
    const [first] = await submit(author.token, record(1), record(2));
    await asAdmin(`/api/admin/ai-hackathons/records/${first}/decide`, json('POST', { status: 'verified' }));
    expect(await body(await asAdmin(`/api/admin/tokens/${author.id}/recheck`, { method: 'POST' }))).toEqual({ queued: 1 });
    expect(await body(await asAdmin(`/api/admin/tokens/${author.id}/ban`, { method: 'POST' }))).toEqual({ rejected: 1 });
    expect((await as(author.token, '/api/me')).status).toBe(403);
  });
});

describe('overview and activity', () => {
  it('count records by status and list the latest changes', async () => {
    const [first] = await submit((await collector('scout')).token, record(1), record(2));
    await asAdmin(`/api/admin/ai-hackathons/records/${first}/decide`, json('POST', { status: 'verified' }));
    const [overview] = (await body(await asAdmin('/api/admin/overview'))).apps;
    expect(overview).toMatchObject({ slug: 'ai-hackathons', counts: { pending: 1, verified: 1 }, open_tasks: 1, review: 0 });
    const { items } = await body(await asAdmin('/api/admin/activity?app=ai-hackathons'));
    expect(items.map((item: any) => `${item.actor.label}:${item.action}`)).toEqual(['Admin:verify', 'scout:submit', 'scout:submit']);
  });
});

describe('spot-check', () => {
  it('keeps one sample all week and counts the marks', async () => {
    await submit((await collector()).token, record(1), record(2), record(3));
    await verifyAll((await maintainer()).token);
    const first = await body(await asAdmin('/api/admin/ai-hackathons/spot-check'));
    expect(first.week).toBe(isoWeek(new Date()));
    expect(first.items).toHaveLength(3);
    expect((await body(await asAdmin('/api/admin/ai-hackathons/spot-check'))).items.map((item: any) => item.record.id)).toEqual(
      first.items.map((item: any) => item.record.id),
    );

    const mark = (id: string, payload: unknown) => asAdmin(`/api/admin/ai-hackathons/spot-check/${id}`, json('POST', payload));
    expect((await mark('rec_nope', { correct: true })).status).toBe(422);
    await mark(first.items[0].record.id, { correct: true });
    const after = await body(await mark(first.items[1].record.id, { correct: false, note: 'Prize is wrong.' }));
    expect(after).toMatchObject({ marked: 2, correct: 1 });
  });

  it('names ISO weeks the standard way', () => {
    const week = (day: string) => isoWeek(new Date(`${day}T12:00:00Z`));
    expect(week('2026-10-01')).toBe('2026-W40');
    expect(week('2026-01-01')).toBe('2026-W01');
    expect(week('2027-01-01')).toBe('2026-W53');
    expect(week('2021-01-03')).toBe('2020-W53');
  });
});
