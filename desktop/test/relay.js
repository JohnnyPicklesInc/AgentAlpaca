// Full host relay test (run under Electron's node: node-pty needs the ABI).
// Uses lib/host.js AgentSession against a live dev server, plus a viewer socket
// to confirm output streams out AND remote input reaches the PTY.
const WebSocket = require('ws');
const { AgentSession } = require('../lib/host');

const server = process.env.TEST_SERVER;
const token = process.env.TEST_TOKEN;
const cookie = process.env.TEST_COOKIE;
const wsBase = server.replace('http', 'ws');

const results = { registered: false, viewerOutput: false, inputRoundTrip: false };

const s = new AgentSession(
  { server, token },
  { file: '/bin/bash', args: ['-c', 'echo DESKTOP_OK_$((3*4)); cat'], label: 'desktop-test', cols: 80, rows: 24 },
);

s.on('sid', (sid) => {
  results.registered = true;
  const v = new WebSocket(`${wsBase}/ws/view?session=${sid}`, { headers: { cookie } });
  v.binaryType = 'arraybuffer';
  v.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const t = Buffer.from(data).toString('utf8');
    if (t.includes('DESKTOP_OK_12')) results.viewerOutput = true;
    if (t.includes('PING_FROM_VIEWER')) results.inputRoundTrip = true;
  });
  v.on('open', () => setTimeout(() => v.send(Buffer.from('PING_FROM_VIEWER\n', 'utf8')), 400));
});

s.on('error', (e) => console.log('session error:', e.message));

s.start().catch((e) => {
  console.log('start failed:', e.message);
  process.exit(1);
});

setTimeout(() => {
  console.log(JSON.stringify(results, null, 2));
  const ok = results.registered && results.viewerOutput && results.inputRoundTrip;
  console.log(ok ? 'DESKTOP RELAY OK ✅' : 'DESKTOP RELAY FAILED ❌');
  s.stop().finally(() => process.exit(ok ? 0 : 1));
}, 2500);
