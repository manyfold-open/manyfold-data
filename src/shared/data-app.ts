/**
 * A data app is one dataset, defined by one config file in data-apps/. The Table's
 * filters, the Overview charts, record validation and (later) the agent skill all
 * derive from that config, so they cannot drift apart.
 *
 * This module runs in the browser, the Worker and Node scripts. It imports nothing
 * and sticks to syntax Node can strip, because scripts/ run it with plain `node`.
 */

/* ───────── config ───────── */

interface FieldBase {
  /** Column header and label. */
  label: string;
  required?: boolean;
  /** One line, for people and agents, on what belongs in the field. */
  help?: string;
}

export interface TextField extends FieldBase {
  type: 'text';
  max: number;
}

export interface EnumField extends FieldBase {
  type: 'enum';
  values: readonly string[];
  /** Display names, e.g. 'in-person' → 'In person'. Values without one show as written. */
  valueLabels?: Readonly<Record<string, string>>;
}

export interface DateField extends FieldBase {
  type: 'date';
}

export interface NumberField extends FieldBase {
  type: 'number';
  min?: number;
  max?: number;
  /** How pages print the value. */
  display?: 'usd' | 'plain';
}

export interface UrlField extends FieldBase {
  type: 'url';
  /** Keep only the site's home page (scheme and host), so one site is one value. */
  homePage?: boolean;
}

export interface TagsField extends FieldBase {
  type: 'tags';
  max: number;
}

export type FieldDef = TextField | EnumField | DateField | NumberField | UrlField | TagsField;
export type FieldType = FieldDef['type'];

/**
 * An inclusive range on a date or number field. A date bound is a YYYY-MM-DD date,
 * 'today', or a number of days from today such as 'today-90' or 'today+7'.
 */
export interface RangeCondition {
  from?: string | number;
  to?: string | number;
}

export type ChartDef =
  | { kind: 'count'; title: string; where?: Readonly<Record<string, RangeCondition>> }
  | { kind: 'over-time'; title: string; field: string; bucket: 'week' | 'month' }
  | { kind: 'by-category'; title: string; field: string }
  /** `edges` are bucket lower bounds; the last bucket is open-ended. */
  | { kind: 'histogram'; title: string; field: string; edges?: readonly number[] };

/** `field` must not be earlier or smaller than `notBefore`, when both are present. */
export interface OrderRule {
  field: string;
  notBefore: string;
}

export interface DataAppConfig {
  slug: string;
  title: string;
  description: string;
  /** SPDX identifier of the data license, e.g. 'CC-BY-4.0'. */
  license: string;
  /** What one record is, for page copy: "32 hackathons". */
  noun: { one: string; other: string };
  /** Fields that together identify a record. Normalized before comparing. */
  identity: readonly string[];
  fields: Readonly<Record<string, FieldDef>>;
  rules?: readonly OrderRule[];
  /** Submissions must fall inside these ranges, read at submit time ('today' included). */
  accept?: Readonly<Record<string, RangeCondition>>;
  /** One realistic record, shown to agents in their instructions. */
  example: { data: Readonly<Record<string, FieldValue>>; source_url: string; evidence: string };
  table: {
    columns: readonly string[];
    /** A field name; a leading '-' sorts descending. */
    defaultSort: string;
    defaultFilter?: Readonly<Record<string, RangeCondition>>;
    /** Heading of the Overview's preview: the first rows of the default Table view. */
    previewTitle: string;
  };
  charts: readonly ChartDef[];
  scope: { in: string; out: string };
  sourceHints: readonly string[];
  recheckAfterDays: number;
  notify: { line: string };
}

/** Returns the config unchanged, with its literal types kept. validateConfig() checks it. */
export function defineDataApp<const T extends DataAppConfig>(config: T): T {
  return config;
}

/** Top-level paths on data.manyfold.ai that the platform owns. */
export const RESERVED_SLUGS: readonly string[] = [
  'api',
  'settings',
  'assets',
  'admin',
  'docs',
  'about',
  'new',
  'login',
  'invite',
  'privacy',
];

/** Field names that would collide with query parameters (src/shared/query.ts). */
const RESERVED_FIELDS: readonly string[] = ['q', 'sort', 'page', 'limit', 'status', 'id'];

/** Field types the Table can sort by. */
export const SORTABLE: readonly FieldType[] = ['text', 'enum', 'date', 'number'];

