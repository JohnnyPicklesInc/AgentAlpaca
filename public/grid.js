/**
 * Grid view: render every live session as its own interactive xterm tile on one
 * page. Each tile holds an independent viewer WebSocket to its session's Durable
 * Object, using the same framing as term.js (binary out = keystrokes to the home
 * PTY, binary in = terminal output, text = JSON control).
 * Loaded as a classic script; Terminal + FitAddon come from the vendored UMD builds.
 */
(function () {
  var enc = new TextEncoder();
  var gridEl = document.getElementById('grid');
  var emptyEl = document.getElementById('empty');
  var tiles = new Map(); // session id -> tile controller

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function makeTile(s) {
    var tile = document.createElement('div');
    tile.className = 'tile';
    tile.innerHTML =
      '<div class="tile-bar">' +
      '<span class="dot"></span>' +
      '<div class="grow"><div class="title"></div><div class="sub mono"></div></div>' +
      '<span class="tstatus">connecting…</span>' +
      '<a class="btn btn-sm btn-ghost expand" title="Open full screen">⤢</a>' +
      '</div>' +
      '<div class="tile-term"></div>';

    var titleEl = tile.querySelector('.title');
    var subEl = tile.querySelector('.sub');
    var statusEl = tile.querySelector('.tstatus');
    var termHost = tile.querySelector('.tile-term');
    var expandUrl = '/term.html?s=' + encodeURIComponent(s.id);
    tile.querySelector('.expand').href = expandUrl;
    titleEl.textContent = s.label || 'terminal';
    subEl.textContent = s.cmd || '';
    gridEl.appendChild(tile);

    var term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12,
      scrollback: 1500,
      theme: { background: '#000000', foreground: '#e7e7ef', cursor: '#7c5cff' },
    });
    var fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(termHost);
    function refit() {
      try {
        fit.fit();
      } catch (e) {}
    }
    refit();

    // On desktop, tapping focuses the tile so keystrokes go here. On phones a
    // 260px tile is too cramped to type in (and the soft keyboard would bury it),
    // so a tap opens the full-screen, keyboard-aware view instead.
    var coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    function activate() {
      if (coarse) {
        location.href = expandUrl;
        return;
      }
      term.focus();
    }
    termHost.addEventListener('mousedown', activate);
    termHost.addEventListener('touchend', function (e) {
      e.preventDefault();
      activate();
    });
    term.textarea &&
      term.textarea.addEventListener('focus', function () {
        for (var t of tiles.values()) t.el.classList.remove('focused');
        tile.classList.add('focused');
      });

    function setStatus(state, text) {
      tile.classList.remove('online', 'offline');
      tile.classList.add(state);
      statusEl.textContent = text;
    }

    var ws;
    var reconnectDelay = 800;
    var done = false;

    function connect() {
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(proto + '//' + location.host + '/ws/view?session=' + encodeURIComponent(s.id));
      ws.binaryType = 'arraybuffer';
      ws.onopen = function () {
        reconnectDelay = 800;
        setStatus('online', 'connected');
      };
      ws.onmessage = function (ev) {
        if (typeof ev.data === 'string') {
          var m;
          try {
            m = JSON.parse(ev.data);
          } catch (e) {
            return;
          }
          if (m.t === 'hello' || m.t === 'meta') {
            if (m.title) titleEl.textContent = m.title;
            setStatus(m.bridgeOnline ? 'online' : 'offline', m.bridgeOnline ? 'live' : 'home offline');
          } else if (m.t === 'status') {
            setStatus(m.bridgeOnline ? 'online' : 'offline', m.bridgeOnline ? 'live' : 'home offline');
          } else if (m.t === 'exit') {
            setStatus('offline', 'ended' + (m.code != null ? ' (' + m.code + ')' : ''));
            term.write('\r\n\x1b[90m— session ended —\x1b[0m\r\n');
            done = true;
            try {
              ws.close();
            } catch (e) {}
          }
        } else {
          term.write(new Uint8Array(ev.data));
        }
      };
      ws.onclose = function () {
        if (done) return;
        setStatus('offline', 'reconnecting…');
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 1.6, 8000);
      };
      ws.onerror = function () {
        try {
          ws.close();
        } catch (e) {}
      };
    }

    // Keystrokes -> home PTY (binary frames), same as the full-screen view.
    term.onData(function (data) {
      if (ws && ws.readyState === 1) ws.send(enc.encode(data));
    });

    connect();
    return { el: tile, refit: refit };
  }

  function sync(sessions) {
    if (!sessions.length && !tiles.size) {
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      if (!tiles.has(s.id)) tiles.set(s.id, makeTile(s));
    }
  }

  async function refresh() {
    try {
      var r = await fetch('/api/sessions');
      if (r.status === 401) {
        location.replace('/login.html');
        return;
      }
      var data = await r.json();
      sync(data.sessions || []);
    } catch (e) {
      /* keep the current tiles on transient errors */
    }
  }

  function refitAll() {
    for (var t of tiles.values()) t.refit();
  }
  window.addEventListener('resize', refitAll);
  window.addEventListener('orientationchange', refitAll);

  var logout = document.getElementById('logout');
  if (logout) {
    logout.addEventListener('click', async function () {
      await fetch('/api/auth/logout', { method: 'POST' });
      location.replace('/');
    });
  }

  refresh();
  // New sessions can appear after load; poll to add tiles for them (existing
  // tiles are never torn down — their live sockets keep streaming).
  setInterval(refresh, 7000);
})();
