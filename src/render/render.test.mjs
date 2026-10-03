// Renderer unit tests (no GPU): loaders, lightmap atlas, PVS/culling, light point, MDL/SPR,
// particles, palette.   npx tsx src/render/render.test.mjs
// Needs the LibreQuake test data in .cache/render-test/ (maps/*.bsp, pak0.pak) — see README.
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBsp, decompressVis, parseEntities } from './bsp.ts';
import { WorldGeometry } from './world.ts';
import { loadMdl, loadSpr, mdlPose } from './mdl.ts';
import { Palette, playerTranslation } from './palette.ts';
import { Particles, Dlights } from './effects.ts';
import { PakVfs } from './demo/pakvfs.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const data = path.join(root, '.cache/render-test');
if (!fs.existsSync(path.join(data, 'pak0.pak'))) {
  console.log('SKIP: no test data in .cache/render-test (see src/render/README.md)');
  process.exit(0);
}
let n = 0;
const test = (name, fn) => {
  const t0 = performance.now();
  try { fn(); n++; console.log(`ok ${name} (${(performance.now() - t0).toFixed(0)} ms)`); } catch (e) { console.error(`FAIL ${name}`); throw e; }
};

const vfs = new PakVfs();
vfs.mountPak(new Uint8Array(fs.readFileSync(path.join(data, 'pak0.pak'))));
const pal = Palette.fromVfs(vfs);
const STYLES = new Float32Array(64).fill(1);

test('palette: fullbrights detected from the colormap (id/LQ layout: 224..254)', () => {
  let nfb = 0;
  for (let i = 0; i < 256; i++) nfb += pal.fullbright[i];
  assert.ok(nfb >= 16 && nfb <= 40, `fullbright count ${nfb}`);
  assert.equal(pal.fullbright[240], 1);
  assert.equal(pal.fullbright[15], 0);
});

test('palette: player translation (rows 1 and 6 forward, rows 8..13 backwards)', () => {
  const t = playerTranslation(4, 12);
  assert.equal(t[16], 64); assert.equal(t[31], 79);       // top 4 → 64..79
  assert.equal(t[96], 192 + 15); assert.equal(t[111], 192); // bottom 12 → reversed 207..192
  assert.equal(t[0], 0); assert.equal(t[255], 255);
});

const maps = fs.readdirSync(path.join(data, 'maps')).filter((f) => f.endsWith('.bsp')).sort();
for (const m of maps) {
  test(`world: ${m}`, () => {
    const bytes = new Uint8Array(fs.readFileSync(path.join(data, 'maps', m)));
    const litp = path.join(data, 'maps', m.replace('.bsp', '.lit'));
    const lit = fs.existsSync(litp) ? new Uint8Array(fs.readFileSync(litp)) : null;
    const bsp = loadBsp(bytes, lit);
    if (lit) assert.ok(bsp.lit, '.lit accepted');
    const g = new WorldGeometry(bsp);
    // every lightmapped vertex samples inside its page
    for (let v = 0; v < g.numVerts; v++) {
      if (g.styles[v * 4] === 255) continue;
      const u = g.lm[v * 3], w = g.lm[v * 3 + 1];
      assert.ok(u > 0 && u < 1 && w > 0 && w < 1, `lightmap uv in page (${u}, ${w})`);
    }
    // style blocks never overlap: rasterise allocations into a coverage map per page
    const cover = g.pages.map((p) => new Uint8Array(p.width * p.height));
    for (let f = 0; f < bsp.numFaces; f++) {
      const page = g.facePage[f];
      if (page < 0) continue;
      const pg = g.pages[page];
      const v0 = g.faceIdx[g.faceIdxStart[f]];
      const smax = (bsp.faceExtents[f * 2] >> 4) + 1, tmax = (bsp.faceExtents[f * 2 + 1] >> 4) + 1;
      let ns = 0; while (ns < 4 && bsp.faceStyles[f * 4 + ns] !== 255) ns++;
      // block origin from the vertex uv: u*W = (s - mins)/16 + 1.5 + x
      const ti = bsp.faceTexinfo[f] * 8, T = bsp.texVecs, P = g.position;
      const s = P[v0 * 3] * T[ti] + P[v0 * 3 + 1] * T[ti + 1] + P[v0 * 3 + 2] * T[ti + 2] + T[ti + 3];
      const t = P[v0 * 3] * T[ti + 4] + P[v0 * 3 + 1] * T[ti + 5] + P[v0 * 3 + 2] * T[ti + 6] + T[ti + 7];
      const bx = Math.round(g.lm[v0 * 3] * pg.width - (s - bsp.faceTexMins[f * 2]) / 16 - 1.5);
      const by = Math.round(g.lm[v0 * 3 + 1] * pg.height - (t - bsp.faceTexMins[f * 2 + 1]) / 16 - 1.5);
      const w = (smax + 2) * ns, h = tmax + 2;
      for (let y = by; y < by + h; y++) for (let x = bx; x < bx + w; x++) {
        assert.ok(x >= 0 && y >= 0 && x < pg.width && y < pg.height, 'block inside page');
        assert.equal(cover[page][y * pg.width + x], 0, `overlap at ${x},${y} page ${page}`);
        cover[page][y * pg.width + x] = 1;
      }
    }
    // PVS + culling from every spawn point, with a 360° "frustum" (no planes)
    const ents = parseEntities(bsp.entities);
    const spawns = ents.filter((e) => e.classname === 'info_player_deathmatch');
    assert.ok(spawns.length > 0, 'has deathmatch spawns');
    const vis = new Uint8Array(((bsp.models[0].visleafs + 7) >> 3) + 4);
    for (const sp of spawns) {
      const [x, y, z] = sp.origin.split(' ').map(Number);
      const leaf = g.leafAt(x, y, z + 22);
      assert.ok(leaf > 0, 'spawn eye is in a real leaf');
      assert.notEqual(bsp.leafContents[leaf], -2, 'spawn eye is not in solid');
      decompressVis(bsp, leaf, vis);
      assert.ok(vis[(leaf - 1) >> 3] & (1 << ((leaf - 1) & 7)), 'leaf sees itself');
      g.cull(x, y, z + 22, new Float32Array(0), 0, false);
      assert.ok(g.stats.faces > 20, `faces visible from spawn: ${g.stats.faces}`);
      for (let b = 0; b < g.batches.length; b++) {
        for (let k = g.batchStart[b]; k < g.batchStart[b] + g.batchCount[b]; k++) assert.ok(g.worldIndices[k] < g.numVerts);
      }
      // light under the spawn: floors are lit
      const L = new Float32Array(3);
      assert.ok(g.lightPoint(x, y, z, STYLES, L), 'light point hits the floor');
      assert.ok(L[0] + L[1] + L[2] > 0, 'spawn floor is lit');
    }
    // culling cost (hot path, no allocation): 1000 culls
    const sp = spawns[0].origin.split(' ').map(Number);
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) g.cull(sp[0] + (i & 7), sp[1], sp[2] + 22, new Float32Array(0), 0, false);
    const us = ((performance.now() - t0) / 1000) * 1000;
    console.log(`   ${m}: ${bsp.version} faces ${bsp.numFaces} batches ${g.batches.length} lightmap pages ${g.pages.map((p) => p.width + 'x' + p.height).join(',')} cull ${us.toFixed(0)} µs (no frustum)`);
  });
}

