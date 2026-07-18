/** App shell: list the user's live sessions (polling) and hand out pairing codes. */
import { supported as passkeysSupported, registerPasskey, friendlyError } from './passkey.js';

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const modal = document.getElementById('modal');
const pairCmd = document.getElementById('pairCmd');
const pairNote = document.getElementById('pairNote');

// Service worker disabled for now: on shared localhost origins a stale SW can
// serve old code and mask errors. Actively tear down any existing registration
// and caches so every load is fresh.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
  if (self.caches) caches.keys().then((ks) => ks.forEach((k) => caches.delete(k))).catch(() => {});
}

function ago(unixSec) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function render(sessions) {
  if (!sessions.length) {
    listEl.innerHTML = '';
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;
  listEl.innerHTML = sessions
    .map((s) => {
      const online = s.bridge_online ? 'online' : '';
      const badge = s.bridge_online ? '<span class="badge live">● live</span>' : '<span class="badge">offline</span>';
      return `<div class="session ${online}" data-id="${esc(s.id)}">
        <span class="dot"></span>
        <div class="grow">
          <div class="title">${esc(s.label || 'terminal')}</div>
          <div class="sub mono">${esc(s.cmd || '')} · ${s.bridge_online ? 'active' : 'last seen ' + ago(s.last_seen)}</div>
        </div>
        ${badge}
      </div>`;
    })
    .join('');
  for (const el of listEl.querySelectorAll('.session')) {
    el.addEventListener('click', () => {
      location.href = `/term.html?s=${encodeURIComponent(el.dataset.id)}`;
    });
  }
}

async function refresh() {
  try {
    const r = await fetch('/api/sessions');
    if (r.status === 401) {
      location.replace('/login.html');
      return;
    }
    const data = await r.json();
    render(data.sessions || []);
  } catch {
    /* keep last view on transient errors */
  }
}

// --- pairing ---
document.getElementById('addBridge').addEventListener('click', async () => {
  pairCmd.textContent = 'requesting…';
  pairNote.textContent = 'This code expires in 10 minutes and can be used once.';
  modal.hidden = false;
  try {
    const r = await fetch('/api/bridge/pair-code', { method: 'POST' });
    let data = {};
    try {
      data = await r.json();
    } catch {}
    if (r.status === 401) {
      pairCmd.textContent = 'not signed in';
      pairNote.innerHTML = 'Your session expired. <a href="/login.html">Sign in again</a>, then retry.';
      return;
    }
    if (!r.ok || !data.code) {
      pairCmd.textContent = 'error';
      pairNote.textContent = `Could not create a pairing code (HTTP ${r.status}${data.error ? ': ' + data.error : ''}). Try again.`;
      return;
    }
    pairCmd.textContent = data.code; // bare code — what the app needs
    const cli = document.getElementById('pairCli');
    if (cli) cli.textContent = `alpaca pair ${data.code}`;
    const copyBtn = document.getElementById('copyCode');
    if (copyBtn) {
      copyBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(data.code);
          copyBtn.textContent = 'Copied ✓';
          setTimeout(() => (copyBtn.textContent = 'Copy code'), 1500);
        } catch {}
      };
    }
  } catch (e) {
    pairCmd.textContent = 'network error';
    pairNote.textContent = 'Could not reach the server: ' + (e && e.message ? e.message : e);
  }
});
document.getElementById('closeModal').addEventListener('click', () => {
  modal.hidden = true;
  refresh();
});
modal.addEventListener('click', (e) => {
  if (e.target === modal) modal.hidden = true;
});

document.getElementById('logout').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.replace('/');
});

refresh();
setInterval(refresh, 4000);

// --- passkeys ---
const pkSection = document.getElementById('passkeys');
const pkList = document.getElementById('passkeyList');
const pkMsg = document.getElementById('passkeyMsg');
const addPk = document.getElementById('addPasskey');

function renderPasskeys(items) {
  if (!items.length) {
    pkList.innerHTML = '<p class="muted small">No passkeys yet.</p>';
    return;
  }
  pkList.innerHTML = items
    .map(
      (p) => `<div class="session"><span class="grow"><div class="title">🔑 ${esc(p.label || 'Passkey')}</div>
        <div class="sub">added ${ago(p.created_at)}${p.last_used ? ' · used ' + ago(p.last_used) : ''}</div></span>
        <button class="btn btn-sm btn-ghost" data-del="${esc(p.id)}">Remove</button></div>`,
    )
    .join('');
  pkList.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      await fetch('/api/passkeys/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: b.dataset.del }),
      });
      refreshPasskeys();
    }),
  );
}

async function refreshPasskeys() {
  try {
    const r = await fetch('/api/passkeys');
    if (!r.ok) return;
    const data = await r.json();
    renderPasskeys(data.passkeys || []);
  } catch {}
}

if (passkeysSupported() && pkSection) {
  pkSection.hidden = false;
  addPk.addEventListener('click', async () => {
    addPk.disabled = true;
    pkMsg.innerHTML = '<div class="msg">Follow your browser’s prompt…</div>';
    try {
      await registerPasskey();
      pkMsg.innerHTML = '<div class="msg msg-ok">Passkey added ✓</div>';
      refreshPasskeys();
    } catch (e) {
      pkMsg.innerHTML = `<div class="msg msg-err">${esc(friendlyError(e))}</div>`;
    } finally {
      addPk.disabled = false;
      setTimeout(() => (pkMsg.innerHTML = ''), 3000);
    }
  });
  refreshPasskeys();
}
