// Contrast checks for the color tokens in src/app/styles.css, in light and dark: text
// tokens need 4.5:1 on every surface they sit on, chart marks 3:1 (WCAG 2.2, 1.4.3 and
// 1.4.11). The test reads the stylesheet itself, so a token change cannot skip it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/app/styles.css', import.meta.url), 'utf8');

/** The `--name: #hex` pairs of the block after a marker comment. */
function tokens(marker: string): Record<string, string> {
  const start = css.indexOf(marker);
  if (start < 0) throw new Error(`no ${marker} block in styles.css`);
  const block = css.slice(start, css.indexOf('}', css.indexOf('{', start)));
  return Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
}

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

const ratio = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const THEMES = {
  light: tokens('/* theme: light */'),
  'dark (system)': tokens('/* theme: dark (system) */'),
  'dark (chosen)': tokens('/* theme: dark (chosen) */'),
};

describe('color tokens', () => {
  it('define the same colors for the system dark theme and the chosen one', () => {
    expect(THEMES['dark (system)']).toEqual(THEMES['dark (chosen)']);
  });

  for (const [name, t] of Object.entries(THEMES)) {
    describe(name, () => {
      const surfaces = ['bg', 'hover', 'chip'] as const;

      it.each(['ink', 'ink2', 'muted', 'accent-ink', 'up', 'warn'])('text %s reads at 4.5:1 on every surface', (text) => {
        for (const surface of surfaces) expect(ratio(t[text]!, t[surface]!), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      });

      it('chart marks stand out at 3:1 from the page and from empty tracks', () => {
        expect(ratio(t.accent!, t.bg!)).toBeGreaterThanOrEqual(3);
        expect(ratio(t.accent!, t.chip!)).toBeGreaterThanOrEqual(3);
      });

      it('button text reads at 4.5:1 on the primary button', () => {
        expect(ratio(t['on-btn']!, t.btn!)).toBeGreaterThanOrEqual(4.5);
        expect(ratio(t['on-btn']!, t['btn-h']!)).toBeGreaterThanOrEqual(4.5);
      });

      it('selected pills (page color on ink) read at 4.5:1', () => {
        expect(ratio(t.bg!, t.ink!)).toBeGreaterThanOrEqual(4.5);
      });
    });
  }
});
