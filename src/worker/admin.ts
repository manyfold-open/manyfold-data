/**
 * The admin gate for /api/admin/*. One secret, ADMIN_PASSWORD, opens it. With no secret
 * set nothing does: a fresh deployment is closed rather than open, the rule tarot
 * settled on. The compare is constant-time, and every admin request is metered per IP
 * so the password cannot be guessed at speed.
 */

import { sha256Hex } from './ids';
import { enforce, MINUTE } from './ratelimit';
import { HttpError, type Env } from './types';

const ADMIN_PER_MINUTE = { limit: 30, windowMs: MINUTE };

/** Constant-time: both sides are hashed first, so neither length nor content leaks. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export async function requireAdmin(env: Env, supplied: string | undefined, ip: string): Promise<void> {
  const secret = (env.ADMIN_PASSWORD ?? '').trim();
  if (!secret) {
    throw new HttpError(
      503,
      'admin_closed',
      'The admin API stays closed until the ADMIN_PASSWORD secret is set: npx wrangler secret put ADMIN_PASSWORD',
    );
  }
  await enforce(env.DB, [{ scope: 'admin', subject: ip, rule: ADMIN_PER_MINUTE }]);
  if (!supplied || !(await safeEqual(supplied, secret))) {
    throw new HttpError(401, 'admin_password_invalid', 'Send the admin password in the x-admin-password header.');
  }
}
