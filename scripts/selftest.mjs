/**
 * Server-lib self-test — no server, no network. Exercises the session-cookie
 * signing, token hashing, pairing-code shape, and base64url round-trips that the
 * Worker relies on. Run: node scripts/selftest.mjs
 */
import {
  b64u,
  unb64u,
  signSession,
  verifySession,
  sha256b64u,
  randomToken,
  pairingCode,
  timingSafeEqual,
} from '../src/lib.js';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`);
  }
}

// --- base64url ---
const probe = crypto.getRandomValues(new Uint8Array(20));
check('b64url round-trips', b64u(unb64u(b64u(probe))) === b64u(probe));

// --- sessions ---
const SECRET = 'dev-session-secret';
const now = 1_700_000_000;
const token = await signSession(SECRET, 'user-abc', now);
const ok = await verifySession(SECRET, token, now + 100);
check('valid session verifies to its userId', ok && ok.userId === 'user-abc');
check('expired session is rejected', (await verifySession(SECRET, token, now + 60 * 60 * 24 * 40)) === null);
const tampered = token.slice(0, -3) + (token.endsWith('AAA') ? 'BBB' : 'AAA');
check('tampered session is rejected', (await verifySession(SECRET, tampered, now + 100)) === null);
check('wrong secret rejects a session', (await verifySession('other-secret', token, now + 100)) === null);

// --- token hashing (magic links / bridge tokens) ---
const t = randomToken();
const h1 = await sha256b64u(t);
check('token hash is deterministic', (await sha256b64u(t)) === h1);
check('different tokens hash differently', (await sha256b64u(randomToken())) !== h1);
check('raw token is not recoverable from hash', h1 !== t && h1.length === 43);

// --- pairing codes ---
const code = pairingCode();
check('pairing code has ALPACA- prefix', /^ALPACA-[A-Z2-9]{6}$/.test(code));
check('pairing codes vary', pairingCode() !== pairingCode() || pairingCode() !== pairingCode());

// --- constant-time compare ---
check('timingSafeEqual true for equal', timingSafeEqual(unb64u(h1), unb64u(h1)));
check('timingSafeEqual false for unequal length', !timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2])));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
