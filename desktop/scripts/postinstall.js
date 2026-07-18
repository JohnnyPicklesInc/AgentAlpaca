#!/usr/bin/env node
/**
 * Restore node-pty's spawn-helper exec bit (npm extraction sometimes drops it,
 * which makes pty.spawn fail with "posix_spawnp failed"). Runs before the
 * electron-rebuild step. No-op on Windows.
 */
'use strict';
const fs = require('fs');
const path = require('path');
if (process.platform === 'win32') process.exit(0);
const prebuilds = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
try {
  for (const dir of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, dir, 'spawn-helper');
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
} catch {}
