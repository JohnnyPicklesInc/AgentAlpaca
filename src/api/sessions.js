/**
 * The terminal-session registry. The bridge registers a session when it starts
 * wrapping a command; the web app lists the signed-in user's sessions to pick
 * one to watch. Live bytes never touch this table — see AlpacaSession.
 */
import { json } from '../http.js';
import { currentUser, bridgeFromToken } from '../auth.js';

/** POST /api/sessions  { label, cmd, cols, rows }  (bridge, bearer)  ->  { id } */
export async function register({ request, env }) {
  const bridge = await bridgeFromToken(request, env);
  if (!bridge) return json({ error: 'unauthorized bridge' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const label = String(body?.label || 'terminal').slice(0, 120);
  const cmd = String(body?.cmd || '').slice(0, 300);
  const cols = Number.isInteger(body?.cols) ? body.cols : 80;
  const rows = Number.isInteger(body?.rows) ? body.rows : 24;

  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, bridge_id, label, cmd, cols, rows, created_at, last_seen, bridge_online, closed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
  )
    .bind(id, bridge.userId, bridge.bridgeId, label, cmd, cols, rows, now, now)
    .run();
  await env.DB.prepare('UPDATE bridges SET last_seen = ? WHERE id = ?').bind(now, bridge.bridgeId).run();

  return json({ id });
}

/** POST /api/sessions/close  { id }  (bridge, bearer)  ->  { ok: true } */
export async function close({ request, env }) {
  const bridge = await bridgeFromToken(request, env);
  if (!bridge) return json({ error: 'unauthorized bridge' }, 401);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  await env.DB.prepare('UPDATE sessions SET closed = 1, bridge_online = 0, last_seen = ? WHERE id = ? AND user_id = ?')
    .bind(Math.floor(Date.now() / 1000), String(body?.id || ''), bridge.userId)
    .run();
  return json({ ok: true });
}

/** GET /api/sessions  (web, auth)  ->  { sessions: [...] } */
export async function list({ request, env }) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'not signed in' }, 401);
  const { results } = await env.DB.prepare(
    `SELECT id, label, cmd, cols, rows, created_at, last_seen, bridge_online, closed
       FROM sessions WHERE user_id = ? AND closed = 0
       ORDER BY bridge_online DESC, last_seen DESC LIMIT 100`,
  )
    .bind(user.userId)
    .all();
  return json({ sessions: results || [] });
}
