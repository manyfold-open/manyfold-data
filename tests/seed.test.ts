/// <reference types="vite/client" />
// Every seed file must load: valid against its config, one record per identity, and
// inside the data app's accepted ranges on the day each record was checked.
import { describe, expect, it } from 'vitest';
import { dataApps } from '../data-apps/index';
import { checkAccept, identityKey, validateProvenance, validateRecordData } from '../src/shared/data-app';

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

    it('was inside the accepted ranges on the day it was checked', () => {
      const outside = entries.flatMap((entry, index) => {
        const data = validateRecordData(app, entry.data);
        if (!data.ok) return [];
        return checkAccept(app, data.value, entry.observed_at.slice(0, 10)).map(
          (error) => `#${index + 1} ${error.field} ${error.message}`,
        );
      });
      expect(outside).toEqual([]);
    });
  });
}