test('mdl: player.mdl loads, seam split, poses', () => {
  const m = loadMdl(vfs.get('progs/player.mdl'));
  assert.ok(m.frames.length > 100, `frames ${m.frames.length}`);
  assert.ok(m.frames.length >= 17, 'stand1..5 at 12..16 (QC $frame order)');
  assert.ok(m.numDrawVerts >= m.numVerts, 'seam verts split');
  for (const i of m.indices) assert.ok(i < m.numDrawVerts);
  assert.equal(m.poses.length, m.numPoses * m.numVerts * 4);
  assert.equal(mdlPose(m, 6, 0), m.frames[6].firstPose);
});

test('mdl: group frames animate (flame.mdl / group skins)', () => {
  for (const name of vfs.list('progs/').filter((p) => p.endsWith('.mdl'))) {
    const m = loadMdl(vfs.get(name));
    for (const f of m.frames) if (f.numPoses > 1) {
      const a = mdlPose(m, m.frames.indexOf(f), 0), b = mdlPose(m, m.frames.indexOf(f), f.intervals[0] + 0.001);
      assert.notEqual(a, b, `${name} group frame advances`);
    }
  }
});

test('spr: s_explod.spr frames', () => {
  const s = loadSpr(vfs.get('progs/s_explod.spr'));
  assert.ok(s.frames.length >= 6);
  const f = s.frames[0].images[0];
  assert.equal(f.pixels.length, f.width * f.height);
});

test('particles: explosion, trail and decay; storage is fixed', () => {
  const p = new Particles(4096);
  p.setTime(0);
  p.explosion(0, 0, 0);
  assert.equal(p.count, 1024);
  p.trail(0, 0, 0, 300, 0, 0, 0);
  assert.ok(p.count > 1024 + 90);
  let t = 0;
  for (let i = 0; i < 400; i++) { t += 1 / 60; p.update(t, 1 / 60); }
  assert.equal(p.count, 0, 'all dead after ~6.7 s');
  for (let i = 0; i < 10; i++) p.explosion(0, 0, 0);
  assert.equal(p.count, 4096, 'capped');
});

test('dlights: keyed reuse and decay', () => {
  const d = new Dlights();
  d.update(1, 0);
  d.set(5, 0, 0, 0, 200, 0.1, 0);
  d.set(5, 1, 0, 0, 210, 0.1, 0);
  let live = 0;
  for (let i = 0; i < 64; i++) if (d.alive(i)) live++;
  assert.equal(live, 1, 'same key reuses the slot');
  d.set(0, 0, 0, 0, 350, 0.5, 0, 300);
  d.update(1.2, 0.2);
  live = 0;
  for (let i = 0; i < 64; i++) if (d.alive(i)) live++;
  assert.equal(live, 1, 'muzzle light died, explosion still alive');
});

console.log(`${n} tests passed`);
