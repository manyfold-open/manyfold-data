// Two field options the newer data apps lean on: a date whose absence means "no end" (a
// program taking applications on a rolling basis), and a unit on a plain number (MW, %).
import { describe, expect, it } from 'vitest';
import accelerators from '../data-apps/ai-accelerators/config';
import dataCenters from '../data-apps/ai-data-centers/config';
import { amountParts, formatValue, shortAmount } from '../src/app/format';
import { validateConfig, type DataAppConfig } from '../src/shared/data-app';
import { listFrom, statsFrom } from '../src/shared/engine';
import { defaultQuery, parseQuery } from '../src/shared/query';
import type { DatasetResponse, PublicRecord } from '../src/shared/types';
import { fillLine } from '../src/worker/notify';
import { collectorSkill } from '../src/worker/skill';
import type { Token } from '../src/worker/tokens';

const today = '2026-10-02';

const program = (id: string, data: PublicRecord['data']): PublicRecord => ({
  id,
  status: 'verified',
  data: { name: id, organizer: 'Org', kind: 'accelerator', url: `https://example.org/${id}`, audience: 'startups', region: 'global', ...data },
  source_url: `https://example.org/${id}`,
  observed_at: '2026-10-01T00:00:00.000Z',
  verified_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
});

const records = [
  program('soon', { deadline: '2026-10-09' }),
  program('later', { deadline: '2026-12-01' }),
  program('closed', { deadline: '2026-09-01' }),
  program('rolling', {}),
];

const ids = (search: string, config: DataAppConfig = accelerators) =>
  listFrom(config, { records, today }, parseQuery(config, new URLSearchParams(search)).state, 10).records.map((r) => r.id);

describe('an open-ended date', () => {
  it('passes a lower bound and fails an upper one', () => {
    expect(ids('deadline_from=today')).toEqual(['soon', 'later', 'rolling']);
    expect(ids('deadline_to=today%2B30')).toEqual(['closed', 'soon']);
    expect(ids('deadline_from=today&deadline_to=today%2B30')).toEqual(['soon']);
  });

  it('puts rolling programs after dated ones in the default view, and counts them as open', () => {
    expect(listFrom(accelerators, { records, today }, defaultQuery(accelerators), 10).records.map((r) => r.id)).toEqual([
      'soon',
      'later',
      'rolling',
    ]);
    const dataset: DatasetResponse = { today, generated_at: `${today}T00:00:00Z`, records, pending: 0, discordInvite: null };
    const open = statsFrom(accelerators, dataset, new Date(`${today}T12:00:00Z`)).charts.find((chart) => chart.title === 'Open for applications');
    expect(open).toMatchObject({ kind: 'count', value: 3 });
  });

  it('only changes dates that opt in: a missing hackathon prize still fails every range', () => {
    const plain = { ...accelerators, fields: { ...accelerators.fields, deadline: { type: 'date' as const, label: 'Deadline' } } };
    expect(ids('deadline_from=today', plain)).toEqual(['soon', 'later']);
  });

  it('shows its word where the date would be, and leaves a Discord segment out', () => {
    expect(formatValue(accelerators.fields.deadline, undefined)).toBe('Rolling');
    expect(formatValue(accelerators.fields.funding_usd, undefined)).toBe('');
    expect(fillLine(accelerators, records[3]!.data)).toBe('rolling · Accelerator · Global');
    expect(fillLine(accelerators, records[0]!.data)).toBe('soon · Accelerator · deadline 2026-10-09 · Global');
  });

  it('cannot be required, and needs a short word', () => {
    const broken = {
      ...accelerators,
      fields: { ...accelerators.fields, deadline: { type: 'date' as const, label: 'Deadline', required: true, openEnded: '' } },
    };
    expect(validateConfig(broken)).toEqual([
      'ai-accelerators: field "deadline": openEnded must be 1 to 24 characters',
      'ai-accelerators: field "deadline" cannot be both required and openEnded',
    ]);
  });
});

describe('a unit on a plain number', () => {
  const capacity = dataCenters.fields.capacity_mw;
  const equity = accelerators.fields.equity_pct;

  it('prints after the number everywhere: tables, chips, Discord', () => {
    expect(formatValue(capacity, 1200)).toBe('1,200 MW');
    expect(amountParts(capacity, 1200)).toEqual({ number: '1,200', unit: 'MW' });
    expect(shortAmount(capacity, 250)).toBe('250 MW');
    expect(formatValue(equity, 7)).toBe('7%');
    expect(amountParts(equity, 7)).toEqual({ number: '7%', unit: '' });
    expect(
      fillLine(dataCenters, {
        name: 'Example Campus',
        developer: ['Example Compute'],
        capacity_mw: 1200,
        investment_usd: 15000000000,
        city: ['Springfield'],
        stage: 'under-construction',
      }),
    ).toBe('Example Campus · Example Compute · 1,200 MW · $15,000,000,000 · Springfield · Under construction');
  });

  it('is refused on money', () => {
    const broken = {
      ...dataCenters,
      fields: { ...dataCenters.fields, investment_usd: { type: 'number' as const, label: 'Investment', display: 'usd' as const, unit: 'USD' } },
    };
    expect(validateConfig(broken)).toEqual(['ai-data-centers: field "investment_usd": a usd amount takes no unit']);
  });
});

describe('the collector instructions', () => {
  const token: Token = {
    id: 'tok_test',
    role: 'collector',
    label: 'test-scout',
    apps: ['ai-accelerators'],
    status: 'active',
    pendingCap: 20,
    dailyTaskLimit: null,
    expiresAt: null,
    createdAt: '2026-10-01T00:00:00Z',
  };
  const standing = { pending: 0, verified: 0, rejected: 0, merged: 0, stale: 0, pending_cap: 20, warnings: [] };

  it('say what a missing open-ended date means, and the unit of a number', () => {
    const skill = collectorSkill(accelerators, 'https://data.test', token, standing, new Date(`${today}T12:00:00Z`));
    expect(skill).toContain('A record without one has no end; pages show "Rolling".');
    expect(skill).toContain('A number, 0 or more, at most 100, in percent.');
    const centers = collectorSkill(dataCenters, 'https://data.test', { ...token, apps: ['ai-data-centers'] }, standing, new Date());
    expect(centers).toContain('A number, 0 or more, in MW.');
  });
});