const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const FIELD = /^[a-z][a-z0-9_]{0,31}$/;

/** Everything wrong with a config, as readable lines. Empty means valid. */
export function validateConfig(config: DataAppConfig): string[] {
  const problems: string[] = [];
  const fail = (message: string) => problems.push(`${config.slug}: ${message}`);

  if (!SLUG.test(config.slug)) fail('slug must be 3 to 40 lowercase letters, digits and hyphens');
  if (RESERVED_SLUGS.includes(config.slug)) fail(`slug "${config.slug}" is reserved`);

  for (const [name, def] of Object.entries(config.fields)) {
    if (!FIELD.test(name)) fail(`field "${name}" must start with a letter and use a-z, 0-9 and _`);
    if (RESERVED_FIELDS.includes(name)) fail(`field "${name}" is a reserved name`);
    if (/_(from|to)$/.test(name)) fail(`field "${name}" must not end in _from or _to`);
    if (def.type === 'enum' && def.values.length === 0) fail(`enum field "${name}" needs values`);
  }

  const need = (name: string, where: string, types?: readonly FieldType[]) => {
    const def = config.fields[name];
    if (!def) fail(`${where} names unknown field "${name}"`);
    else if (types && !types.includes(def.type)) {
      fail(`${where} needs a ${types.join(' or ')} field, but "${name}" is ${def.type}`);
    }
  };

  if (config.identity.length === 0) fail('identity needs at least one field');
  config.identity.forEach((name) => need(name, 'identity'));
  config.table.columns.forEach((name) => need(name, 'table.columns'));
  need(config.table.defaultSort.replace(/^-/, ''), 'table.defaultSort', SORTABLE);
  Object.keys(config.table.defaultFilter ?? {}).forEach((name) =>
    need(name, 'table.defaultFilter', ['date', 'number']),
  );
  for (const rule of config.rules ?? []) {
    need(rule.field, 'rules', ['date', 'number']);
    need(rule.notBefore, 'rules', ['date', 'number']);
  }
  Object.keys(config.accept ?? {}).forEach((name) => need(name, 'accept', ['date', 'number']));
  const bounds = (where: string, ranges: Readonly<Record<string, RangeCondition>> | undefined) => {
    for (const [name, range] of Object.entries(ranges ?? {})) {
      const type = config.fields[name]?.type;
      for (const bound of [range.from, range.to]) {
        if (bound === undefined) continue;
        if (type === 'date' && !(typeof bound === 'string' && isDateBound(bound))) {
          fail(`${where} bound for "${name}" must be YYYY-MM-DD, today or today-N; got ${String(bound)}`);
        }
        if (type === 'number' && typeof bound !== 'number') fail(`${where} bound for "${name}" must be a number`);
      }
    }
  };
  bounds('accept', config.accept);
  bounds('table.defaultFilter', config.table.defaultFilter);
  for (const chart of config.charts) if (chart.kind === 'count') bounds(`chart "${chart.title}"`, chart.where);
  const example = validateRecordData(config, config.example.data);
  if (!example.ok) {
    fail(`example: ${example.errors.map((error) => `${error.field} ${error.message}`).join('; ')}`);
  }
  for (const chart of config.charts) {
    const where = `chart "${chart.title}"`;
    if (chart.kind === 'count') {
      Object.keys(chart.where ?? {}).forEach((name) => need(name, where, ['date', 'number']));
    } else if (chart.kind === 'over-time') need(chart.field, where, ['date']);
    else if (chart.kind === 'by-category') need(chart.field, where, ['enum', 'tags']);
    else need(chart.field, where, ['number']);
  }
  return problems;
}

/* ───────── record validation ───────── */

export type FieldValue = string | number | string[];
export type RecordData = Record<string, FieldValue>;

