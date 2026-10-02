// The Google tag: who gets it, what it says before anything else, and the several places it
// must never appear — the admin console, the API, any host but the public one, and every
// deployment without an id.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONSENT_KEY,
  CONSENT_REGIONS,
  analyticsHead,
  consentRequiredFor,
  freshRequest,
  isMeasuredPath,
  isMeasurementId,
  measurementIdFor,
  shouldInject,
  type InjectionContext,
} from '../src/worker/analytics';
import { consentState } from '../src/shared/consent';
import { measuredUrl, TYPED_PARAMS } from '../src/shared/query';
import { app } from '../src/worker/index';
import { createD1 } from './d1';

/** A made-up id in the shape Google issues; never a real property's. */
const ID = 'G-TESTID0000';
const ORIGIN = 'https://data.test';

const html = (status = 200) =>
  new Response('<html><head><title>t</title></head><body></body></html>', {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', etag: '"abc"' },
  });

const injects = (response: Response, context: Partial<Omit<InjectionContext, 'url'>> & { url?: string } = {}): boolean =>
  shouldInject(response, {
    measurementId: ID,
    method: 'GET',
    publicOrigin: ORIGIN,
    ...context,
    url: new URL(context.url ?? `${ORIGIN}/`),
  });

describe('the measurement id', () => {
  it('accepts the shape Google issues and nothing else', () => {
    expect(isMeasurementId('G-TESTID0000')).toBe(true);
    expect(isMeasurementId('UA-12345-1')).toBe(false);
    expect(isMeasurementId('')).toBe(false);
    expect(isMeasurementId(undefined)).toBe(false);
    // The reason the check exists: the value is written into a script.
    expect(isMeasurementId("G-X'});</script><script>alert(1)//")).toBe(false);
  });

  it('reads it off the env, trimmed, or reports that there is none', () => {
    expect(measurementIdFor({ GA_MEASUREMENT_ID: ' g-testid0000 ' })).toBe(ID);
    expect(measurementIdFor({ GA_MEASUREMENT_ID: '' })).toBeNull();
    expect(measurementIdFor({})).toBeNull();
  });
});

describe('who is asked', () => {
  it('asks across the EEA, the UK and Switzerland, and when the country is unknown', () => {
    for (const country of ['DE', 'FR', 'IE', 'GB', 'CH', 'NO']) expect(consentRequiredFor(country)).toBe(true);
    expect(consentRequiredFor(undefined)).toBe(true);
    expect(consentRequiredFor('')).toBe(true);
    expect(CONSENT_REGIONS).toHaveLength(new Set(CONSENT_REGIONS).size);
  });

  it('does not ask where it does not have to', () => {
    for (const country of ['US', 'CN', 'SG', 'JP', 'BR', 'us']) expect(consentRequiredFor(country)).toBe(false);
  });
});

