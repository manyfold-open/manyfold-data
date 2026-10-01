import { describe, expect, it } from 'vitest';
import { dataApps } from '../data-apps/index';
import hackathons from '../data-apps/ai-hackathons/config';
import {
  checkAccept,
  cleanText,
  describeDateBound,
  identityKey,
  isDateBound,
  isIsoDate,
  normalizeUrl,
  resolveDateBound,
  validateConfig,
  validateProvenance,
  validateRecordData,
  type DataAppConfig,
} from '../src/shared/data-app';

const valid = {
  name: 'Example Agents Hackathon',
  organizer: 'Example Labs',
  url: 'https://example.org/agents-hackathon',
  deadline: '2026-11-15',
  starts_on: '2026-11-21',
  ends_on: '2026-11-23',
  format: 'online',
  region: 'global',
  prize_usd: 25000,
  tags: ['agents'],
};

const errorsOf = (input: unknown, config: DataAppConfig = hackathons) => {
  const result = validateRecordData(config, input);
  return result.ok ? [] : result.errors;
};

describe('validateConfig', () => {
  it('accepts every registered data app', () => {
    expect(dataApps.flatMap(validateConfig)).toEqual([]);
  });

  it('gives every data app a unique slug', () => {
    const slugs = dataApps.map((app) => app.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('refuses reserved slugs and unknown or mistyped fields', () => {
    const broken: DataAppConfig = {
      ...hackathons,
      slug: 'settings',
      identity: ['nope'],
      table: { ...hackathons.table, defaultSort: 'tags' },
      charts: [{ kind: 'over-time', title: 'Bad', field: 'format', bucket: 'week' }],
    };
    const problems = validateConfig(broken).join('\n');
    expect(problems).toMatch(/slug "settings" is reserved/);
    expect(problems).toMatch(/identity names unknown field "nope"/);
    expect(problems).toMatch(/defaultSort needs a text or enum or date or number field/);
    expect(problems).toMatch(/chart "Bad" needs a date field, but "format" is enum/);
  });
});

describe('validateRecordData', () => {
  it('accepts a complete record and returns cleaned values', () => {
    const result = validateRecordData(hackathons, { ...valid, name: '  Example\u200B  Agents Hackathon ' });
    expect(result).toEqual({ ok: true, value: { ...valid, name: 'Example Agents Hackathon' } });
  });

  it('names each field, its rule and what it got', () => {
    const messages = errorsOf({ ...valid, deadline: 'next Friday', format: 'remote', extra: 1 }).map(
      (error) => `${error.field} ${error.message}`,
    );
    expect(messages).toContain('deadline must be a date written YYYY-MM-DD; got "next Friday"');
    expect(messages).toContain('format must be one of online, in-person, hybrid; got "remote"');
    expect(messages.some((message) => message.startsWith('extra is not a field of this data app'))).toBe(true);
  });

  it('requires required fields and skips empty optional ones', () => {
    const { name: _name, ...withoutName } = valid;
    expect(errorsOf(withoutName)).toEqual([{ field: 'name', message: 'is required' }]);
    expect(errorsOf({ ...valid, city: '', prize_usd: null })).toEqual([]);
  });

  it('checks order rules between dates', () => {
    expect(errorsOf({ ...valid, ends_on: '2026-11-20' }).map((error) => error.field)).toEqual([
      'ends_on',
    ]);
  });

  it('refuses non-https urls, bad tags and impossible dates', () => {
    const fields = errorsOf({
      ...valid,
      url: 'http://example.org/x',
      tags: ['Agents'],
      starts_on: '2026-02-30',
    }).map((error) => error.field);
    expect(fields).toEqual(expect.arrayContaining(['url', 'tags', 'starts_on']));
  });
});

describe('validateProvenance', () => {
  it('needs a source page, a quote and a time', () => {
    const result = validateProvenance({ source_url: 'ftp://x', evidence: '  ', observed_at: 'yesterday' });
    expect(result.ok ? [] : result.errors.map((error) => error.field)).toEqual([
      'source_url',
      'evidence',
      'observed_at',
    ]);
  });

  it('normalizes the time to ISO 8601 UTC', () => {
    expect(
      validateProvenance({
        source_url: 'https://example.org',
        evidence: 'Registration closes on November 15, 2026.',
        observed_at: '2026-10-01T10:55:00+02:00',
      }),
    ).toEqual({
      ok: true,
      value: {
        source_url: 'https://example.org/',
        evidence: 'Registration closes on November 15, 2026.',
        observed_at: '2026-10-01T08:55:00.000Z',
      },
    });
  });
});

describe('identity', () => {
  it('treats URL variants of the same page as one', () => {
    const variants = [
      'https://Example.org/hack/',
      'http://www.example.org/hack?utm_source=x#apply',
      'https://example.org:443/hack',
    ];
    expect(new Set(variants.map(normalizeUrl))).toEqual(new Set(['https://example.org/hack']));
  });

  it('keeps meaningful query parameters, sorted', () => {
    expect(normalizeUrl('https://example.org/e?b=2&a=1&fbclid=z')).toBe('https://example.org/e?a=1&b=2');
  });

  it('builds the key from the identity fields only', () => {
    expect(identityKey(hackathons, { ...valid, url: 'https://www.example.org/agents-hackathon/' })).toBe(
      'https://example.org/agents-hackathon',
    );
  });
});

describe('helpers', () => {
  it('removes invisible characters and collapses whitespace', () => {
    expect(cleanText('a\u200B\u202E b\n\tc ')).toBe('a b c');
  });

  it('knows real calendar dates', () => {
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-1-05')).toBe(false);
  });
});

describe('date bounds', () => {
  it('reads today and days from today against the UTC date', () => {
    expect(resolveDateBound('today', '2026-10-01')).toBe('2026-10-01');
    expect(resolveDateBound('today-90', '2026-10-01')).toBe('2026-07-03');
    expect(resolveDateBound('today+7', '2026-12-28')).toBe('2027-01-04');
    expect(resolveDateBound('2026-05-01', '2026-10-01')).toBe('2026-05-01');
  });

  it('accepts only bounds it can read, and says them in words', () => {
    for (const bound of ['today', 'today-30', 'today+7', '2026-10-01']) expect(isDateBound(bound)).toBe(true);
    for (const bound of ['today-', 'yesterday', 'today - 3', '2026-02-30']) expect(isDateBound(bound)).toBe(false);
    expect(describeDateBound('today-1')).toBe('1 day before today');
    expect(describeDateBound('today+30')).toBe('30 days after today');
    expect(describeDateBound('today')).toBe('today');
  });

  it('checks a moving window at submit time, naming the dates', () => {
    const config = { ...hackathons, accept: { deadline: { from: 'today-90', to: 'today' } } };
    expect(checkAccept(config, { deadline: '2026-07-03' }, '2026-10-01')).toEqual([]);
    expect(checkAccept(config, { deadline: '2026-07-02' }, '2026-10-01')).toEqual([
      { field: 'deadline', message: 'must be 90 days before today (2026-07-03) or later for this data app; got "2026-07-02"' },
    ]);
    expect(checkAccept(config, { deadline: '2026-10-02' }, '2026-10-01')[0]?.message).toContain('today (2026-10-01) or earlier');
  });

  it('refuses a config bound it cannot read', () => {
    const config = { ...hackathons, accept: { deadline: { from: 'yesterday' } } };
    expect(validateConfig(config)).toEqual([
      'ai-hackathons: accept bound for "deadline" must be YYYY-MM-DD, today or today-N; got yesterday',
    ]);
  });
});

describe('lists of names', () => {
  it('keep case and accents, read a string as comma-separated names, and drop repeats', () => {
    const ok = (city: unknown) => {
      const result = validateRecordData(hackathons, { ...valid, city });
      return result.ok ? result.value.city : result.errors;
    };
    expect(ok(['Zürich', 'San Francisco', 'zürich'])).toEqual(['Zürich', 'San Francisco']);
    expect(ok('Rome, Milan; Imperia')).toEqual(['Rome', 'Milan', 'Imperia']);
    expect(ok(['London, UK'])).toEqual([
      { field: 'city', message: 'each name must be text of 1 to 60 characters without commas; got "London, UK"' },
    ]);
    expect(ok(['x'.repeat(61)])).toHaveLength(1);
    expect(ok(Array.from({ length: 9 }, (_, n) => `City ${n}`))).toEqual([
      { field: 'city', message: 'must have at most 8 names; got 9' },
    ]);
  });

  it('only show preview columns the data app has', () => {
    const config = { ...hackathons, table: { ...hackathons.table, previewColumns: ['name', 'venue'] } };
    expect(validateConfig(config)).toEqual(['ai-hackathons: table.previewColumns names unknown field "venue"']);
  });
});

describe('home-page urls', () => {
  it('keep only the scheme and host', () => {
    const config: DataAppConfig = {
      ...hackathons,
      fields: { ...hackathons.fields, url: { type: 'url', label: 'Website', required: true, homePage: true } },
    };
    const result = validateRecordData(config, { ...valid, url: 'https://www.example.org/about?ref=x#team' });
    expect(result.ok && result.value.url).toBe('https://www.example.org/');
    expect(identityKey(config, { ...valid, url: 'https://www.example.org/' })).toBe('https://example.org');
  });
});
