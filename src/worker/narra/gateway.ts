/**
 * Narra Messenger Gateway configuration for Manyfold Data (`mfd-guide`).
 *
 * Uses `@manyfold/narra-agent-kit/worker` for decentralized Matrix sync + per-room
 * Durable Object coordination, D1 3-layer memory, trilingual `zh-Hant`/`zh-Hans`/`en`
 * dataset search & high-signal updates across all 17 datasets with bare URLs,
 * and Manyfold A2A fallback.
 *
 * Invariants:
 * - Strict 17-dataset domain scope with explicit antiKeywords for off-topic domains.
 * - Bare `https://...` URLs only (never Markdown links or punctuation touching URLs).
 * - Strict `zh-Hant` / `zh-Hans` / `en` script purity matching `decision.detectedLang`.
 * - Zero external calls when `NARRA_GATEWAY_ENABLED` is not `'on'`.
 */

import type {
  AgentSpec,
  AgentUpdateItem,
  InboundEvent,
  LangCode,
  RecallTurnResult,
  TriageDecision,
} from '@manyfold/narra-agent-kit';
import {
  isNarraGatewayEnabled,
  type NarraA2ACredentialResult,
  type NarraGatewayConfig,
} from '@manyfold/narra-agent-kit/worker';
import { dataApps, findDataApp } from '../../../data-apps/index';
import { todayUtc, type DataAppConfig, type RecordData } from '../../shared/data-app';
import { listFrom } from '../../shared/engine';
import { defaultQuery, type QueryState } from '../../shared/query';
import type { DatasetResponse, PublicRecord } from '../../shared/types';
import { ensureSchema } from '../db';
import { fillLine } from '../notify';
import { appSummaries, datasetJson } from '../records';
import type { Env } from '../types';

export const MFD_AGENT_ID = 'mfd-guide';
export const MFD_MANYFOLD_AGENT_ID = 'agt_agq66cw5uzyudifa4fuhcnaddu';
export const MFD_MATRIX_ID = '@agent-37b08ab6:matrix.netmind.chat';
const DEFAULT_PUBLIC_ORIGIN = 'https://data.manyfold.ai';
const DEFAULT_NARRA_API = 'https://api.netmind.chat';

export const HIGH_SIGNAL_SLUGS = [
  'visa-changes',
  'new-rules',
  'recalls',
  'ai-hackathons',
  'ai-fundraising',
] as const;

const HIGH_SIGNAL_SET = new Set<string>(HIGH_SIGNAL_SLUGS);

