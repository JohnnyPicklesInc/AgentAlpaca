/**
 * Renderer for the host app. Talks to the main process only through
 * window.alpaca (see preload.js). Shows a live local xterm view per session,
 * mirroring what the remote viewer sees.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const enc = new TextEncoder();
  let state = { server: 'https://agentalpaca.app', sessions: new Map(), active: null };

  // one xterm reused across sessions; we keep per-session buffers. Created
  // defensively so a missing/broken xterm can't kill the whole UI (pairing must
  // still work). term/fit stay null if xterm didn't load.
  let term = null;
  let fit = null;
  try {
    if (typeof Terminal !== 'undefined') {
      term = new Terminal({
        cursorBlink: true,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 13,
        scrollback: 8000,
        theme: { background: '#000000', foreground: '#e7e7ef', cursor: '#7c5cff' },
      });
      if (typeof FitAddon !== 'undefined') {
        fit = new FitAddon.FitAddon();
        term.loadAddon(fit);
      }
    }
  } catch (e) {
    console.error('xterm init failed:', e);
  }

  function show(view) {
    $('pairView').hidden = view !== 'pair';
    $('mainView').hidden = view !== 'main';
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // --- pairing ---
  async function initPair(status) {
    $('server').value = status.server || 'https://agentalpaca.app';
    async function doPair() {
      // Accept a bare code OR a pasted "alpaca pair ALPACA-XXXX" — extract the code.
      const raw = $('code').value.trim();
      const m = raw.toUpperCase().match(/ALPACA-[A-Z0-9]+/);
      const code = m ? m[0] : raw.toUpperCase();
      const server = $('server').value.trim() || 'https://agentalpaca.app';
      if (!code) {
        $('pairMsg').innerHTML = '<div class="msg err">Enter the pairing code from the web app.</div>';
        $('code').focus();
        return;
      }
      $('pairBtn').disabled = true;
      $('pairMsg').innerHTML = '<div class="msg">Pairing…</div>';
      try {
        const r = await window.alpaca.pair({ code, server });
        if (!r || !r.ok) throw new Error((r && r.error) || 'pairing failed');
        await boot();
      } catch (e) {
        $('pairMsg').innerHTML = `<div class="msg err">${esc(e.message || 'Pairing failed')}</div>`;
      } finally {
        $('pairBtn').disabled = false;
      }
    }
    $('pairBtn').onclick = doPair;
    $('code').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doPair();
    });
    document.querySelectorAll('[data-open]').forEach((el) =>
      el.addEventListener('click', (ev) => {
        ev.preventDefault();
        window.alpaca.openExternal((status.server || 'https://agentalpaca.app').replace(/\/$/, '') + el.dataset.open);
      }),
    );
  }

  // --- main view ---
  function renderAgents(list) {
    $('agentList').innerHTML = list
      .map(
        (a) => `<button class="agent ${a.installed ? '' : 'missing'}" data-agent="${a.id}" ${a.installed ? '' : 'title="' + esc(a.hint) + '"'}>
          <span>${esc(a.name)}</span>
          <span class="badge ${a.installed ? 'ok' : ''}">${a.installed ? 'ready' : 'not found'}</span>
        </button>`,
      )
      .join('');
    $('agentList')
      .querySelectorAll('.agent')
      .forEach((el) =>
        el.addEventListener('click', () => launch({ agentId: el.dataset.agent })),
      );
  }

  function renderSessions() {
    const list = $('sessionList');
    if (!state.sessions.size) {
      list.innerHTML = '<p class="muted small">Nothing running.</p>';
      return;
    }
    list.innerHTML = [...state.sessions.values()]
      .map(
        (s) => `<div class="sess ${s.sid === state.active ? 'active' : ''}" data-sid="${s.sid}">
          <span class="dot ${s.online ? 'on' : ''}"></span>
          <span class="grow">${esc(s.name)}</span>
        </div>`,
      )
      .join('');
    list.querySelectorAll('.sess').forEach((el) => el.addEventListener('click', () => activate(el.dataset.sid)));
  }

  async function launch(opts) {
    try {
      await window.alpaca.launch(opts);
    } catch (e) {
      alert('Could not launch: ' + (e.message || e));
    }
  }

  function activate(sid) {
    const s = state.sessions.get(sid);
    if (!s) return;
    state.active = sid;
    $('placeholder').hidden = true;
    $('termWrap').hidden = false;
    $('termTitle').textContent = s.cmd || s.name;
    $('termStatus').textContent = s.online ? '● live' : 'offline';
    $('termStatus').className = 'badge ' + (s.online ? 'ok' : '');
    if (term) {
      term.reset();
      if (s.buffer) term.write(s.buffer);
      requestAnimationFrame(() => {
        try {
          fit && fit.fit();
        } catch {}
        term.focus();
        window.alpaca.resize(sid, term.cols, term.rows);
      });
    }
    renderSessions();
  }

  function wireTerminal() {
    if (term) {
      term.open($('terminal'));
      term.onData((d) => {
        if (state.active) window.alpaca.sendInput(state.active, d);
      });
      window.addEventListener('resize', () => {
        try {
          fit && fit.fit();
        } catch {}
        if (state.active) window.alpaca.resize(state.active, term.cols, term.rows);
      });
    }

    $('stopBtn').onclick = () => state.active && window.alpaca.stop(state.active);
    $('openRemote').onclick = () =>
      state.active && window.alpaca.openExternal(state.server.replace(/\/$/, '') + '/term.html?s=' + encodeURIComponent(state.active));
    $('stopAllBtn').onclick = () => window.alpaca.stopAll();
    $('webBtn').onclick = () => window.alpaca.openExternal(state.server.replace(/\/$/, '') + '/app.html');
    $('unpairBtn').onclick = async () => {
      if (confirm('Unpair this machine? Running agents will stop.')) {
        await window.alpaca.unpair();
        location.reload();
      }
    };
    $('customBtn').onclick = () => {
      const cmd = $('custom').value.trim();
      if (cmd) launch({ agentId: 'custom', customCommand: cmd });
    };
  }

  // --- IPC events from main ---
  window.alpaca.on('session:started', ({ sid, name, cmd }) => {
    state.sessions.set(sid, { sid, name, cmd, online: false, buffer: '' });
    renderSessions();
    activate(sid);
  });
  window.alpaca.on('session:data', ({ sid, data }) => {
    const s = state.sessions.get(sid);
    if (!s) return;
    s.buffer = (s.buffer + data).slice(-200000);
    if (sid === state.active && term) term.write(data);
  });
  window.alpaca.on('session:status', ({ sid, online }) => {
    const s = state.sessions.get(sid);
    if (!s) return;
    s.online = online;
    if (sid === state.active) {
      $('termStatus').textContent = online ? '● live' : 'offline';
      $('termStatus').className = 'badge ' + (online ? 'ok' : '');
    }
    renderSessions();
  });
  window.alpaca.on('session:exit', ({ sid }) => {
    const s = state.sessions.get(sid);
    if (s && sid === state.active && term) term.write('\r\n\x1b[90m— agent exited —\x1b[0m\r\n');
    state.sessions.delete(sid);
    if (state.active === sid) {
      state.active = null;
      $('termWrap').hidden = true;
      $('placeholder').hidden = false;
    }
    renderSessions();
  });
  window.alpaca.on('session:error', ({ message }) => {
    alert('Agent error: ' + message);
  });

  // --- boot ---
  async function boot() {
    const status = await window.alpaca.status();
    state.server = status.server;
    if (!status.paired) {
      show('pair');
      initPair(status);
      return;
    }
    show('main');
    $('hostLabel').textContent = status.label || '';
    renderAgents(status.agents);
    // restore any already-running sessions (e.g. window was reopened)
    state.sessions = new Map();
    (status.running || []).forEach((s) => state.sessions.set(s.sid, { sid: s.sid, name: s.name, online: s.online, buffer: '' }));
    renderSessions();
  }

  // Surface any startup failure instead of a silent dead window.
  if (!window.alpaca) {
    document.body.innerHTML =
      '<div style="padding:24px;color:#ff6b6b;font-family:system-ui">Preload failed to load — window.alpaca is missing. Restart the app; if it persists, run with ALPACA_DEBUG=1 and check the console.</div>';
  } else {
    try {
      wireTerminal();
      boot();
    } catch (e) {
      document.body.innerHTML =
        '<div style="padding:24px;color:#ff6b6b;font-family:system-ui">Renderer error: ' + esc(e.message || e) + '</div>';
    }
  }
})();

window.addEventListener('error', (e) => {
  const msg = document.getElementById('pairMsg');
  if (msg) msg.innerHTML = '<div class="msg err">Script error: ' + (e.message || 'unknown') + '</div>';
});
