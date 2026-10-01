/**
 * The browser half of measurement: the visitor's answer to the consent question, and the
 * few moments worth naming. The tag itself is written into the page by the Worker
 * (src/worker/analytics.ts), so everything here does nothing when `gtag` is absent — the
 * normal state of `npm run dev`, of /settings, and of every test.
 *
 * Events carry the data app's slug and nothing a visitor typed:
 *
 *   agent_instruction_copied   an owner copied the sentence that sets their agent to work
 *   skill_opened               someone opened a data app's SKILL.md
 *   data_exported              CSV, JSON or the RSS feed (format)
 *   discord_joined             someone opened the data app's Discord invite
 *   record_reported            a reader sent a report (never its text)
 *
 * Page views need no code: the tag's first page_view, then GA4's history-change page views
 * as the router moves between pages.
 */

export const CONSENT_KEY = 'manyfold-data.consent';

export type Consent = 'granted' | 'denied';

declare global {
  interface Window {
    /** Defined by the tag the Worker adds; absent when nothing is measured. */
    gtag?: (...args: unknown[]) => void;
  }
}

const gtag = (...args: unknown[]): void => {
  if (typeof window.gtag === 'function') window.gtag(...args);
};

/** Whether this page has a Google tag on it at all. */
export const measuring = (): boolean => typeof window.gtag === 'function';

/** The answer this browser gave last time, if it gave one. */
export function storedConsent(): Consent | null {
  try {
    const value = localStorage.getItem(CONSENT_KEY);
    return value === 'granted' || value === 'denied' ? value : null;
  } catch {
    return null; // storage blocked: the visitor is asked again, the honest fallback
  }
}

/** Records an answer and tells the tag at once, even if the browser refuses to store it. */
export function setConsent(choice: Consent): void {
  gtag('consent', 'update', {
    ad_storage: choice,
    ad_user_data: choice,
    ad_personalization: choice,
    analytics_storage: choice,
  });
  try {
    localStorage.setItem(CONSENT_KEY, choice);
  } catch {
    /* see storedConsent */
  }
}

export type AnalyticsEvent =
  | 'agent_instruction_copied'
  | 'skill_opened'
  | 'data_exported'
  | 'discord_joined'
  | 'record_reported';

/** One named moment. Silent when nothing is measuring. */
export const track = (event: AnalyticsEvent, params: { data_app: string; format?: 'csv' | 'json' | 'rss' }): void => {
  gtag('event', event, params);
};