export const MFD_AGENT_SPEC: AgentSpec = {
  id: MFD_AGENT_ID,
  matrixId: MFD_MATRIX_ID,
  name: 'Manyfold Data',
  aliases: [
    'mfd-guide',
    'MFD',
    'mfd',
    'ManyfoldData',
    'Manyfold Data',
    '資料小幫手',
    '數據小助手',
    '数据小助手',
  ],
  domainDescription:
    'Searches Manyfold Data’s 17 verified open datasets: AI hackathons, AI accelerators and grants, AI conferences and CFPs, AI fundraising, AI acquisitions, AI data centers, robotaxi cities, robot launches, AI scam alerts, visa policy changes, new rules taking effect, product recalls, international scholarships, marathons, endurance races, sky events, and cancer drug updates.',
  domainKeywords: [
    // 1. ai-hackathons
    'hackathon',
    'hackathons',
    '黑客松',
    '駭客松',
    // 2. ai-accelerators
    'accelerator',
    'accelerators',
    'grant',
    'grants',
    'fellowship',
    'residency',
    'compute credits',
    '加速器',
    '創業補助',
    '创业补助',
    '算力補貼',
    '算力补贴',
    // 3. ai-conferences
    'conference',
    'conferences',
    'cfp',
    'call for papers',
    'neurips',
    'icml',
    'iclr',
    '頂會',
    '顶会',
    '學術會議',
    '学术会议',
    '徵稿',
    '征稿',
    // 4. ai-fundraising
    'fundraising',
    'funding round',
    'series a',
    'series b',
    'seed round',
    'raised',
    '融資',
    '融资',
    '募資',
    '募资',
    // 5. ai-acquisitions
    'acquisition',
    'acquisitions',
    'acquired',
    'acqui-hire',
    'merger',
    '收購',
    '收购',
    '併購',
    '并购',
    // 6. ai-data-centers
    'data center',
    'data centers',
    'datacenter',
    'gigawatt',
    '算力中心',
    '資料中心',
    '数据中心',
    // 7. robotaxis
    'robotaxi',
    'robotaxis',
    'waymo',
    'apollo go',
    'pony.ai',
    'weride',
    'zoox',
    'driverless taxi',
    '無人計程車',
    '无人出租车',
    '自動駕駛計程車',
    '自动驾驶出租车',
    // 8. robot-launches
    'robot launch',
    'humanoid',
    'quadruped',
    'unitree',
    '1x neo',
    '人形機器人',
    '人形机器人',
    '機器狗',
    '机器狗',
    // 9. ai-scams
    'ai scam',
    'ai scams',
    'deepfake',
    'voice clone',
    'scam alert',
    'ai詐騙',
    'ai诈骗',
    '深偽',
    '深伪',
    '聲音克隆',
    '声音克隆',
    // 10. visa-changes
    'visa',
    'visas',
    'visa-free',
    'visa policy',
    'e-visa',
    'travel authorisation',
    'eta',
    'etias',
    '簽證',
    '签证',
    '免簽',
    '免签',
    '過境免簽',
    '过境免签',
    '電子簽',
    '电子签',
    // 11. new-rules
    'new rule',
    'new rules',
    'takes effect',
    'effective on',
    'regulation',
    '新規',
    '新规',
    '新法規',
    '新法规',
    '法規生效',
    '法规生效',
    // 12. recalls
    'recall',
    'recalls',
    'safety recall',
    'product recall',
    '召回',
    // 13. scholarships
    'scholarship',
    'scholarships',
    'chevening',
    'erasmus',
    'daad',
    '獎學金',
    '奖学金',
    // 14. marathons
    'marathon',
    'marathons',
    '馬拉松',
    '马拉松',
    // 15. endurance-races
    'half marathon',
    'half-marathon',
    'trail race',
    'ultra',
    'triathlon',
    'ironman',
    'utmb',
    '半程馬拉松',
    '半程马拉松',
    '半馬',
    '半马',
    '越野跑',
    '鐵人三項',
    '铁人三项',
    // 16. sky-events
    'sky event',
    'solar eclipse',
    'lunar eclipse',
    'meteor shower',
    'comet',
    'rocket launch',
    '日食',
    '月食',
    '流星雨',
    '彗星',
    '火箭發射',
    '火箭发射',
    '天象',
    // 17. oncology-drug-updates
    'oncology',
    'cancer drug',
    'phase 3',
    'fda approval',
    '抗癌藥',
    '抗癌药',
    '腫瘤藥物',
    '肿瘤药物',
    '臨床三期',
    '临床三期',
    // Meta dataset queries
    'manyfold data',
    'dataset',
    'datasets',
    '資料集',
    '数据集',
  ],
  antiKeywords: [
    // Restaurants & food (lcf-guide)
    'restaurant',
    'restaurants',
    'chinese food',
    'dim sum',
    'hotpot',
    'hot pot',
    'bubble tea',
    'boba',
    'chinatown',
    'sichuan',
    'cantonese',
    'noodles',
    'dumplings',
    '中餐',
    '餐廳',
    '餐厅',
    '火鍋',
    '火锅',
    '奶茶',
    '川菜',
    '點心',
    '点心',
    '中國城',
    '中国城',
    '吃什麼',
    '吃什么',
    // Tarot (tarot-master-2)
    'tarot',
    '塔羅',
    '塔罗',
    '占卜',
    '抽牌',
    // Fortune stick (fortune-stick)
    'fortune stick',
    '求籤',
    '求签',
    '問一籤',
    '问一签',
    '抽籤',
    '抽签',
    '籤詩',
    '签诗',
    '解籤',
    '解签',
    // Pop-ups (spotted-guide)
    'pop-up',
    'popup',
    'pop up',
    '快閃',
    '快闪',
    'exhibition',
    '展覽',
    '展览',
    // Vouchers / deals (quidpaw)
    'voucher',
    'vouchers',
    'coupon',
    'coupons',
    'promo code',
    'discount code',
    '優惠碼',
    '优惠码',
    '折扣碼',
    '折扣码',
    'rebate',
    // Split bills (penny)
    'split bill',
    'split the bill',
    '分帳',
    '分账',
    'aa制',
    // General AI news (ai5-chat)
    'ai news',
    'ai in 5',
    'ai5',
    'ai新聞',
    'ai新闻',
    '今日ai',
  ],
  silenceThreshold: 0.55,
  sessionWindowMs: 180_000,
  politeYieldDelayMs: 1_800,
  capabilities: {
    supportsVoice: true,
  },
};

const originOfEnv = (env: Pick<Env, 'PUBLIC_ORIGIN'>): string =>
  (env.PUBLIC_ORIGIN ?? DEFAULT_PUBLIC_ORIGIN).replace(/\/+$/, '');

export const recordUrl = (env: Pick<Env, 'PUBLIC_ORIGIN'>, slug: string, id: string): string =>
  `${originOfEnv(env)}/${slug}/r/${id}`;

export const appUrl = (env: Pick<Env, 'PUBLIC_ORIGIN'>, slug: string): string =>
  `${originOfEnv(env)}/${slug}`;

