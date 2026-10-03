// Minimal PNG writer (RGB/RGBA, 8-bit) for previews. Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
import { deflateSync } from 'node:zlib';
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** pixels: Uint8Array w*h*ch, ch = 3 or 4 */
export function encodePng(w, h, pixels, ch = 3) {
  const raw = Buffer.alloc((w * ch + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * ch + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * w * ch, w * ch).copy(raw, y * (w * ch + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ch === 4 ? 6 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

// tiny 4x5 font for labels on previews
const FONT = { a:'7d7d5',b:'6576e',c:'7444f',d:'6555e',e:'7464f',f:'74644',g:'7457f',h:'55755',i:'72227',j:'1155f',k:'55655',l:'4444f',m:'57755',n:'75555',o:'7555f',p:'75744',q:'75571',r:'75655',s:'7471f',t:'72222',u:'5555f',v:'55552',w:'55775',x:'55255',y:'55722',z:'7124f','0':'7555f','1':'26227','2':'7174f','3':'7171f','4':'55711','5':'7471f','6':'7475f','7':'71111','8':'7575f','9':'7571f','_':'0000f','+':'02720','*':'05250','-':'00700','.':'00002',':':'02020','/':'11244' };
export function drawText(px, W, H, x, y, s, rgb = [235, 235, 235], scale = 1) {
  for (const ch of s.toLowerCase()) {
    const g = FONT[ch] || '00000';
    for (let r = 0; r < 5; r++) {
      const bits = parseInt(g[r], 16);
      for (let c = 0; c < 4; c++) if (bits & (8 >> c)) {
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
          const X = x + c * scale + dx, Y = y + r * scale + dy;
          if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
          const i = (Y * W + X) * 3; px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2];
        }
      }
    }
    x += 5 * scale;
  }
}
export function drawRect(px, W, H, x, y, w, h, rgb) {
  for (let Y = Math.max(0, y); Y < Math.min(H, y + h); Y++) for (let X = Math.max(0, x); X < Math.min(W, x + w); X++) {
    const i = (Y * W + X) * 3; px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2];
  }
}
