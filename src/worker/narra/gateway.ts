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

import {
  isNonConversationalDevOrUrlNoise,
  stripAgentMentions,
  toZhHant,
  type AgentSpec,
  type AgentUpdateItem,
  type InboundEvent,
  type LangCode,
  type RecallTurnResult,
  type RoomContext,
  type TriageDecision,
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
import { appSummaries, datasetJson, getRecord } from '../records';
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

// Dataset keywords that override AI-news/LLM-model antiKeywords so genuine dataset queries
// like "OpenAI 最近完成了什么融资？" or "Google AI 数据中心" are never penalized in triage.
const MFD_DATASET_OVERRIDE_ASCII = [
  'hackathons?',
  'accelerators?',
  '(?:ai|research)\\s+grant',
  'grants?',
  'fellowship',
  'residency',
  'compute\\s+credits',
  'conferences?',
  'cfp',
  'call\\s+for\\s+papers',
  'neurips',
  'icml',
  'iclr',
  'cvpr',
  'acl',
  'aaai',
  'iccv',
  'emnlp',
  'ai\\s+summit',
  'fundraising',
  'funding',
  'series\\s+[a-d]',
  'seed\\s+round',
  'raised\\s+million',
  'acquisitions?',
  'acquired',
  'acqui-hire',
  'merger',
  'data\\s*centers?',
  'gigawatt',
  'robotaxis?',
  'waymo',
  'apollo\\s+go',
  'pony\\.ai',
  'weride',
  'zoox',
  'driverless\\s+taxi',
  'robot\\s+launch',
  'humanoid',
  'quadruped',
  'unitree',
  '1x\\s+neo',
  'ai\\s*scams?',
  'deepfake',
  'voice\\s+clone',
  'scam\\s+alert',
  'visas?',
  'etias',
  'new\\s+rules?',
  'regulation',
  'recalls?',
  'scholarships?',
  'chevening',
  'erasmus',
  'daad',
  'marathons?',
  'triathlon',
  'ironman',
  'utmb',
  'sky\\s+event',
  'eclipse',
  'meteor\\s+shower',
  'comet',
  'rocket\\s+launch',
  'oncology',
  'cancer\\s+drug',
  'fda\\s+approval',
  'manyfold\\s+data',
  'datasets?',
].join('|');

const MFD_DATASET_OVERRIDE_CJK = [
  '黑客松',
  '駭客松',
  '加速器',
  '孵化器',
  '創業補助',
  '创业补助',
  '算力補貼',
  '算力补贴',
  '頂會',
  '顶会',
  '學術會議',
  '学术会议',
  '徵稿',
  '征稿',
  '研討會',
  '研讨会',
  '投稿',
  '截稿',
  'AI會議',
  'AI会议',
  'AI大會',
  'AI大会',
  '融資',
  '融资',
  '募資',
  '募资',
  '收購',
  '收购',
  '併購',
  '并购',
  '算力中心',
  '資料中心',
  '数据中心',
  '無人計程車',
  '无人出租车',
  '自動駕駛計程車',
  '自动驾驶出租车',
  '人形機器人',
  '人形机器人',
  '機器狗',
  '机器狗',
  'ai詐騙',
  'ai诈骗',
  '深偽',
  '深伪',
  '聲音克隆',
  '声音克隆',
  '簽證',
  '签证',
  '免簽',
  '免签',
  '工簽',
  '工签',
  '新規',
  '新规',
  '新法規',
  '新法规',
  '召回',
  '下架',
  '獎學金',
  '奖学金',
  '馬拉松',
  '马拉松',
  '半馬',
  '半马',
  '越野跑',
  '鐵人三項',
  '铁人三项',
  '日食',
  '月食',
  '流星雨',
  '彗星',
  '火箭發射',
  '火箭发射',
  '天象',
  '抗癌藥',
  '抗癌药',
  '癌症新藥',
  '癌症新药',
  '抗癌新藥',
  '抗癌新药',
  '腫瘤藥物',
  '肿瘤药物',
  '資料集',
  '数据集',
  '數據集',
].join('|');

// General AI news / LLM model chatter belongs to AI in 5, unless a verified MFD dataset keyword is present.
const AI_NEWS_ANTI_KEYWORD_RE = new RegExp(
  `^(?![\\s\\S]*(?:(?<![a-z0-9])(?:${MFD_DATASET_OVERRIDE_ASCII})(?![a-z0-9])|${MFD_DATASET_OVERRIDE_CJK}))[\\s\\S]*(?:(?<![a-z0-9])(?:openai|anthropic|claude|gemini|deepseek|llama|meta\\s+ai|google\\s+ai|grok|xai|qwen)(?![a-z])|(?<![a-z0-9])ai\\s*圈|大模型|新模型)`,
  'i',
);

const THIS_WEEKEND_RE = /這週末|这周末|本[週周]末|\bthis weekend\b/i;
const LONDON_RE = /倫敦|伦敦|\bLondon\b/i;
const IN_PERSON_RE = /(?:到|去)?[現现][場场](?:參加|参加)|(?:實體|实体|線下|线下)|\bin[ -]person\b/i;

const ANY_HACKATHON_LOCATION_RE =
  /^(?:這週末|这周末|本[週周]末)\s*有(?:什麼|什么|沒有|没有)?\s*(?:ai\s*)?(?:hackathons?|黑客松|駭客松)\s*(?:嗎|吗)?[？?。!！\s]*(?:(?:線上|线上)或[現现][場场]都(?:行|可以)[。.!！\s]*)?$/i;
const LONDON_IN_PERSON_REFINEMENT_RE =
  /^(?:那[就只]?\s*)?(?:只要|只看|只找|要)?\s*(?:倫敦|伦敦)\s*(?:[現现][場场]|[實实][體体]|[線线]下)(?:的)?(?:[，,\s]*(?:線上|线上)(?:的)?先不用)?[？?。.!！\s]*$/i;

const WEEKEND_REFINEMENT_RE =
  /^(?:(?:那|只要|只看|只找)?\s*(?:這?週末|这?周末)(?:的)?(?:呢|嗎|吗)?|(?:what about|how about|only|just)\s+(?:this\s+|the\s+)?weekend(?:\s+ones?)?)[？?。.!！]*$/i;

export const MFD_AGENT_SPEC: AgentSpec = {
  matchesIndependentGroupRequest: (text, context) =>
    LONDON_IN_PERSON_REFINEMENT_RE.test(text) && Boolean(recentWeekendHackathonQuestion(context, Date.now())),
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
    'Strictly scoped to searching Manyfold Data’s 17 verified structured datasets (AI hackathons, AI accelerators/grants, AI conferences/CFPs, AI fundraising, AI acquisitions, AI data centers, robotaxi cities, robot launches, AI scam alerts, visa policy changes, new rules taking effect, product recalls, international scholarships, marathons, endurance races, sky events, and cancer drug updates). NEVER answer general tourism, weekend sightseeing, hangout ideas, shopping, or restaurant queries.',
  domainKeywords: [
    WEEKEND_REFINEMENT_RE,
    // 1. ai-hackathons
    'hackathon',
    'hackathons',
    '黑客松',
    '駭客松',
    // 2. ai-accelerators
    'accelerator',
    'accelerators',
    'ai grant',
    'research grant',
    'grants',
    'fellowship',
    'residency',
    'compute credits',
    '加速器',
    '孵化器',
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
    '研討會',
    '研讨会',
    '投稿',
    '截稿',
    '論文投稿',
    '论文投稿',
    'AI會議',
    'AI会议',
    'AI大會',
    'AI大会',
    'ai conference',
    'ai summit',
    'cvpr',
    'acl',
    'aaai',
    'iccv',
    'emnlp',
    // 4. ai-fundraising
    'fundraising',
    'funding round',
    'series a',
    'series b',
    'seed round',
    'raised million',
    'funding raised',
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
    'uk eta',
    'travel eta',
    /\beta\b.{0,12}(?:uk|visa|travel|entry|英國|英国|簽證|签证)/i,
    /(?:入境|旅遊簽證|旅游签证).{0,12}(?:規定|规定|手續|手续|變嚴|变严|變化|变化)/,
    'etias',
    '簽證',
    '签证',
    '免簽',
    '免签',
    '過境免簽',
    '过境免签',
    '電子簽',
    '电子签',
    '工簽',
    '工签',
    '工作簽證',
    '工作签证',
    '學生簽證',
    '学生签证',
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
    '產品召回',
    '产品召回',
    '食品召回',
    '汽車召回',
    '汽车召回',
    '食品下架',
    '問題食品',
    '问题食品',
    '車子下架',
    '车子下架',
    '安全下架',
    /(?:食品|產品|产品|車子|车子).{0,6}下架/,
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
    'ultra marathon',
    'ultramarathon',
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
    '癌症新藥',
    '癌症新药',
    '抗癌新藥',
    '抗癌新药',
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
    '數據集',
    '有哪些數據集',
    '有哪些資料集',
    '有哪些数据集',
    '什麼數據集',
    '什么数据集',
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
    '好餓',
    '好饿',
    '推薦吃的',
    '推荐吃的',
    // Casual sightseeing, weekend outings & shopping (spotted-guide / general chat)
    '逛逛',
    '逛街',
    '好去處',
    '好去处',
    '哪裡好玩',
    '哪里好玩',
    '有什麼好玩',
    '有什么好玩',
    '帶朋友去',
    '带朋友去',
    '市集',
    '特賣',
    '特卖',
    'sample sale',
    'things to do',
    'sightseeing',
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
    // General AI news & LLM model updates (ai5-chat)
    /\bnoticias?\s+(?:de|sobre)\s+(?:la\s+)?(?:ia|inteligencia\s+artificial)\b/i,
    'ai news',
    'ai in 5',
    'ai5',
    'ai新聞',
    'ai新闻',
    '今日ai',
    AI_NEWS_ANTI_KEYWORD_RE,
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

const MENTION_NAMES: readonly string[] = [
  MFD_AGENT_SPEC.name,
  ...(MFD_AGENT_SPEC.aliases ?? []),
  'London Chinese Food',
  '倫敦中餐地圖',
  '伦敦中餐地图',
  '問一籤',
  '問一簽',
  '问一签',
  'AI Fortune Stick',
  '塔羅大師',
  '塔罗大师',
  'AI Tarot',
  'AI in 5',
  'Spotted London',
  'Manyfold Data',
  'Penny',
  'Quidpaw',
];

const stripMentions = (text: string): string => stripAgentMentions(text, MENTION_NAMES);

const localizeZh = (text: string, lang: LangCode): string => (lang === 'zh-Hant' ? toZhHant(text) : text);

const GREETING_RE =
  /^(?:你好|妳好|您好|嗨|哈囉|哈喽|早安|早|午安|晚安|你是誰|你是谁|hi|hello|hey|good\s*(?:morning|afternoon|evening)|who\s+are\s+you)[!！。.?？~～\s]*$/i;

const THANKS_RE =
  /(?:謝謝|谢谢|感謝|感谢|多謝|多谢|謝啦|谢啦|\b(?:thanks|thank\s+you|thx|tysm|cheers)\b)/i;

const COMPOUND_RE = /^\[internal hint\]\s*process compound\b/i;

const LIST_APPS_RE =
  /(?:有哪些數據集|有哪些資料集|有哪些数据集|什麼數據集|什麼資料集|什么数据集|涵蓋哪些|涵盖哪些|你能(?:幫我|帮我)?(?:查|做)(?:什麼|什么|哪些)|你可以(?:幫我|帮我)?(?:查|做)(?:什麼|什么|哪些)|你會(?:幫我|帮我)?(?:查|做)(?:什麼|什么|哪些)|你会(?:帮我)?(?:查|做)(?:什么|哪些)|你能查啥|what\s+datasets|which\s+datasets|list\s+(?:datasets|apps)|what\s+can\s+you\s+(?:do|help(?:\s+with)?|search|check|look\s+up))/i;

const DM_OFF_TOPIC_RE =
  /會下雨|会下雨|下雨|天氣|天气|rain\s+today|weather\s+forecast|forecast|\bweather\b|比特幣|比特币|bitcoin|btc|股價|股价|匯率|汇率|唐人街|拉麵|拉面|麵館|面馆|好吃的/i;

const WHATS_NEW_RE =
  /(?:最近有什麼新|最近有什么新|最新數據|最新数据|新驗證|新验证|what(?:'s| is)\s+new|latest\s+(?:updates|records)|high[- ]signal)/i;

const DEADLINE_FOLLOWUP_RE = /截止|(?:報名|报名|申請|申请)\s*(?:到|至|限到)|\b(?:deadline|last day to (?:register|apply)|(?:when|what time) does registration close)\b/i;
const DEADLINE_CLOCK_RE = /[幾几][點点]|(?:什麼|什么)時間|(?:什麼|什么)时间|\b(?:what time|time of day|exact time|time zone)\b/i;
const RECORD_ORDINAL_RE = /第\s*([一二三四五1-5])\s*[個个筆笔項项條条場场]|\b(first|second|third|fourth|fifth)\s+(?:one|record|event|option)\b/i;

const MFD_FOLLOWUP_RE =
  /(?:還有|还有|更多|詳情|详情|截止|日期|來源|来源|哪一?[個个筆笔條条]?|[這那这][幾几]?[筆笔條条個个]|\b(?:more|details?|deadline|source|link|which|another)\b)/i;

const COMPARATIVE_ADVICE_RE =
  /(?:比較這|比较这|幫我比較|帮我比较|哪一?[個筆條个笔条].{0,12}(?:影響|影响|最適合|最适合|重要|關鍵|关键|值得|比較好|比较好)|[這这][幾几][筆條個笔条个].{0,12}(?:影響|影响|比較|比较|差別|差别|分析)|[對对].{0,14}(?:影響|影响)(?:最大|比較大|比较大|如何|是什麼|是什么)|\b(?:compare\s+(?:these|those|them)|which\s+one\s+(?:affects?|impacts?|is\s+best|matters\s+most)|most\s+impact\s+on|explain\s+(?:these|those))\b)/i;

/* ───────── dataset inference & trilingual labels ───────── */

const DATASET_TRIGGERS: ReadonlyArray<{ slug: string; patterns: ReadonlyArray<string | RegExp> }> = [
  { slug: 'ai-hackathons', patterns: ['hackathon', 'hackathons', '黑客松', '駭客松'] },
  {
    slug: 'ai-accelerators',
    patterns: [
      'accelerator',
      'accelerators',
      'ai grant',
      'research grant',
      'grants',
      'fellowship',
      'residency',
      'compute credits',
      '加速器',
      '孵化器',
      '創業補助',
      '创业补助',
      '算力補貼',
      '算力补贴',
    ],
  },
  {
    slug: 'ai-conferences',
    patterns: [
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
      '研討會',
      '研讨会',
      '投稿',
      '截稿',
      '論文投稿',
      '论文投稿',
      'AI會議',
      'AI会议',
      'AI大會',
      'AI大会',
      'ai conference',
      'ai summit',
      'cvpr',
      'acl',
      'aaai',
      'iccv',
      'emnlp',
    ],
  },
  {
    slug: 'ai-fundraising',
    patterns: ['fundraising', 'funding', 'raised million', 'funding raised', 'series a', 'series b', 'seed round', '融資', '融资', '募資', '募资'],
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
    patterns: [
      'visa',
      'visas',
      'visa-free',
      'e-visa',
      'uk eta',
      'travel eta',
      /\beta\b.{0,12}(?:uk|visa|travel|entry|英國|英国|簽證|签证)/i,
      'etias',
      '簽證',
      '签证',
      '免簽',
      '免签',
      '過境免簽',
      '过境免签',
      '電子簽',
      '电子签',
      '旅遊簽證',
      '旅游签证',
      '入境規定',
      '入境规定',
      '入境手續',
      '入境手续',
      '辦什麼手續',
      '办什么手续',
      '簽證規定',
      '签证规定',
      '工簽',
      '工签',
      '工作簽證',
      '工作签证',
      '學生簽證',
      '学生签证',
    ],
  },
  {
    slug: 'new-rules',
    patterns: ['new rule', 'new rules', 'regulation', 'takes effect', 'effective on', '新規', '新规', '新法規', '新法规', '法規生效', '法规生效'],
  },
  {
    slug: 'recalls',
    patterns: [
      'recall',
      'recalls',
      '召回',
      '產品召回',
      '产品召回',
      '食品召回',
      '汽車召回',
      '汽车召回',
      '下架',
      '食品下架',
      '問題食品',
      '问题食品',
      '車子下架',
      '车子下架',
      '安全下架',
    ],
  },
  {
    slug: 'scholarships',
    patterns: ['scholarship', 'scholarships', 'chevening', 'erasmus', 'daad', '獎學金', '奖学金'],
  },
  { slug: 'marathons', patterns: ['marathon', 'marathons', '馬拉松', '马拉松'] },
  {
    slug: 'endurance-races',
    patterns: ['half marathon', 'half-marathon', 'trail race', 'ultra marathon', 'ultramarathon', 'triathlon', 'ironman', 'utmb', '半程馬拉松', '半程马拉松', '半馬', '半马', '越野跑', '鐵人三項', '铁人三项'],
  },
  {
    slug: 'sky-events',
    patterns: ['sky event', 'solar eclipse', 'lunar eclipse', 'meteor shower', 'comet', 'rocket launch', '日食', '月食', '流星雨', '彗星', '火箭發射', '火箭发射', '天象'],
  },
  {
    slug: 'oncology-drug-updates',
    patterns: [
      'oncology',
      'cancer drug',
      'phase 3',
      'fda approval',
      '抗癌藥',
      '抗癌药',
      '癌症新藥',
      '癌症新药',
      '抗癌新藥',
      '抗癌新药',
      '腫瘤藥物',
      '肿瘤药物',
      '臨床三期',
      '临床三期',
    ],
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

const GENERIC_LOCATION_TERMS = new Set<string>([
  ...CJK_ENTITY_MAP.map(([, en]) => en.toLowerCase()),
  'uk',
  'us',
  'usa',
  'eu',
]);

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
  'in',
  'on',
  'at',
  'to',
  'of',
  'by',
  'or',
  'as',
  'it',
  'be',
  'do',
  'me',
  'my',
  'we',
  'us',
  'you',
  'your',
  'this',
  'that',
  'these',
  'those',
  'next',
  'last',
  'month',
  'week',
  'year',
  'today',
  'tomorrow',
  'register',
  'apply',
  'join',
  'attend',
  'happening',
  'going',
  // Domain words already used to select the dataset slug:
  'ai',
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

function matchToken(lowerText: string, needle: string | RegExp, rawText?: string): boolean {
  if (needle instanceof RegExp) return needle.test(rawText ?? lowerText);
  const clean = needle.trim().toLowerCase();
  if (!clean) return false;
  if (/[\u3400-\u9FFF]/.test(clean)) return lowerText.includes(clean);
  if (clean.includes(' ')) return lowerText.includes(clean);
  return new RegExp(`(?<![a-z0-9])${clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'i').test(
    lowerText,
  );
}

export function inferDatasetSlugs(text: string): string[] {
  const lower = text.toLowerCase();
  const slugs: string[] = [];
  for (const item of DATASET_TRIGGERS) {
    if (item.patterns.some((p) => matchToken(lower, p, text))) {
      slugs.push(item.slug);
    }
  }
  return slugs;
}

export function extractSearchTerms(text: string): string[] {
  const stripped = (text ?? '').replace(/https?:\/\/\S+/gi, ' ');
  const terms: string[] = [];
  for (const [zh, en] of CJK_ENTITY_MAP) {
    if (stripped.includes(zh)) terms.push(en);
  }
  const ascii = stripped.match(/[A-Za-z0-9][A-Za-z0-9.-]{1,}/g) ?? [];
  for (const tok of ascii) {
    const low = tok.toLowerCase();
    if (!SEARCH_STOPWORDS.has(low) && low.length >= 2) {
      terms.push(tok);
    }
  }
  return [...new Set(terms)];
}

/* ───────── D1 queries & high-signal updates ───────── */

const schemaReadyDbs = new WeakSet<D1Database>();

async function ensureSchemaOnce(db: D1Database): Promise<void> {
  if (schemaReadyDbs.has(db)) return;
  await ensureSchema(db);
  schemaReadyDbs.add(db);
}

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
  await ensureSchemaOnce(env.DB);
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
    const title = DATASET_TITLES[u.slug]?.[lang] ?? localizeZh(u.datasetTitle, lang);
    lines.push(`- [${title}] ${localizeZh(u.summary, lang)}`);
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

function thanksReply(lang: LangCode): string {
  if (lang === 'zh-Hant') {
    return '不客氣！之後想查 AI 黑客松、融資、簽證變化、新法規、產品召回或獎學金等開放資料，隨時問我 📊';
  }
  if (lang === 'zh-Hans') {
    return '不客气！之后想查 AI 黑客松、融资、签证变化、新法规、产品召回或奖学金等开放数据，随时问我 📊';
  }
  return "You're welcome! Ask anytime when you want to check AI hackathons, funding, visa changes, new rules, recalls, or scholarships 📊";
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
    lines.push(`- ${localizeZh(fillLine(config, rec.data), lang)}`);
    lines.push(recordUrl(env, config.slug, rec.id));
  }
  return lines.join('\n');
}

export function resolveMemorySlugs(memories: RecallTurnResult): string[] {
  const slugs: string[] = [];
  for (const m of [...memories.userMemories, ...memories.roomMemories]) {
    if (m.key === 'watch_datasets' || m.key === 'dataset') {
      for (const part of m.value.split(',')) {
        const clean = part.trim();
        if (findDataApp(clean)) slugs.push(clean);
      }
    } else if (m.key === 'note' || m.key.startsWith('note_')) {
      slugs.push(...inferDatasetSlugs(m.value));
    }
  }
  return [...new Set(slugs)];
}

/**
 * Fast D1-backed responder for Manyfold Data (`mfd-guide`).
 * Returns `null` when Manyfold A2A should handle the turn.
 */
function recentWeekendHackathonQuestion(context: RoomContext | undefined, now: number) {
  const turns = [...(context?.recentHistory ?? [])]
    .filter((turn) => turn.timestampMs <= now)
    .sort((a, b) => b.timestampMs - a.timestampMs);
  const agentIndex = turns.findIndex((turn) => turn.isAgent || turn.isSelf);
  if (agentIndex < 0) return undefined;
  const answer = turns[agentIndex]!;
  if (!(answer.isSelf || answer.senderId === MFD_MATRIX_ID) || now - answer.timestampMs > 180_000) return undefined;
  const question = turns.slice(agentIndex + 1).find((turn) => !turn.isAgent && !turn.isSelf);
  return question && THIS_WEEKEND_RE.test(question.text) && inferDatasetSlugs(question.text).includes('ai-hackathons')
    ? question : undefined;
}

async function respondToWeekendRefinement(
  env: Env,
  event: InboundEvent,
  context: RoomContext | undefined,
  lang: LangCode,
): Promise<string> {
  const prior = (context?.recentHistory ?? [])
    .filter((turn) => turn.eventId !== event.eventId && turn.timestampMs <= event.timestampMs)
    .sort((a, b) => b.timestampMs - a.timestampMs);
  const last = prior[0];
  const question = prior.slice(1).find((turn) => !turn.isAgent);
  if (
    !last || !(last.isSelf || last.senderId === MFD_MATRIX_ID) ||
    !question || question.senderId !== event.senderId ||
    !inferDatasetSlugs(question.text).includes('ai-hackathons') ||
    !LONDON_RE.test(question.text)
  ) {
    return '[NO_REPLY]';
  }

  return respondWithWeekendHackathons(env, event, lang, true, IN_PERSON_RE.test(question.text));
}

async function respondWithWeekendHackathons(
  env: Env,
  event: InboundEvent,
  lang: LangCode,
  londonOnly: boolean,
  inPersonOnly: boolean,
): Promise<string> {
  const now = new Date(event.timestampMs);
  const londonDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const first = new Date(`${londonDate}T00:00:00Z`);
  const day = first.getUTCDay();
  first.setUTCDate(first.getUTCDate() + (day === 0 ? -1 : 6 - day));
  const lastDay = new Date(first);
  lastDay.setUTCDate(lastDay.getUTCDate() + 1);
  const start = todayUtc(first);
  const end = todayUtc(lastDay);

  const config = findDataApp('ai-hackathons')!;
  const { records } = JSON.parse(await datasetJson(env.DB, config, now)) as DatasetResponse;
  const matches = records.filter(({ data }) => {
    const cities = Array.isArray(data.city) ? data.city : [data.city];
    const starts = typeof data.starts_on === 'string' ? data.starts_on : '';
    const ends = typeof data.ends_on === 'string' && data.ends_on ? data.ends_on : starts;
    const hasInPersonOption = data.format === 'in-person' || data.format === 'hybrid';
    return (!inPersonOnly || hasInPersonOption) &&
      (!londonOnly || cities.some((city) => typeof city === 'string' && LONDON_RE.test(city))) &&
      starts >= start && starts <= end && ends >= londonDate;
  });
  const header = lang === 'zh-Hant' ? `${londonOnly ? '倫敦' : ''}這週末（${start} 至 ${end}）的${inPersonOnly ? '現場 ' : ' '}AI 黑客松`
    : lang === 'zh-Hans' ? `${londonOnly ? '伦敦' : ''}这周末（${start} 至 ${end}）的${inPersonOnly ? '现场 ' : ' '}AI 黑客松`
      : `${londonOnly ? 'London ' : ''}${inPersonOnly ? 'in-person ' : ''}AI hackathons this weekend (${start} to ${end})`;
  if (matches.length === 0) {
    return lang === 'zh-Hant' ? `${header}：目前沒有查到符合日期的已驗證活動。`
      : lang === 'zh-Hans' ? `${header}：目前没有查到符合日期的已验证活动。`
        : `${header}: I found no verified events matching those dates.`;
  }
  const formats = {
    'in-person': { en: 'In person', 'zh-Hant': '現場', 'zh-Hans': '现场' },
    online: { en: 'Online', 'zh-Hant': '線上', 'zh-Hans': '线上' },
    hybrid: { en: 'Hybrid', 'zh-Hant': '混合', 'zh-Hans': '混合' },
  } as const;
  return [header, ...matches.slice(0, event.isVoice ? 2 : 3).flatMap(({ id, data }) => {
    const format = formats[data.format as keyof typeof formats]?.[lang];
    const cities = Array.isArray(data.city) ? data.city.join(', ') : data.city;
    return [
      `- ${[localizeZh(String(data.name), lang), data.starts_on, format, cities].filter(Boolean).join(' · ')}`,
      recordUrl(env, config.slug, id),
    ];
  })].join('\n');
}

async function respondToRecordDeadline(
  env: Env,
  event: InboundEvent,
  context: RoomContext | undefined,
  lang: LangCode,
  ordinal: number,
): Promise<string> {
  const prior = (context?.recentHistory ?? [])
    .filter((turn) => turn.isAgent && turn.timestampMs <= event.timestampMs)
    .sort((a, b) => b.timestampMs - a.timestampMs)[0];
  if (!prior || !(prior.isSelf || prior.senderId === MFD_MATRIX_ID)) return '[NO_REPLY]';

  const origin = originOfEnv(env) + '/';
  const refs = [...new Set(prior.text.match(/https:\/\/[^\s<>]+/g) ?? [])]
    .filter((url) => url.startsWith(origin))
    .flatMap((url) => {
      const match = /^([a-z0-9-]+)\/r\/(rec_[a-z0-9_]+)$/i.exec(url.slice(origin.length));
      return match ? [{ slug: match[1]!, id: match[2]!, url }] : [];
    });
  const ref = refs[ordinal];
  const config = ref && findDataApp(ref.slug);
  if (!ref || !config) return '[NO_REPLY]';
  const result = await getRecord(env.DB, config, ref.id);
  if (!result || !('record' in result) || result.record.status !== 'verified') return '[NO_REPLY]';

  const { data } = result.record;
  const label = typeof data.name === 'string' ? data.name : config.title;
  const deadline = typeof data.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.deadline)
    ? data.deadline : null;
  const answer = lang === 'zh-Hant'
    ? (deadline ? `報名截止日是 ${deadline}。` : '這筆資料沒有列出截止日。')
    : lang === 'zh-Hans'
      ? (deadline ? `报名截止日是 ${deadline}。` : '这笔资料没有列出截止日。')
      : (deadline ? `The listed deadline is ${deadline}.` : 'This record does not list a deadline.');
  const timeNote = deadline && DEADLINE_CLOCK_RE.test(event.text)
    ? (lang === 'zh-Hant' ? '資料只列日期，沒有列出幾點截止或時區。'
      : lang === 'zh-Hans' ? '资料只列日期，没有列出几点截止或时区。'
        : 'The record gives a date only, with no cutoff time or time zone.')
    : null;
  return [localizeZh(label, lang), answer, timeNote, ref.url].filter(Boolean).join('\n');
}

export async function fastRespondMfd(
  env: Env,
  event: InboundEvent,
  decision: TriageDecision,
  memories: RecallTurnResult,
  context?: RoomContext,
): Promise<string | null> {
  const lang = decision.detectedLang;
  const cleanedText = stripMentions(event.text);
  const isUnmentionedGroup =
    event.chatType === 'group' && decision.reason !== 'explicit_mention' && decision.reason !== 'reply_to_self';

  if (event.kind === 'image' || event.kind === 'compound' || COMPOUND_RE.test(event.text)) {
    return compoundReply(lang);
  }
  if (!cleanedText || GREETING_RE.test(cleanedText)) {
    if (isUnmentionedGroup && decision.reason === 'active_session') {
      return '[NO_REPLY]';
    }
    return greetingReply(lang);
  }
  if (
    /\b(?:ignore\s+(?:all\s+)?previous\s+instructions|print\s+(?:your\s+)?system\s+prompt|d1\s+database\s+schema|narra_agent_token)\b/i.test(
      cleanedText,
    )
  ) {
    return isUnmentionedGroup ? '[NO_REPLY]' : offTopicRedirect(lang);
  }
  if (isUnmentionedGroup && isNonConversationalDevOrUrlNoise(cleanedText)) {
    return '[NO_REPLY]';
  }

  const isMultiMention = decision.reason === 'multi_mention_domain_match';
  const inferredSlugs = inferDatasetSlugs(cleanedText);
  const hasAntiHit =
    (MFD_AGENT_SPEC.antiKeywords ?? []).some((kw) => {
      if (kw instanceof RegExp) return kw.test(cleanedText);
      return matchToken(cleanedText.toLowerCase(), kw);
    }) || DM_OFF_TOPIC_RE.test(cleanedText);
  const hasDomainHit = (MFD_AGENT_SPEC.domainKeywords ?? []).some((kw) => {
    if (kw instanceof RegExp) return kw.test(cleanedText);
    return matchToken(cleanedText.toLowerCase(), kw);
  });

  if (
    THANKS_RE.test(cleanedText) &&
    !/[?？]\s*$/.test(cleanedText) &&
    !hasAntiHit &&
    inferredSlugs.length === 0 &&
    !hasDomainHit &&
    !LIST_APPS_RE.test(cleanedText) &&
    !WHATS_NEW_RE.test(cleanedText) &&
    !MFD_FOLLOWUP_RE.test(cleanedText) &&
    !/(?:嗎|吗|什麼|什么|怎麼|怎么|請問|请问|幫我|帮我|查一下|告訴我|告诉我|\b(?:can\s+you|could\s+you|tell\s+me|show\s+me|what|which|how|why|when|where)\b)/i.test(
      cleanedText,
    )
  ) {
    if (isUnmentionedGroup) {
      return '[NO_REPLY]';
    }
    return thanksReply(lang);
  }

  if (hasAntiHit && inferredSlugs.length === 0) {
    return isMultiMention || isUnmentionedGroup ? '[NO_REPLY]' : offTopicRedirect(lang);
  }

  if (
    (!isUnmentionedGroup || decision.reason === 'active_session') &&
    COMPARATIVE_ADVICE_RE.test(cleanedText) &&
    inferredSlugs.length === 0 &&
    hasA2ACredential(env)
  ) {
    return null;
  }

  const limit = event.isVoice ? 2 : event.chatType === 'group' ? 3 : 5;
  const now = new Date();
  const terms = extractSearchTerms(cleanedText);
  const hasSearchOrFollowupSignal =
    inferredSlugs.length > 0 ||
    terms.some((t) => !GENERIC_LOCATION_TERMS.has(t.toLowerCase())) ||
    MFD_FOLLOWUP_RE.test(cleanedText) ||
    WHATS_NEW_RE.test(cleanedText) ||
    hasDomainHit;

  if (!env.DB) {
    return hasA2ACredential(env) && hasSearchOrFollowupSignal ? null : offTopicRedirect(lang);
  }

  await ensureSchemaOnce(env.DB);
  if (isUnmentionedGroup && WEEKEND_REFINEMENT_RE.test(cleanedText.trim())) {
    return respondToWeekendRefinement(env, event, context, lang);
  }

  if (LONDON_IN_PERSON_REFINEMENT_RE.test(cleanedText)) {
    const question = recentWeekendHackathonQuestion(context, event.timestampMs);
    if (question?.senderId === event.senderId) {
      return respondWithWeekendHackathons(env, event, lang, true, true);
    }
    if (isUnmentionedGroup) return '[NO_REPLY]';
  }

  const londonWeekend = LONDON_RE.test(cleanedText) && THIS_WEEKEND_RE.test(cleanedText);
  if (inferredSlugs.length === 1 && inferredSlugs[0] === 'ai-hackathons' &&
      (londonWeekend || ANY_HACKATHON_LOCATION_RE.test(cleanedText.trim()))) {
    return respondWithWeekendHackathons(env, event, lang, londonWeekend, IN_PERSON_RE.test(cleanedText));
  }

  const ordinal = RECORD_ORDINAL_RE.exec(cleanedText);
  if (decision.reason === 'active_session' && ordinal && DEADLINE_FOLLOWUP_RE.test(cleanedText)) {
    const number = ordinal[1]
      ? (Number(ordinal[1]) || '一二三四五'.indexOf(ordinal[1]) + 1)
      : ['first', 'second', 'third', 'fourth', 'fifth'].indexOf(ordinal[2]!.toLowerCase()) + 1;
    return respondToRecordDeadline(env, event, context, lang, number - 1);
  }

  // 1. "What datasets exist?" or capability question
  if (
    LIST_APPS_RE.test(cleanedText) &&
    (inferredSlugs.length === 0 || /(?:datasets?|apps?|數據集|資料集|数据集)/i.test(cleanedText))
  ) {
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

  // Unmentioned active-session turns with zero dataset signals and no follow-up cue stay silent.
  if (
    isUnmentionedGroup &&
    decision.reason === 'active_session' &&
    inferredSlugs.length === 0 &&
    terms.length === 0 &&
    !LIST_APPS_RE.test(cleanedText) &&
    !WHATS_NEW_RE.test(cleanedText) &&
    !MFD_FOLLOWUP_RE.test(cleanedText)
  ) {
    return '[NO_REPLY]';
  }

  const candidateSlugs =
    inferredSlugs.length > 0
      ? inferredSlugs
      : isUnmentionedGroup && decision.reason !== 'active_session'
        ? []
        : resolveMemorySlugs(memories);

  if (candidateSlugs.length > 0) {
    const candidateConfigs = candidateSlugs
      .map((slug) => findDataApp(slug))
      .filter((cfg): cfg is DataAppConfig => cfg !== undefined);
    const candidateResults = await Promise.all(
      candidateConfigs.map((config) => queryDatasetRecords(env.DB, config, terms, limit, now)),
    );
    const firstCandidateHitIdx = candidateResults.findIndex((res) => res.records.length > 0);
    if (firstCandidateHitIdx >= 0) {
      const config = candidateConfigs[firstCandidateHitIdx]!;
      const res = candidateResults[firstCandidateHitIdx]!;
      return formatRecordResults(env, config, res.records, res.total, res.today, lang, res.usedDefaultFilter);
    }
    // If terms narrowed too strictly on an inferred dataset, fall back to recent verified rows from D1.
    if (terms.length > 0) {
      const primary = candidateConfigs[0];
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

  // 4. Cross-dataset text search in parallel when specific non-location search terms exist.
  // Never run blind cross-dataset text search on unmentioned group turns with zero dataset
  // signals, preventing substring hijacks (e.g. "Meta" -> "Hashmeta").
  const canCrossSearch =
    terms.length > 0 &&
    !(isUnmentionedGroup && inferredSlugs.length === 0 && !hasDomainHit) &&
    (!(isUnmentionedGroup && inferredSlugs.length === 0) ||
      terms.some((t) => !GENERIC_LOCATION_TERMS.has(t.toLowerCase())));
  if (canCrossSearch) {
    const crossResults = await Promise.all(
      dataApps.map((config) => queryDatasetRecords(env.DB, config, terms, limit, now)),
    );
    const firstCrossHitIdx = crossResults.findIndex((res) => res.records.length > 0);
    if (firstCrossHitIdx >= 0) {
      const config = dataApps[firstCrossHitIdx]!;
      const res = crossResults[firstCrossHitIdx]!;
      return formatRecordResults(env, config, res.records, res.total, res.today, lang, res.usedDefaultFilter);
    }
  }

  // Unmentioned group turns with zero matching D1 records stay silent instead of triggering A2A or generic prompts.
  if (isUnmentionedGroup) {
    return '[NO_REPLY]';
  }

  // 5. Fallback to Manyfold A2A only when the turn carries dataset/search/follow-up signals
  if (hasA2ACredential(env) && hasSearchOrFollowupSignal) {
    return null;
  }

  // Graceful response when A2A is not configured or turn has no dataset/search signal
  const root = originOfEnv(env);
  if (inferredSlugs.length > 0 || terms.some((t) => !GENERIC_LOCATION_TERMS.has(t.toLowerCase()))) {
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

const MAX_MFD_PREFETCH_DATASETS = 3;
const MAX_MFD_PREFETCH_RECORDS = 6;
const MAX_MFD_PREFETCH_CHARS = 1500;
const MAX_RECENT_SELF_TURNS_TO_SCAN = 6;

function extractRecentRecordRefs(
  env: Pick<Env, 'PUBLIC_ORIGIN' | 'NARRA_MATRIX_ID'>,
  context?: RoomContext,
): {
  slugs: string[];
  recordIdsBySlug: Map<string, string[]>;
  orderedRefs: Array<{ slug: string; id: string }>;
} {
  const slugs: string[] = [];
  const seenSlugs = new Set<string>();
  const recordIdsBySlug = new Map<string, string[]>();
  const orderedRefs: Array<{ slug: string; id: string }> = [];
  const seenPairs = new Set<string>();

  if (!context) {
    return { slugs, recordIdsBySlug, orderedRefs };
  }

  const candidateTexts: string[] = [];
  if (context.replyToTarget?.text) {
    candidateTexts.push(context.replyToTarget.text);
  }
  const selfMatrixId = (env.NARRA_MATRIX_ID ?? MFD_MATRIX_ID).trim();
  const history = context.recentHistory ?? [];
  let scannedSelfTurns = 0;
  for (let i = history.length - 1; i >= 0 && scannedSelfTurns < MAX_RECENT_SELF_TURNS_TO_SCAN; i--) {
    const turn = history[i]!;
    const isSelfTurn =
      turn.isSelf === true || turn.senderId === selfMatrixId || turn.senderId === MFD_MATRIX_ID;
    if (!isSelfTurn) continue;
    scannedSelfTurns++;
    if (turn.text) {
      candidateTexts.push(turn.text);
    }
  }

  if (candidateTexts.length === 0) {
    return { slugs, recordIdsBySlug, orderedRefs };
  }

  const hosts = new Set<string>(['data.manyfold.ai']);
  try {
    const originHost = new URL(originOfEnv(env)).host;
    if (originHost) hosts.add(originHost.toLowerCase());
  } catch {
    // Ignore invalid PUBLIC_ORIGIN URL.
  }
  const escapedHosts = [...hosts]
    .map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const urlRe = new RegExp(`(?:${escapedHosts})\\/([a-z0-9-]+)\\/r\\/(rec_[a-z0-9_]+)`, 'gi');

  const hasReplyTargetText = Boolean(context.replyToTarget?.text);
  for (let idx = 0; idx < candidateTexts.length; idx++) {
    const text = candidateTexts[idx]!;
    urlRe.lastIndex = 0;
    let foundInThisText = false;
    let match: RegExpExecArray | null;
    while ((match = urlRe.exec(text)) !== null) {
      const slug = match[1]!.toLowerCase();
      const id = match[2]!;
      if (!findDataApp(slug)) continue;
      foundInThisText = true;

      if (!seenSlugs.has(slug)) {
        seenSlugs.add(slug);
        slugs.push(slug);
      }
      const pairKey = `${slug}:${id}`;
      if (!seenPairs.has(pairKey)) {
        seenPairs.add(pairKey);
        orderedRefs.push({ slug, id });
        const list = recordIdsBySlug.get(slug);
        if (list) list.push(id);
        else recordIdsBySlug.set(slug, [id]);
      }
    }
    // Once we have extracted verified record URLs from the most recent self reply in `recentHistory`,
    // stop scanning older self turns so pronoun follow-ups ("这几个里...") never mix in stale lists
    // from earlier topics. (If `replyToTarget` is idx 0, still allow the latest history turn at idx >= 1.)
    const isHistoryTurn = !hasReplyTargetText || idx > 0;
    if (isHistoryTurn && foundInThisText) break;
  }

  return { slugs, recordIdsBySlug, orderedRefs };
}

async function prefetchDatasetRecords(
  db: D1Database,
  config: DataAppConfig,
  terms: readonly string[],
  prioritizedIds: readonly string[],
  limit: number,
  now: Date,
): Promise<{ pinned: PublicRecord[]; general: PublicRecord[] }> {
  const dataset = JSON.parse(await datasetJson(db, config, now)) as DatasetResponse;
  const pinned: PublicRecord[] = [];
  if (prioritizedIds.length > 0) {
    const byId = new Map<string, PublicRecord>();
    for (const rec of dataset.records) {
      byId.set(rec.id, rec);
    }
    for (const id of prioritizedIds) {
      const rec = byId.get(id);
      if (rec) pinned.push(rec);
    }
  }

  const baseDefault = defaultQuery(config);
  const runSearch = (useDefault: boolean, qTerm: string) => {
    const state: QueryState = {
      q: qTerm,
      filters: useDefault ? baseDefault.filters : {},
      sort: baseDefault.sort,
      page: 1,
    };
    return listFrom(config, dataset, state, limit, { facets: false }).records;
  };

  let general: PublicRecord[] = [];
  if (terms.length > 0) {
    for (const term of terms) {
      const hits = runSearch(true, term);
      if (hits.length > 0) {
        general = hits;
        break;
      }
    }
    if (general.length === 0) {
      for (const term of terms) {
        const hits = runSearch(false, term);
        if (hits.length > 0) {
          general = hits;
          break;
        }
      }
    }
  }
  if (general.length === 0) {
    general = runSearch(true, '');
    if (general.length === 0 && Object.keys(baseDefault.filters).length > 0) {
      general = runSearch(false, '');
    }
  }

  return { pinned, general };
}

export async function buildMfdExtraEnvelopeFields(
  env: Env,
  event: InboundEvent,
  decision: TriageDecision,
  memories: RecallTurnResult,
  context?: RoomContext,
): Promise<Record<string, string> | null> {
  if (!env.DB) return null;

  try {
    await ensureSchemaOnce(env.DB);
    const lang = decision.detectedLang;
    const cleanedText = stripMentions(event.text);
    const terms = extractSearchTerms(cleanedText);
    const recentRefs = extractRecentRecordRefs(env, context);
    const inferred = inferDatasetSlugs(cleanedText);
    const remembered = resolveMemorySlugs(memories);
    const mergedSlugs = [...new Set([...recentRefs.slugs, ...inferred, ...remembered])];
    const targetSlugs = (mergedSlugs.length > 0 ? mergedSlugs : [...HIGH_SIGNAL_SLUGS]).slice(
      0,
      MAX_MFD_PREFETCH_DATASETS,
    );
    const targetConfigs = targetSlugs
      .map((slug) => findDataApp(slug))
      .filter((cfg): cfg is DataAppConfig => cfg !== undefined);
    if (targetConfigs.length === 0) return null;

    const now = new Date();
    const prefetched = await Promise.all(
      targetConfigs.map((config) =>
        prefetchDatasetRecords(
          env.DB,
          config,
          terms,
          recentRefs.recordIdsBySlug.get(config.slug) ?? [],
          3,
          now,
        ),
      ),
    );

    const selected: Array<{ config: DataAppConfig; record: PublicRecord }> = [];
    const seenIds = new Set<string>();

    // 1. Prioritize exact recently shown records from replyToTarget / recent self turns FIRST.
    if (recentRefs.orderedRefs.length > 0) {
      const pinnedByKey = new Map<string, { config: DataAppConfig; record: PublicRecord }>();
      for (let i = 0; i < targetConfigs.length; i++) {
        const config = targetConfigs[i]!;
        for (const rec of prefetched[i]!.pinned) {
          pinnedByKey.set(`${config.slug}:${rec.id}`, { config, record: rec });
        }
      }
      for (const ref of recentRefs.orderedRefs) {
        if (selected.length >= MAX_MFD_PREFETCH_RECORDS) break;
        const key = `${ref.slug}:${ref.id}`;
        const hit = pinnedByKey.get(key);
        if (!hit || seenIds.has(key)) continue;
        seenIds.add(key);
        selected.push(hit);
      }
    }

    // 2. Fill remaining slots up to 6 verified records round-robin across queried datasets.
    const maxPerDataset = Math.max(0, ...prefetched.map((r) => r.general.length));
    for (let slot = 0; slot < maxPerDataset && selected.length < MAX_MFD_PREFETCH_RECORDS; slot++) {
      for (let i = 0; i < targetConfigs.length && selected.length < MAX_MFD_PREFETCH_RECORDS; i++) {
        const rec = prefetched[i]!.general[slot];
        if (!rec) continue;
        const key = `${targetConfigs[i]!.slug}:${rec.id}`;
        if (seenIds.has(key)) continue;
        seenIds.add(key);
        selected.push({ config: targetConfigs[i]!, record: rec });
      }
    }

    if (selected.length === 0) return null;

    const today = todayUtc(now);
    const header = `Manyfold Data verified records (today ${today}):`;
    const lines: string[] = [header];
    let totalLen = header.length;

    for (const { config, record } of selected) {
      const title = DATASET_TITLES[config.slug]?.[lang] ?? config.title;
      const summaryRaw = localizeZh(fillLine(config, record.data), lang);
      const summary = summaryRaw.length > 160 ? `${summaryRaw.slice(0, 159)}…` : summaryRaw;
      const line = `- [${title}] ${summary} | ${recordUrl(env, config.slug, record.id)}`;
      const candidateLen = totalLen + 1 + line.length;
      if (candidateLen <= MAX_MFD_PREFETCH_CHARS) {
        lines.push(line);
        totalLen = candidateLen;
      } else {
        const remaining = MAX_MFD_PREFETCH_CHARS - totalLen - 2;
        if (remaining >= 24) {
          lines.push(`${line.slice(0, remaining)}…`);
          totalLen = MAX_MFD_PREFETCH_CHARS;
        }
        break;
      }
    }

    if (lines.length <= 1) return null;
    return {
      d1_prefetched_records: lines.join('\n').slice(0, MAX_MFD_PREFETCH_CHARS),
    };
  } catch {
    return null;
  }
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
    enableA2AFailureReply: true,
    thinkingMessage: (lang) =>
      lang === 'zh-Hant'
        ? '📊 正在並行查詢 Manyfold Data 開放資料集，稍等一下…'
        : lang === 'zh-Hans'
          ? '📊 正在并行查询 Manyfold Data 开放数据集，稍等一下…'
          : '📊 Querying Manyfold Data verified datasets in parallel, one moment…',
    buildExtraEnvelopeFields: buildMfdExtraEnvelopeFields,
    ...overrides,
  };
}

export const mfdGatewayConfig: NarraGatewayConfig<Env> = createMfdGatewayConfig();
