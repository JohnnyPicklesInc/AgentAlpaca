// Headless Electron smoke test: confirm the lib modules load and node-pty
// spawns a PTY under the Electron ABI. No windows/tray. Exits 0 on success.
const { app } = require('electron');
const agents = require('../lib/agents');
const pty = require('node-pty');

app.whenReady().then(() => {
  let out = '';
  const t = pty.spawn('/bin/bash', ['-c', 'echo ELECTRON_PTY_OK && ls / | head -2'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
  });
  t.onData((d) => (out += d));
  t.onExit(({ exitCode }) => {
    const list = agents.list();
    console.log('AGENTS:', list.map((a) => `${a.id}:${a.installed}`).join(', '));
    console.log('PTY_OUT:', JSON.stringify(out.replace(/\r?\n/g, ' ').trim()).slice(0, 120));
    const ok = out.includes('ELECTRON_PTY_OK') && exitCode === 0;
    console.log(ok ? 'SMOKE_OK ✅' : 'SMOKE_FAIL ❌');
    app.exit(ok ? 0 : 1);
  });
});

setTimeout(() => {
  console.log('SMOKE_TIMEOUT ❌');
  app.exit(2);
}, 8000);
