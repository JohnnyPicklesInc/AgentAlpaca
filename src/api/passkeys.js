/**
 * Passkeys (WebAuthn). Registration requires an existing signed-in session
 * (you add a passkey to your account after signing in with Google). Sign-in is
 * usernameless/discoverable: the authenticator reveals which account to use.
 *
 *   POST /api/passkeys/register/start   (auth)  -> creation options
 *   POST /api/passkeys/register/finish  (auth)  -> stores the credential
 *   POST /api/passkeys/auth/start               -> request options (+ challenge cookie)
 *   POST /api/passkeys/auth/finish              -> verifies, sets session
 *   GET  /api/passkeys                  (auth)  -> list
 *   POST /api/passkeys/delete           (auth)  -> remove one
 *
 * Verification is delegated to @simplewebauthn/server (Web Crypto based, runs in
 * the Worker). Only the credential public key + counter are stored.
 */
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { json, sessionCookie, isHttps, parseCookies } from '../http.js';
import { b64u, unb64u, signSession, randomToken, SESSION_TTL } from '../lib.js';
import { currentUser } from '../auth.js';

const CHALLENGE_TTL = 300; // seconds

/** Relying-party identity, derived from the configured base URL. */
function rp(env) {
  const base = (env.OAUTH_BASE_URL || 'http://127.0.0.1:8796').replace(/\/$/, '');
  return { origin: base, rpID: new URL(base).hostname, rpName: 'Agent Alpaca' };
}

/** Set-Cookie for a short-lived challenge id (name varies by flow). */
function challengeCookie(name, id, secure) {
  return `${name}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${CHALLENGE_TTL}${secure ? '; Secure' : ''}`;
}
function clearChallengeCookie(name, secure) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}
const wacCookie = (id, secure) => challengeCookie('aa_wac', id, secure);
const clearWacCookie = (secure) => clearChallengeCookie('aa_wac', secure);

// --- registration (signed-in user adds a passkey) --------------------------

export async function registerStart({ request, env }) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'not signed in' }, 401);
  const { rpID, rpName } = rp(env);

  const row = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(user.userId).first();
  const { results } = await env.DB.prepare('SELECT id, transports FROM credentials WHERE user_id = ?')
    .bind(user.userId)
    .all();

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: row?.email || 'user',
    userID: new TextEncoder().encode(user.userId),
    attestationType: 'none',
    excludeCredentials: (results || []).map((c) => ({ id: c.id, transports: safeJson(c.transports) })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });

  await env.TOKENS_KV.put(`wac:reg:${user.userId}`, options.challenge, { expirationTtl: CHALLENGE_TTL });
  return json(options);
}

export async function registerFinish({ request, env }) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'not signed in' }, 401);
  const { origin, rpID } = rp(env);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  const key = `wac:reg:${user.userId}`;
  const expectedChallenge = await env.TOKENS_KV.get(key);
  if (!expectedChallenge) return json({ error: 'challenge expired, try again' }, 400);
  await env.TOKENS_KV.delete(key);

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });
  } catch (e) {
    return json({ error: `passkey registration failed: ${e.message}` }, 400);
  }
  if (!verification.verified || !verification.registrationInfo) {
    return json({ error: 'passkey could not be verified' }, 400);
  }

  const cred = verification.registrationInfo.credential;
  await env.DB.prepare(
    `INSERT INTO credentials (id, user_id, public_key, counter, transports, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET public_key = excluded.public_key, counter = excluded.counter`,
  )
    .bind(
      cred.id,
      user.userId,
      b64u(cred.publicKey),
      cred.counter || 0,
      JSON.stringify(cred.transports || body?.response?.transports || []),
      labelFor(body),
      Math.floor(Date.now() / 1000),
    )
    .run();

  return json({ ok: true });
}

// --- passkey-only account creation (no prior sign-in) ----------------------

export async function signupStart({ request, env }) {
  const { rpID, rpName } = rp(env);
  let body = {};
  try {
    body = await request.json();
  } catch {}
  const displayName = String(body?.name || '').trim().slice(0, 60) || 'Agent Alpaca';
  const userId = crypto.randomUUID();

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: displayName,
    userDisplayName: displayName,
    userID: new TextEncoder().encode(userId),
    attestationType: 'none',
    // Discoverable (resident) key required so they can later sign in with just
    // the passkey, no username.
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });

  const cid = randomToken(16);
  await env.TOKENS_KV.put(`wac:su:${cid}`, JSON.stringify({ challenge: options.challenge, userId }), {
    expirationTtl: CHALLENGE_TTL,
  });
  return json(options, 200, { 'set-cookie': challengeCookie('aa_su', cid, isHttps(request)) });
}

