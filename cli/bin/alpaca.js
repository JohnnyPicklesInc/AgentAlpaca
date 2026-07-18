#!/usr/bin/env node
/**
 * alpaca — the Agent Alpaca home bridge.
 *
 * Wraps any command in a real pseudo-terminal, mirrors its output to your local
 * terminal AND to Agent Alpaca, and injects remote keystrokes back into it. You
 * keep using the terminal locally as normal; the web view is a second seat.
 *
 *   alpaca pair ALPACA-7F3K [--server URL] [--label name]   link this machine
 *   alpaca -- claude                                         wrap a command
 *   alpaca                                                   wrap your $SHELL
 *   alpaca status | logout
 *
 * Config lives in ~/.agentalpaca/config.json.
 */
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

let pty, WebSocket;
try {
  pty = require('node-pty');
  WebSocket = require('ws');
} catch (e) {
  console.error('Missing dependencies. Run `npm install` inside the cli/ directory first.');
  process.exit(1);
}

const CONFIG_DIR = path.join(os.homedir(), '.agentalpaca');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_SERVER = process.env.ALPACA_SERVER || 'https://agentalpaca.app';

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
}

function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--server') flags.server = args[++i];
    else if (a === '--label') flags.label = args[++i];
    else rest.push(a);
  }
  return { flags, rest };
}

function wsUrl(server, sid) {
  const u = new URL(server);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws/bridge';
  u.search = '?session=' + encodeURIComponent(sid);
  return u.toString();
}

async function apiPost(server, pathname, token, body) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(server.replace(/\/$/, '') + pathname, {
    method: 'POST',
    headers,
    body: JSON.stringify(body || {}),
  });
  let data = {};
  try {
    data = await r.json();
  } catch {}
  return { ok: r.ok, status: r.status, data };
}

// --- commands ---------------------------------------------------------------

async function cmdPair(args) {
  const { flags, rest } = parseFlags(args);
  const code = (rest[0] || '').trim().toUpperCase();
  if (!code) {
    console.error('Usage: alpaca pair ALPACA-XXXX [--server URL] [--label name]');
    process.exit(1);
  }
  const server = flags.server || loadConfig().server || DEFAULT_SERVER;
  const label = flags.label || os.hostname();
  const { ok, data } = await apiPost(server, '/api/bridge/claim', null, { code, label });
  if (!ok) {
    console.error('Pairing failed:', data.error || 'unknown error');
    process.exit(1);
  }
  saveConfig({ server, token: data.token, userId: data.userId, bridgeId: data.bridgeId, label });
  console.log(`✓ Paired "${label}" with ${server}`);
  console.log('Now run:  alpaca -- claude   (or any command)');
}

function cmdStatus() {
  const cfg = loadConfig();
  if (!cfg.token) {
    console.log('Not paired. Run `alpaca pair <code>` with a code from the web app.');
    return;
  }
  console.log('Server:', cfg.server);
  console.log('Label: ', cfg.label);
  console.log('Paired: yes');
}

function cmdLogout() {
  try {
    fs.unlinkSync(CONFIG_PATH);
  } catch {}
  console.log('Removed local pairing. (Revoke the bridge in the web app to fully disable it.)');
}

