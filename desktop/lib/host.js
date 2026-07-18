/**
 * Host relay logic for the desktop app — pairing + one AgentSession per launched
 * agent. An AgentSession spawns the agent in a PTY, registers a session with the
 * cloud, opens the bridge WebSocket, and relays bytes both ways. Pure Node
 * (EventEmitter + node-pty + ws), no Electron — so it can be unit-tested.
 *
 * Framing matches the web/CLI: BINARY = terminal bytes, TEXT(JSON) = control.
 */
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const pty = require('node-pty');
const WebSocket = require('ws');

const CONFIG_DIR = path.join(os.homedir(), '.agentalpaca');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

// Default server, resolved once at load. Precedence:
//   1. ALPACA_SERVER env (dev override, e.g. http://127.0.0.1:8796)
//   2. app-config.json "defaultServer" (shipped default — the main server)
//   3. hardcoded fallback
let SHIPPED_DEFAULT = 'https://agentalpaca.app';
try {
  const cfg = require('../app-config.json');
  if (cfg && cfg.defaultServer) SHIPPED_DEFAULT = cfg.defaultServer;
} catch {}
const DEFAULT_SERVER = process.env.ALPACA_SERVER || SHIPPED_DEFAULT;

/**
 * Normalize a user-entered server into a valid absolute URL. A bare
 * `127.0.0.1:8796` (no scheme) isn't a valid fetch/URL target and throws
 * "fetch failed", so prepend a scheme: http:// for loopback, https:// otherwise.
 */
function normalizeServer(input) {
  let s = String(input || '').trim();
  if (!s) return DEFAULT_SERVER;
  if (!/^https?:\/\//i.test(s)) {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(s);
    s = (local ? 'http://' : 'https://') + s;
  }
  try {
    return new URL(s).toString().replace(/\/$/, '');
  } catch {
    throw new Error(`invalid server URL: "${input}"`);
  }
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return cfg;
}

/** Headers for authenticated bridge calls (bearer + optional Access service token). */
function authHeaders(cfg) {
  const h = { authorization: 'Bearer ' + cfg.token };
  if (cfg.accessClientId && cfg.accessClientSecret) {
    h['CF-Access-Client-Id'] = cfg.accessClientId;
    h['CF-Access-Client-Secret'] = cfg.accessClientSecret;
  }
  return h;
}

async function apiPost(server, pathname, cfg, body) {
  const url = normalizeServer(server) + pathname;
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cfg.token ? authHeaders(cfg) : {}) },
      body: JSON.stringify(body || {}),
    });
  } catch (e) {
    throw new Error(`could not reach ${url} (${e.message || e}). Check the server URL and that it's running.`);
  }
  let data = {};
  try {
    data = await r.json();
  } catch {}
  return { ok: r.ok, status: r.status, data };
}

/** Trade a pairing code for a saved bridge token. */
async function pair(server, code, label) {
  const srv = normalizeServer(server);
  const res = await apiPost(srv, '/api/bridge/claim', {}, { code: String(code).trim().toUpperCase(), label });
  if (!res.ok) throw new Error(res.data.error || `pairing failed (${res.status})`);
  return saveConfig({ server: srv, token: res.data.token, userId: res.data.userId, bridgeId: res.data.bridgeId, label });
}

function wsUrl(server, sid) {
  const u = new URL(server);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws/bridge';
  u.search = '?session=' + encodeURIComponent(sid);
  return u.toString();
}

/**
 * One launched agent. Emits: 'sid' (string), 'data' (string), 'status'
 * ({online:boolean}), 'exit' ({code}), 'error' (Error).
 */
class AgentSession extends EventEmitter {
  /**
   * @param {object} cfg host config (server, token, ...)
   * @param {{file:string, args:string[], label:string, cwd?:string, cols?:number, rows?:number}} spec
   */
  constructor(cfg, spec) {
    super();
    this.cfg = cfg;
    this.spec = spec;
    this.sid = null;
    this.term = null;
    this.ws = null;
    this.closed = false;
    this.online = false;
    this._outbuf = [];
    this._outBytes = 0;
    this._reconnectTimer = null;
    this._reconnectDelay = 800;
    this._server = normalizeServer(cfg.server || DEFAULT_SERVER);
  }

  async start() {
    const cols = this.spec.cols || 100;
    const rows = this.spec.rows || 30;
    const cmdLine = [this.spec.file, ...this.spec.args].join(' ');

    const reg = await apiPost(this._server, '/api/sessions', this.cfg, {
      label: this.spec.label,
      cmd: cmdLine,
      cols,
      rows,
    });
    if (!reg.ok) throw new Error(reg.data.error || `could not register session (${reg.status})`);
    this.sid = reg.data.id;
    this.emit('sid', this.sid);

    this.term = pty.spawn(this.spec.file, this.spec.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: this.spec.cwd || os.homedir(),
      env: process.env,
    });

    this.term.onData((d) => {
      this.emit('data', d); // local view (app window)
      this._sendBinary(Buffer.from(d, 'utf8')); // cloud
    });
    this.term.onExit(({ exitCode }) => {
      this.emit('exit', { code: exitCode });
      this._sendControl({ t: 'exit', code: exitCode });
      this.stop();
    });

    this._connect();
    return this.sid;
  }

  /** Local keystrokes (from the app window) into the PTY. */
  write(data) {
    if (this.term) this.term.write(data);
  }

  resize(cols, rows) {
    try {
      this.term && this.term.resize(cols, rows);
    } catch {}
    this._sendControl({ t: 'meta', cols, rows });
  }

  async stop() {
    if (this.closed) return;
    this.closed = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    try {
      this.term && this.term.kill();
    } catch {}
    try {
      this.ws && this.ws.close();
    } catch {}
    if (this.sid) await apiPost(this._server, '/api/sessions/close', this.cfg, { id: this.sid }).catch(() => {});
    this.emit('status', { online: false });
  }

  _connect() {
    this.ws = new WebSocket(wsUrl(this._server, this.sid), { headers: authHeaders(this.cfg) });
    this.ws.on('open', () => {
      this._reconnectDelay = 800;
      this.online = true;
      this.emit('status', { online: true });
      this._sendControl({ t: 'meta', title: this.spec.label, cmd: [this.spec.file, ...this.spec.args].join(' '), cols: this.term.cols, rows: this.term.rows });
      const pending = this._outbuf;
      this._outbuf = [];
      this._outBytes = 0;
      for (const b of pending) this.ws.send(b);
    });
    this.ws.on('message', (data, isBinary) => {
      if (isBinary && this.term) this.term.write(data.toString('utf8')); // remote input -> PTY
    });
    this.ws.on('close', () => {
      this.online = false;
      this.emit('status', { online: false });
      if (this.closed) return;
      this._reconnectTimer = setTimeout(() => this._connect(), this._reconnectDelay);
      this._reconnectDelay = Math.min(this._reconnectDelay * 1.6, 8000);
    });
    this.ws.on('error', () => {
      try {
        this.ws.close();
      } catch {}
    });
  }

  _sendBinary(buf) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(buf);
    } else {
      this._outbuf.push(buf);
      this._outBytes += buf.length;
      while (this._outBytes > 512 * 1024 && this._outbuf.length > 1) this._outBytes -= this._outbuf.shift().length;
    }
  }

  _sendControl(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }
}

module.exports = { loadConfig, saveConfig, pair, AgentSession, CONFIG_PATH, DEFAULT_SERVER };
