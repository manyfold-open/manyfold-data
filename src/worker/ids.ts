/** Ids, secrets and hashes, from Web Crypto only, so this runs in workerd and in Node tests. */

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

let lastTime = -1;
let lastRandom: number[] = [];

/**
 * A sortable id: prefix, then 10 characters of time and 16 of randomness (the ULID
 * layout). Ids made in the same millisecond count up from the previous one instead of
 * drawing new randomness, so they still sort in the order they were made — a batch of
 * records keeps its submission order.
 */
export function newId(prefix: string, nowMs: number = Date.now()): string {
  let time = '';
  for (let rest = nowMs, i = 0; i < 10; i += 1, rest = Math.floor(rest / 32)) {
    time = CROCKFORD[rest % 32] + time;
  }
  if (nowMs === lastTime) {
    let i = lastRandom.length - 1;
    while (i >= 0 && lastRandom[i] === 31) lastRandom[i--] = 0;
    if (i >= 0) lastRandom[i]! += 1;
  } else {
    // 256 is a multiple of 32, so taking each byte modulo 32 has no bias.
    lastRandom = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte % 32);
    lastTime = nowMs;
  }
  return `${prefix}_${time}${lastRandom.map((digit) => CROCKFORD[digit]).join('')}`;
}

/** A token secret: `mfd_` and 32 random base62 characters, about 190 bits. */
export function newSecret(): string {
  const out: string[] = [];
  while (out.length < 32) {
    // Bytes from 248 up are skipped, so each of the 62 characters is equally likely.
    for (const byte of crypto.getRandomValues(new Uint8Array(48))) {
      if (byte < 248 && out.length < 32) out.push(BASE62[byte % 62]!);
    }
  }
  return `mfd_${out.join('')}`;
}

/** The shape of a token secret, checked before any lookup. */
export const SECRET = /^mfd_[0-9A-Za-z]{32}$/;

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
