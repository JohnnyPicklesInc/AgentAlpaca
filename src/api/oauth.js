/**
 * Google Sign-In endpoints (authorization-code flow). No email, no passwords.
 *   GET /api/auth/google/start     -> 302 to Google's consent screen
 *   GET /api/auth/google/callback  -> verifies, upserts user, sets session, -> /grid.html
 *
 * CSRF/replay protection: a random `state` (with a bound `nonce`) is stored in KV
 * for 10 minutes and consumed on callback.
 */
import { json, sessionCookie, isHttps } from '../http.js';
import { signSession, SESSION_TTL, PAIR_TTL } from '../lib.js';
import { googleAuthUrl, googleExchange, randomState } from '../oauth.js';

// The redirect URI MUST be deterministic and byte-identical between the auth and
// token steps. Deriving it from request.url is unreliable under `wrangler dev`
// (a configured custom-domain route makes request.url report the production
// host). So prefer an explicit OAUTH_BASE_URL:
//   local: http://127.0.0.1:8796   production: https://agentalpaca.app
function redirectUri(request, env) {
  const base = (env && env.OAUTH_BASE_URL) || new URL(request.url).origin;
  return `${base.replace(/\/$/, '')}/api/auth/google/callback`;
}

/** GET /api/auth/google/start */
export async function googleStart({ request, env }) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return json({ error: 'Google sign-in is not configured on this server' }, 500);
  }
  if (!env.TOKENS_KV) return json({ error: 'server misconfigured' }, 500);

  const state = randomState();
  const nonce = randomState();
  const ru = redirectUri(request, env);
  // Persist the EXACT redirect_uri used here so the token exchange reuses it
  // verbatim (Google requires the two to match byte-for-byte).
  await env.TOKENS_KV.put(`oauth:${state}`, JSON.stringify({ nonce, redirectUri: ru }), { expirationTtl: PAIR_TTL });

  const url = googleAuthUrl({
    clientId: env.GOOGLE_CLIENT_ID,
    redirectUri: ru,
    state,
    nonce,
  });
  return new Response(null, { status: 302, headers: { location: url } });
}

/** GET /api/auth/google/callback?code=&state= */
export async function googleCallback({ request, env }) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const err = url.searchParams.get('error');
  if (err) return failRedirect(url.origin, err);
  if (!code || !state) return failRedirect(url.origin, 'missing code/state');
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.DB || !env.SESSION_SECRET || !env.TOKENS_KV) {
    return failRedirect(url.origin, 'server misconfigured');
  }

  const rec = await env.TOKENS_KV.get(`oauth:${state}`, 'json');
  if (!rec) return failRedirect(url.origin, 'invalid or expired state');
  await env.TOKENS_KV.delete(`oauth:${state}`); // single-use

  // Reuse the redirect_uri from the authorization step (stored in KV). Falling
  // back to re-derivation only if an older record lacks it.
  const usedRedirect = rec.redirectUri || redirectUri(request, env);
  const derived = redirectUri(request, env);
  if (usedRedirect !== derived) {
    console.log(`google redirect_uri differs: auth=${usedRedirect} callback=${derived}`);
  }

  let profile;
  try {
    profile = await googleExchange({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      code,
      redirectUri: usedRedirect,
      nonce: rec.nonce,
    });
  } catch (e) {
    console.error('google callback error:', (e && e.stack) || e, 'redirect_uri=', redirectUri(request, env));
    // Surface the real reason + the exact redirect_uri we sent (dev only) so
    // mismatches are obvious. These values aren't sensitive.
    const reason =
      env.DEV_MAGIC_ECHO === '1' && e && e.message
        ? `${e.message} — we sent redirect_uri=${redirectUri(request, env)}`
        : 'google sign-in failed';
    return failRedirect(url.origin, reason);
  }

  // Upsert by verified email — links to an existing account if one exists.
  let user = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(profile.email).first();
  if (!user) {
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)')
      .bind(id, profile.email, Math.floor(Date.now() / 1000))
      .run();
    user = { id };
  }

  const session = await signSession(env.SESSION_SECRET, user.id, Date.now() / 1000);
  return new Response(null, {
    status: 302,
    headers: { location: '/grid.html', 'set-cookie': sessionCookie(session, SESSION_TTL, isHttps(request)) },
  });
}

function failRedirect(origin, reason) {
  return new Response(null, {
    status: 302,
    headers: { location: `/login.html?error=${encodeURIComponent(reason)}` },
  });
}
