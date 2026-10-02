/**
 * What a visitor's answer to the consent question sets, in Google Consent Mode's terms. One
 * answer covers analytics and ad measurement; ad personalization is never granted, whatever
 * the answer (AGENTS.md invariant 17). The Worker replays a stored answer with it before the
 * first hit (src/worker/analytics.ts); the banner and /privacy send it when a visitor answers
 * (src/app/analytics.ts).
 */

export type ConsentChoice = 'granted' | 'denied';

export const consentState = (choice: ConsentChoice) => ({
  ad_storage: choice,
  ad_user_data: choice,
  ad_personalization: 'denied' as const,
  analytics_storage: choice,
});
