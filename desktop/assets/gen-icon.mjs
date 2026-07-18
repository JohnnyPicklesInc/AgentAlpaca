/**
 * Generate the tray + app icons with no image deps (built-in zlib only).
 *   - trayTemplate.png : 22x22 black rounded-square glyph on transparent
 *     (macOS "template" image — the OS recolors it for light/dark menu bars).
 *   - icon.png         : 512x512 purple rounded square (window / installer icon).
 * Run: node assets/gen-icon.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function png(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.subarray(y * width * 4, (y + 1) * width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function roundedSquare(size, [r, g, b], radiusFrac) {
  const rgba = Buffer.alloc(size * size * 4);
  const rad = size * radiusFrac;
  const pad = size * 0.08;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // distance into a rounded-rect mask
      const dx = Math.max(pad + rad - x, 0, x - (size - pad - rad));
      const dy = Math.max(pad + rad - y, 0, y - (size - pad - rad));
      const inside = Math.hypot(dx, dy) <= rad;
      const i = (y * size + x) * 4;
      if (inside) {
        rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
      }
    }
  }
  return png(size, size, rgba);
}

writeFileSync(join(here, 'trayTemplate.png'), roundedSquare(22, [0, 0, 0], 0.28));
writeFileSync(join(here, 'trayTemplate@2x.png'), roundedSquare(44, [0, 0, 0], 0.28));
writeFileSync(join(here, 'icon.png'), roundedSquare(512, [124, 92, 255], 0.22));
console.log('wrote trayTemplate.png, trayTemplate@2x.png, icon.png');
