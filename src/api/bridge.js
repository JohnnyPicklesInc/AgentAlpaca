/**
 * Bridge pairing. A bridge is a home machine authorized to stream terminals into
 * an account. Pairing avoids typing credentials into a CLI:
 *
 *   1. web (signed in):  POST /api/bridge/pair-code  -> { code }   (shown on screen)
 *   2. home cli:         POST /api/bridge/claim { code, label } -> { token, userId }
 *
 * The pairing code lives in KV for 10 minutes and maps to the requesting user.
 * Claiming it mints a long-lived bridge token; only its hash is stored.
 */
import { json } from '../http.js';
import { currentUser } from '../auth.js';
import { randomToken, sha256b64u, pairingCode, PAIR_TTL } from '../lib.js';

/** POST /api/bridge/pair-code  (web, auth)  ->  { code, expiresIn } */
export async function pairCode({ request, env }) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'not signed in' }, 401);
  if (!env.TOKENS_KV) return json({ error: 'server misconfigured' }, 500);

  const code = pairingCode();
  await env.TOKENS_KV.put(`pair:${code}`, JSON.stringify({ userId: user.userId }), { expirationTtl: PAIR_TTL });
  return json({ code, expiresIn: PAIR_TTL });
}

/** POST /api/bridge/claim  { code, label }  (cli, no cookie)  ->  { token, userId } */
export async function claim({ request, env }) {
  if (!env.TOKENS_KV || !env.DB) return json({ error: 'server misconfigured' }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  const code = String(body?.code || '').trim().toUpperCase();
  const label = String(body?.label || 'home').slice(0, 80);
  if (!code) return json({ error: 'missing pairing code' }, 400);

  const kvKey = `pair:${code}`;
  const record = await env.TOKENS_KV.get(kvKey, 'json');
  if (!record) return json({ error: 'invalid or expired pairing code' }, 400);
  await env.TOKENS_KV.delete(kvKey); // single-use

  const token = randomToken(32);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO bridges (id, user_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(id, record.userId, await sha256b64u(token), label, Math.floor(Date.now() / 1000))
    .run();

  return json({ token, userId: record.userId, bridgeId: id, label });
}

/** GET /api/bridges  (web, auth)  ->  { bridges: [...] } */
export async function list({ request, env }) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'not signed in' }, 401);
  const { results } = await env.DB.prepare(
    'SELECT id, label, created_at, last_seen FROM bridges WHERE user_id = ? ORDER BY created_at DESC',
  )
    .bind(user.userId)
    .all();
  return json({ bridges: results || [] });
}

/** POST /api/bridge/revoke  { id }  (web, auth)  ->  { ok: true } */
export async function revoke({ request, env }) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'not signed in' }, 401);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  const id = String(body?.id || '');
  await env.DB.prepare('DELETE FROM bridges WHERE id = ? AND user_id = ?').bind(id, user.userId).run();
  return json({ ok: true });
}
