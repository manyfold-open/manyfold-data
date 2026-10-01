/**
 * Encryption at rest for the one credential this app stores: each data app's Discord
 * webhook URL, which lets anyone holding it post to the channel. AES-GCM, with the key
 * derived by SHA-256 from the CONFIG_ENCRYPTION_KEY secret (32 characters or more).
 *
 * The secret is required, unlike the starter's generated fallback: this deployment is
 * ours, so there is no reason to keep the key beside the ciphertext. Changing the secret
 * makes stored webhooks unreadable — enter them again in /settings.
 */

import { HttpError, type Env } from './types';

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface Sealed {
  ciphertext: string;
  iv: string;
}

const toB64 = (bytes: Uint8Array): string => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
const fromB64 = (value: string): Uint8Array => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

const keys = new Map<string, Promise<CryptoKey>>();

function aesKey(env: Env): Promise<CryptoKey> {
  const material = (env.CONFIG_ENCRYPTION_KEY ?? '').trim();
  if (material.length < 32) {
    throw new HttpError(
      503,
      'not_configured',
      'Set the CONFIG_ENCRYPTION_KEY secret (32 characters or more) to store webhooks: npx wrangler secret put CONFIG_ENCRYPTION_KEY',
    );
  }
  let key = keys.get(material);
  if (!key) {
    key = crypto.subtle
      .digest('SHA-256', enc.encode(material))
      .then((digest) => crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']));
    keys.set(material, key);
  }
  return key;
}

export async function seal(env: Env, plaintext: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const buffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), enc.encode(plaintext));
  return { ciphertext: toB64(new Uint8Array(buffer)), iv: toB64(iv) };
}

export async function unseal(env: Env, sealed: Sealed): Promise<string> {
  try {
    const buffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(sealed.iv) }, await aesKey(env), fromB64(sealed.ciphertext));
    return dec.decode(buffer);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(409, 'unreadable_secret', 'A stored webhook can no longer be read: the encryption key changed. Enter it again.');
  }
}
