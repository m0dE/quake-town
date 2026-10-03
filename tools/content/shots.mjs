#!/usr/bin/env node
// Screenshots of our maps in the real renderer (src/render test page, headless Chromium).
//   RENDER_PORT=5297 npx vite --config src/render/demo/vite.config.js &   (maps linked into .cache/render-test/maps)
//   node tools/content/shots.mjs [maps=qt_aero,qt_tower,qt_fort] [preset=modern] [port=5297]
// Cameras: content/maps/<map>.mjs `shots` export, else the map's spawns.
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
import { chromium } from '/app/data/home/arrr-mono/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { parseBsp } from './lib/bsp.mjs';
import { zipEntries, zipRead } from './lib/archive.mjs';

// our own flag model from the built base pack (the test page's pak0 has none)
function flagMdl() {
  const idx = JSON.parse(fs.readFileSync('public/packs/index.json', 'utf8'));
  const base = idx.find((e) => e.kind === 'base');
  const z = fs.readFileSync(path.join('public/packs', base.file));
  return zipRead(z, zipEntries(z).get('progs/flag.mdl')).toString('base64');
}

const arg = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const maps = (arg.maps ?? 'qt_aero,qt_tower,qt_fort').split(',');
const presets = (arg.preset ?? 'modern').split(',');
const port = arg.port ?? 5297;
const out = path.resolve(arg.out ?? 'docs/shots/content');
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`http://127.0.0.1:${port}/render.html?manual=1&map=${maps[0]}`);
  await page.waitForFunction(() => document.title === 'ready', null, { timeout: 180000 });
  for (const map of maps) {
    await page.evaluate((m) => window.__qt.loadMap(m), map);
    const bsp = parseBsp(fs.readFileSync(path.join('.cache/render-test/maps', `${map}.bsp`)));
    const flags = bsp.ents.filter((e) => /^item_flag_team[12]$/.test(e.classname)).map((e) => {
      const o = e.origin.split(' ').map(Number);
      return { x: o[0], y: o[1], z: o[2] - 8, skin: e.classname.endsWith('1') ? 0 : 1 };
    });
    if (flags.length) {
      await page.evaluate(([b64, fl]) => {
        const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        window.__qt.renderer.vfs.add('progs/flag.mdl', bin);
        for (const f of fl) window.__qt.things().push({ model: 'progs/flag.mdl', x: f.x, y: f.y, z: f.z, yaw: 90, frame: 2, skin: f.skin, effects: 0, kind: 'static' });
      }, [flagMdl(), flags]);
    }
    let cams = [];
    try { const mod = await import(path.resolve('content/maps', `${map}.mjs`)); cams = mod.shots ?? []; } catch { /* none */ }
    if (!cams.length) cams = (await page.evaluate(() => window.__qt.spawns())).slice(0, 4).map((s) => [s.x, s.y, s.z + 22, 8, s.yaw]);
    for (let v = 0; v < cams.length; v++) {
      for (const preset of presets) {
        await page.evaluate(([p]) => window.__qt.setPreset(p), [preset]);
        await page.evaluate((c) => window.__qt.setView(...c), cams[v]);
        for (let k = 0; k < 3; k++) await page.evaluate((tt) => window.__qt.render(tt), 10 + k * 0.016);
        const st = await page.evaluate((tt) => window.__qt.render(tt), 10.1);
        const url = await page.evaluate((tt) => { window.__qt.render(tt); return document.getElementById('c').toDataURL('image/png'); }, 10.12);
        const file = path.join(out, `${map}-${v}-${preset}.png`);
        fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
        console.log(file, `calls ${st.drawCalls} tris ${st.tris} cpu ${st.ms?.toFixed?.(2)} ms`);
      }
    }
  }
} finally {
  await browser.close();
}
