/** How values read on the page. Dates are calendar dates in UTC, never shifted by time zone. */

import { openEndedLabel, valueLabel, withUnit, type DataAppConfig, type FieldDef, type FieldValue } from '../shared/data-app';

const dayFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const shortDayFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const monthFormat = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const timeFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usdCompact = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});
const plain = new Intl.NumberFormat('en-US');

const asDate = (value: string) => new Date(value.length === 10 ? `${value}T00:00:00Z` : value);

/** "Nov 15, 2026" */
export const formatDate = (value: string): string => dayFormat.format(asDate(value));
/** "Nov 15" */
export const formatShortDate = (value: string): string => shortDayFormat.format(asDate(value));
/** "Oct 2026" */
export const formatMonth = (value: string): string => monthFormat.format(asDate(value));
/** "Oct 1, 2026, 08:55 UTC" */
export const formatTime = (value: string): string => `${timeFormat.format(asDate(value))} UTC`;
export const formatCount = (value: number): string => plain.format(value);

/** The URL when it is https, else null. Records are validated on the way in; this is the second lock. */
export const safeHref = (value: string): string | null => (/^https:\/\//i.test(value) ? value : null);

/** "example.org/agents-hackathon", for showing a link without its scheme. */
export function displayUrl(value: string): string {
  try {
    const url = new URL(value);
    const text = `${url.hostname.replace(/^www\./, '')}${url.pathname === '/' ? '' : url.pathname}`;
    return text.length > 64 ? `${text.slice(0, 61)}...` : text;
  } catch {
    return value;
  }
}

const LICENSES: Record<string, { name: string; url: string }> = {
  'CC-BY-4.0': { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
};

/** A data license's short name and deed, from its SPDX identifier. */
export const licenseOf = (spdx: string): { name: string; url: string | null } =>
  LICENSES[spdx] ?? { name: spdx, url: null };

export const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export function formatNumber(def: FieldDef | undefined, value: number, compact = false): string {
  if (def?.type === 'number' && def.display === 'usd') return (compact ? usdCompact : usd).format(value);
  return withUnit(def, plain.format(value));
}

/** "1 hackathon", "32 hackathons" */
export const countOf = (config: DataAppConfig, count: number): string =>
  `${formatCount(count)} ${count === 1 ? config.noun.one : config.noun.other}`;

/**
 * A field value as text, for tables and the record page. URLs show as their host; a missing
 * open-ended date shows its word ("Rolling"), any other missing value as ''.
 */
export function formatValue(def: FieldDef | undefined, value: FieldValue | undefined): string {
  if (value === undefined || value === null || value === '') return openEndedLabel(def) ?? '';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'number') return formatNumber(def, value);
  switch (def?.type) {
    case 'date':
      return formatDate(value);
    case 'enum':
      return valueLabel(def, value);
    case 'url':
      try {
        return new URL(value).hostname.replace(/^www\./, '');
      } catch {
        return value;
      }
    default:
      return value;
  }
}

/** A number with up to `digits` decimals, trailing zeros dropped: 9.50 → "9.5". */
const trim = (value: number, digits: number): string =>
  value.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');

/**
 * An amount as a number and a small unit, the way pages print money: 9 500 000 → "9.5" and
 * "M USD". Numbers that are not money print in full, with their field's unit if it has one.
 */
export function amountParts(def: FieldDef | undefined, value: number): { number: string; unit: string } {
  if (!(def?.type === 'number' && def.display === 'usd')) {
    const unit = def?.type === 'number' ? (def.unit ?? '') : '';
    // A percent sign sits on the number: "7%", not "7 %".
    return unit === '%' ? { number: withUnit(def, plain.format(value)), unit: '' } : { number: plain.format(value), unit };
  }
  const size = Math.abs(value);
  if (size >= 1e9) return { number: trim(value / 1e9, 2), unit: 'B USD' };
  if (size >= 1e6) return { number: trim(value / 1e6, 1), unit: 'M USD' };
  if (size >= 1e3) return { number: trim(value / 1e3, 1), unit: 'K USD' };
  return { number: plain.format(value), unit: 'USD' };
}

/** A short amount for labels and chips: "$9.5M", "$25K", "$1B". Plain numbers stay plain: "500 MW". */
export function shortAmount(def: FieldDef | undefined, value: number): string {
  if (!(def?.type === 'number' && def.display === 'usd')) return withUnit(def, plain.format(value));
  const size = Math.abs(value);
  if (size >= 1e9) return `$${trim(value / 1e9, 2)}B`;
  if (size >= 1e6) return `$${trim(value / 1e6, 1)}M`;
  if (size >= 1e3) return `$${trim(value / 1e3, 1)}K`;
  return `$${plain.format(value)}`;
}

/** A field label without its unit, for headings: "Amount (USD)" → "Amount". */
export const bareLabel = (label: string): string => label.replace(/\s*\([^)]*\)\s*$/, '');

/** Up to two initials for an avatar: "Zhipu AI (智谱)" → "ZA". */
export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '?') + (words[1]?.[0] ?? '')).toUpperCase();
}

/** A stable hue for a name, so its avatar has the same color on every page. */
export function hueOf(name: string): number {
  let hue = 0;
  for (let index = 0; index < name.length; index += 1) hue = (hue * 31 + name.charCodeAt(index)) % 360;
  return hue;
}

/** "Hackathons" from the config's noun. */
export const nounTitle = (config: DataAppConfig): string => capitalize(config.noun.other);