export async function signupFinish({ request, env }) {
  const { origin, rpID } = rp(env);
  const secure = isHttps(request);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  const cid = parseCookies(request.headers.get('cookie')).aa_su;
  if (!cid) return json({ error: 'missing challenge' }, 400);
  const rec = await env.TOKENS_KV.get(`wac:su:${cid}`, 'json');
  if (!rec) return json({ error: 'challenge expired, try again' }, 400);
  await env.TOKENS_KV.delete(`wac:su:${cid}`);

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge: rec.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });
  } catch (e) {
    return json({ error: `passkey signup failed: ${e.message}` }, 400, { 'set-cookie': clearChallengeCookie('aa_su', secure) });
  }
  if (!verification.verified || !verification.registrationInfo) {
    return json({ error: 'passkey could not be verified' }, 400, { 'set-cookie': clearChallengeCookie('aa_su', secure) });
  }

  const cred = verification.registrationInfo.credential;
  const now = Math.floor(Date.now() / 1000);
  // New account with a synthetic, never-collides email placeholder.
  await env.DB.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)')
    .bind(rec.userId, `${rec.userId}@passkey.local`, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO credentials (id, user_id, public_key, counter, transports, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      cred.id,
      rec.userId,
      b64u(cred.publicKey),
      cred.counter || 0,
      JSON.stringify(cred.transports || body?.response?.transports || []),
      labelFor(body),
      now,
    )
    .run();

  const session = await signSession(env.SESSION_SECRET, rec.userId, Date.now() / 1000);
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(session, SESSION_TTL, secure) });
}

// --- authentication (usernameless sign-in) ---------------------------------

export async function authStart({ request, env }) {
  const { rpID } = rp(env);
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });

  const id = randomToken(16);
  await env.TOKENS_KV.put(`wac:auth:${id}`, options.challenge, { expirationTtl: CHALLENGE_TTL });
  return json(options, 200, { 'set-cookie': wacCookie(id, isHttps(request)) });
}

export async function authFinish({ request, env }) {
  const { origin, rpID } = rp(env);
  const secure = isHttps(request);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  const wacId = parseCookies(request.headers.get('cookie')).aa_wac;
  if (!wacId) return json({ error: 'missing challenge' }, 400);
  const expectedChallenge = await env.TOKENS_KV.get(`wac:auth:${wacId}`);
  if (!expectedChallenge) return json({ error: 'challenge expired, try again' }, 400);
  await env.TOKENS_KV.delete(`wac:auth:${wacId}`);

  const row = await env.DB.prepare('SELECT * FROM credentials WHERE id = ?').bind(String(body?.id || '')).first();
  if (!row) return json({ error: 'unknown passkey' }, 400, { 'set-cookie': clearWacCookie(secure) });

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: row.id,
        publicKey: unb64u(row.public_key),
        counter: row.counter,
        transports: safeJson(row.transports),
      },
    });
  } catch (e) {
    return json({ error: `passkey sign-in failed: ${e.message}` }, 400, { 'set-cookie': clearWacCookie(secure) });
  }
  if (!verification.verified) return json({ error: 'passkey could not be verified' }, 400, { 'set-cookie': clearWacCookie(secure) });

  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('UPDATE credentials SET counter = ?, last_used = ? WHERE id = ?')
    .bind(verification.authenticationInfo.newCounter, now, row.id)
    .run();

  // The challenge cookie is already consumed (deleted from KV); it expires on
  // its own, so we only need to set the session cookie here.
  const session = await signSession(env.SESSION_SECRET, row.user_id, Date.now() / 1000);
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(session, SESSION_TTL, secure) });
}

// --- management ------------------------------------------------------------

export async function list({ request, env }) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'not signed in' }, 401);
  const { results } = await env.DB.prepare(
    'SELECT id, label, created_at, last_used FROM credentials WHERE user_id = ? ORDER BY created_at DESC',
  )
    .bind(user.userId)
    .all();
  return json({ passkeys: results || [] });
}

export async function remove({ request, env }) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'not signed in' }, 401);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  await env.DB.prepare('DELETE FROM credentials WHERE id = ? AND user_id = ?')
    .bind(String(body?.id || ''), user.userId)
    .run();
  return json({ ok: true });
}

function safeJson(s) {
  try {
    return JSON.parse(s) || [];
  } catch {
    return [];
  }
}

/** A friendly label from the authenticator attachment, best-effort. */
function labelFor(body) {
  const t = body?.response?.transports || [];
  if (t.includes('internal')) return 'This device';
  if (t.includes('hybrid')) return 'Phone / QR';
  if (t.includes('usb') || t.includes('nfc')) return 'Security key';
  return 'Passkey';
}
