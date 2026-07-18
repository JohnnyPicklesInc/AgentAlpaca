#!/usr/bin/env node
/**
 * node-pty ships a small `spawn-helper` binary in its prebuilds, but npm's
 * tarball extraction sometimes drops the executable bit — which makes every
 * pty.spawn() fail with "posix_spawnp failed". Restore +x here so a fresh
 * `npm install` just works. No-op on Windows.
 */
'use strict';
const fs = require('fs');
const path = require('path');

if (process.platform === 'win32') process.exit(0);

const prebuilds = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
try {
  for (const dir of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, dir, 'spawn-helper');
    if (fs.existsSync(helper)) {
      fs.chmodSync(helper, 0o755);
    }
  }
} catch {
  // node-pty layout changed or not installed yet; nothing to fix.
}
