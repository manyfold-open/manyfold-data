// Which Discord invite a data app's top-bar button opens.
import { describe, expect, it } from 'vitest';
import { DISCORD_URL, discordHref } from '../src/app/site';

describe('discordHref', () => {
  it("opens the data app's own channel when it has an invite", () => {
    expect(discordHref('https://discord.gg/AbC123')).toBe('https://discord.gg/AbC123');
  });

  it('falls back to the community invite without one', () => {
    expect(discordHref(null)).toBe(DISCORD_URL);
    expect(discordHref(undefined)).toBe(DISCORD_URL);
    expect(discordHref('')).toBe(DISCORD_URL);
  });
});
