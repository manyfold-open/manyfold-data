/**
 * The smart filter, version 1: a sentence becomes filters, by rules built from the config's
 * own words. Enum values match their labels ("Series A", "in person"), tags match the
 * values the Table has seen ("San Francisco", "agents"), amounts like "$50M" or "under
 * $5K" become a range on the histogram's field, and "next 7 days" or "last month" a range
 * on the app's date field.
 *
 * It runs in the browser and returns a QueryState, nothing more: the sentence is never sent,
 * stored or tracked (AGENTS.md invariant 17). A model-backed version may replace it later
 * and must return the same shape.
 *
 * Plain TypeScript with no DOM or React, so tests can run it in Node.
 */

import { valueLabel, type DataAppConfig, type FieldDef } from '../../shared/data-app';
import { shortAmount } from '../format';
import type { FieldFilter, QueryState } from '../../shared/query';
import { shortLabel } from './charts';
import { amountOf, dateDirection, dateFieldOf, rangeLabel } from './filters';

export interface SmartResult {
  /** The state to apply: the base state's search and sort, these filters, page 1. */
  state: QueryState;
  /** What was understood, in the words the chips use. Empty when nothing was. */
  applied: string[];
}

/** Lowercase, accents removed, punctuation as spaces; keeps $ . and + for amounts. */
export function normalize(text: string): string {
  return ` ${text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/(\d)\s*[-–]\s*(?=\$?\d)/g, '$1 to ')
    .replace(/[^\p{L}\p{N}$.+]+/gu, ' ')
    .replace(/\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A phrase as a whole-word pattern; a trailing "s" is optional, so "americas" also finds "america". */
const phrase = (words: string): RegExp => {
  const stem = words.length > 4 && words.endsWith('s') ? `${escape(words.slice(0, -1))}s?` : `${escape(words)}s?`;
  return new RegExp(` ${stem} `);
};

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  fourteen: 14,
  thirty: 30,
  sixty: 60,
  ninety: 90,
};

const SCALE: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  mm: 1e6,
  mn: 1e6,
  million: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
};

/** "$50m", "50 million", "$2.5b", "25k usd". Groups: dollar sign, digits, scale, currency word. */
const AMOUNT = String.raw`(\$ ?)?(\d+(?:\.\d+)?) ?(k|thousand|mm|mn|m|million|bn|b|billion)?( ?(?:usd|dollars))?`;

/** An amount from four AMOUNT groups starting at `at`, or null for a bare number: "7 days" is not money. */
function amountAt(match: RegExpExecArray, at: number, scaleFrom?: string): number | null {
  const [dollar, digits, scale, usd] = [match[at], match[at + 1], match[at + 2] ?? scaleFrom, match[at + 3]];
  if (!dollar && !scale && !usd) return null;
  return Math.round(Number(digits) * (scale ? SCALE[scale]! : 1));
}

/** The amount field, when it holds money: "$50M" means nothing to a capacity in MW. */
function moneyOf(config: DataAppConfig): ReturnType<typeof amountOf> {
  const amount = amountOf(config);
  const def = amount ? config.fields[amount.field] : undefined;
  return def?.type === 'number' && def.display === 'usd' ? amount : null;
}

/** The first match of a whole-word pattern whose amount reads as money. */
function firstAmount(pattern: string, text: string): { match: RegExpExecArray; value: number } | null {
  for (const match of text.matchAll(new RegExp(`(?<= )${pattern}(?= )`, 'g'))) {
    const value = amountAt(match, 1);
    if (value !== null) return { match, value };
  }
  return null;
}

interface Candidate {
  field: string;
  value: string;
  words: string[];
}

/** Every way the config names an enum value, and every tag the Table has seen. */
function candidates(config: DataAppConfig, tags: Readonly<Record<string, readonly string[]>>): Candidate[] {
  const out: Candidate[] = [];
  for (const [field, def] of Object.entries(config.fields)) {
    if (def.type === 'enum') {
      // A label's first word stands for its value only when no sibling starts the same way.
      const firstWord = (value: string) => normalize(valueLabel(def, value)).trim().split(' ')[0] ?? '';
      const firsts = new Map<string, number>();
      for (const value of def.values) firsts.set(firstWord(value), (firsts.get(firstWord(value)) ?? 0) + 1);
      for (const value of def.values) {
        if (value === 'other') continue;
        const first = firstWord(value);
        const words = [normalize(valueLabel(def, value)).trim(), normalize(value).trim()];
        if (firsts.get(first) === 1 && first.length >= 4) words.push(first);
        out.push({ field, value, words: [...new Set(words)].filter((word) => word.length >= 3) });
      }
    } else if (def.type === 'tags') {
      for (const value of tags[field] ?? []) {
        const word = normalize(value).trim();
        if (word.length >= 3) out.push({ field, value, words: [word] });
      }
    }
  }
  // Longest phrases first, so "pre series a" is taken before "series a" can be.
  return out.sort((a, b) => Math.max(...b.words.map((w) => w.length)) - Math.max(...a.words.map((w) => w.length)));
}

/** Reads a sentence into filters. `tags` lists known values of each tags field. */
export function parseSmartFilter(
  config: DataAppConfig,
  base: QueryState,
  sentence: string,
  tags: Readonly<Record<string, readonly string[]>> = {},
  today = new Date().toISOString().slice(0, 10),
): SmartResult {
  let text = normalize(sentence);
  const filters: Record<string, FieldFilter> = {};
  const take = (pattern: RegExp | string) => {
    text = ` ${text.replace(pattern, ' ').replace(/\s+/g, ' ').trim()} `;
  };

  // Dates first, so "next 7 days" is not read as anything else.
  const dateField = dateFieldOf(config);
  if (dateField) {
    const future = dateDirection(config, dateField) === 'future';
    const unitDays = { day: 1, week: 7, month: 30 } as const;
    const span = / (?:in the |within the |within )?(next|coming|last|past|previous|within) (?:(\d+|[a-z]+) )?(day|week|month)s? /.exec(text);
    const named = / (today|this week|this month|closing soon|soon|upcoming|open now|still open|recently|recent) /.exec(text);
    let days: number | null = null;
    let ahead = future;
    if (span) {
      const count = span[2] ? Number(span[2]) || NUMBER_WORDS[span[2]] || 0 : 1;
      if (count > 0) {
        days = count * unitDays[span[3] as keyof typeof unitDays];
        // "next" and "last" say which way to look; "within" follows the field.
        if (span[1] === 'next' || span[1] === 'coming') ahead = true;
        else if (span[1] !== 'within') ahead = false;
        take(span[0]);
      }
    } else if (named) {
      const word = named[1]!;
      if (word === 'upcoming' || word === 'open now' || word === 'still open') {
        if (future) {
          filters[dateField] = { kind: 'range', from: 'today' };
          take(named[0]);
        }
      } else {
        days = word === 'today' ? 0 : word === 'this month' ? 30 : 7;
        take(named[0]);
      }
    }
    if (days !== null) {
      filters[dateField] = ahead
        ? { kind: 'range', from: 'today', to: `today+${days}` }
        : days === 0
          ? { kind: 'range', from: 'today' }
          : future
            ? { kind: 'range', from: `today-${days}`, to: 'today' }
            : { kind: 'range', from: `today-${days}` };
    }
  }

  // Amounts: a range, a ceiling or a floor; a bare amount means "at least".
  const amount = moneyOf(config);
  if (amount) {
    const between = new RegExp(`(?<= )(?:between |from )?${AMOUNT} (?:to|and) ${AMOUNT}(?= )`).exec(text);
    // "$1 to 5m": a scale written once applies to both ends.
    const high = between ? amountAt(between, 5) : null;
    const low = between ? amountAt(between, 1, between[3] ? undefined : between[7]) : null;
    const ceiling = firstAmount(`(?:under|below|less than|at most|up to|max|maximum|<) ?${AMOUNT}`, text);
    const floor = firstAmount(`(?:(?:over|above|more than|at least|min|minimum|>=|>) ?)?${AMOUNT}(?: ?\\+| or more| and up| plus)?`, text);
    if (between && low !== null && high !== null && low <= high) {
      filters[amount.field] = { kind: 'range', from: String(low), to: String(high) };
      take(between[0]);
    } else if (ceiling) {
      filters[amount.field] = { kind: 'range', to: String(ceiling.value) };
      take(ceiling.match[0]);
    } else if (floor) {
      filters[amount.field] = { kind: 'range', from: String(floor.value) };
      take(floor.match[0]);
    }
  }

  // Values, longest phrase first; each match is removed so it cannot match twice.
  for (const candidate of candidates(config, tags)) {
    for (const word of candidate.words) {
      const pattern = phrase(word);
      if (!pattern.test(text)) continue;
      const current = filters[candidate.field];
      const values = current?.kind === 'in' ? current.values : [];
      if (!values.includes(candidate.value)) filters[candidate.field] = { kind: 'in', values: [...values, candidate.value] };
      take(pattern);
      break;
    }
  }

  const applied: string[] = [];
  for (const field of Object.keys(config.fields)) {
    const filter = filters[field];
    const def = config.fields[field];
    if (!filter || !def) continue;
    if (filter.kind === 'in') applied.push(...filter.values.map((value) => shortLabel(valueLabel(def, value))));
    else applied.push(rangeLabel(config, field, filter, today));
  }

  return { state: { ...base, filters: applied.length > 0 ? filters : base.filters, page: 1 }, applied };
}

/** What the smart filter understands, for the hint shown when it finds nothing. */
export function smartHint(config: DataAppConfig): string {
  const names = Object.values(config.fields)
    .filter((def) => def.type === 'enum' || def.type === 'tags')
    .map((def) => def.label.toLowerCase())
    .slice(0, 3);
  const parts = [names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0]];
  if (moneyOf(config)) parts.push('an amount');
  if (dateFieldOf(config)) parts.push('a time range');
  const named = parts.filter(Boolean) as string[];
  const list = named.length > 1 ? `${named.slice(0, -1).join(', ')} or ${named.at(-1)}` : (named[0] ?? 'value');
  return `No filters found in that. Try naming a ${list}.`;
}

/** A sentence that shows what the smart filter can do, from the config's own values. */
export function smartExample(config: DataAppConfig): string {
  const pick = (def: FieldDef | undefined) =>
    def?.type === 'enum' ? shortLabel(valueLabel(def, def.values[Math.min(2, def.values.length - 1)]!)) : null;
  const [first, second] = Object.values(config.fields).filter((def) => def.type === 'enum');
  const words = [pick(second), pick(first)?.toLowerCase(), config.noun.other].filter(Boolean) as string[];
  if (words.length > 0) words[0] = words[0]!.charAt(0).toUpperCase() + words[0]!.slice(1);
  const dateField = dateFieldOf(config);
  if (dateField) words.push(dateDirection(config, dateField) === 'future' ? 'in the next 30 days' : 'in the last 30 days');
  const amount = moneyOf(config);
  const edge = amount?.edges.filter((value) => value > 0)[2];
  if (amount && edge) words.push(`over ${shortAmount(config.fields[amount.field], edge)}`);
  return words.join(' ');
}
