// Where doubt goes, on a real SQLite database: typed unsure verdicts and their routes (a maintainer
// with a browser, a second maintainer, a parked duplicate, the admin), giving tasks back, records
// waiting for the admin and the cap, the version of the instructions agents work from, maintainers'
// quality, and the admin's own passages and precedents.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fundraising from '../data-apps/ai-fundraising/config';
import hackathons from '../data-apps/ai-hackathons/config';
import { app } from '../src/worker/index';
import { HUMAN_DAILY_MAX } from '../src/worker/maintainer';
import { BROWSER_WAIT_MS } from '../src/worker/maintenance';
import { skillVersion } from '../src/worker/skill';
import { createD1 } from './d1';
import { withMaintainerVersion } from './versions';

const PASSWORD = 'test-admin-password';
let env: { DB: D1Database; ASSETS: Fetcher; ADMIN_PASSWORD?: string };
/** Pages the fetch stub serves, by URL; any other page is the word "page". */
let pages: Record<string, string>;

beforeEach(() => {
  env = {
    DB: createD1(),
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    ADMIN_PASSWORD: PASSWORD,
  };
  pages = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://cloudflare-dns.com/')) return Response.json({ Status: 0 });
      if (url in pages) return new Response(pages[url], { headers: { 'content-type': 'text/html; charset=utf-8' } });
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
const json = (method: string, payload: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(payload),
});
const asAdmin = (path: string, init: RequestInit = {}) =>
  call(path, { ...init, headers: { ...(init.headers as Record<string, string>), 'x-admin-password': PASSWORD } });
const as = async (token: string, path: string, init: RequestInit = {}) =>
  call(path, {
    ...init,
    headers: await withMaintainerVersion(path, { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` }),
  });

async function collector(name = 'collector'): Promise<{ token: string; id: string }> {
  const reply = await body(await call('/api/ai-hackathons/join', json('POST', { agent_name: name }, { 'cf-connecting-ip': name })));
  return { token: reply.token, id: reply.token_id };
}

async function maintainer(label: string, payload: Record<string, unknown> = {}): Promise<{ token: string; id: string }> {
  const reply = await body(await asAdmin('/api/admin/tokens', json('POST', { label, ...payload })));
  return { token: reply.token, id: reply.id };
}

const record = (n: number) => ({
  data: {
    name: `Test Hackathon ${n}`,
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

async function submit(token: string, ...numbers: number[]): Promise<string[]> {
  const reply = await body(await as(token, '/api/ai-hackathons/records', json('POST', { records: numbers.map(record) })));
  return reply.results.map((result: { id: string }) => result.id);
}

const lease = async (token: string, limit = 10) => body(await as(token, `/api/ai-hackathons/tasks?limit=${limit}`));
const verdicts = async (token: string, list: unknown[]) =>
  body(await as(token, '/api/ai-hackathons/verdicts', json('POST', { verdicts: list })));
const release = async (token: string, ids: string[]) =>
  body(await as(token, '/api/ai-hackathons/tasks/release', json('POST', { task_ids: ids })));
const verified = (taskId: string) => ({
  task_id: taskId,
  verdict: 'verified',
  source_url: 'https://example.org/official',
  evidence: 'Applications close on 15 November 2099.',
});
const unsure = (taskId: string, type: string, extra: Record<string, unknown> = {}) => ({
  task_id: taskId,
  verdict: 'unsure',
  unsure_type: type,
  reason: 'Cannot settle it from here.',
  ...extra,
});
const taskOf = (tasks: any[], recordId: string) => tasks.find((task) => task.record.id === recordId);
const statusOf = async (recordId: string) => sql('SELECT status FROM records WHERE id = ?', recordId).first<string>('status');
const taskStatus = async (taskId: string) => sql('SELECT status FROM tasks WHERE id = ?', taskId).first<string>('status');
const review = async () => (await body(await asAdmin('/api/admin/ai-hackathons/review'))).items;

describe('an unsure verdict', () => {
  it('says why, and a question of policy goes to the admin', async () => {
    const [id] = await submit((await collector()).token, 1);
    const keeper = await maintainer('keeper');
    const [task] = (await lease(keeper.token)).tasks;

    const untyped = await verdicts(keeper.token, [{ task_id: task.id, verdict: 'unsure', reason: 'Not sure.' }]);
    expect(untyped.results[0].errors[0]).toMatchObject({ field: 'unsure_type', message: expect.stringContaining('cannot_open') });

    const reply = await verdicts(keeper.token, [unsure(task.id, 'policy')]);
    expect(reply.results[0]).toMatchObject({ status: 'applied', record_status: 'pending', routed: 'admin' });
    expect(await taskStatus(task.id)).toBe('review');
    expect(await review()).toEqual([expect.objectContaining({ kind: 'unsure', unsure_type: 'policy', record: expect.objectContaining({ id }) })]);
  });

  it(`sends at most ${HUMAN_DAILY_MAX} tasks a day from one token to the admin`, async () => {
    await submit((await collector()).token, 1);
    const keeper = await maintainer('keeper');
    const [task] = (await lease(keeper.token)).tasks;
    const today = new Date().toISOString();
    for (let n = 0; n < HUMAN_DAILY_MAX; n += 1) {
      await sql(`INSERT INTO revisions (record_id, app_slug, actor, action, after_json, created_at) VALUES (?, 'ai-hackathons', ?, 'unsure', '{}', ?)`, `rec_old${n}`, keeper.id, today).run();
    }
    const reply = await verdicts(keeper.token, [unsure(task.id, 'policy')]);
    expect(reply.results[0].errors[0]).toMatchObject({ field: 'verdict', message: expect.stringContaining('tasks/release') });
    expect(await taskStatus(task.id)).toBe('leased');
  });
});

describe('cannot_open', () => {
  it('is refused when the server reads the record’s passage on its page', async () => {
    const [id] = await submit((await collector()).token, 1);
    pages['https://example.org/hack-1'] = '<main><p>Registration closes on November&nbsp;15, 2099.</p></main>';
    const keeper = await maintainer('keeper');
    const [task] = (await lease(keeper.token)).tasks;
    const reply = await verdicts(keeper.token, [unsure(task.id, 'cannot_open')]);
    expect(reply.results[0].errors[0]).toMatchObject({ field: 'unsure_type', message: expect.stringContaining('found the record') });
    expect(await statusOf(id!)).toBe('pending');
  });

  it('goes first to a maintainer with a browser, never back to the one who could not open it', async () => {
    const [first, second] = await submit((await collector()).token, 1, 2);
    const plain = await maintainer('plain');
    const other = await maintainer('other');
    const browser = await maintainer('with a browser', { capabilities: ['browser'] });
    const held = (await lease(plain.token)).tasks;

    const reply = await verdicts(plain.token, [unsure(taskOf(held, first!).id, 'cannot_open', { reason: 'The page shows a bot check.' })]);
    expect(reply.results[0]).toMatchObject({ status: 'applied', routed: 'browser' });
    expect(await taskStatus(taskOf(held, first!).id)).toBe('open');
    // Neither the maintainer who could not open it nor one without a browser gets it.
    expect((await lease(plain.token)).tasks.map((task: any) => task.record.id)).toEqual([second]);
    expect((await lease(other.token)).tasks).toEqual([]);

    const [task] = (await lease(browser.token)).tasks;
    expect(task).toMatchObject({ needs: 'browser', record: { id: first } });
    // A maintainer with a browser that cannot open it either sends it to the admin.
    const after = await verdicts(browser.token, [unsure(task.id, 'cannot_open')]);
    expect(after.results[0]).toMatchObject({ status: 'applied', routed: 'admin' });
    expect(await taskStatus(task.id)).toBe('review');
    expect(await sql('SELECT COUNT(*) AS n FROM task_needs').first('n')).toBe(0);
  });

  it('goes to the admin at once when no maintainer of the app has a browser', async () => {
    await submit((await collector()).token, 1);
    await maintainer('browser elsewhere', { apps: ['ai-fundraising'], capabilities: ['browser'] });
    const keeper = await maintainer('keeper');
    const [task] = (await lease(keeper.token)).tasks;
    const reply = await verdicts(keeper.token, [unsure(task.id, 'cannot_open')]);
    expect(reply.results[0].routed).toBe('admin');
  });

  it('goes to the admin after a day without a maintainer with a browser taking it', async () => {
    await submit((await collector()).token, 1);
    await maintainer('browser', { capabilities: ['browser'] });
    const keeper = await maintainer('keeper');
    const [task] = (await lease(keeper.token)).tasks;
    await verdicts(keeper.token, [unsure(task.id, 'cannot_open', { reason: 'Cloudflare challenge on every try.' })]);

    expect((await body(await asAdmin('/api/admin/maintenance', { method: 'POST' }))).escalated).toBe(0);
    const overview = (await body(await asAdmin('/api/admin/overview'))).apps.find((entry: any) => entry.slug === 'ai-hackathons');
    expect(overview).toMatchObject({ needs_browser: 1, oldest_review_at: null });

    await sql('UPDATE task_needs SET since = ?', new Date(Date.now() - BROWSER_WAIT_MS - 60_000).toISOString()).run();
    expect((await body(await asAdmin('/api/admin/maintenance', { method: 'POST' }))).escalated).toBe(1);
    expect(await taskStatus(task.id)).toBe('review');
    const [item] = await review();
    expect(item).toMatchObject({ unsure_type: 'cannot_open', by: 'system' });
    expect(item.reason).toContain('Cloudflare challenge');
    const later = (await body(await asAdmin('/api/admin/overview'))).apps.find((entry: any) => entry.slug === 'ai-hackathons');
    expect(later).toMatchObject({ needs_browser: 0, oldest_review_at: expect.any(String) });
  });
});

describe('conflict', () => {
  it('goes to a second maintainer, then to the admin, and stays out of the public history', async () => {
    const [id] = await submit((await collector()).token, 1, 2);
    const first = await maintainer('first');
    const second = await maintainer('second');
    const [task] = (await lease(first.token, 1)).tasks;

    expect((await verdicts(first.token, [unsure(task.id, 'conflict')])).results[0].routed).toBe('second-opinion');
    expect(await taskStatus(task.id)).toBe('open');
    const [again] = (await lease(second.token, 1)).tasks;
    expect(again.id).toBe(task.id);
    expect((await verdicts(second.token, [unsure(again.id, 'conflict')])).results[0].routed).toBe('admin');
    expect(await taskStatus(task.id)).toBe('review');

    // Settled by the admin, its public history shows decisions, not doubts.
    await asAdmin(`/api/admin/ai-hackathons/records/${id}/decide`, json('POST', { status: 'verified' }));
    const page = await body(await call(`/api/ai-hackathons/records/${id}`));
    expect(page.revisions.map((revision: any) => revision.action)).toEqual(['submit', 'verify']);
  });
});

describe('duplicate_pending', () => {
  it('parks a record until the one it duplicates is verified, then merges it', async () => {
    const [kept, twin] = await submit((await collector()).token, 1, 2);
    const keeper = await maintainer('keeper');
    const tasks = (await lease(keeper.token)).tasks;

    const parked = await verdicts(keeper.token, [unsure(taskOf(tasks, twin!).id, 'duplicate_pending', { duplicate_of: kept })]);
    expect(parked.results[0]).toMatchObject({ status: 'applied', routed: 'parked', record_status: 'pending' });
    expect(await taskStatus(taskOf(tasks, twin!).id)).toBe('blocked');
    expect((await body(await asAdmin('/api/admin/overview'))).apps.find((entry: any) => entry.slug === 'ai-hackathons').parked).toBe(1);

    await verdicts(keeper.token, [verified(taskOf(tasks, kept!).id)]);
    expect(await sql('SELECT status, merged_into FROM records WHERE id = ?', twin).first()).toEqual({ status: 'merged', merged_into: kept });
    expect(await body(await call(`/api/ai-hackathons/records/${twin}`))).toEqual({ merged_into: kept });
    expect(await sql("SELECT actor FROM revisions WHERE record_id = ? AND action = 'merge'", twin).first('actor')).toBe('system');
    expect(await sql('SELECT COUNT(*) AS n FROM task_waits').first('n')).toBe(0);
  });

  it('opens the task again when the record it duplicates is rejected, and refuses a loop', async () => {
    const [first, twin] = await submit((await collector()).token, 1, 2);
    const keeper = await maintainer('keeper');
    const other = await maintainer('other');
    const tasks = (await lease(keeper.token)).tasks;
    await verdicts(keeper.token, [unsure(taskOf(tasks, twin!).id, 'duplicate_pending', { duplicate_of: first })]);
    // The keeper gives the other task back, untouched, for someone else.
    expect((await release(keeper.token, [taskOf(tasks, first!).id])).released).toBe(1);

    const [task] = (await lease(other.token)).tasks;
    expect(task.record.id).toBe(first);
    const loop = await verdicts(other.token, [unsure(task.id, 'duplicate_pending', { duplicate_of: twin })]);
    expect(loop.results[0].errors[0]).toMatchObject({ field: 'duplicate_of', message: expect.stringContaining('already waits for this one') });

    await verdicts(other.token, [{ task_id: task.id, verdict: 'rejected', reason: 'The page says it was cancelled.' }]);
    expect(await taskStatus(taskOf(tasks, twin!).id)).toBe('open');
    expect(await statusOf(twin!)).toBe('pending');
  });

  it('follows the admin’s decision on the record it waits for', async () => {
    const [first, twin, third, fourth] = await submit((await collector()).token, 1, 2, 3, 4);
    const keeper = await maintainer('keeper');
    const tasks = (await lease(keeper.token)).tasks;
    await verdicts(keeper.token, [
      unsure(taskOf(tasks, twin!).id, 'duplicate_pending', { duplicate_of: first }),
      unsure(taskOf(tasks, fourth!).id, 'duplicate_pending', { duplicate_of: third }),
    ]);
    await asAdmin(`/api/admin/ai-hackathons/records/${first}/decide`, json('POST', { status: 'rejected', reason: 'Cancelled.' }));
    expect(await taskStatus(taskOf(tasks, twin!).id)).toBe('open');
    await asAdmin(`/api/admin/ai-hackathons/records/${third}/decide`, json('POST', { status: 'verified' }));
    expect(await sql('SELECT status, merged_into FROM records WHERE id = ?', fourth).first()).toEqual({ status: 'merged', merged_into: third });
  });

  it('is refused for a verified twin, one not waiting, and a recheck', async () => {
    const [kept, twin, third] = await submit((await collector()).token, 1, 2, 3);
    const keeper = await maintainer('keeper');
    const tasks = (await lease(keeper.token)).tasks;
    await verdicts(keeper.token, [verified(taskOf(tasks, kept!).id), { task_id: taskOf(tasks, third!).id, verdict: 'rejected', reason: 'Cancelled.' }]);
    const reply = await verdicts(keeper.token, [
      unsure(taskOf(tasks, twin!).id, 'duplicate_pending', { duplicate_of: kept }),
      unsure(taskOf(tasks, twin!).id, 'duplicate_pending', { duplicate_of: third }),
      unsure(taskOf(tasks, twin!).id, 'duplicate_pending', { duplicate_of: 'rec_nope' }),
    ]);
    expect(reply.results.map((result: any) => result.errors[0].message)).toEqual([
      expect.stringContaining('send verdict duplicate'),
      expect.stringContaining('not waiting for review'),
      expect.stringContaining('must be the id of another'),
    ]);
  });

  it('comes undone with the verdict that merged it', async () => {
    const [kept, twin] = await submit((await collector()).token, 1, 2);
    const keeper = await maintainer('keeper');
    const tasks = (await lease(keeper.token)).tasks;
    const since = new Date(Date.now() - 60_000).toISOString();
    await verdicts(keeper.token, [unsure(taskOf(tasks, twin!).id, 'duplicate_pending', { duplicate_of: kept })]);
    await verdicts(keeper.token, [verified(taskOf(tasks, kept!).id)]);
    expect(await statusOf(twin!)).toBe('merged');

    const report = await body(await asAdmin(`/api/admin/tokens/${keeper.id}/revert`, json('POST', { since })));
    expect(report).toMatchObject({ reverted: 2, skipped: [] });
    expect(await statusOf(kept!)).toBe('pending');
    expect(await sql('SELECT status, merged_into FROM records WHERE id = ?', twin).first()).toEqual({ status: 'pending', merged_into: null });
    expect(await sql("SELECT COUNT(*) AS n FROM tasks WHERE record_id = ? AND status = 'open'", twin).first('n')).toBe(1);
  });
});

describe('giving tasks back', () => {
  it('returns them untouched, counts nothing, and leaves them leasable', async () => {
    await submit((await collector()).token, 1, 2);
    const keeper = await maintainer('keeper');
    const tasks = (await lease(keeper.token)).tasks;
    const reply = await release(keeper.token, [tasks[0].id, 'tsk_not_mine']);
    expect(reply).toMatchObject({ released: 1, done_today: 0, leased: 1 });
    expect(await taskStatus(tasks[0].id)).toBe('open');
    expect((await lease(keeper.token)).tasks).toHaveLength(2);
    expect((await as(keeper.token, '/api/ai-hackathons/tasks/release', json('POST', { task_ids: [] }))).status).toBe(422);
  });
});

describe('the pending cap', () => {
  it('leaves out records waiting for the admin', async () => {
    const author = await collector();
    const [id] = await submit(author.token, 1, 2, 3, 4, 5);
    expect((await body(await as(author.token, '/api/ai-hackathons/records', json('POST', { records: [record(6)] })))).results[0].status).toBe('over_cap');
    const keeper = await maintainer('keeper');
    const task = taskOf((await lease(keeper.token)).tasks, id!);
    await verdicts(keeper.token, [unsure(task.id, 'policy')]);
    expect((await body(await as(author.token, '/api/me'))).standing['ai-hackathons'].pending).toBe(4);
    expect((await body(await as(author.token, '/api/ai-hackathons/records', json('POST', { records: [record(6)] })))).results[0].status).toBe('accepted');
  });
});

describe('the version of the instructions', () => {
  it('is sent with the skill, named in it, and required of maintainers, never told in an error', async () => {
    const keeper = await maintainer('keeper');
    const version = await skillVersion(hackathons, 'maintainer');
    const skill = await call('/api/ai-hackathons/skill', { headers: { authorization: `Bearer ${keeper.token}` } });
    expect(skill.headers.get('x-skill-version')).toBe(version);
    const text = await skill.text();
    expect(text).toContain(`These instructions are version \`${version}\``);
    expect(text).toContain('| `cannot_open` |');
    expect(text).toContain('POST https://data.test/api/ai-hackathons/tasks/release');
    expect(text).not.toContain('## You have a browser');

    const missing = await as(keeper.token, '/api/ai-hackathons/tasks', { headers: { 'x-no-skill-version': '1' } });
    expect(missing.status).toBe(428);
    const old = await call('/api/ai-hackathons/tasks', { headers: { authorization: `Bearer ${keeper.token}`, 'x-skill-version': '000000000000' } });
    expect(old.status).toBe(409);
    const verdictsWithout = await as(keeper.token, '/api/ai-hackathons/verdicts', json('POST', { verdicts: [] }, { 'x-no-skill-version': '1' }));
    expect(verdictsWithout.status).toBe(428);
    for (const response of [missing, old]) {
      const error = (await body(response)).error;
      expect(error.message).not.toContain(version);
      expect(error.message).toContain('GET https://data.test/api/ai-hackathons/skill');
    }
    // Giving tasks back works whatever the agent read.
    expect((await as(keeper.token, '/api/ai-hackathons/tasks/release', json('POST', { task_ids: ['tsk_x'] }))).status).toBe(200);
  });

  it('differs by data app and role, and a browser changes only the text', async () => {
    const versions = [
      await skillVersion(hackathons, 'maintainer'),
      await skillVersion(hackathons, 'collector'),
      await skillVersion(fundraising, 'maintainer'),
    ];
    expect(new Set(versions).size).toBe(3);
    const browser = await maintainer('browser', { capabilities: ['browser'] });
    const skill = await call('/api/ai-hackathons/skill', { headers: { authorization: `Bearer ${browser.token}` } });
    expect(skill.headers.get('x-skill-version')).toBe(versions[0]);
    expect(await skill.text()).toContain('## You have a browser');
  });

  it('is asked of collectors: a submit without it is taken with a warning, an old one refused', async () => {
    const author = await collector();
    const version = await skillVersion(hackathons, 'collector');
    const skill = await call('/api/ai-hackathons/skill', { headers: { authorization: `Bearer ${author.token}` } });
    expect(skill.headers.get('x-skill-version')).toBe(version);
    expect(await skill.text()).toContain(`X-Skill-Version: ${version}`);

    const without = await body(await as(author.token, '/api/ai-hackathons/records', json('POST', { records: [record(1)] })));
    expect(without.results[0].status).toBe('accepted');
    expect(without.warnings).toEqual([expect.stringContaining('X-Skill-Version')]);
    const old = await as(author.token, '/api/ai-hackathons/records', json('POST', { records: [record(2)] }, { 'x-skill-version': '000000000000' }));
    expect(old.status).toBe(409);
    const current = await body(await as(author.token, '/api/ai-hackathons/records', json('POST', { records: [record(3)] }, { 'x-skill-version': version })));
    expect(current.warnings).toEqual([]);
  });
});

