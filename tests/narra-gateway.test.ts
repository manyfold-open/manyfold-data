import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  routeEvent,
  sanitizeMobileLinks,
  staggerWindowMinute,
  type InboundEvent,
  type RecallTurnResult,
  type RoomContext,
  type TriageDecision,
} from '@manyfold/narra-agent-kit';
import { isNarraGatewayEnabled, kickNarraGateway } from '@manyfold/narra-agent-kit/worker';
import { dataApps, findDataApp } from '../data-apps/index';
import { todayUtc } from '../src/shared/data-app';
import { ensureSchema } from '../src/worker/db';
import workerDefault, {
  app,
  NarraMatrixSync,
  NarraRoomCoordinator,
} from '../src/worker/index';
import {
  createMfdGatewayConfig,
  fastRespondMfd,
  fetchMfdUpdates,
  HIGH_SIGNAL_SLUGS,
  MFD_AGENT_ID,
  MFD_AGENT_SPEC,
  MFD_MANYFOLD_AGENT_ID,
  MFD_MATRIX_ID,
  queryHighSignalUpdates,
} from '../src/worker/narra/gateway';
import type { Env } from '../src/worker/types';
import { createD1 } from './d1';

afterEach(() => {
  vi.unstubAllGlobals();
});

class FakeDOStorage {
  readonly data = new Map<string, unknown>();
  alarmAt: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    if (!this.data.has(key)) return undefined;
    return structuredClone(this.data.get(key)) as T;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }

  async list<T>(options: { prefix?: string; limit?: number } = {}): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    const prefix = options.prefix ?? '';
    for (const key of [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort()) {
      if (options.limit && out.size >= options.limit) break;
      out.set(key, structuredClone(this.data.get(key)) as T);
    }
    return out;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarmAt = typeof scheduledTime === 'number' ? scheduledTime : scheduledTime.getTime();
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }
}

function createFakeNamespace<T extends { fetch(req: Request): Promise<Response>; alarm?(): Promise<void> }>(
  factory: (ctx: DurableObjectState) => T,
) {
  const storages = new Map<string, FakeDOStorage>();
  const instances = new Map<string, { instance: T; storage: FakeDOStorage }>();

  const ensure = (name: string) => {
    let entry = instances.get(name);
    if (!entry) {
      let storage = storages.get(name);
      if (!storage) {
        storage = new FakeDOStorage();
        storages.set(name, storage);
      }
      const state = {
        storage,
        id: { toString: () => name, equals: () => false },
        waitUntil: () => undefined,
        blockConcurrencyWhile: async <R>(fn: () => Promise<R>) => fn(),
      } as unknown as DurableObjectState;
      entry = { instance: factory(state), storage };
      instances.set(name, entry);
    }
    return entry;
  };

  const namespace = {
    idFromName: (name: string) => ({ toString: () => name, name }) as unknown as DurableObjectId,
    idFromString: (id: string) => ({ toString: () => id, name: id }) as unknown as DurableObjectId,
    newUniqueId: () => ({ toString: () => 'unique', name: 'unique' }) as unknown as DurableObjectId,
    get: (id: DurableObjectId) => {
      const name = (id as unknown as { name?: string }).name ?? id.toString();
      const { instance } = ensure(name);
      return {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          instance.fetch(input instanceof Request ? input : new Request(String(input), init)),
      } as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;

  return { namespace, instances, storages };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: createD1(),
    ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
    PUBLIC_ORIGIN: 'https://data.manyfold.ai',
    NARRA_GATEWAY_ENABLED: 'off',
    NARRA_SYNC: 'off',
    NARRA_AGENT_ID: MFD_MANYFOLD_AGENT_ID,
    NARRA_MATRIX_ID: MFD_MATRIX_ID,
    ...overrides,
  };
}

function makeInboundEvent(overrides: Partial<InboundEvent> = {}): InboundEvent {
  const nowMs = Date.now();
  return {
    roomId: '!mfd-room:matrix.netmind.chat',
    chatType: 'group',
    eventId: '$evt-mfd-1',
    senderId: '@alice:matrix.netmind.chat',
    type: 'm.room.message',
    kind: 'text',
    text: '',
    timestampMs: nowMs,
    timeIso: new Date(nowMs).toISOString(),
    mentions: [],
    isVoice: false,
    ...overrides,
  };
}

const DEFAULT_ROOM_CTX: RoomContext = {
  roomId: '!mfd-room:matrix.netmind.chat',
  chatType: 'group',
  members: [
    { matrixId: '@alice:matrix.netmind.chat', isAgent: false },
    { matrixId: MFD_MATRIX_ID, displayName: 'Manyfold Data', isAgent: true },
    { matrixId: '@agent-lcf:matrix.netmind.chat', displayName: 'London Chinese Food', isAgent: true },
    { matrixId: '@agent-tarot:matrix.netmind.chat', displayName: 'Tarot Master', isAgent: true },
  ],
  recentHistory: [],
};

const EMPTY_MEM: RecallTurnResult = {
  userMemories: [],
  roomMemories: [],
  promptSafeLines: [],
};

async function seedVerifiedRecord(
  db: D1Database,
  slug: string,
  id: string,
  data: Record<string, unknown>,
  verifiedAt = '2026-11-19T12:00:00Z',
): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare(
      `INSERT INTO records (
        id, app_slug, identity_key, status, data_json, source_url, evidence,
        observed_at, submitted_by, merged_into, flagged, verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'verified', ?, ?, ?, ?, 'tok_test', NULL, 0, ?, ?, ?)`,
    )
    .bind(
      id,
      slug,
      id,
      JSON.stringify(data),
      String(data.url ?? 'https://example.org/source'),
      'Verified official announcement excerpt.',
      verifiedAt,
      verifiedAt,
      verifiedAt,
      verifiedAt,
    )
    .run();
}

