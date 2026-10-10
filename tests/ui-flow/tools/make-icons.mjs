// Generates the PWA icons with node:zlib only (no deps).
// Usage: node tests/ui-flow/tools/make-icons.mjs [outDir=public/icons]
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const BG = [0x11, 0x11, 0x11, 255];
const WHITE = [0xf5, 0xf5, 0xf5, 255];
const AMBER = [0xff, 0xb0, 0x20, 255];

/** Dark square, white tape-measure ring with an amber tab; `scale` shrinks the art (maskable safe zone). */
function art(scale) {
  return (x, y, s) => {
    const cx = s / 2, cy = s / 2;
    const r = Math.hypot(x - cx, y - cy) / s;
    const outer = 0.32 * scale, inner = 0.2 * scale;
    if (r <= outer && r >= inner) return WHITE;
    // tape tab sticking out to the right
    const tx = (x - cx) / s, ty = (y - cy) / s;
    if (tx >= 0 && tx <= 0.42 * scale && Math.abs(ty - 0.26 * scale) <= 0.06 * scale) return AMBER;
    return BG;
  };
}

const out = process.argv[2] ?? "public/icons";
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "icon-192.png"), png(192, art(1)));
writeFileSync(join(out, "icon-512.png"), png(512, art(1)));
writeFileSync(join(out, "icon-512-maskable.png"), png(512, art(0.75)));
console.log("icons written to", out);
