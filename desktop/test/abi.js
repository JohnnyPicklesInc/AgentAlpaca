const pty = require('node-pty');
const agents = require('../lib/agents');
const t = pty.spawn('/bin/bash', ['-c', 'echo PTY_ABI_OK'], { name: 'xterm-256color', cols: 80, rows: 24 });
let out = '';
t.onData((d) => (out += d));
t.onExit(() => {
  console.log('node-pty under Electron ABI:', out.includes('PTY_ABI_OK') ? 'OK ✅' : 'FAIL ❌');
  console.log('agents detected:', agents.list().map((a) => `${a.id}=${a.installed}`).join(', '));
  process.exit(out.includes('PTY_ABI_OK') ? 0 : 1);
});