describe('Manyfold Data Narra gateway integration', () => {
  it('stays completely disabled by default and keeps scheduled cron healthy', async () => {
    const db = createD1();
    const fetchSpy = vi.fn(async () => new Response('unexpected', { status: 500 }));
    vi.stubGlobal('fetch', fetchSpy);

    const doNs = {
      idFromName: vi.fn(),
      get: vi.fn(),
    } as unknown as DurableObjectNamespace;

    const env = makeEnv({
      DB: db,
      NARRA_GATEWAY_ENABLED: 'off',
      NARRA_SYNC: 'off',
      NARRA_AGENT_TOKEN: 'secret-token-unused',
      NARRA_SYNC_DO: doNs,
      NARRA_ROOM_DO: doNs,
    });

    expect(isNarraGatewayEnabled(env)).toBe(false);
    const kick = await kickNarraGateway(env);
    expect(kick).toEqual({
      enabled: false,
      syncKicked: false,
      syncRunning: false,
      broadcast: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(doNs.get).not.toHaveBeenCalled();

    const waitPromises: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => {
        waitPromises.push(p);
      },
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext;

    await workerDefault.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now(), noRetry: () => undefined }, env, ctx);
    await Promise.all(waitPromises);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(doNs.get).not.toHaveBeenCalled();
    expect(NarraMatrixSync).toBeTypeOf('function');
    expect(NarraRoomCoordinator).toBeTypeOf('function');
  });

  it('strictly guards /api/admin/gateway/status behind ADMIN_PASSWORD and redacts secrets', async () => {
    const envUnconfigured = makeEnv({ ADMIN_PASSWORD: '' });
    const res503 = await app.request('https://data.test/api/admin/gateway/status', {}, envUnconfigured);
    expect(res503.status).toBe(503);

    const env = makeEnv({
      ADMIN_PASSWORD: 'super-secret-admin-pw',
      NARRA_AGENT_TOKEN: 'narra-live-secret-token',
      MANYFOLD_A2A_URL: 'https://manyfold.ai/api/a2a/agt_agq66cw5uzyudifa4fuhcnaddu',
      MANYFOLD_A2A_TOKEN: 'a2a-live-secret-token',
    });

    const resUnauth = await app.request('https://data.test/api/admin/gateway/status', {}, env);
    expect(resUnauth.status).toBe(401);

    const resWrong = await app.request(
      'https://data.test/api/admin/gateway/status',
      { headers: { 'x-admin-password': 'wrong-password' } },
      env,
    );
    expect(resWrong.status).toBe(401);

    const resOk = await app.request(
      'https://data.test/api/admin/gateway/status',
      { headers: { 'x-admin-password': 'super-secret-admin-pw' } },
      env,
    );
    expect(resOk.status).toBe(200);
    const rawJson = await resOk.text();
    expect(rawJson).not.toContain('narra-live-secret-token');
    expect(rawJson).not.toContain('a2a-live-secret-token');
    expect(rawJson).not.toContain('super-secret-admin-pw');

    const status = JSON.parse(rawJson) as Record<string, unknown>;
    expect(status.agentId).toBe(MFD_AGENT_ID);
    expect(status.matrixId).toBe(MFD_MATRIX_ID);
    expect(status.enabled).toBe(false);
    expect(status.syncEnabled).toBe(false);
    expect((status.config as Record<string, unknown>).NARRA_GATEWAY_ENABLED).toBe('off');
    expect((status.config as Record<string, unknown>).hasNarraAgentToken).toBe(true);
  });

  it('enforces strict 17-dataset routing and rejects antiKeywords', async () => {
    expect(dataApps).toHaveLength(17);

    // Dataset queries route positively
    for (const q of [
      'What AI hackathons have upcoming deadlines?',
      'Any recent visa changes for Japan or China?',
      '幫我查最新的產品召回和獎學金資料',
      '最近有哪些 AI 融资和机器人发布数据？',
      'Show oncology drug updates and marathons',
    ]) {
      const ev = makeInboundEvent({ text: q });
      const decision = await routeEvent(ev, DEFAULT_ROOM_CTX, MFD_AGENT_SPEC);
      expect(decision.shouldReply, `Expected match for: ${q}`).toBe(true);
    }

    // Off-topic antiKeywords in ambient group chat are suppressed by router
    for (const offTopic of [
      'Recommend a spicy Sichuan hotpot restaurant in Chinatown',
      '哪家倫敦中餐館的點心和奶茶比較好喝？',
      'Draw me a tarot card or a fortune stick for love',
      'Any pop-up events with student vouchers in Soho?',
    ]) {
      const ev = makeInboundEvent({ text: offTopic });
      const decision = await routeEvent(ev, DEFAULT_ROOM_CTX, MFD_AGENT_SPEC);
      expect(decision.shouldReply, `Expected antiKeyword drop for: ${offTopic}`).toBe(false);

      // Even if forced through fastRespondMfd (e.g. DM or multi-mention), stays strictly on-domain
      const dmDecision: TriageDecision = {
        shouldReply: true,
        tier: 0,
        reason: 'dm',
        confidence: 1,
        detectedLang: decision.detectedLang,
        shouldQuote: false,
      };
      const replySingle = await fastRespondMfd(
        makeEnv(),
        makeInboundEvent({ text: offTopic, chatType: 'dm' }),
        dmDecision,
        EMPTY_MEM,
      );
      expect(replySingle).toBeTruthy();
      expect(replySingle).not.toBe('[NO_REPLY]');

      const multiDecision: TriageDecision = {
        shouldReply: true,
        tier: 1,
        reason: 'multi_mention_domain_match',
        confidence: 0.85,
        detectedLang: decision.detectedLang,
        shouldQuote: true,
      };
      const replyMulti = await fastRespondMfd(
        makeEnv(),
        makeInboundEvent({ text: `@mfd-guide ${offTopic}` }),
        multiDecision,
        EMPTY_MEM,
      );
      expect(replyMulti).toBe('[NO_REPLY]');
    }
  });

  it('answers D1 dataset queries in zh-Hant, zh-Hans, and en with bare URLs', async () => {
    const db = createD1();
    const today = todayUtc();

    await seedVerifiedRecord(db, 'visa-changes', 'visa_jp_2026', {
      ...findDataApp('visa-changes')!.example.data,
      title: 'China extends 30-day visa-free entry for Japan',
      destination: ['China'],
      travelers: ['Japan'],
      effective_on: today,
    });
    await seedVerifiedRecord(db, 'ai-hackathons', 'hack_upcoming', {
      ...findDataApp('ai-hackathons')!.example.data,
      name: 'Global Agents Hackathon 2099',
      deadline: '2099-11-15',
      starts_on: '2099-11-20',
      ends_on: '2099-11-22',
    });
    await seedVerifiedRecord(db, 'ai-fundraising', 'fund_alpha', {
      ...findDataApp('ai-fundraising')!.example.data,
      company: 'Alpha Compute Labs',
      announced_on: today,
    });
    await seedVerifiedRecord(db, 'recalls', 'recall_1', {
      ...findDataApp('recalls')!.example.data,
      product: 'Model X Smart Battery Pack',
      announced_on: today,
    });
    await seedVerifiedRecord(db, 'scholarships', 'schol_chevening', {
      ...findDataApp('scholarships')!.example.data,
      name: 'Chevening Global Fellowship',
      deadline: '2099-10-01',
    });

    const env = makeEnv({ DB: db });

    // 1. zh-Hant
    const zhHantEv = makeInboundEvent({ text: '@mfd-guide 最近有哪些 AI 黑客松？' });
    const zhHantDecision = await routeEvent(zhHantEv, DEFAULT_ROOM_CTX, MFD_AGENT_SPEC);
    expect(zhHantDecision.detectedLang).toBe('zh-Hant');
    const zhHantReply = await fastRespondMfd(env, zhHantEv, zhHantDecision, EMPTY_MEM);
    expect(zhHantReply).toContain('Global Agents Hackathon 2099');
    expect(zhHantReply).toContain('https://data.manyfold.ai/ai-hackathons/r/hack_upcoming');
    expect(zhHantReply).toContain('已驗證資料');
    expect(zhHantReply).not.toMatch(/\[[^\]]+\]\(https?:\/\//);
    expect(sanitizeMobileLinks(zhHantReply!)).toBe(zhHantReply);

    // 2. zh-Hans
    const zhHansEv = makeInboundEvent({ text: '@mfd-guide 帮我查一下最近的中国签证政策变化' });
    const zhHansDecision = await routeEvent(zhHansEv, DEFAULT_ROOM_CTX, MFD_AGENT_SPEC);
    expect(zhHansDecision.detectedLang).toBe('zh-Hans');
    const zhHansReply = await fastRespondMfd(env, zhHansEv, zhHansDecision, EMPTY_MEM);
    expect(zhHansReply).toContain('China extends 30-day visa-free entry for Japan');
    expect(zhHansReply).toContain('https://data.manyfold.ai/visa-changes/r/visa_jp_2026');
    expect(zhHansReply).toContain('已验证数据');
    expect(zhHansReply).not.toMatch(/\[[^\]]+\]\(https?:\/\//);

    // 3. en scholarship & overview
    const enEv = makeInboundEvent({ text: 'List open international scholarships' });
    const enDecision = await routeEvent(enEv, DEFAULT_ROOM_CTX, MFD_AGENT_SPEC);
    expect(enDecision.detectedLang).toBe('en');
    const enReply = await fastRespondMfd(env, enEv, enDecision, EMPTY_MEM);
    expect(enReply).toContain('Chevening Global Fellowship');
    expect(enReply).toContain('https://data.manyfold.ai/scholarships/r/schol_chevening');
    expect(enReply).not.toMatch(/\[[^\]]+\]\(https?:\/\//);

    const listEv = makeInboundEvent({ text: '@mfd-guide what datasets exist?' });
    const listDecision = await routeEvent(listEv, DEFAULT_ROOM_CTX, MFD_AGENT_SPEC);
    const listReply = await fastRespondMfd(env, listEv, listDecision, EMPTY_MEM);
    expect(listReply).toContain('17 verified open datasets');
    expect(listReply).toContain('https://data.manyfold.ai/');
  });

  it('filters fetchMfdUpdates to high-signal verified records and deduplicates staggered broadcasts', async () => {
    const db = createD1();
    const today = todayUtc();

    await seedVerifiedRecord(
      db,
      'visa-changes',
      'hs_visa',
      {
        ...findDataApp('visa-changes')!.example.data,
        title: 'UK ETA begins for EU visitors',
        effective_on: today,
      },
      '2026-11-19T12:10:00Z',
    );
    await seedVerifiedRecord(
      db,
      'ai-hackathons',
      'hs_hack_past',
      {
        ...findDataApp('ai-hackathons')!.example.data,
        name: 'Expired 2020 Hackathon',
        deadline: '2020-01-01',
        starts_on: '2020-01-10',
        ends_on: '2020-01-12',
      },
      '2026-11-19T12:20:00Z',
    );
    await seedVerifiedRecord(
      db,
      'ai-hackathons',
      'hs_hack_future',
      {
        ...findDataApp('ai-hackathons')!.example.data,
        name: 'Future Open Source AI Hack',
        deadline: '2099-12-01',
        starts_on: '2099-12-10',
        ends_on: '2099-12-12',
      },
      '2026-11-19T12:15:00Z',
    );
    await seedVerifiedRecord(
      db,
      'new-rules',
      'hs_rule',
      {
        ...findDataApp('new-rules')!.example.data,
        title: 'EU AI Act transparency rules take effect',
        effective_on: today,
      },
      '2026-11-19T12:12:00Z',
    );
    await seedVerifiedRecord(
      db,
      'scholarships',
      'low_sig_schol',
      {
        ...findDataApp('scholarships')!.example.data,
        name: 'Non-High-Signal Scholarship',
      },
      '2026-11-19T12:30:00Z',
    );

    const updates = await queryHighSignalUpdates({ DB: db }, '2026-11-19T12:00:00Z', 5);
    expect(updates.map((u) => u.slug).every((s) => (HIGH_SIGNAL_SLUGS as readonly string[]).includes(s))).toBe(true);
    expect(updates.map((u) => u.id)).toEqual(['hs_hack_future', 'hs_rule', 'hs_visa']);

    const roomMatch = '!mfd_bcast:matrix.netmind.chat';
    const dmRoom = '!mfd_dm:matrix.netmind.chat';
    const slot = staggerWindowMinute(MFD_AGENT_ID, roomMatch, 60);
    const nowDate = new Date('2026-11-19T12:00:00.000Z');
    nowDate.setUTCMinutes(slot, 0, 0);
    const nowMs = nowDate.getTime();

    const sentPayloads: Array<{ roomId: string; text: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/agent-runtime/chat/send')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { room_id: string; text: string };
        sentPayloads.push({ roomId: body.room_id, text: body.text });
        return Response.json({ status: 'ok', data: { event_id: `$mfd_bc_${sentPayloads.length}` } });
      }
      return new Response('not found', { status: 404 });
    });

    let env!: Env;
    const syncHandle = createFakeNamespace((ctx) => new NarraMatrixSync(ctx, env));
    const roomHandle = createFakeNamespace((ctx) => new NarraRoomCoordinator(ctx, env));

    env = makeEnv({
      DB: db,
      NARRA_GATEWAY_ENABLED: 'on',
      NARRA_SYNC: 'off',
      NARRA_AGENT_TOKEN: 'narra_mfd_bcast_tok',
      NARRA_SYNC_DO: syncHandle.namespace,
      NARRA_ROOM_DO: roomHandle.namespace,
    });

    // Seed group language memory + DM context to ensure DM is excluded
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS narra_room_memory (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          room_id TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'fact',
          memory_key TEXT NOT NULL,
          memory_value TEXT NOT NULL,
          updated_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(agent_id, room_id, memory_key)
        )`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO narra_room_memory (id, agent_id, room_id, kind, memory_key, memory_value, created_at, updated_at)
         VALUES ('mem_1', ?, ?, 'language', 'language', 'zh-Hant', '2026-11-19T11:00:00Z', '2026-11-19T11:00:00Z')`,
      )
      .bind(MFD_AGENT_ID, roomMatch)
      .run();

    await roomHandle.namespace.get(roomHandle.namespace.idFromName(dmRoom)).fetch('https://narra-room/status');
    await roomHandle.storages.get(dmRoom)!.put('chatType', 'dm');
    await roomHandle.namespace.get(roomHandle.namespace.idFromName(dmRoom)).fetch('https://narra-room/events', {
      method: 'POST',
      body: JSON.stringify({ roomId: dmRoom, chatType: 'dm', events: [] }),
    });

    const syncStub = syncHandle.namespace.get(syncHandle.namespace.idFromName('narra'));
    await syncStub.fetch('https://narra-sync/kick', { method: 'POST' });
    await syncHandle.storages.get('narra')!.put('roomIds', [roomMatch, dmRoom]);

    const items = await fetchMfdUpdates(env, '2026-11-19T12:00:00Z', fetchMock as unknown as typeof fetch);
    expect(items).toHaveLength(1);
    expect(items[0]!.roomId).toBe(roomMatch);
    expect(items[0]!.lang).toBe('zh-Hant');
    expect(items[0]!.text).toContain('https://data.manyfold.ai/ai-hackathons/r/hs_hack_future');
    expect(items[0]!.text).not.toContain('Expired 2020 Hackathon');
    expect(items[0]!.text).not.toContain('Non-High-Signal Scholarship');

    const cfg = createMfdGatewayConfig({
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => nowMs,
    });

    const kick1 = await kickNarraGateway(env, cfg);
    expect(kick1.enabled).toBe(true);
    expect(kick1.broadcast?.sent).toHaveLength(1);
    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0]!.roomId).toBe(roomMatch);

    // Second kick dedupes via D1 narra_broadcast_log
    const kick2 = await kickNarraGateway(env, cfg);
    expect(kick2.broadcast?.sent).toHaveLength(0);
    expect(sentPayloads).toHaveLength(1);
  });

  it('falls back to Manyfold A2A when D1 lacks a match and sanitizes Markdown links to bare URLs', async () => {
    const db = createD1();
    await ensureSchema(db);
    const nowMs = Date.now();
    const sentTexts: string[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://a2a.mfd.test/rpc') {
        const sse = `data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: '1',
          result: {
            kind: 'status-update',
            status: {
              state: 'completed',
              message: {
                role: 'agent',
                parts: [
                  {
                    kind: 'text',
                    text: 'See [AI Accelerators](https://data.manyfold.ai/ai-accelerators) for verified compute grant cohorts.',
                  },
                ],
              },
            },
          },
        })}\n\n`;
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (url.endsWith('/api/agent-runtime/chat/send')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { text: string };
        sentTexts.push(body.text);
        return Response.json({ status: 'ok', data: { event_id: '$mfd_a2a_1' } });
      }
      return new Response('not found', { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const env = makeEnv({
      DB: db,
      NARRA_GATEWAY_ENABLED: 'on',
      NARRA_SYNC: 'off',
      NARRA_AGENT_TOKEN: 'narra_tok_mfd_a2a',
      MANYFOLD_A2A_URL: 'https://a2a.mfd.test/rpc',
      MANYFOLD_A2A_TOKEN: 'a2a_secret_mfd',
    });

    const dmRoom = '!dm_mfd_a2a:matrix.netmind.chat';
    const dmEv = makeInboundEvent({
      roomId: dmRoom,
      chatType: 'dm',
      text: 'Any quantum compute credits accelerator programs in Munich?',
    });
    const dmDecision = await routeEvent(
      dmEv,
      {
        roomId: dmRoom,
        chatType: 'dm',
        members: [{ matrixId: '@alice:matrix.netmind.chat', isAgent: false }],
        recentHistory: [],
      },
      MFD_AGENT_SPEC,
    );
    expect(dmDecision.shouldReply).toBe(true);
    const fast = await fastRespondMfd(env, dmEv, dmDecision, EMPTY_MEM);
    expect(fast).toBeNull();

    const roomHandle = createFakeNamespace((ctx) => new NarraRoomCoordinator(ctx, env));
    const stub = roomHandle.namespace.get(roomHandle.namespace.idFromName(dmRoom));

    await stub.fetch('https://narra-room/events', {
      method: 'POST',
      body: JSON.stringify({
        roomId: dmRoom,
        chatType: 'dm',
        events: [
          {
            event_id: '$ev_mfd_a2a',
            sender: '@alice:matrix.netmind.chat',
            type: 'm.room.message',
            origin_server_ts: nowMs,
            content: { msgtype: 'm.text', body: dmEv.text },
          },
        ],
      }),
    });

    // Wait past 1.8s BurstCoalescer debounce using real Date.now() clock inside NarraRoomCoordinator
    await new Promise((resolve) => setTimeout(resolve, 1_900));
    await roomHandle.instances.get(dmRoom)!.instance.alarm();

    expect(sentTexts).toHaveLength(1);
    expect(sentTexts[0]).toBe(
      sanitizeMobileLinks(
        'See [AI Accelerators](https://data.manyfold.ai/ai-accelerators) for verified compute grant cohorts.',
      ),
    );
    expect(sentTexts[0]).not.toMatch(/\[[^\]]+\]\(https?:\/\//);
    expect(sentTexts[0]).toContain('https://data.manyfold.ai/ai-accelerators');
  });

  it('strips multi-word and sibling @mentions cleanly and converts Simplified summary text in zh-Hant', async () => {
    const db = createD1();

    await seedVerifiedRecord(db, 'ai-hackathons', 'hack_hant_check', {
      ...findDataApp('ai-hackathons')!.example.data,
      name: '伦敦开源黑客营 2099',
      deadline: '2099-11-15',
      starts_on: '2099-11-20',
      ends_on: '2099-11-22',
    });

    const env = makeEnv({ DB: db });

    // Multi-word mention + sibling mentions stripped cleanly without polluting search terms
    const ev = makeInboundEvent({
      text: '@Manyfold Data @London Chinese Food @AI in 5 @問一籤 最近有哪些黑客松？',
    });
    const decision = await routeEvent(ev, DEFAULT_ROOM_CTX, MFD_AGENT_SPEC);
    expect(decision.detectedLang).toBe('zh-Hant');

    const reply = await fastRespondMfd(env, ev, decision, EMPTY_MEM);
    expect(reply).toBeTruthy();
    expect(reply).toContain('倫敦開源黑客營 2099');
    expect(reply).not.toContain('伦敦开源');

    // Mention-only message falls back to greeting instead of treating "Data" as query
    const mentionOnlyEv = makeInboundEvent({
      text: '@Manyfold Data @Spotted London @Penny @Quidpaw',
    });
    const mentionOnlyReply = await fastRespondMfd(
      env,
      mentionOnlyEv,
      { shouldReply: true, tier: 0, reason: 'mention', confidence: 1, detectedLang: 'zh-Hant', shouldQuote: true },
      EMPTY_MEM,
    );
    expect(mentionOnlyReply).toContain('Manyfold Data 小幫手');
  });
});
