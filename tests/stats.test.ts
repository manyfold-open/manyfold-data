import { describe, expect, it } from 'vitest';
import { weekStart } from '../src/shared/dates';
import { bucketDates, histogram } from '../src/shared/engine';
import { schemaStatements, SCHEMA } from '../src/worker/schema';

describe('weekStart', () => {
  it('returns the Monday of the week', () => {
    expect(weekStart('2026-10-01')).toBe('2026-09-28'); // a Thursday
    expect(weekStart('2026-09-28')).toBe('2026-09-28'); // a Monday
    expect(weekStart('2026-10-04')).toBe('2026-09-28'); // a Sunday
  });
});

describe('bucketDates', () => {
  it('counts per week and fills empty weeks with zero', () => {
    expect(bucketDates(['2026-10-01', '2026-10-02', '2026-10-20'], 'week')).toEqual([
      { start: '2026-09-28', count: 2 },
      { start: '2026-10-05', count: 0 },
      { start: '2026-10-12', count: 0 },
      { start: '2026-10-19', count: 1 },
    ]);
  });

  it('counts per month and keeps only the latest buckets', () => {
    expect(bucketDates(['2026-01-15', '2026-03-02'], 'month', 2)).toEqual([
      { start: '2026-02-01', count: 0 },
      { start: '2026-03-01', count: 1 },
    ]);
  });

  it('returns nothing for no dates', () => {
    expect(bucketDates([], 'week')).toEqual([]);
  });
});

describe('histogram', () => {
  it('uses configured lower bounds and leaves the last bucket open', () => {
    expect(histogram([0, 999, 1000, 250000], [0, 1000, 100000])).toEqual([
      { from: 0, to: 1000, count: 2 },
      { from: 1000, to: 100000, count: 1 },
      { from: 100000, to: null, count: 1 },
    ]);
  });

  it('chooses round buckets when none are configured', () => {
    const bins = histogram([5, 12, 30, 58]);
    expect(bins.map((bin) => bin.from)).toEqual([0, 10, 20, 30, 40, 50]);
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(4);
  });
});

describe('schema', () => {
  it('splits into create statements only', () => {
    const statements = schemaStatements(SCHEMA);
    expect(statements.length).toBeGreaterThan(10);
    expect(statements.every((statement) => statement.startsWith('CREATE '))).toBe(true);
  });
});
