/**
 * Live terminal view. Connects a viewer WebSocket to the session's Durable
 * Object and renders the stream in xterm.js. Framing matches the bridge:
 *   - binary in  = terminal output -> term.write
 *   - binary out = keystrokes      -> sent to the home PTY
 *   - text (JSON) = control (hello / meta / status / exit)
 * Loaded as a classic script; Terminal + FitAddon come from the vendored UMD builds.
 */
(function () {
  var sid = new URLSearchParams(location.search).get('s');
  var titleEl = document.getElementById('title');
  var statusEl = document.getElementById('status');
  var statusText = document.getElementById('statusText');
  var enc = new TextEncoder();

  if (!sid) {
    statusText.textContent = 'no session';
    return;
  }

  var term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 13,
    scrollback: 5000,
    theme: { background: '#000000', foreground: '#e7e7ef', cursor: '#7c5cff' },
  });
  var fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById('terminal'));
  fit.fit();
  term.focus();

  function setStatus(state, text) {
    statusEl.className = 'status ' + state;
    statusText.textContent = text;
  }

  var ws;
  var reconnectDelay = 800;

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws/view?session=' + encodeURIComponent(sid));
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
          if (m.title) {
            titleEl.textContent = m.title;
            document.title = m.title + ' · Agent Alpaca';
          }
          setStatus(m.bridgeOnline ? 'online' : 'offline', m.bridgeOnline ? 'live' : 'home offline');
        } else if (m.t === 'status') {
          setStatus(m.bridgeOnline ? 'online' : 'offline', m.bridgeOnline ? 'live' : 'home offline');
        } else if (m.t === 'exit') {
          setStatus('offline', 'session ended' + (m.code != null ? ' (' + m.code + ')' : ''));
          term.write('\r\n\x1b[90m— session ended —\x1b[0m\r\n');
        }
      } else {
        term.write(new Uint8Array(ev.data));
      }
    };

    ws.onclose = function () {
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

  // Keystrokes -> home PTY (binary frames).
  term.onData(function (data) {
    if (ws && ws.readyState === 1) ws.send(enc.encode(data));
  });

  // Keep xterm sized to the viewport; the home PTY size is authoritative, but
  // fitting keeps the local rendering crisp.
  window.addEventListener('resize', function () {
    try {
      fit.fit();
    } catch (e) {}
  });

  connect();
})();
