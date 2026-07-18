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
  var termEl = document.getElementById('terminal');
  term.open(termEl);

  function refit() {
    try {
      fit.fit();
    } catch (e) {}
  }
  refit();
  term.focus();

  // On mobile the soft keyboard only opens after a real user gesture that lands
  // on xterm's hidden input, and taps on the padding around the canvas miss it.
  // Route any touch/click on the terminal box to term.focus() so tapping the
  // screen reliably brings up the keyboard.
  termEl.addEventListener('touchend', function () {
    term.focus();
  });
  termEl.addEventListener('mousedown', function () {
    term.focus();
  });

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

  function send(data) {
    if (ws && ws.readyState === 1) ws.send(enc.encode(data));
  }

  // Sticky Ctrl: a phone keyboard has no Ctrl, so tapping the on-screen ctrl key
  // arms it, and the next letter typed is folded into its control code (^A..^Z).
  var ctrlArmed = false;
  function setCtrl(on) {
    ctrlArmed = on;
    var b = document.querySelector('.key-toggle');
    if (b) b.classList.toggle('active', on);
  }

  // Keystrokes -> home PTY (binary frames).
  term.onData(function (data) {
    if (ctrlArmed && data.length === 1) {
      var c = data.toUpperCase().charCodeAt(0);
      if (c >= 64 && c <= 95) data = String.fromCharCode(c & 0x1f); // @A-Z[\]^_ -> ^@..^_
      setCtrl(false);
    }
    send(data);
  });

  var SEQ = {
    esc: '\x1b',
    tab: '\t',
    '^c': '\x03',
    up: '\x1b[A',
    down: '\x1b[B',
    right: '\x1b[C',
    left: '\x1b[D',
  };
  document.getElementById('keybar').addEventListener('click', function (ev) {
    var el = ev.target.closest('.key');
    if (!el) return;
    if (el.dataset.mod === 'ctrl') {
      setCtrl(!ctrlArmed);
    } else if (SEQ[el.dataset.seq]) {
      send(SEQ[el.dataset.seq]);
    }
    term.focus(); // keep the soft keyboard up after tapping a key
  });

  // Keep xterm sized to the visible viewport. The home PTY size is authoritative,
  // but fitting keeps the local rendering crisp — and refitting when the soft
  // keyboard opens/closes (visualViewport resize) stops it from hiding the prompt.
  window.addEventListener('resize', refit);
  window.addEventListener('orientationchange', refit);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', refit);
  }

  connect();
})();
