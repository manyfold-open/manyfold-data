/**
 * A reader's request for data to track, sent from the front page's "Request a data app"
 * card. The form's maxLength values and POST /api/requests share these limits and this
 * check, so they cannot drift apart. Every message is written for the person at the form.
 *
 * This module runs in the browser and the Worker. It imports with explicit .ts extensions
 * and sticks to syntax Node can strip, like the rest of src/shared/.
 */

import { cleanText, type FieldError, type Validated } from './data-app.ts';

export const REQUEST_LIMITS = {
  topicMin: 3,
  topicMax: 120,
  detailsMax: 1000,
  contactMax: 100,
} as const;

export interface NewDataRequest {
  topic: string;
  /** Why it matters, where the data is: optional. */
  details: string | null;
  /** An email or Discord name, for a reply: optional, and posted to Discord with the request. */
  contact: string | null;
}

/** An optional text field: missing, null and blank all mean null. */
function optional(errors: FieldError[], field: string, value: unknown, max: number, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    errors.push({ field, message: `${field} must be text.` });
    return null;
  }
  const text = cleanText(value);
  if (text.length > max) errors.push({ field, message: `Keep the ${name} to ${max.toLocaleString('en-US')} characters or fewer.` });
  return text || null;
}

export function checkDataRequest(input: unknown): Validated<NewDataRequest> {
  const body = (input !== null && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const errors: FieldError[] = [];

  const topic = typeof body.topic === 'string' ? cleanText(body.topic) : '';
  if (topic.length < REQUEST_LIMITS.topicMin || topic.length > REQUEST_LIMITS.topicMax) {
    errors.push({
      field: 'topic',
      message: `Say what you'd like tracked, in ${REQUEST_LIMITS.topicMin} to ${REQUEST_LIMITS.topicMax} characters.`,
    });
  }
  const details = optional(errors, 'details', body.details, REQUEST_LIMITS.detailsMax, 'details');
  const contact = optional(errors, 'contact', body.contact, REQUEST_LIMITS.contactMax, 'email or Discord name');

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { topic, details, contact } };
}
