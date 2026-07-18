/**
 * Agent Alpaca Worker entry.
 *   - /api/*  : JSON API (auth, bridge pairing, session registry).
 *   - /ws/*   : WebSocket upgrades. The Worker authenticates and checks session
 *               ownership, then hands the socket to the session's Durable Object.
 *   - else    : static PWA assets (served by the platform; this handler only
 *               runs for non-asset paths, so the ASSETS fallback is a safety net).
 */
import { AlpacaSession } from './session.js';
import { json } from './http.js';
import { currentUser, bridgeFromToken } from './auth.js';
import * as auth from './api/auth.js';
import * as oauth from './api/oauth.js';
import * as passkeys from './api/passkeys.js';
import * as bridge from './api/bridge.js';
import * as sessions from './api/sessions.js';

export { AlpacaSession };

// method + path -> handler
const ROUTES = {
  'POST /api/auth/logout': auth.logout,
  'GET /api/auth/methods': auth.methods,
  'GET /api/auth/google/start': oauth.googleStart,
  'GET /api/auth/google/callback': oauth.googleCallback,
  'POST /api/passkeys/signup/start': passkeys.signupStart,
  'POST /api/passkeys/signup/finish': passkeys.signupFinish,
  'POST /api/passkeys/register/start': passkeys.registerStart,
  'POST /api/passkeys/register/finish': passkeys.registerFinish,
  'POST /api/passkeys/auth/start': passkeys.authStart,
  'POST /api/passkeys/auth/finish': passkeys.authFinish,
  'GET /api/passkeys': passkeys.list,
  'POST /api/passkeys/delete': passkeys.remove,
  'POST /api/bridge/pair-code': bridge.pairCode,
  'POST /api/bridge/claim': bridge.claim,
  'POST /api/bridge/revoke': bridge.revoke,
  'GET /api/bridges': bridge.list,
  'POST /api/sessions': sessions.register,
  'POST /api/sessions/close': sessions.close,
  'GET /api/sessions': sessions.list,
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === '/ws/bridge') return await upgrade(request, env, url, 'bridge');
      if (pathname === '/ws/view') return await upgrade(request, env, url, 'viewer');

      if (pathname.startsWith('/api/')) {
        const handler = ROUTES[`${request.method} ${pathname}`];
        if (!handler) return json({ error: 'not found' }, 404);
        return await handler({ request, env, ctx });
      }
    } catch (err) {
      console.error('unhandled', err);
      return json({ error: 'server error' }, 500);
    }

    // Non-API, non-WS: fall through to static assets.
    return env.ASSETS.fetch(request);
  },
};

/**
 * Authenticate a WebSocket upgrade, verify the caller owns the session, then
 * forward the upgrade to that session's Durable Object with trusted identity
 * headers (only the Worker can reach the DO, so the DO trusts these).
 */
async function upgrade(request, env, url, role) {
  if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
    return new Response('expected websocket', { status: 426 });
  }
  const sid = url.searchParams.get('session');
  if (!sid) return new Response('missing session', { status: 400 });

  let userId;
  if (role === 'bridge') {
    const b = await bridgeFromToken(request, env);
    if (!b) return new Response('unauthorized', { status: 401 });
    userId = b.userId;
  } else {
    const u = await currentUser(request, env);
    if (!u) return new Response('unauthorized', { status: 401 });
    userId = u.userId;
  }

  const sess = await env.DB.prepare('SELECT user_id FROM sessions WHERE id = ?').bind(sid).first();
  if (!sess || sess.user_id !== userId) return new Response('not found', { status: 404 });

  const headers = new Headers(request.headers);
  headers.set('x-alpaca-role', role);
  headers.set('x-alpaca-user', userId);
  headers.set('x-alpaca-session', sid);
  const fwd = new Request(url.toString(), { method: 'GET', headers });

  const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sid));
  return stub.fetch(fwd);
}
