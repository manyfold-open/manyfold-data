/// <reference types="vite/client" />
// Every seed file must load: valid against its config, one record per identity, and
// checked on or before the deadline it records.
import { describe, expect, it } from 'vitest';
import { dataApps } from '../data-apps/index';
import { identityKey, validateProvenance, validateRecordData } from '../src/shared/data-app';

interface SeedEntry {
  data: Record<string, unknown>;
  source_url: string;
  evidence: string;
  observed_at: string;
}

const seeds = import.meta.glob<SeedEntry[]>('../data-apps/*/seed.json', { eager: true, import: 'default' });

for (const app of dataApps) {
  const entries = seeds[`../data-apps/${app.slug}/seed.json`];
  if (!entries) continue;

  describe(`${app.slug} seed`, () => {
    it('validates every record and its provenance', () => {
      const problems = entries.flatMap((entry, index) => {
        const data = validateRecordData(app, entry.data);
        const provenance = validateProvenance(entry);
        return [...(data.ok ? [] : data.errors), ...(provenance.ok ? [] : provenance.errors)].map(
          (error) => `#${index + 1} ${error.field} ${error.message}`,
        );
      });
      expect(problems).toEqual([]);
    });

    it('has one record per identity', () => {
      const keys = entries.map((entry, index) => {
        const data = validateRecordData(app, entry.data);
        return data.ok ? identityKey(app, data.value) : `invalid #${index}`;
      });
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('was checked on or before each deadline', () => {
      const late = entries.filter(
        (entry) => typeof entry.data.deadline === 'string' && entry.observed_at.slice(0, 10) > entry.data.deadline,
      );
      expect(late.map((entry) => entry.data.name)).toEqual([]);
    });
  });
}
