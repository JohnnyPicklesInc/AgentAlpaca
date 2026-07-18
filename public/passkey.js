/**
 * Passkey (WebAuthn) client glue. Uses the vendored @simplewebauthn/browser
 * global (SimpleWebAuthnBrowser), which handles the base64url<->ArrayBuffer
 * conversions and the navigator.credentials ceremony. Imported by login.js and
 * app.js. The vendor bundle must be loaded (classic <script>) before this runs.
 */
const SWA = window.SimpleWebAuthnBrowser;

/** True if this browser can do passkeys at all. */
export function supported() {
  return !!(SWA && window.PublicKeyCredential);
}

async function postJson(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await r.json();
  } catch {}
  return { ok: r.ok, status: r.status, data };
}

/** Sign in with a discoverable passkey. Resolves on success, throws otherwise. */
export async function signInWithPasskey() {
  const start = await postJson('/api/passkeys/auth/start');
  if (!start.ok) throw new Error(start.data.error || 'could not start passkey sign-in');
  const assertion = await SWA.startAuthentication({ optionsJSON: start.data });
  const finish = await postJson('/api/passkeys/auth/finish', assertion);
  if (!finish.ok || !finish.data.ok) throw new Error(finish.data.error || 'passkey sign-in failed');
  return finish.data;
}

/** Create a brand-new account with just a passkey (no prior sign-in). */
export async function signUpWithPasskey(name) {
  const start = await postJson('/api/passkeys/signup/start', name ? { name } : {});
  if (!start.ok) throw new Error(start.data.error || 'could not start signup');
  const attestation = await SWA.startRegistration({ optionsJSON: start.data });
  const finish = await postJson('/api/passkeys/signup/finish', attestation);
  if (!finish.ok || !finish.data.ok) throw new Error(finish.data.error || 'account creation failed');
  return finish.data;
}

/** Register a new passkey for the signed-in user. */
export async function registerPasskey() {
  const start = await postJson('/api/passkeys/register/start');
  if (!start.ok) throw new Error(start.data.error || 'could not start registration');
  const attestation = await SWA.startRegistration({ optionsJSON: start.data });
  const finish = await postJson('/api/passkeys/register/finish', attestation);
  if (!finish.ok || !finish.data.ok) throw new Error(finish.data.error || 'passkey registration failed');
  return finish.data;
}

/** Map SimpleWebAuthn/browser errors to friendly text. */
export function friendlyError(e) {
  const msg = String((e && e.message) || e);
  if (/timed out|not allowed|abort/i.test(msg)) return 'Cancelled or timed out.';
  if (/no available authenticator|not have|no credentials/i.test(msg)) return 'No passkey found on this device.';
  return msg;
}