const stripMentions = (text: string): string =>
  (text ?? '')
    .replace(/\[@[^\]\n]{1,80}\]\(@[^)\s]+\)/g, ' ')
    .replace(/@[A-Za-z0-9._=\-/+]+:[A-Za-z0-9.-]+(?::\d{1,5})?/g, ' ')
    .replace(/(?:^|\s)@[A-Za-z0-9._\-\u3400-\u9FFF]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const GREETING_RE =
  /^(?:你好|妳好|您好|嗨|哈囉|哈喽|早安|早|午安|晚安|你是誰|你是谁|謝謝|谢谢|感謝|感谢|hi|hello|hey|good\s*(?:morning|afternoon|evening)|thanks|thank\s+you|who\s+are\s+you)[!！。.?？~～\s]*$/i;

const COMPOUND_RE = /^\[internal hint\]\s*process compound\b/i;

const LIST_APPS_RE =
  /(?:有哪些數據集|有哪些数据集|什麼數據集|什么数据集|涵蓋哪些|涵盖哪些|what\s+datasets|which\s+datasets|list\s+(?:datasets|apps))/i;

const WHATS_NEW_RE =
  /(?:最近有什麼新|最近有什么新|最新數據|最新数据|新驗證|新验证|what(?:'s| is)\s+new|latest\s+(?:updates|records)|high[- ]signal)/i;

/* ───────── dataset inference & trilingual labels ───────── */

const DATASET_TRIGGERS: ReadonlyArray<{ slug: string; patterns: string[] }> = [
  { slug: 'ai-hackathons', patterns: ['hackathon', 'hackathons', '黑客松', '駭客松'] },
  {
    slug: 'ai-accelerators',
    patterns: ['accelerator', 'accelerators', 'grant', 'grants', 'fellowship', 'residency', 'compute credits', '加速器', '創業補助', '创业补助', '算力補貼', '算力补贴'],
  },
  {
    slug: 'ai-conferences',
    patterns: ['conference', 'conferences', 'cfp', 'call for papers', 'neurips', 'icml', 'iclr', '頂會', '顶会', '學術會議', '学术会议', '徵稿', '征稿'],
  },
  {
    slug: 'ai-fundraising',
    patterns: ['fundraising', 'funding', 'raised', 'series a', 'series b', 'seed round', '融資', '融资', '募資', '募资'],
  },
  {
    slug: 'ai-acquisitions',
    patterns: ['acquisition', 'acquisitions', 'acquired', 'acqui-hire', 'merger', '收購', '收购', '併購', '并购'],
  },
  {
    slug: 'ai-data-centers',
    patterns: ['data center', 'data centers', 'datacenter', 'gigawatt', '算力中心', '資料中心', '数据中心'],
  },
  {
    slug: 'robotaxis',
    patterns: ['robotaxi', 'robotaxis', 'waymo', 'apollo go', 'pony.ai', 'weride', 'zoox', 'driverless taxi', '無人計程車', '无人出租车', '自動駕駛計程車', '自动驾驶出租车'],
  },
  {
    slug: 'robot-launches',
    patterns: ['robot launch', 'humanoid', 'quadruped', 'unitree', '1x neo', 'robot dog', '人形機器人', '人形机器人', '機器狗', '机器狗', '機器人發售', '机器人发售'],
  },
  {
    slug: 'ai-scams',
    patterns: ['ai scam', 'ai scams', 'deepfake', 'voice clone', 'scam alert', 'ai詐騙', 'ai诈骗', '深偽', '深伪', '聲音克隆', '声音克隆'],
  },
  {
    slug: 'visa-changes',
    patterns: ['visa', 'visas', 'visa-free', 'e-visa', 'eta', 'etias', '簽證', '签证', '免簽', '免签', '過境免簽', '过境免签', '電子簽', '电子签'],
  },
  {
    slug: 'new-rules',
    patterns: ['new rule', 'new rules', 'regulation', 'takes effect', 'effective on', '新規', '新规', '新法規', '新法规', '法規生效', '法规生效'],
  },
  { slug: 'recalls', patterns: ['recall', 'recalls', '召回'] },
  {
    slug: 'scholarships',
    patterns: ['scholarship', 'scholarships', 'chevening', 'erasmus', 'daad', '獎學金', '奖学金'],
  },
  { slug: 'marathons', patterns: ['marathon', 'marathons', '馬拉松', '马拉松'] },
  {
    slug: 'endurance-races',
    patterns: ['half marathon', 'half-marathon', 'trail race', 'ultra', 'triathlon', 'ironman', 'utmb', '半程馬拉松', '半程马拉松', '半馬', '半马', '越野跑', '鐵人三項', '铁人三项'],
  },
  {
    slug: 'sky-events',
    patterns: ['sky event', 'solar eclipse', 'lunar eclipse', 'meteor shower', 'comet', 'rocket launch', '日食', '月食', '流星雨', '彗星', '火箭發射', '火箭发射', '天象'],
  },
  {
    slug: 'oncology-drug-updates',
    patterns: ['oncology', 'cancer drug', 'phase 3', 'fda approval', '抗癌藥', '抗癌药', '腫瘤藥物', '肿瘤药物', '臨床三期', '临床三期'],
  },
];

const DATASET_TITLES: Record<string, { en: string; 'zh-Hant': string; 'zh-Hans': string }> = {
  'ai-hackathons': { en: 'AI Hackathons', 'zh-Hant': 'AI 黑客松', 'zh-Hans': 'AI 黑客松' },
  'ai-accelerators': { en: 'AI Accelerators & Grants', 'zh-Hant': 'AI 加速器與資助', 'zh-Hans': 'AI 加速器与资助' },
  'ai-conferences': { en: 'AI Conferences & CFPs', 'zh-Hant': 'AI 學術會議與徵稿', 'zh-Hans': 'AI 学术会议与征稿' },
  'ai-fundraising': { en: 'AI Company Fundraising', 'zh-Hant': 'AI 公司融資', 'zh-Hans': 'AI 公司融资' },
  'ai-acquisitions': { en: 'AI Acquisitions', 'zh-Hant': 'AI 收購併購', 'zh-Hans': 'AI 收购并购' },
  'ai-data-centers': { en: 'AI Data Centers', 'zh-Hant': 'AI 資料中心', 'zh-Hans': 'AI 数据中心' },
  robotaxis: { en: 'Robotaxi Cities', 'zh-Hant': 'Robotaxi 城市', 'zh-Hans': 'Robotaxi 城市' },
  'robot-launches': { en: 'Robot Launches', 'zh-Hant': '機器人發布', 'zh-Hans': '机器人发布' },
  'ai-scams': { en: 'AI Scam Alerts', 'zh-Hant': 'AI 詐騙警報', 'zh-Hans': 'AI 诈骗警报' },
  'visa-changes': { en: 'Visa Policy Changes', 'zh-Hant': '簽證政策變化', 'zh-Hans': '签证政策变化' },
  'new-rules': { en: 'New Rules Taking Effect', 'zh-Hant': '新法規生效', 'zh-Hans': '新法规生效' },
  recalls: { en: 'Product Recalls', 'zh-Hant': '產品召回', 'zh-Hans': '产品召回' },
  scholarships: { en: 'International Scholarships', 'zh-Hant': '國際獎學金', 'zh-Hans': '国际奖学金' },
  marathons: { en: 'World Marathons', 'zh-Hant': '世界馬拉松', 'zh-Hans': '世界马拉松' },
  'endurance-races': { en: 'Half Marathons, Trails & Triathlons', 'zh-Hant': '半馬・越野・鐵三', 'zh-Hans': '半马・越野・铁三' },
  'sky-events': { en: 'Sky Events', 'zh-Hant': '天象與發射', 'zh-Hans': '天象与发射' },
  'oncology-drug-updates': { en: 'Cancer Drug Updates', 'zh-Hant': '抗癌藥物進展', 'zh-Hans': '抗癌药物进展' },
};

const CJK_ENTITY_MAP: ReadonlyArray<[string, string]> = [
  ['中國', 'China'],
  ['中国', 'China'],
  ['英國', 'United Kingdom'],
  ['英国', 'United Kingdom'],
  ['倫敦', 'London'],
  ['伦敦', 'London'],
  ['美國', 'United States'],
  ['美国', 'United States'],
  ['日本', 'Japan'],
  ['東京', 'Tokyo'],
  ['东京', 'Tokyo'],
  ['韓國', 'South Korea'],
  ['韩国', 'South Korea'],
  ['新加坡', 'Singapore'],
  ['德國', 'Germany'],
  ['德国', 'Germany'],
  ['法國', 'France'],
  ['法国', 'France'],
  ['歐洲', 'Europe'],
  ['欧洲', 'Europe'],
  ['歐盟', 'European Union'],
  ['欧盟', 'European Union'],
  ['香港', 'Hong Kong'],
  ['台灣', 'Taiwan'],
  ['台湾', 'Taiwan'],
  ['舊金山', 'San Francisco'],
  ['旧金山', 'San Francisco'],
  ['紐約', 'New York'],
  ['纽约', 'New York'],
  ['線上', 'online'],
  ['线上', 'online'],
];

const SEARCH_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'into',
  'about',
  'what',
  'which',
  'when',
  'where',
  'who',
  'how',
  'any',
  'are',
  'is',
  'was',
  'were',
  'can',
  'could',
  'tell',
  'show',
  'find',
  'check',
  'search',
  'list',
  'give',
  'latest',
  'recent',
  'upcoming',
  'open',
  'new',
  'updates',
  'update',
  'news',
  'dataset',
  'datasets',
  'manyfold',
  'data',
  'please',
  'thanks',
  'there',
  'here',
  'still',
  'now',
  // Domain words already used to select the dataset slug:
  'hackathon',
  'hackathons',
  'accelerator',
  'accelerators',
  'grant',
  'grants',
  'conference',
  'conferences',
  'fundraising',
  'funding',
  'raised',
  'acquisition',
  'acquisitions',
  'robotaxi',
  'robotaxis',
  'robot',
  'scam',
  'scams',
  'visa',
  'visas',
  'rule',
  'rules',
  'recall',
  'recalls',
  'scholarship',
  'scholarships',
  'marathon',
  'marathons',
  'sky',
  'oncology',
  'cancer',
]);

function matchToken(lowerText: string, needle: string): boolean {
  const clean = needle.trim().toLowerCase();
  if (!clean) return false;
  if (/[\u3400-\u9FFF]/.test(clean)) return lowerText.includes(clean);
  if (clean.includes(' ')) return lowerText.includes(clean);
  return new RegExp(`(?<![a-z0-9])${clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'i').test(
    lowerText,
  );
}

function inferDatasetSlugs(text: string): string[] {
  const lower = text.toLowerCase();
  const slugs: string[] = [];
  for (const item of DATASET_TRIGGERS) {
    if (item.patterns.some((p) => matchToken(lower, p))) {
      slugs.push(item.slug);
    }
  }
  return slugs;
}

function extractSearchTerms(text: string): string[] {
  const terms: string[] = [];
  for (const [zh, en] of CJK_ENTITY_MAP) {
    if (text.includes(zh)) terms.push(en);
  }
  const ascii = text.match(/[A-Za-z0-9][A-Za-z0-9.-]{1,}/g) ?? [];
  for (const tok of ascii) {
    const low = tok.toLowerCase();
    if (!SEARCH_STOPWORDS.has(low) && low.length >= 2) {
      terms.push(tok);
    }
  }
  return [...new Set(terms)];
}

/* ───────── D1 queries & high-signal updates ───────── */

export interface HighSignalUpdate {
  id: string;
  slug: string;
  datasetTitle: string;
  summary: string;
  verifiedAt: string;
}

function isUpcomingHackathon(data: RecordData, today: string): boolean {
  const bound = String(data.deadline ?? data.starts_on ?? '');
  return !bound || bound >= today;
}

/**
 * Queries newly verified high-signal records from D1 across
 * `visa-changes`, `new-rules`, `recalls`, `ai-hackathons`, `ai-fundraising`.
 */
export async function queryHighSignalUpdates(
  env: Pick<Env, 'DB'>,
  sinceIso: string,
  limit = 3,
): Promise<HighSignalUpdate[]> {
  if (!env.DB) return [];
  await ensureSchema(env.DB);
  const cutoff = (sinceIso ?? '').trim();
  const sql = cutoff
    ? `SELECT id, app_slug, data_json, verified_at FROM records
       WHERE app_slug IN ('visa-changes', 'new-rules', 'recalls', 'ai-hackathons', 'ai-fundraising')
         AND status = 'verified' AND verified_at IS NOT NULL AND verified_at > ?
       ORDER BY verified_at DESC, id DESC LIMIT 18`
    : `SELECT id, app_slug, data_json, verified_at FROM records
       WHERE app_slug IN ('visa-changes', 'new-rules', 'recalls', 'ai-hackathons', 'ai-fundraising')
         AND status = 'verified' AND verified_at IS NOT NULL
       ORDER BY verified_at DESC, id DESC LIMIT 18`;

  const { results } = cutoff
    ? await env.DB.prepare(sql).bind(cutoff).all<{ id: string; app_slug: string; data_json: string; verified_at: string }>()
    : await env.DB.prepare(sql).all<{ id: string; app_slug: string; data_json: string; verified_at: string }>();

  const today = todayUtc();
  const out: HighSignalUpdate[] = [];
  for (const row of results) {
    if (!HIGH_SIGNAL_SET.has(row.app_slug)) continue;
    const config = findDataApp(row.app_slug);
    if (!config) continue;
    const data = JSON.parse(row.data_json) as RecordData;
    if (row.app_slug === 'ai-hackathons' && !isUpcomingHackathon(data, today)) continue;

    out.push({
      id: row.id,
      slug: row.app_slug,
      datasetTitle: config.title,
      summary: fillLine(config, data),
      verifiedAt: row.verified_at,
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function discoverBroadcastRooms(
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Array<{ roomId: string; lang: LangCode }>> {
  const roomIds = new Set<string>();

  if (env.NARRA_SYNC_DO) {
    try {
      const stub = env.NARRA_SYNC_DO.get(env.NARRA_SYNC_DO.idFromName('narra'));
      const res = await stub.fetch('https://narra-sync/status');
      if (res.ok) {
        const status = (await res.json()) as { roomIds?: unknown };
        if (Array.isArray(status.roomIds)) {
          for (const id of status.roomIds) {
            if (typeof id === 'string' && id.startsWith('!')) roomIds.add(id);
          }
        }
      }
    } catch {
      // Ignore unreachable sync DO.
    }
  }

  const roomLangs = new Map<string, LangCode>();
  if (env.DB) {
    try {
      const rows = await env.DB
        .prepare('SELECT room_id, memory_key, memory_value FROM narra_room_memory WHERE agent_id = ?')
        .bind(MFD_AGENT_ID)
        .all<{ room_id: string; memory_key: string; memory_value: string }>();
      for (const r of rows.results) {
        if (r.room_id.startsWith('!')) roomIds.add(r.room_id);
        if (
          (r.memory_key === 'language' || r.memory_key === 'lang') &&
          (r.memory_value === 'zh-Hant' || r.memory_value === 'zh-Hans' || r.memory_value === 'en')
        ) {
          roomLangs.set(r.room_id, r.memory_value);
        }
      }
    } catch {
      // narra_room_memory may not be initialized yet.
    }
  }

  if (roomIds.size === 0 && isNarraGatewayEnabled(env)) {
    const endpoint = (env.NARRA_API_ENDPOINT ?? DEFAULT_NARRA_API).replace(/\/+$/, '');
    try {
      const res = await fetchImpl(
        `${endpoint}/api/agent-runtime/chat/rooms?conversation_type=group`,
        {
          headers: { authorization: `Bearer ${env.NARRA_AGENT_TOKEN!.trim()}` },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        const data = (body && typeof body.data === 'object' && body.data ? body.data : body) as Record<
          string,
          unknown
        > | null;
        const rooms = Array.isArray(data?.rooms) ? (data!.rooms as Array<Record<string, unknown>>) : [];
        for (const r of rooms) {
          if (typeof r.room_id === 'string' && r.room_id.startsWith('!') && r.conversation_type !== 'dm') {
            roomIds.add(r.room_id);
          }
        }
      }
    } catch {
      // Non-fatal fallback.
    }
  }

  const out: Array<{ roomId: string; lang: LangCode }> = [];
  for (const roomId of roomIds) {
    if (env.NARRA_ROOM_DO) {
      try {
        const roomStub = env.NARRA_ROOM_DO.get(env.NARRA_ROOM_DO.idFromName(roomId));
        const res = await roomStub.fetch('https://narra-room/status');
        if (res.ok) {
          const st = (await res.json()) as { chatType?: string | null };
          if (st.chatType === 'dm') continue;
        }
      } catch {
        // Keep room if status check fails.
      }
    }
    out.push({ roomId, lang: roomLangs.get(roomId) ?? 'en' });
  }
  return out;
}

export function formatMfdUpdatesMessage(
  env: Pick<Env, 'PUBLIC_ORIGIN'>,
  updates: readonly HighSignalUpdate[],
  lang: LangCode,
): string {
  if (updates.length === 0) return '';
  const header =
    lang === 'zh-Hant'
      ? '📊 Manyfold Data 最新高價值驗證數據：'
      : lang === 'zh-Hans'
        ? '📊 Manyfold Data 最新高价值验证数据：'
        : '📊 Newly verified high-signal records on Manyfold Data:';

  const lines = [header];
  for (const u of updates.slice(0, 3)) {
    const title = DATASET_TITLES[u.slug]?.[lang] ?? u.datasetTitle;
    lines.push(`- [${title}] ${u.summary}`);
    lines.push(recordUrl(env, u.slug, u.id));
  }
  return lines.join('\n');
}

export async function fetchMfdUpdates(
  env: Env,
  sinceIso: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AgentUpdateItem[]> {
  const updates = await queryHighSignalUpdates(env, sinceIso, 3);
  if (updates.length === 0) return [];
  const rooms = await discoverBroadcastRooms(env, fetchImpl);
  if (rooms.length === 0) return [];

  const updateKey = `mfd-updates:${updates.map((u) => u.id).sort().join(',')}`;
  return rooms.map((room) => ({
    updateKey,
    roomId: room.roomId,
    chatType: 'group' as const,
    title: 'Manyfold Data updates',
    text: formatMfdUpdatesMessage(env, updates, room.lang),
    lang: room.lang,
    priority: 'normal' as const,
  }));
}

/* ───────── fastRespond formatting & search ───────── */

function greetingReply(lang: LangCode): string {
  if (lang === 'zh-Hant') {
    return '嗨！我是 Manyfold Data 小幫手，黑客松、AI 融資、簽證變化、新法規、召回或獎學金都能幫你查，想找哪一類？';
  }
  if (lang === 'zh-Hans') {
    return '嗨！我是 Manyfold Data 小助手，黑客松、AI 融资、签证变化、新法规、召回或奖学金都能帮你查，想找哪一类？';
  }
  return "Hi! I'm the Manyfold Data guide — ask me about upcoming AI hackathons, funding rounds, visa changes, new rules, recalls, or scholarships.";
}

function compoundReply(lang: LangCode): string {
  if (lang === 'zh-Hant') {
    return '這則訊息是圖片或檔案我暫時看不到喔，直接用文字告訴我想查哪個資料集或關鍵詞就可以！';
  }
  if (lang === 'zh-Hans') {
    return '这条消息是图片或文件我暂时看不到哦，直接用文字告诉我想查哪个数据集或关键词就可以！';
  }
  return "I can't view images or files here — just type the dataset or topic you want me to search!";
}

function offTopicRedirect(lang: LangCode): string {
  if (lang === 'zh-Hant') {
    return '這題不在我的資料集裡，我只查 Manyfold Data（黑客松、融資、簽證變化、新法規、召回、獎學金等），想找哪一類？';
  }
  if (lang === 'zh-Hans') {
    return '这题我答不了，我只查 Manyfold Data 里的数据（黑客松、融资、签证变化、新法规、召回、奖学金等），想找哪一类？';
  }
  return "That's outside my datasets — I only search Manyfold Data (hackathons, funding, visa changes, new rules, recalls, scholarships, and more). Want me to check one of those?";
}

function hasA2ACredential(env: Env): boolean {
  return Boolean((env.MANYFOLD_A2A_URL ?? '').trim() && (env.MANYFOLD_A2A_TOKEN ?? '').trim());
}

async function queryDatasetRecords(
  db: D1Database,
  config: DataAppConfig,
  terms: readonly string[],
  limit: number,
  now: Date,
): Promise<{ records: PublicRecord[]; total: number; usedDefaultFilter: boolean; today: string }> {
  const dataset = JSON.parse(await datasetJson(db, config, now)) as DatasetResponse;
  const baseDefault = defaultQuery(config);
  const runSearch = (useDefault: boolean, qTerm: string) => {
    const state: QueryState = {
      q: qTerm,
      filters: useDefault ? baseDefault.filters : {},
      sort: baseDefault.sort,
      page: 1,
    };
    return listFrom(config, dataset, state, limit, { facets: false });
  };

  if (terms.length === 0) {
    let res = runSearch(true, '');
    let usedDefaultFilter = true;
    if (res.records.length === 0 && Object.keys(baseDefault.filters).length > 0) {
      res = runSearch(false, '');
      usedDefaultFilter = false;
    }
    return { records: res.records, total: res.total, usedDefaultFilter, today: res.today };
  }

  for (const term of terms) {
    const res = runSearch(true, term);
    if (res.records.length > 0) {
      return { records: res.records, total: res.total, usedDefaultFilter: true, today: res.today };
    }
  }
  for (const term of terms) {
    const res = runSearch(false, term);
    if (res.records.length > 0) {
      return { records: res.records, total: res.total, usedDefaultFilter: false, today: res.today };
    }
  }

  return { records: [], total: 0, usedDefaultFilter: true, today: dataset.today };
}

function formatRecordResults(
  env: Pick<Env, 'PUBLIC_ORIGIN'>,
  config: DataAppConfig,
  records: readonly PublicRecord[],
  total: number,
  today: string,
  lang: LangCode,
  usedDefaultFilter: boolean,
): string {
  const title = DATASET_TITLES[config.slug]?.[lang] ?? config.title;
  const header =
    lang === 'zh-Hant'
      ? `📊 Manyfold Data「${title}」共找到 ${total} 筆已驗證資料（今天是 ${today}${!usedDefaultFilter ? '，含歷史/已結束紀錄' : ''}）：`
      : lang === 'zh-Hans'
        ? `📊 Manyfold Data「${title}」共找到 ${total} 条已验证数据（今天是 ${today}${!usedDefaultFilter ? '，含历史/已结束记录' : ''}）：`
        : `📊 Manyfold Data (${title}) lists ${total} matching verified record${total === 1 ? '' : 's'} (today is ${today}${!usedDefaultFilter ? ', including past dates' : ''}):`;

  const lines = [header];
  for (const rec of records) {
    lines.push(`- ${fillLine(config, rec.data)}`);
    lines.push(recordUrl(env, config.slug, rec.id));
  }
  return lines.join('\n');
}

function resolveMemorySlugs(memories: RecallTurnResult): string[] {
  const slugs: string[] = [];
  for (const m of [...memories.userMemories, ...memories.roomMemories]) {
    if (m.key === 'watch_datasets' || m.key === 'dataset') {
      for (const part of m.value.split(',')) {
        const clean = part.trim();
        if (findDataApp(clean)) slugs.push(clean);
      }
    }
  }
  return slugs;
}

/**
 * Fast D1-backed responder for Manyfold Data (`mfd-guide`).
 * Returns `null` when Manyfold A2A should handle the turn.
 */
export async function fastRespondMfd(
  env: Env,
  event: InboundEvent,
  decision: TriageDecision,
  memories: RecallTurnResult,
): Promise<string | null> {
  const lang = decision.detectedLang;
  const cleanedText = stripMentions(event.text);

  if (event.kind === 'image' || event.kind === 'compound' || COMPOUND_RE.test(event.text)) {
    return compoundReply(lang);
  }
  if (!cleanedText || GREETING_RE.test(cleanedText)) {
    return greetingReply(lang);
  }

  const isMultiMention = decision.reason === 'multi_mention_domain_match';
  const inferredSlugs = inferDatasetSlugs(cleanedText);
  const hasAntiHit = (MFD_AGENT_SPEC.antiKeywords ?? []).some((kw) => {
    if (kw instanceof RegExp) return kw.test(cleanedText);
    return matchToken(cleanedText.toLowerCase(), kw);
  });

  if (hasAntiHit && inferredSlugs.length === 0) {
    return isMultiMention ? '[NO_REPLY]' : offTopicRedirect(lang);
  }

  const limit = event.isVoice ? 2 : event.chatType === 'group' ? 3 : 5;
  const now = new Date();

  if (!env.DB) {
    return hasA2ACredential(env) ? null : offTopicRedirect(lang);
  }

  await ensureSchema(env.DB);

  // 1. "What datasets exist?"
  if (LIST_APPS_RE.test(cleanedText)) {
    const summaries = await appSummaries(env.DB, dataApps, now);
    const nonEmpty = summaries.filter((s) => s.verified > 0);
    const shown = (nonEmpty.length > 0 ? nonEmpty : summaries).slice(0, limit === 2 ? 3 : 6);
    const header =
      lang === 'zh-Hant'
        ? `📊 Manyfold Data 目前收錄 ${dataApps.length} 個已驗證開放資料集：`
        : lang === 'zh-Hans'
          ? `📊 Manyfold Data 目前收录 ${dataApps.length} 个已验证开放数据集：`
          : `📊 Manyfold Data covers ${dataApps.length} verified open datasets:`;
    const lines = [header];
    for (const s of shown) {
      const title = DATASET_TITLES[s.slug]?.[lang] ?? s.title;
      lines.push(`- ${title} (${s.verified})`);
      lines.push(appUrl(env, s.slug));
    }
    return lines.join('\n');
  }

  // 2. "What's new?" -> high-signal verified updates (without marking broadcast watermark)
  if (WHATS_NEW_RE.test(cleanedText) && inferredSlugs.length === 0) {
    const updates = await queryHighSignalUpdates(env, '', Math.min(limit, 3));
    if (updates.length > 0) {
      return formatMfdUpdatesMessage(env, updates, lang);
    }
  }

  // 3. Targeted dataset query (or remembered watched datasets)
  const terms = extractSearchTerms(cleanedText);
  const candidateSlugs = inferredSlugs.length > 0 ? inferredSlugs : resolveMemorySlugs(memories);

  if (candidateSlugs.length > 0) {
    for (const slug of candidateSlugs) {
      const config = findDataApp(slug);
      if (!config) continue;
      const res = await queryDatasetRecords(env.DB, config, terms, limit, now);
      if (res.records.length > 0) {
        return formatRecordResults(env, config, res.records, res.total, res.today, lang, res.usedDefaultFilter);
      }
    }
    // If terms narrowed too strictly on an inferred dataset, show recent verified rows of that dataset when no A2A.
    if (terms.length > 0 && !hasA2ACredential(env)) {
      const primary = findDataApp(candidateSlugs[0]!);
      if (primary) {
        const broader = await queryDatasetRecords(env.DB, primary, [], limit, now);
        if (broader.records.length > 0) {
          return formatRecordResults(
            env,
            primary,
            broader.records,
            broader.total,
            broader.today,
            lang,
            broader.usedDefaultFilter,
          );
        }
      }
    }
  }

  // 4. Cross-dataset text search when specific search terms exist
  if (terms.length > 0) {
    for (const config of dataApps) {
      const res = await queryDatasetRecords(env.DB, config, terms, limit, now);
      if (res.records.length > 0) {
        return formatRecordResults(env, config, res.records, res.total, res.today, lang, res.usedDefaultFilter);
      }
    }
  }

  // 5. Fallback to Manyfold A2A if credential is available
  if (hasA2ACredential(env)) {
    return null;
  }

  // Graceful response when A2A is not configured
  const root = originOfEnv(env);
  if (inferredSlugs.length > 0 || terms.length > 0) {
    if (lang === 'zh-Hant') {
      return `Manyfold Data 目前還沒有查到符合的已驗證紀錄，可在首頁查看全部 17 個資料集或提交「Request a data app」：\n${root}`;
    }
    if (lang === 'zh-Hans') {
      return `Manyfold Data 目前还没有查到符合的已验证记录，可在首页查看全部 17 个数据集或提交「Request a data app」：\n${root}`;
    }
    return `Manyfold Data doesn't have a matching verified record for that yet — browse all 17 datasets or use "Request a data app" here:\n${root}`;
  }

  if (lang === 'zh-Hant') {
    return '想查詢哪一個資料集（如 AI 黑客松、AI 融資、簽證變化、新法規、產品召回或獎學金）？告訴我關鍵詞就可以！';
  }
  if (lang === 'zh-Hans') {
    return '想查询哪一个数据集（如 AI 黑客松、AI 融资、签证变化、新法规、产品召回或奖学金）？告诉我关键词就可以！';
  }
  return 'Which Manyfold Data dataset would you like to search (e.g., AI hackathons, fundraising, visa changes, new rules, recalls, or scholarships)?';
}

export async function resolveMfdA2ACredential(env: Env): Promise<NarraA2ACredentialResult | null> {
  const url = (env.MANYFOLD_A2A_URL ?? '').trim();
  const token = (env.MANYFOLD_A2A_TOKEN ?? '').trim();
  if (url && token) {
    return { url, token, label: MFD_AGENT_SPEC.name };
  }
  return null;
}

export function createMfdGatewayConfig(
  overrides: Partial<NarraGatewayConfig<Env>> = {},
): NarraGatewayConfig<Env> {
  return {
    spec: MFD_AGENT_SPEC,
    fetchUpdates: (env, sinceIso) => fetchMfdUpdates(env, sinceIso, overrides.fetchImpl),
    fastRespond: fastRespondMfd,
    resolveA2ACredential: resolveMfdA2ACredential,
    ...overrides,
  };
}

export const mfdGatewayConfig: NarraGatewayConfig<Env> = createMfdGatewayConfig();
