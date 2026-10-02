/**
 * Google Analytics 4, written into each public page by the Worker on its way out.
 *
 * The same design as manyfold-tarot, for the same reasons:
 *
 * - **Consent comes before the tag.** The consent defaults go onto dataLayer in an inline
 *   script that runs before gtag.js is fetched. In the EEA, the UK and Switzerland every
 *   storage type starts `denied`; everywhere else it starts `granted`. Google's own
 *   `region` parameter makes that split, so the HTML is the same for every visitor and the
 *   consent state never depends on a geo lookup being right. A choice the visitor already
 *   made is replayed before the first hit.
 * - **Ads are measured, never personalized.** The GA4 property is linked to Google Ads, which
 *   counts the key events that follow an ad click. One answer covers analytics and that
 *   measurement (`analytics_storage`, `ad_storage`, `ad_user_data`); `ad_personalization`
 *   stays denied for everyone, whatever they answer.
 * - **The id is validated before it is interpolated.** It lands inside a `<script>`.
 * - **Nothing a reader typed reaches Google.** Page views carry `page_location` with the
 *   Table's search (`?q=`) removed, here for the first hit and in src/app/router.tsx for the
 *   rest.
 * - **The admin console is never measured**, and neither is any host but the public one:
 *   `npm run dev` on localhost serves no tag even with the real id configured.
 *
 * What the Worker does decide per visitor is whether to show a banner; that rides on
 * GET /api/consent (see consentRequiredFor). A wrong guess there shows or hides a banner,
 * it does not store a cookie.
 */

import { consentState } from '../shared/consent';
import { TYPED_PARAMS } from '../shared/query';

/**
 * Where a visitor has to opt in before anything is stored: the EEA (EU 27 plus Iceland,
 * Liechtenstein and Norway), the UK and Switzerland — the list Google publishes for
 * Consent Mode.
 */
export const CONSENT_REGIONS = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'IS', 'LI', 'NO',
  'GB', 'CH',
] as const;

/** Where the visitor's own answer is kept. Read by the tag before its first hit, written
 *  by the banner and the privacy page. Storing a consent decision needs no consent. */
export const CONSENT_KEY = 'manyfold-data.consent';

/** GA4 measurement ids look like `G-XXXXXXXXXX`, and nothing else goes in. */
const MEASUREMENT_ID = /^G-[A-Z0-9]{4,24}$/;

export const isMeasurementId = (value: string | undefined | null): value is string =>
  typeof value === 'string' && MEASUREMENT_ID.test(value.trim().toUpperCase());

/** The id this deployment measures with, or null if it measures nothing. */
export const measurementIdFor = (env: { GA_MEASUREMENT_ID?: string }): string | null => {
  const raw = env.GA_MEASUREMENT_ID?.trim().toUpperCase();
  return isMeasurementId(raw) ? raw : null;
};

/**
 * Whether this visitor is owed a banner before anything is stored. An unknown country
 * (local dev, tests, an odd proxy) means yes: asking someone who did not need asking is the
 * cheap way to be wrong.
 */
export const consentRequiredFor = (country: string | null | undefined): boolean => {
  if (!country) return true;
  return (CONSENT_REGIONS as readonly string[]).includes(country.trim().toUpperCase());
};

/** The console is the admin's own room, and the API has no pages. Neither is measured. */
export const isMeasuredPath = (pathname: string): boolean =>
  !/^\/(settings|api)(\/|$)/.test(pathname);

const GRANTED = JSON.stringify(consentState('granted'));
const DENIED = JSON.stringify(consentState('denied'));

/**
 * The two script tags that go into `<head>`, in this order: an inline block (consent
 * defaults, then the visitor's stored choice, then `config`), and gtag.js itself, async.
 * The inline block runs first, so by the time the library loads dataLayer already says
 * what it is allowed to do.
 */
export function analyticsHead(measurementId: string): string {
  const id = measurementId.toUpperCase();
  const regions = CONSENT_REGIONS.map((code) => `'${code}'`).join(',');
  const inline = [
    'window.dataLayer=window.dataLayer||[];',
    'function gtag(){dataLayer.push(arguments);}',
    // Google resolves the region-specific default over the catch-all, whatever the order.
    `gtag('consent','default',{'ad_storage':'denied','ad_user_data':'denied','ad_personalization':'denied','analytics_storage':'denied','functionality_storage':'granted','security_storage':'granted','wait_for_update':500,'region':[${regions}]});`,
    "gtag('consent','default',{'ad_storage':'granted','ad_user_data':'granted','ad_personalization':'denied','analytics_storage':'granted','functionality_storage':'granted','security_storage':'granted'});",
    // A choice already made outranks both defaults, and must be in place before `config`
    // sends the first page_view.
    `try{var c=localStorage.getItem('${CONSENT_KEY}');if(c==='granted')gtag('consent','update',${GRANTED});else if(c==='denied')gtag('consent','update',${DENIED});}catch(e){}`,
    "gtag('js',new Date());",
    // The page's address without what the reader typed (TYPED_PARAMS: the Table's search).
    // `set` holds for every later hit; the router sets it again on each navigation.
    `try{var u=new URL(location.href);${JSON.stringify(TYPED_PARAMS)}.forEach(function(p){u.searchParams.delete(p)});gtag('set',{'page_location':u.toString()});}catch(e){}`,
    `gtag('config','${id}');`,
  ].join('\n');
  return (
    '\n<!-- Google tag (gtag.js), added by the Worker: see src/worker/analytics.ts -->\n' +
    `<script>\n${inline}\n</script>\n` +
    `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>\n`
  );
}

export interface InjectionContext {
  measurementId: string | null;
  method: string;
  /** The request's URL. */
  url: URL;
  /** The deployment's public origin; pages served on any other host are not measured. */
  publicOrigin: string | undefined;
}

/** Whether a request is for a page that will carry the tag, decided before it is fetched. */
export function wantsTag({ measurementId, method, url, publicOrigin }: InjectionContext): boolean {
  if (!measurementId) return false;
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (!isMeasuredPath(url.pathname)) return false;
  if (publicOrigin) {
    try {
      if (new URL(publicOrigin).host !== url.host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Whether this response gets the tag: only a 200 HTML document on a page that wants it.
 * Split from the rewrite so it can be tested in Node, where HTMLRewriter does not exist.
 */
export function shouldInject(response: Response, context: InjectionContext): boolean {
  if (!wantsTag(context)) return false;
  if (response.status !== 200) return false;
  return (response.headers.get('content-type') ?? '').toLowerCase().includes('text/html');
}

/**
 * The request to send the assets binding for a tagged page: without validators, so a
 * browser's copy of the untagged page (or one tagged with an older id) is never answered
 * with a 304 and kept.
 */
export function freshRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete('if-none-match');
  headers.delete('if-modified-since');
  return new Request(request, { headers });
}

/** Puts the tag in the page, if there is a tag and this is a page. */
export function withAnalytics(response: Response, context: InjectionContext): Response {
  if (!shouldInject(response, context)) return response;
  const tagged = new HTMLRewriter()
    .on('head', {
      element(element) {
        element.append(analyticsHead(context.measurementId as string), { html: true });
      },
    })
    .transform(response);
  // The asset's validators describe the untagged file, not this body.
  const headers = new Headers(tagged.headers);
  headers.delete('etag');
  headers.delete('last-modified');
  return new Response(tagged.body, { status: tagged.status, statusText: tagged.statusText, headers });
}
