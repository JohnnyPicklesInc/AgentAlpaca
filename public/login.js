/** Login: Google sign-in + passkey sign-in. Surfaces any ?error=. */
import { supported, signInWithPasskey, signUpWithPasskey, friendlyError } from './passkey.js';

const message = document.getElementById('message');

function show(html, cls) {
  message.innerHTML = `<div class="msg ${cls}">${html}</div>`;
}

const errParam = new URLSearchParams(location.search).get('error');
if (errParam) show(`Sign-in failed: ${errParam.replace(/[<>]/g, '')}. Try again.`, 'msg-err');

// Passkey sign-in + passkey account creation (shown only if supported).
const passkeyBtn = document.getElementById('passkeyBtn');
const signupRow = document.getElementById('signupRow');
const signupLink = document.getElementById('signupPasskey');

if (supported()) {
  if (passkeyBtn) {
    passkeyBtn.hidden = false;
    passkeyBtn.addEventListener('click', async () => {
      passkeyBtn.disabled = true;
      show('Waiting for your passkey…', 'msg-ok');
      try {
        await signInWithPasskey();
        location.replace('/grid.html');
      } catch (e) {
        show(friendlyError(e), 'msg-err');
        passkeyBtn.disabled = false;
      }
    });
  }
  if (signupRow) signupRow.hidden = false;
  if (signupLink) {
    signupLink.addEventListener('click', async (e) => {
      e.preventDefault();
      show('Creating your account…', 'msg-ok');
      try {
        await signUpWithPasskey();
        location.replace('/grid.html');
      } catch (err) {
        show(friendlyError(err), 'msg-err');
      }
    });
  }
}

fetch('/api/auth/methods')
  .then((r) => r.json())
  .then((m) => {
    if (!m.google) {
      const b = document.getElementById('googleBtn');
      if (b) {
        b.style.opacity = '0.5';
        b.style.pointerEvents = 'none';
      }
      show('Google sign-in is not configured on this server.', 'msg-err');
    }
  })
  .catch(() => {});