describe('the tag itself', () => {
  const head = analyticsHead(ID);

  it('denies everything in the consent regions before the library or the first hit', () => {
    const defaults = head.indexOf("gtag('consent','default'");
    const config = head.indexOf("gtag('config'");
    const library = head.indexOf('googletagmanager.com/gtag/js');
    expect(defaults).toBeGreaterThan(-1);
    expect(defaults).toBeLessThan(config);
    expect(config).toBeLessThan(library);
    expect(head).toContain("'analytics_storage':'denied'");
    for (const country of CONSENT_REGIONS) expect(head).toContain(`'${country}'`);
  });

  it('replays a stored answer ahead of the first hit', () => {
    expect(head.indexOf(CONSENT_KEY)).toBeGreaterThan(-1);
    expect(head.indexOf(CONSENT_KEY)).toBeLessThan(head.indexOf("gtag('config'"));
  });

  it('measures ads but never grants ad personalization, by default or after a yes', () => {
    expect(head).toContain("'ad_storage':'granted'");
    expect(head).not.toMatch(/ad_personalization['"]:\s*['"]granted/);
    const start = head.indexOf('try{var c=');
    const replay = new Function('localStorage', 'gtag', head.slice(start, head.indexOf('\n', start)));
    const sent: unknown[] = [];
    replay({ getItem: () => 'granted' }, (...args: unknown[]) => sent.push(args));
    expect(sent).toEqual([['consent', 'update', consentState('granted')]]);
  });

  it('leaves the reader\'s search out of the page address, before the first hit', () => {
    const set = head.indexOf("gtag('set',{'page_location'");
    expect(set).toBeGreaterThan(-1);
    expect(set).toBeLessThan(head.indexOf("gtag('config'"));
    expect(head).toContain('["q"].forEach');
    // The inline code does what measuredUrl does.
    const strip = new Function('location', 'gtag', head.slice(head.indexOf('try{var u='), head.indexOf("gtag('config'")));
    const sent: unknown[] = [];
    strip({ href: `${ORIGIN}/ai-hackathons/table?q=jane+doe&format=online&sort=deadline` }, (...args: unknown[]) => sent.push(args));
    expect(sent).toEqual([['set', { page_location: `${ORIGIN}/ai-hackathons/table?format=online&sort=deadline` }]]);
  });

  it('carries the id in both places', () => {
    expect(head).toContain(`gtag('config','${ID}')`);
    expect(head).toContain(`gtag/js?id=${ID}`);
  });
});

describe('which responses are tagged', () => {
  it('tags the public pages', () => {
    for (const path of ['/', '/ai-hackathons', '/ai-hackathons/table', '/ai-hackathons/r/rec_1', '/privacy']) {
      expect(isMeasuredPath(path)).toBe(true);
      expect(injects(html(), { url: `${ORIGIN}${path}` })).toBe(true);
    }
  });

  it('never measures the admin console or the API', () => {
    for (const path of ['/settings', '/settings/tokens', '/api/apps']) {
      expect(isMeasuredPath(path)).toBe(false);
      expect(injects(html(), { url: `${ORIGIN}${path}` })).toBe(false);
    }
  });

  it('serves nothing from Google without an id, or on any other host', () => {
    expect(injects(html(), { measurementId: null })).toBe(false);
    expect(injects(html(), { url: 'http://localhost:5173/' })).toBe(false);
    expect(injects(html(), { url: 'https://manyfold-data.example.workers.dev/' })).toBe(false);
  });

  it('leaves everything that is not a 200 HTML page as it was', () => {
    expect(injects(html(404))).toBe(false);
    expect(injects(html(), { method: 'POST' })).toBe(false);
    expect(injects(new Response('{}', { headers: { 'content-type': 'application/json' } }))).toBe(false);
    expect(injects(new Response('asset'))).toBe(false);
  });

  it('asks the assets binding for a fresh copy, not a 304', () => {
    const request = freshRequest(
      new Request(`${ORIGIN}/`, { headers: { 'if-none-match': '"abc"', 'if-modified-since': 'x', accept: 'text/html' } }),
    );
    expect(request.headers.get('if-none-match')).toBeNull();
    expect(request.headers.get('if-modified-since')).toBeNull();
    expect(request.headers.get('accept')).toBe('text/html');
  });
});

/** Enough of workerd's HTMLRewriter for one `head` append, which is all the Worker uses. */
class FakeRewriter {
  private appends: string[] = [];
  on(selector: string, handler: { element(element: { append(content: string): void }): void }) {
    if (selector === 'head') handler.element({ append: (content) => this.appends.push(content) });
    return this;
  }
  transform(response: Response): Response {
    const appends = this.appends;
    const body = new ReadableStream({
      async start(controller) {
        const text = await response.text();
        controller.enqueue(new TextEncoder().encode(text.replace('</head>', `${appends.join('')}</head>`)));
        controller.close();
      },
    });
    return new Response(body, { status: response.status, headers: response.headers });
  }
}

describe('the Worker', () => {
  let seen: Request[];
  let env: { DB: D1Database; ASSETS: Fetcher; PUBLIC_ORIGIN: string; GA_MEASUREMENT_ID?: string };

  beforeEach(() => {
    seen = [];
    env = {
      DB: createD1(),
      ASSETS: {
        fetch: async (request: Request) => {
          seen.push(request);
          return html();
        },
      } as unknown as Fetcher,
      PUBLIC_ORIGIN: ORIGIN,
      GA_MEASUREMENT_ID: ID,
    };
    vi.stubGlobal('HTMLRewriter', FakeRewriter);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const page = (url: string, headers: Record<string, string> = {}) => app.request(url, { headers }, env);

  it('adds the tag to a page, fetched fresh and without the untagged file’s validators', async () => {
    const response = await page(`${ORIGIN}/ai-hackathons`, { 'if-none-match': '"abc"' });
    const text = await response.text();
    expect(text).toContain(`gtag('config','${ID}')`);
    expect(text.indexOf('gtag/js')).toBeLessThan(text.indexOf('</head>'));
    expect(response.headers.get('etag')).toBeNull();
    expect(seen[0]!.headers.get('if-none-match')).toBeNull();
  });

  it('serves /settings, localhost and an id-less deployment untouched', async () => {
    expect(await (await page(`${ORIGIN}/settings/tokens`)).text()).not.toContain('gtag');
    expect(await (await page('http://localhost:5173/')).text()).not.toContain('gtag');
    env.GA_MEASUREMENT_ID = '';
    expect(await (await page(`${ORIGIN}/`)).text()).not.toContain('gtag');
  });

  it('tells the page whether to ask, by country, and never caches the answer', async () => {
    const ask = async (headers: Record<string, string>) => {
      const response = await app.request(`${ORIGIN}/api/consent`, { headers }, env);
      expect(response.headers.get('cache-control')).toBe('no-store');
      return ((await response.json()) as { required: boolean }).required;
    };
    expect(await ask({ 'cf-ipcountry': 'DE' })).toBe(true);
    expect(await ask({ 'cf-ipcountry': 'US' })).toBe(false);
    expect(await ask({})).toBe(true);
    env.GA_MEASUREMENT_ID = '';
    expect(await ask({ 'cf-ipcountry': 'DE' })).toBe(false);
  });
});

describe('what an answer sets', () => {
  it('covers analytics and ad measurement, and never grants ad personalization', () => {
    expect(consentState('granted')).toEqual({
      ad_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'denied',
      analytics_storage: 'granted',
    });
    expect(consentState('denied')).toEqual({
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'denied',
    });
  });
});

describe('the address analytics sees', () => {
  it('drops the search text and keeps every filter', () => {
    expect(TYPED_PARAMS).toEqual(['q']);
    expect(measuredUrl(`${ORIGIN}/ai-fundraising/table?q=openai&stage=seed&sort=-announced_on`)).toBe(
      `${ORIGIN}/ai-fundraising/table?stage=seed&sort=-announced_on`,
    );
    expect(measuredUrl(`${ORIGIN}/ai-fundraising/table?q=a%20b`)).toBe(`${ORIGIN}/ai-fundraising/table`);
    expect(measuredUrl(`${ORIGIN}/ai-hackathons`)).toBe(`${ORIGIN}/ai-hackathons`);
  });
});
