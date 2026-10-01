/**
 * Worker-side types. `Env` mirrors the bindings in wrangler.jsonc — add a binding
 * there, add it here too.
 */

export interface Env {
  /** Static build output in dist/client. Non-/api/ requests are served from here. */
  ASSETS: Fetcher;
  DB: D1Database;
  /** Opens /api/admin/*. A secret: `npx wrangler secret put ADMIN_PASSWORD`. Unset = closed. */
  ADMIN_PASSWORD?: string;
  /** Encrypts stored Discord webhooks. A secret, 32+ characters. Never rotate it casually. */
  CONFIG_ENCRYPTION_KEY?: string;
  /** The site's own address, for links in messages sent outside a request (the cron). */
  PUBLIC_ORIGIN?: string;
  /** GA4 measurement id. Empty or unset: no analytics is served at all. */
  GA_MEASUREMENT_ID?: string;
}

/** Errors that already know their HTTP shape. Thrown anywhere, mapped in index.ts. */
export class HttpError extends Error {
  // Plain fields rather than constructor parameter properties: keeps the class
  // friendly to toolchains that only strip types.
  readonly status: number;
  readonly code: string;
  /** Extra response headers, such as Retry-After on a 429. */
  readonly headers: Record<string, string>;

  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}
