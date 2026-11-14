// Minimal PNG codec for the README art: decode 8-bit non-interlaced PNGs (grey, RGB, palette, grey+alpha, RGBA) to
// RGBA, trim transparent margins, and re-encode losslessly (palette when ≤ 256 colours, else RGB/RGBA; per-row
// adaptive filters, zlib level 9). No dependencies beyond node:zlib.
import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** @returns {{ width: number, height: number, data: Buffer }} RGBA, 4 bytes per pixel. */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let width = 0, height = 0, type = 0, palette = null, alpha = null;
  const idat = [];
  for (let i = 8; i < buf.length;) {
    const len = buf.readUInt32BE(i), kind = buf.toString('latin1', i + 4, i + 8), body = buf.subarray(i + 8, i + 8 + len);
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4); type = body[9];
      if (body[8] !== 8 || body[12] !== 0) throw new Error('only 8-bit non-interlaced PNGs are supported');
    } else if (kind === 'PLTE') palette = body;
    else if (kind === 'tRNS') alpha = body;
    else if (kind === 'IDAT') idat.push(body);
    i += 12 + len;
  }
  const bpp = CHANNELS[type], stride = width * bpp, raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = px.subarray(y * stride, (y + 1) * stride), up = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0, b = up ? up[x] : 0, c = up && x >= bpp ? up[x - bpp] : 0;
      row[x] = (src[x] + (filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : 0)) & 255;
    }
  }
  const data = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const s = p * bpp, d = p * 4;
    if (type === 6) px.copy(data, d, s, s + 4);
    else if (type === 2) { px.copy(data, d, s, s + 3); data[d + 3] = 255; }
    else if (type === 3) { const k = px[s]; palette.copy(data, d, k * 3, k * 3 + 3); data[d + 3] = alpha && k < alpha.length ? alpha[k] : 255; }
    else { data[d] = data[d + 1] = data[d + 2] = px[s]; data[d + 3] = type === 4 ? px[s + 1] : 255; }
  }
  return { width, height, data };
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Crops to the non-transparent bounding box, then pads every side with `pad` transparent pixels. */
export function trim(img, pad) {
  const { width, height, data } = img;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) throw new Error('render is fully transparent');
  const w = x1 - x0 + 1 + pad * 2, h = y1 - y0 + 1 + pad * 2, out = Buffer.alloc(w * h * 4);
  for (let y = y0; y <= y1; y++) data.copy(out, ((y - y0 + pad) * w + pad) * 4, (y * width + x0) * 4, (y * width + x1 + 1) * 4);
  return { width: w, height: h, data: out };
}

/** Lossless PNG: palette (with tRNS) when the image has ≤ 256 distinct RGBA values, else RGB or RGBA. */
export function encodePng({ width, height, data }) {
  const colours = new Map();
  let opaque = true;
  for (let p = 0; p < width * height; p++) {
    if (data[p * 4 + 3] !== 255) opaque = false;
    if (colours.size <= 256) { const key = data.readUInt32BE(p * 4); if (!colours.has(key)) colours.set(key, colours.size); }
  }
  let type, bpp, px;
  const chunks = [];
  if (colours.size <= 256) {
    // Translucent entries first keeps tRNS short.
    const keys = [...colours.keys()].sort((a, b) => (a & 255) - (b & 255) || a - b);
    const index = new Map(keys.map((k, i) => [k, i]));
    const plte = Buffer.alloc(keys.length * 3), trns = Buffer.alloc(keys.length);
    keys.forEach((k, i) => { plte[i * 3] = k >>> 24; plte[i * 3 + 1] = (k >>> 16) & 255; plte[i * 3 + 2] = (k >>> 8) & 255; trns[i] = k & 255; });
    const lastTranslucent = trns.findLastIndex((a) => a !== 255);
    type = 3; bpp = 1; px = Buffer.alloc(width * height);
    for (let p = 0; p < width * height; p++) px[p] = index.get(data.readUInt32BE(p * 4));
    chunks.push(['PLTE', plte]);
    if (lastTranslucent >= 0) chunks.push(['tRNS', trns.subarray(0, lastTranslucent + 1)]);
  } else if (opaque) {
    type = 2; bpp = 3; px = Buffer.alloc(width * height * 3);
    for (let p = 0; p < width * height; p++) data.copy(px, p * 3, p * 4, p * 4 + 3);
  } else { type = 6; bpp = 4; px = data; }
  const stride = width * bpp, raw = Buffer.alloc((stride + 1) * height), trial = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = px.subarray(y * stride, (y + 1) * stride), up = y ? px.subarray((y - 1) * stride, y * stride) : null;
    let best = 0, bestScore = Infinity;
    // Palette rows compress best unfiltered; true-colour rows pick the filter with the smallest absolute sum.
    for (const f of type === 3 ? [0] : [0, 1, 2, 3, 4]) {
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? row[x - bpp] : 0, b = up ? up[x] : 0, c = up && x >= bpp ? up[x - bpp] : 0;
        const v = (row[x] - (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? paeth(a, b, c) : 0)) & 255;
        trial[x] = v; score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) { bestScore = score; best = f; trial.copy(raw, y * (stride + 1) + 1); }
    }
    raw[y * (stride + 1)] = best;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = type;
  const idat = deflateSync(raw, { level: 9, memLevel: 9 });
  return Buffer.concat([SIGNATURE, ...[['IHDR', ihdr], ...chunks, ['IDAT', idat], ['IEND', Buffer.alloc(0)]].map(([k, b]) => chunk(k, b))]);
}

function chunk(kind, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0); head.write(kind, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Fraction of pixels whose colour (premultiplied by alpha) or alpha differs by more than `tolerance` in any channel;
 * 1 when the sizes differ.
 */
export function diffRatio(a, b, tolerance) {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let bad = 0;
  for (let p = 0; p < a.width * a.height; p++) {
    const i = p * 4, aa = a.data[i + 3], ba = b.data[i + 3];
    let off = Math.abs(aa - ba) > tolerance;
    for (let c = 0; c < 3 && !off; c++) off = Math.abs((a.data[i + c] * aa - b.data[i + c] * ba) / 255) > tolerance;
    if (off) bad++;
  }
  return bad / (a.width * a.height);
}
