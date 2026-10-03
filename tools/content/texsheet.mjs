#!/usr/bin/env node
// Contact sheet of a LibreQuake texture WAD: node tools/content/texsheet.mjs lq_tech [filter] > out.png
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from './fetch.mjs';
import { wadTextures } from './lib/wad.mjs';
import { pakEntries } from './lib/archive.mjs';
import { encodePng } from './lib/png.mjs';
const [wadName, filter = '', out = `/tmp/${wadName}.png`] = process.argv.slice(2);
const pal = pakEntries(readFileSync(join(PATHS.lq, 'pak0.pak'))).get('gfx/palette.lmp');
const tex = [...wadTextures(readFileSync(join(PATHS.wads, `${wadName}.wad`))).values()]
  .filter((t) => t.name.includes(filter) && !/^\+[1-9a-j]/.test(t.name)).sort((a, b) => a.name.localeCompare(b.name));
const CELL = 136, COLS = 8, rows = Math.ceil(tex.length / COLS);
const W = COLS * CELL, H = rows * (CELL + 10);
const px = new Uint8Array(W * H * 3).fill(40);
// tiny 3x5 font for labels
const F = { a:'7d7d5',b:'6576e',c:'7444f',d:'6555e',e:'7464f',f:'74644',g:'7457f',h:'55755',i:'72227',j:'1155f',k:'55655',l:'4444f',m:'57755',n:'75555',o:'7555f',p:'75744',q:'75571',r:'75655',s:'7471f',t:'72222',u:'5555f',v:'55552',w:'55775',x:'55255',y:'55722',z:'7124f','0':'7555f','1':'26227','2':'7174f','3':'7171f','4':'55711','5':'7471f','6':'7475f','7':'71111','8':'7575f','9':'7571f','_':'0000f','+':'02720','*':'05250','-':'00700' };
function text(x, y, s) { for (const ch of s) { const g = F[ch] || '00000'; for (let r = 0; r < 5; r++) { const bits = parseInt(g[r], 16); for (let c = 0; c < 4; c++) if (bits & (8 >> c)) { const i = ((y + r) * W + x + c) * 3; px[i] = px[i + 1] = px[i + 2] = 230; } } x += 5; } }
tex.forEach((t, k) => {
  const cx = (k % COLS) * CELL, cy = Math.floor(k / COLS) * (CELL + 10);
  const s = Math.max(t.w, t.h) > 128 ? Math.max(t.w, t.h) / 128 : 1;
  for (let y = 0; y < Math.min(128, t.h / s); y++) for (let x = 0; x < Math.min(128, t.w / s); x++) {
    const c = t.pixels[Math.floor(y * s) * t.w + Math.floor(x * s)];
    const i = ((cy + y) * W + cx + x) * 3;
    px[i] = pal[c * 3]; px[i + 1] = pal[c * 3 + 1]; px[i + 2] = pal[c * 3 + 2];
  }
  text(cx, cy + 130, t.name.slice(0, 26));
});
writeFileSync(out, encodePng(W, H, px));
console.log(out, tex.length);
