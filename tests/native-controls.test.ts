// No browser-default control appears in the reader flow: every select, checkbox, radio,
// date picker and dialog is our own, from src/app/ui/. This scans the page code for the
// native ones, in the reader flow and the admin console alike.
/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';

const sources = import.meta.glob<string>('../src/app/**/*.tsx', { query: '?raw', import: 'default', eager: true });
const EXEMPT = /^\.\.\/src\/app\/ui\//;
// Every native picker counts, not only date: datetime-local, time, month, week, color, range.
const NATIVE = [
  /<select\b/,
  /<dialog\b/,
  /type=["'](checkbox|radio|date|datetime-local|time|month|week|color|range)["']/,
];
const scanned = Object.keys(sources).filter((path) => !EXEMPT.test(path));

describe('native controls', () => {
  it('finds the reader pages to scan', () => {
    expect(scanned).toContain('../src/app/pages/TablePage.tsx');
    expect(scanned).toContain('../src/app/components/FilterPanel.tsx');
    expect(Object.keys(sources)).toContain('../src/app/ui/controls.tsx');
    expect(scanned).toContain('../src/app/settings/TokensSection.tsx');
    expect(scanned.some((path) => EXEMPT.test(path))).toBe(false);
  });

  it('are never used outside src/app/ui/', () => {
    const found: string[] = [];
    for (const path of scanned) {
      sources[path]!.split('\n').forEach((line, index) => {
        for (const pattern of NATIVE) if (pattern.test(line)) found.push(`${path.slice(3)}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });
});