export interface FieldError {
  field: string;
  message: string;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

// Control characters (tab and newline excepted, then collapsed) and invisible format
// characters that can hide text from a reader. Removed from every text value.
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/** One line of plain text: invisible characters removed, whitespace collapsed. */
export const cleanText = (value: string): string =>
  value.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written YYYY-MM-DD. */
export function isIsoDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

const RELATIVE = /^today([+-])(\d{1,4})$/;

/** True for a date bound a config or a Table URL may use: YYYY-MM-DD, today, or today±N. */
export const isDateBound = (value: string): boolean => value === 'today' || RELATIVE.test(value) || isIsoDate(value);

/** The date a bound stands for, read against `today` (YYYY-MM-DD, UTC). */
export function resolveDateBound(bound: string, today: string): string {
  if (bound === 'today') return today;
  const match = RELATIVE.exec(bound);
  if (!match) return bound;
  const days = Number(match[2]) * (match[1] === '-' ? -1 : 1);
  return new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** A bound in words: "today", "90 days before today", or the date itself. */
export function describeDateBound(bound: string): string {
  const match = RELATIVE.exec(bound);
  if (!match) return bound;
  const days = Number(match[2]);
  return `${days} day${days === 1 ? '' : 's'} ${match[1] === '-' ? 'before' : 'after'} today`;
}

/** 1 to 32 characters: lowercase letters, digits and inner hyphens. */
export const TAG = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** A value quoted back in an error message, kept short. */
const show = (value: unknown): string => {
  const text = typeof value === 'string' ? JSON.stringify(value) : String(JSON.stringify(value) ?? value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
};

/** An https URL with a dotted host and no credentials, or null. */
export function parseHttpsUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.')) {
    return null;
  }
  return url.toString();
}

type Checked = { value: FieldValue } | string;

function checkField(def: FieldDef, raw: unknown): Checked {
  switch (def.type) {
    case 'text': {
      if (typeof raw !== 'string') return `must be text; got ${show(raw)}`;
      const text = cleanText(raw);
      if (!text) return 'is empty once invisible characters are removed';
      if (text.length > def.max) return `must be at most ${def.max} characters; got ${text.length}`;
      return { value: text };
    }
    case 'enum':
      if (typeof raw !== 'string' || !def.values.includes(raw)) {
        return `must be one of ${def.values.join(', ')}; got ${show(raw)}`;
      }
      return { value: raw };
    case 'date':
      if (typeof raw !== 'string' || !isIsoDate(raw)) {
        return `must be a date written YYYY-MM-DD; got ${show(raw)}`;
      }
      return { value: raw };
    case 'number':
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return `must be a number; got ${show(raw)}`;
      if (def.min !== undefined && raw < def.min) return `must be at least ${def.min}; got ${raw}`;
      if (def.max !== undefined && raw > def.max) return `must be at most ${def.max}; got ${raw}`;
      return { value: raw };
    case 'url': {
      const url = typeof raw === 'string' ? parseHttpsUrl(raw) : null;
      if (!url) return `must be a full https:// URL; got ${show(raw)}`;
      return { value: def.homePage ? `${new URL(url).origin}/` : url };
    }
    case 'tags': {
      if (!Array.isArray(raw)) return `must be a list of tags; got ${show(raw)}`;
      if (raw.length > def.max) return `must have at most ${def.max} tags; got ${raw.length}`;
      const tags: string[] = [];
      for (const tag of raw) {
        if (typeof tag !== 'string' || !TAG.test(tag)) {
          return `each tag must be 1 to 32 lowercase letters, digits or hyphens; got ${show(tag)}`;
        }
        if (!tags.includes(tag)) tags.push(tag);
      }
      return { value: tags };
    }
  }
}

/**
 * Checks a record's field values against its config and returns the cleaned values.
 * Messages are written for agents: each names the field, the rule and what it got.
 */
export function validateRecordData(config: DataAppConfig, input: unknown): Validated<RecordData> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: [{ field: 'data', message: 'must be a JSON object of field values' }] };
  }
  const source = input as Record<string, unknown>;
  const errors: FieldError[] = [];
  const value: RecordData = {};

  for (const name of Object.keys(source)) {
    if (!(name in config.fields)) {
      errors.push({
        field: name,
        message: `is not a field of this data app; fields are ${Object.keys(config.fields).join(', ')}`,
      });
    }
  }
  for (const [name, def] of Object.entries(config.fields)) {
    const raw = source[name];
    if (raw === undefined || raw === null || raw === '') {
      if (def.required) errors.push({ field: name, message: 'is required' });
      continue;
    }
    const checked = checkField(def, raw);
    if (typeof checked === 'string') errors.push({ field: name, message: checked });
    else value[name] = checked.value;
  }
  for (const rule of config.rules ?? []) {
    const later = value[rule.field];
    const earlier = value[rule.notBefore];
    if (later === undefined || earlier === undefined) continue;
    if ((later as string | number) < (earlier as string | number)) {
      errors.push({
        field: rule.field,
        message: `must not be before ${rule.notBefore} (${show(earlier)}); got ${show(later)}`,
      });
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/** Errors for values outside the config's `accept` ranges. `today` is the UTC date of the submit. */
export function checkAccept(config: DataAppConfig, data: RecordData, today: string): FieldError[] {
  const errors: FieldError[] = [];
  for (const [field, range] of Object.entries(config.accept ?? {})) {
    const value = data[field];
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const at = (bound: string | number) => (typeof bound === 'string' ? resolveDateBound(bound, today) : bound);
    const name = (bound: string | number) =>
      typeof bound === 'string' && bound.startsWith('today') ? `${describeDateBound(bound)} (${at(bound)})` : String(bound);
    if (range.from !== undefined && value < at(range.from)) {
      errors.push({ field, message: `must be ${name(range.from)} or later for this data app; got ${show(value)}` });
    }
    if (range.to !== undefined && value > at(range.to)) {
      errors.push({ field, message: `must be ${name(range.to)} or earlier for this data app; got ${show(value)}` });
    }
  }
  return errors;
}

export interface Provenance {
  source_url: string;
  evidence: string;
  observed_at: string;
}

export const EVIDENCE_MAX = 300;

/** How far ahead of the server clock an observed_at may be before it counts as the future. */
const CLOCK_SKEW_MS = 10 * 60 * 1000;

/**
 * Checks where a record's facts came from: a page, a quote from it, and when it was
 * read. Given `now`, an observed_at in the future is refused.
 */
export function validateProvenance(
  input: { source_url?: unknown; evidence?: unknown; observed_at?: unknown },
  now?: Date,
): Validated<Provenance> {
  const errors: FieldError[] = [];

  const source = typeof input.source_url === 'string' ? parseHttpsUrl(input.source_url) : null;
  if (!source) {
    errors.push({
      field: 'source_url',
      message: `must be the full https:// URL of the page that states the facts; got ${show(input.source_url)}`,
    });
  }

  const evidence = typeof input.evidence === 'string' ? cleanText(input.evidence) : '';
  if (!evidence) {
    errors.push({ field: 'evidence', message: 'must quote the source page word for word' });
  } else if (evidence.length > EVIDENCE_MAX) {
    errors.push({ field: 'evidence', message: `must be at most ${EVIDENCE_MAX} characters; got ${evidence.length}` });
  }

  const observed =
    typeof input.observed_at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(input.observed_at)
      ? Date.parse(input.observed_at)
      : Number.NaN;
  if (!Number.isFinite(observed)) {
    errors.push({
      field: 'observed_at',
      message: `must be an ISO 8601 time such as 2026-10-01T08:55:00Z; got ${show(input.observed_at)}`,
    });
  } else if (now && observed > now.getTime() + CLOCK_SKEW_MS) {
    errors.push({
      field: 'observed_at',
      message: `must not be in the future; it is ${now.toISOString()} now; got ${show(input.observed_at)}`,
    });
  }

  if (errors.length > 0 || !source) return { ok: false, errors };
  return { ok: true, value: { source_url: source, evidence, observed_at: new Date(observed).toISOString() } };
}

/* ───────── identity ───────── */

const TRACKING = /^(utm_[a-z_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref|ref_src|si)$/i;

/**
 * The form two URLs are compared in: https, lowercase host without "www.", no port,
 * credentials, fragment or tracking parameters, sorted query, no trailing slash.
 */
export function normalizeUrl(raw: string): string {
  const url = new URL(raw.trim());
  url.protocol = 'https:';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  url.port = '';
  url.username = '';
  url.password = '';
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}${url.search}`;
}

/** The value two records share when they describe the same thing. */
export function identityKey(config: DataAppConfig, data: RecordData): string {
  return config.identity
    .map((name) => {
      const value = data[name];
      if (value === undefined) return '';
      if (config.fields[name]?.type === 'url') return normalizeUrl(String(value));
      if (typeof value === 'string') return value.toLowerCase().replace(/\s+/g, ' ').trim();
      return JSON.stringify(value);
    })
    .join('|');
}

/* ───────── display ───────── */

/** A field value's display name: the enum's label when it has one. */
export const valueLabel = (def: FieldDef | undefined, value: string): string =>
  (def?.type === 'enum' ? def.valueLabels?.[value] : undefined) ?? value;

/** Today's date in UTC, the clock every 'today' in configs and URLs is read against. */
export const todayUtc = (now: Date = new Date()): string => now.toISOString().slice(0, 10);
