/**
 * AlpacaSession — one Durable Object per terminal session, addressed by the
 * session id. It is a live hub between:
 *
 *   - exactly one BRIDGE socket (the home machine running `alpaca -- <cmd>`), and
 *   - any number of VIEWER sockets (laptop browsers with the xterm terminal open).
 *
 * Framing convention on every socket, both directions:
 *   - BINARY frame  = raw terminal bytes.
 *       bridge -> DO : program output. DO fans it out to all viewers + scrollback.
 *       viewer -> DO : user keystrokes. DO forwards them to the bridge (PTY input).
 *   - TEXT frame (JSON) = control message: { t: 'meta' | 'exit' | 'status' | 'hello' }.
 *
 * No terminal content is persisted. A small in-memory scrollback is replayed to
 * viewers that join mid-session so they see the current screen. The DO stays
 * resident while any socket is connected (that is what keeps the scrollback
 * alive); once everything disconnects the session is idle and the buffer is moot.
 */

const SCROLLBACK_LIMIT = 256 * 1024; // bytes of recent output replayed to new viewers

export class AlpacaSession {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    /** @type {WebSocket | null} */
    this.bridge = null;
    /** @type {Set<WebSocket>} */
    this.viewers = new Set();
    /** @type {Uint8Array[]} recent output chunks */
    this.scroll = [];
    this.scrollBytes = 0;
    this.sid = null;
    this.meta = { title: '', cmd: '', cols: 80, rows: 24 };
  }

  async fetch(request) {
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const role = request.headers.get('x-alpaca-role');
    this.sid = request.headers.get('x-alpaca-session') || this.sid;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    if (role === 'bridge') this.attachBridge(server);
    else this.attachViewer(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  // --- bridge (home machine) -------------------------------------------------

  attachBridge(ws) {
    // Only one bridge per session; a reconnecting bridge replaces the old one.
    if (this.bridge) {
      try {
        this.bridge.close(1000, 'replaced');
      } catch {}
    }
    this.bridge = ws;
    this.scroll = [];
    this.scrollBytes = 0;
    this.setOnline(true);
    this.broadcast(JSON.stringify({ t: 'status', bridgeOnline: true }));

    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') {
        this.onBridgeControl(ev.data);
      } else {
        const bytes = new Uint8Array(ev.data);
        this.appendScroll(bytes);
        this.fanout(bytes);
      }
    });
    const gone = () => {
      if (this.bridge === ws) {
        this.bridge = null;
        this.setOnline(false);
        this.broadcast(JSON.stringify({ t: 'status', bridgeOnline: false }));
      }
    };
    ws.addEventListener('close', gone);
    ws.addEventListener('error', gone);
  }

  onBridgeControl(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.t === 'meta') {
      if (typeof msg.title === 'string') this.meta.title = msg.title;
      if (typeof msg.cmd === 'string') this.meta.cmd = msg.cmd;
      if (Number.isInteger(msg.cols)) this.meta.cols = msg.cols;
      if (Number.isInteger(msg.rows)) this.meta.rows = msg.rows;
      this.broadcast(JSON.stringify({ t: 'meta', ...this.meta }));
    } else if (msg.t === 'exit') {
      this.broadcast(JSON.stringify({ t: 'exit', code: msg.code ?? null }));
    }
  }

  // --- viewers (laptop browsers) ---------------------------------------------

  attachViewer(ws) {
    this.viewers.add(ws);
    // Bring the newcomer up to the current screen state.
    ws.send(JSON.stringify({ t: 'hello', ...this.meta, bridgeOnline: !!this.bridge }));
    for (const chunk of this.scroll) {
      try {
        ws.send(chunk);
      } catch {}
    }

    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') return; // viewer control frames are advisory; ignore for now
      if (this.bridge && this.bridge.readyState === 1) {
        try {
          this.bridge.send(ev.data); // keystrokes -> PTY input on the home machine
        } catch {}
      }
    });
    const gone = () => this.viewers.delete(ws);
    ws.addEventListener('close', gone);
    ws.addEventListener('error', gone);
  }

  // --- helpers ---------------------------------------------------------------

  fanout(bytes) {
    for (const v of this.viewers) {
      if (v.readyState === 1) {
        try {
          v.send(bytes);
        } catch {}
      }
    }
  }

  broadcast(text) {
    for (const v of this.viewers) {
      if (v.readyState === 1) {
        try {
          v.send(text);
        } catch {}
      }
    }
  }

  appendScroll(bytes) {
    this.scroll.push(bytes);
    this.scrollBytes += bytes.byteLength;
    while (this.scrollBytes > SCROLLBACK_LIMIT && this.scroll.length > 1) {
      this.scrollBytes -= this.scroll.shift().byteLength;
    }
  }

  /** Reflect bridge presence into D1 so the web session list shows live/offline. */
  setOnline(online) {
    if (!this.sid || !this.env.DB) return;
    const now = Math.floor(Date.now() / 1000);
    this.ctx.waitUntil(
      this.env.DB.prepare('UPDATE sessions SET bridge_online = ?, last_seen = ? WHERE id = ?')
        .bind(online ? 1 : 0, now, this.sid)
        .run()
        .catch(() => {}),
    );
  }
}
