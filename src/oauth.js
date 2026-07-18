/**
 * OAuth / OIDC helpers. Currently: Google Sign-In via the authorization-code
 * flow. Verifies the returned id_token (an RS256 JWT) against Google's published
 * keys, entirely with Web Crypto — no third-party auth service, no email.
 *
 * Account model: every account is keyed on a verified email (users.email is
 * UNIQUE), so Google, magic-link, and future methods (passkeys) all converge on
 * the same user. See src/api/oauth.js for the request handlers.
 */
import { b64u, unb64u } from './lib.js';

const dec = new TextDecoder();
const jwksCache = new Map(); // url -> { keys, fetchedAt }
const JWKS_TTL_MS = 60 * 60 * 1000; // Google rotates keys; cache for an hour

/** Decode a base64url JWT segment to an object. */
function decodeSegment(seg) {
  return JSON.parse(dec.decode(unb64u(seg)));
}

/** Fetch (and cache) a JWKS document. */
async function getJwks(url) {
  const hit = jwksCache.get(url);
  if (hit && Date.now() - hit.fetchedAt < JWKS_TTL_MS) return hit.keys;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`);
  const doc = await res.json();
  jwksCache.set(url, { keys: doc.keys || [], fetchedAt: Date.now() });
  return doc.keys || [];
}

/**
 * Verify an RS256 JWT against a JWKS, checking signature, aud, iss and exp.
 * @returns {Promise<object>} the verified payload.
 */
export async function verifyRs256(jwt, { jwksUrl, aud, issuers, nowSec = Date.now() / 1000 }) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) throw new Error('malformed jwt');
  const header = decodeSegment(parts[0]);
  const payload = decodeSegment(parts[1]);
  if (header.alg !== 'RS256') throw new Error(`unexpected alg: ${header.alg}`);

  const keys = await getJwks(jwksUrl);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('signing key not found');

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64u(parts[2]), signed);
  if (!ok) throw new Error('bad signature');

  if (aud && payload.aud !== aud) throw new Error('aud mismatch');
  const iss = Array.isArray(issuers) ? issuers : [issuers];
  if (issuers && !iss.includes(payload.iss)) throw new Error('iss mismatch');
  if (payload.exp && Math.floor(nowSec) >= payload.exp) throw new Error('token expired');
  return payload;
}

// --- Google ----------------------------------------------------------------

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/** Build the Google consent-screen URL to redirect the user to. */
export function googleAuthUrl({ clientId, redirectUri, state, nonce }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    prompt: 'select_account',
    access_type: 'online',
  });
  return `${GOOGLE_AUTH}?${q}`;
}

/** Exchange an authorization code for tokens, then verify the id_token. */
export async function googleExchange({ clientId, clientSecret, code, redirectUri, nonce }) {
  const res = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`token exchange ${res.status}: ${body.slice(0, 300)}`);
  }
  const tokens = await res.json();
  if (!tokens.id_token) throw new Error('no id_token in response');

  const payload = await verifyRs256(tokens.id_token, {
    jwksUrl: GOOGLE_JWKS,
    aud: clientId,
    issuers: GOOGLE_ISSUERS,
  });
  if (nonce && payload.nonce !== nonce) throw new Error('nonce mismatch');
  if (!payload.email || payload.email_verified === false) throw new Error('email not verified');
  return { email: String(payload.email).toLowerCase(), name: payload.name, sub: payload.sub };
}

/** base64url random state/nonce. */
export function randomState() {
  return b64u(crypto.getRandomValues(new Uint8Array(16)));
}
