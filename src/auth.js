/**
 * Request-authentication helpers.
 *   - currentUser: resolves the web user from the signed session cookie.
 *   - bridgeFromToken: resolves a paired home bridge from its bearer token.
 * Both return null when unauthenticated; callers 401 on null.
 */
import { verifySession, sha256b64u } from './lib.js';
import { parseCookies } from './http.js';

/**
 * @param {Request} request
 * @param {object} env Worker env (reads SESSION_SECRET).
 * @returns {Promise<{userId: string} | null>}
 */
export async function currentUser(request, env) {
  if (!env.SESSION_SECRET) return null;
  const token = parseCookies(request.headers.get('cookie')).aa_session;
  if (!token) return null;
  const session = await verifySession(env.SESSION_SECRET, token, Date.now() / 1000);
  return session ? { userId: session.userId } : null;
}

/**
 * Resolve a bridge from its `Authorization: Bearer <token>` header. Only the
 * token hash is stored, so we hash the presented token and look it up.
 * @param {Request} request
 * @param {object} env Worker env (reads DB).
 * @returns {Promise<{bridgeId: string, userId: string} | null>}
 */
export async function bridgeFromToken(request, env) {
  if (!env.DB) return null;
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
  if (!m) return null;
  const hash = await sha256b64u(m[1].trim());
  const row = await env.DB.prepare('SELECT id, user_id FROM bridges WHERE token_hash = ?').bind(hash).first();
  return row ? { bridgeId: row.id, userId: row.user_id } : null;
}