async function cmdRun(args) {
  const cfg = loadConfig();
  if (!cfg.token) {
    console.error('This machine is not paired. In the web app click "Add a bridge", then run:');
    console.error('  alpaca pair ALPACA-XXXX');
    process.exit(1);
  }
  const server = cfg.server || DEFAULT_SERVER;

  // Command to wrap: everything after an optional `--`, else all args, else $SHELL.
  let cmdArgs = args;
  if (cmdArgs[0] === '--') cmdArgs = cmdArgs.slice(1);
  if (cmdArgs.length === 0) cmdArgs = [process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : 'bash')];
  const file = cmdArgs[0];
  const fileArgs = cmdArgs.slice(1);

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const label = `${cfg.label}: ${cmdArgs.join(' ')}`.slice(0, 120);

  // Register the session up front so it appears in the web list immediately.
  const reg = await apiPost(server, '/api/sessions', cfg.token, {
    label,
    cmd: cmdArgs.join(' '),
    cols,
    rows,
  });
  if (!reg.ok) {
    console.error('Could not register session:', reg.data.error || reg.status);
    process.exit(1);
  }
  const sid = reg.data.id;

  const term = pty.spawn(file, fileArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    env: process.env,
  });

  // --- outbound relay (buffered while the socket is down) ---
  let ws = null;
  let outbuf = [];
  let outBytes = 0;
  const OUTBUF_LIMIT = 512 * 1024;

  function sendBinary(buf) {
    if (ws && ws.readyState === 1) {
      ws.send(buf);
    } else {
      outbuf.push(buf);
      outBytes += buf.length;
      while (outBytes > OUTBUF_LIMIT && outbuf.length > 1) outBytes -= outbuf.shift().length;
    }
  }
  function sendControl(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  let closed = false;
  let reconnectTimer = null;
  let reconnectDelay = 800;

  function connect() {
    ws = new WebSocket(wsUrl(server, sid), { headers: { authorization: 'Bearer ' + cfg.token } });
    ws.on('open', () => {
      reconnectDelay = 800;
      ws.send(JSON.stringify({ t: 'meta', title: label, cmd: cmdArgs.join(' '), cols: term.cols, rows: term.rows }));
      const pending = outbuf;
      outbuf = [];
      outBytes = 0;
      for (const b of pending) ws.send(b);
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) term.write(data.toString('utf8')); // remote keystrokes -> PTY
    });
    ws.on('close', () => {
      if (closed) return;
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.6, 8000);
    });
    ws.on('error', () => {
      try {
        ws.close();
      } catch {}
    });
  }

  // --- PTY output -> local terminal + relay ---
  term.onData((d) => {
    process.stdout.write(d);
    sendBinary(Buffer.from(d, 'utf8'));
  });

  // --- local keyboard -> PTY (raw passthrough) ---
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (d) => term.write(d.toString('utf8')));

  // --- resize ---
  process.stdout.on('resize', () => {
    const c = process.stdout.columns || 80;
    const r = process.stdout.rows || 24;
    try {
      term.resize(c, r);
    } catch {}
    sendControl({ t: 'meta', cols: c, rows: r });
  });

  // --- teardown ---
  async function cleanup(code) {
    if (closed) return;
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    sendControl({ t: 'exit', code });
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch {}
    process.stdin.pause();
    try {
      ws && ws.close();
    } catch {}
    await apiPost(server, '/api/sessions/close', cfg.token, { id: sid }).catch(() => {});
  }

  term.onExit(({ exitCode }) => {
    cleanup(exitCode).finally(() => {
      process.stdout.write(`\r\n[alpaca] session ended (exit ${exitCode})\r\n`);
      process.exit(exitCode || 0);
    });
  });

  process.on('SIGTERM', () => cleanup(0).finally(() => process.exit(0)));

  console.error(`[alpaca] streaming to ${server} — watch at ${server.replace(/\/$/, '')}/app.html\r`);
  connect();
}

function usage() {
  console.log(`alpaca — watch and drive your terminal agents from anywhere

Usage:
  alpaca pair <CODE> [--server URL] [--label name]   Pair this machine (code from the web app)
  alpaca -- <command...>                             Wrap a command (e.g. alpaca -- claude)
  alpaca                                             Wrap your \$SHELL
  alpaca status                                      Show pairing status
  alpaca logout                                      Remove local pairing

Env:
  ALPACA_SERVER   Default server URL (overridden by --server / saved config)`);
}

async function main() {
  const argv = process.argv.slice(2);
  const first = argv[0];
  if (first === 'pair') return cmdPair(argv.slice(1));
  if (first === 'status') return cmdStatus();
  if (first === 'logout') return cmdLogout();
  if (first === 'help' || first === '--help' || first === '-h') return usage();
  return cmdRun(argv); // everything else is a command to wrap
}

main().catch((e) => {
  console.error('[alpaca]', e.message || e);
  process.exit(1);
});
