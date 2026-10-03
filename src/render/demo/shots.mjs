// Screenshot + measurement driver for render.html (headless Chromium, swiftshader).
// Usage: node src/render/demo/shots.mjs [maps=lqdm1,lqdm2] [presets=modern,classic] [views=3] [w=1280] [h=720]
// Needs the dev server: npx vite --config src/render/demo/vite.config.js
// Writes docs/shots/renderer/<map>-<view>-<preset>.png and prints draw calls / tris / CPU ms.
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
import { chromium } from '/app/data/home/arrr-mono/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const arg = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const maps = (arg.maps ?? Array.from({ length: 13 }, (_, i) => `lqdm${i + 1}`).join(',')).split(',');
const presets = (arg.presets ?? 'modern,classic').split(',');
const nviews = Number(arg.views ?? 3);
const W = Number(arg.w ?? 1280), H = Number(arg.h ?? 720);
const out = path.resolve(arg.out ?? 'docs/shots/renderer');
const port = arg.port ?? 5293;
const fx = arg.fx === '1';
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${port}/render.html?manual=1&map=${maps[0]}`);
await page.waitForFunction(() => document.title === 'ready', null, { timeout: 180000 });

const results = [];
for (const map of maps) {
  await page.evaluate((m) => window.__qt.loadMap(m), map);
  const views = await page.evaluate((n) => {
    const s = window.__qt.spawns();
    const out = [];
    for (let i = 0; i < s.length && out.length < n; i += Math.max(1, Math.floor(s.length / n))) out.push(s[i]);
    return out;
  }, nviews);
  for (let v = 0; v < views.length; v++) {
    const sp = views[v];
    for (const preset of presets) {
      await page.evaluate(([p]) => window.__qt.setPreset(p), [preset]);
      await page.evaluate(([x, y, z, yaw]) => window.__qt.setView(x, y, z + 22, 8, yaw), [sp.x, sp.y, sp.z, sp.yaw]);
      let t = 10 + v;
      if (fx) {
        await page.evaluate(([tt]) => { window.__qt.fireRocket(tt); }, [t - 0.5]);
      }
      // warm up (texture uploads, shader compiles), then measure
      for (let k = 0; k < 3; k++) await page.evaluate((tt) => window.__qt.render(tt), t + k * 0.016);
      const ms = [], prep = [];
      let st;
      for (let k = 0; k < 10; k++) {
        st = await page.evaluate((tt) => window.__qt.render(tt), t + 0.05 + k * 0.007);
        ms.push(st.ms); prep.push(st.prepMs);
      }
      ms.sort((a, b) => a - b); prep.sort((a, b) => a - b);
      const file = path.join(out, `${map}-${v}-${preset}.png`);
      const url = await page.evaluate((tt) => { window.__qt.render(tt); return document.getElementById('c').toDataURL('image/png'); }, t + 0.12);
      fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
      const r = { map, view: v, preset, calls: st.drawCalls, tris: st.tris, faces: st.faces, leafs: st.leafs, cpuMedian: +ms[5].toFixed(2), cpuMax: +ms[9].toFixed(2), prepMedian: +prep[5].toFixed(2), prepMax: +prep[9].toFixed(2), file: path.relative(process.cwd(), file) };
      results.push(r);
      console.log(JSON.stringify(r));
    }
  }
}
fs.writeFileSync(path.join(out, 'stats.json'), JSON.stringify(results, null, 1));
await browser.close();
