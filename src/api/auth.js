/**
 * Session-related endpoints. Sign-in itself is handled by Google OAuth (see
 * api/oauth.js); this module just reports which methods are enabled and clears
 * the session on logout. Email/magic-link sign-in has been removed.
 */
import { json, clearSessionCookie, isHttps } from '../http.js';

/** GET /api/auth/methods  ->  { google }  (which sign-in methods are enabled) */
export async function methods({ env }) {
  return json({ google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) });
}

/** POST /api/auth/logout  ->  { ok: true }  (clears the cookie) */
export async function logout({ request }) {
  return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie(isHttps(request)) });
}
