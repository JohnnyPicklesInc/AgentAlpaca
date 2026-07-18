/**
 * Copy third-party browser bundles out of node_modules into the app's vendor
 * dirs, so they're served first-party (the strict CSP forbids external script
 * hosts) and the vendor dirs can stay gitignored. Run after install:
 *   npm run vendor
 */
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// [source under node_modules, destination filename]
const XTERM = [
  ['node_modules/@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['node_modules/@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
];
const PUBLIC_EXTRA = [
  ['node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js', 'simplewebauthn-browser.js'],
];

async function vendor(destDir, files) {
  const dest = join(root, destDir);
  await mkdir(dest, { recursive: true });
  for (const [from, to] of files) {
    await copyFile(join(root, from), join(dest, to));
    console.log(`vendored ${destDir}/${to}`);
  }
}

// Web app needs xterm (terminal view) + simplewebauthn (passkeys).
await vendor('public/vendor', [...XTERM, ...PUBLIC_EXTRA]);
// Desktop app renderer needs xterm for its local terminal view.
await vendor('desktop/vendor', XTERM);