describe('maintainers answer for their verdicts', () => {
  it('count the admin overturning them, and are suspended past half of ten', async () => {
    const author = await collector();
    await asAdmin(`/api/admin/tokens/${author.id}`, json('PATCH', { pending_cap: 20 }));
    const ids = await submit(author.token, ...Array.from({ length: 10 }, (_, n) => n + 1));
    const keeper = await maintainer('keeper');
    const tasks = [...(await lease(keeper.token, 10)).tasks];
    await verdicts(keeper.token, tasks.map((task: any) => verified(task.id)));

    for (const [n, id] of ids.entries()) {
      const decision = n < 4 ? { status: 'verified' } : { status: 'rejected', reason: 'The page says it was cancelled.' };
      await asAdmin(`/api/admin/ai-hackathons/records/${id}/decide`, json('POST', decision));
    }
    const [token] = (await body(await asAdmin('/api/admin/tokens?role=maintainer'))).tokens;
    expect(token).toMatchObject({ status: 'suspended', quality: { verdicts: 10, checked: 10, overturned: 6 } });
    expect((await as(keeper.token, '/api/ai-hackathons/tasks')).status).toBe(403);
  });

  it('count a spot check that finds a verified record wrong', async () => {
    const [id] = await submit((await collector()).token, 1);
    const keeper = await maintainer('keeper');
    const [task] = (await lease(keeper.token)).tasks;
    await verdicts(keeper.token, [verified(task.id)]);
    await asAdmin(`/api/admin/ai-hackathons/spot-check/${id}`, json('POST', { correct: false, note: 'The deadline moved.' }));
    const [token] = (await body(await asAdmin('/api/admin/tokens?role=maintainer'))).tokens;
    expect(token.quality).toMatchObject({ checked: 1, overturned: 1 });
    expect(token.status).toBe('active');
  });

  it('have capabilities given at issue or later, maintainers only', async () => {
    const browser = await body(await asAdmin('/api/admin/tokens', json('POST', { label: 'browser', capabilities: ['browser'] })));
    expect(browser).toMatchObject({ capabilities: ['browser'], quality: { verdicts: 0, checked: 0 } });
    expect((await body(await asAdmin(`/api/admin/tokens/${browser.id}`, json('PATCH', { capabilities: [] })))).capabilities).toEqual([]);
    expect((await asAdmin('/api/admin/tokens', json('POST', { label: 'x', capabilities: ['teleport'] }))).status).toBe(422);
    const author = await collector();
    expect((await asAdmin(`/api/admin/tokens/${author.id}`, json('PATCH', { capabilities: ['browser'] }))).status).toBe(422);
  });
});

