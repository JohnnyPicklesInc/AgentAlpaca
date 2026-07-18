/**
 * Server-side helpers for Agent Alpaca. Runs in the Cloudflare Worker and is
 * also imported by scripts/selftest.mjs under Node, so it uses only standard Web
 * Crypto + TextEncoder + btoa/atob available in both.
 *
 * Responsibilities:
 *   - base64url + HMAC + constant-time compare.
 *   - Stateless signed session cookies (no session table).
 *   - SHA-256 hashing for magic-link tokens, pairing codes, and bridge tokens
 *     (raw secrets are never stored).
 */

const encoder = new TextEncoder();

export const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days, seconds
export const MAGIC_TTL = 60 * 15; // 15 minutes, seconds
export const PAIR_TTL = 60 * 10; // 10 minutes, seconds

/** Encode bytes as unpadded base64url. */
export function b64u(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode a base64url string (padded or not) to bytes. */
export function unb64u(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(keyBytes, msg) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const data = typeof msg === 'string' ? encoder.encode(msg) : msg;
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

/**
 * Constant-time byte-array comparison. The early length-mismatch return leaks
 * only length, which isn't secret here.
 */
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}

/** SHA-256 of a UTF-8 string, as base64url. Keys magic tokens / bridge tokens. */
export async function sha256b64u(str) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(str));
  return b64u(digest);
}

/** Random URL-safe token (default 32 bytes ≈ 43 chars). */
export function randomToken(n = 32) {
  return b64u(crypto.getRandomValues(new Uint8Array(n)));
}

/**
 * A short, human-friendly pairing code like `ALPACA-7F3K`. Uses an
 * unambiguous alphabet (no 0/O/1/I) so it's easy to read aloud / retype.
 */
export function pairingCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const rnd = crypto.getRandomValues(new Uint8Array(6));
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[rnd[i] % alphabet.length];
  return `ALPACA-${s.slice(0, 3)}${s.slice(3)}`;
}

// --- Sessions ----------------------------------------------------------------

/** Mint a stateless signed session token: `userId.exp.HMAC(secret, "userId.exp")`. */
export async function signSession(secret, userId, nowSec, ttl = SESSION_TTL) {
  const exp = Math.floor(nowSec) + ttl;
  const payload = `${userId}.${exp}`;
  const sig = await hmac(encoder.encode(secret), payload);
  return `${payload}.${b64u(sig)}`;
}

/** Verify a session token and return its userId if authentic and unexpired. */
export async function verifySession(secret, token, nowSec) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [userId, expStr, sigB64] = parts;
  const exp = Number(expStr);
  if (!userId || !Number.isInteger(exp)) return null;
  const expected = await hmac(encoder.encode(secret), `${userId}.${exp}`);
  let provided;
  try {
    provided = unb64u(sigB64);
  } catch {
    return null;
  }
  if (!timingSafeEqual(expected, provided)) return null;
  if (Math.floor(nowSec) >= exp) return null;
  return { userId, exp };
}
