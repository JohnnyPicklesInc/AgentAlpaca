/**
 * Copy the xterm.js UMD build + CSS out of node_modules into public/vendor so
 * they are served first-party (the strict CSP forbids third-party script hosts).
 * Run after install:  npm run vendor
 */
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'public', 'vendor');
await mkdir(dest, { recursive: true });

const files = [
  ['node_modules/@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['node_modules/@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
];

for (const [from, to] of files) {
  await copyFile(join(root, from), join(dest, to));
  console.log(`vendored ${to}`);
}