describe('the admin', () => {
  it('decides with a passage of its own, which becomes the source, and keeps precedents until adopted', async () => {
    const [id] = await submit((await collector()).token, 1);
    const decide = (payload: Record<string, unknown>) => asAdmin(`/api/admin/ai-hackathons/records/${id}/decide`, json('POST', payload));
    expect((await decide({ status: 'verified', source_url: 'http://example.org/x', evidence: 'Closes 15 November.' })).status).toBe(422);
    expect((await decide({ status: 'verified', precedent: 'short' })).status).toBe(422);

    const reply = await body(
      await decide({
        status: 'verified',
        source_url: 'https://organizer.example.org/apply',
        evidence: 'Applications close on 15 November 2099.',
        precedent: "An organizer's own application page settles the deadline over a listing site.",
      }),
    );
    expect(reply.record).toMatchObject({ status: 'verified', source_url: 'https://organizer.example.org/apply', evidence: 'Applications close on 15 November 2099.' });
    expect(reply.revisions.at(-1)).toMatchObject({ action: 'verify', source_url: 'https://organizer.example.org/apply' });

    const open = (await body(await asAdmin('/api/admin/precedents'))).precedents;
    expect(open).toEqual([expect.objectContaining({ app_slug: 'ai-hackathons', record_id: id, decision: 'verified' })]);
    expect((await body(await asAdmin(`/api/admin/precedents/${open[0].id}/adopt`, { method: 'POST' }))).precedents).toEqual([]);
    expect((await body(await asAdmin('/api/admin/precedents?all=1'))).precedents[0].adopted_at).toEqual(expect.any(String));
    expect((await asAdmin(`/api/admin/precedents/${open[0].id}/adopt`, { method: 'POST' })).status).toBe(404);
  });
});
