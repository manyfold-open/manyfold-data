// The router maps every page's path, including the reserved /settings, to a route.
import { describe, expect, it } from 'vitest';
import { matchRoute } from '../src/app/routes';

describe('matchRoute', () => {
  it('maps the public pages', () => {
    expect(matchRoute('/')).toEqual({ name: 'catalog' });
    expect(matchRoute('/ai-hackathons')).toEqual({ name: 'overview', slug: 'ai-hackathons' });
    expect(matchRoute('/ai-hackathons/table')).toEqual({ name: 'table', slug: 'ai-hackathons' });
    expect(matchRoute('/ai-hackathons/r/rec_1')).toEqual({ name: 'record', slug: 'ai-hackathons', id: 'rec_1' });
    expect(matchRoute('/ai-hackathons/nope')).toEqual({ name: 'not-found' });
    expect(matchRoute('/%E0')).toEqual({ name: 'not-found' });
  });

  it('sends /settings and its sections to the console, before any data app', () => {
    expect(matchRoute('/settings')).toEqual({ name: 'settings', section: 'overview' });
    expect(matchRoute('/settings/')).toEqual({ name: 'settings', section: 'overview' });
    expect(matchRoute('/settings/tokens')).toEqual({ name: 'settings', section: 'tokens' });
    expect(matchRoute('/settings/tokens/extra')).toEqual({ name: 'not-found' });
  });

  it('has a privacy page, which no data app can take over', () => {
    expect(matchRoute('/privacy')).toEqual({ name: 'privacy' });
    expect(matchRoute('/privacy/more')).toEqual({ name: 'not-found' });
  });
});
