#!/usr/bin/env node
// Map previews from a compiled BSP (no browser): a top-down plan (all floors, or z slices)
// with entity markers, and perspective views from spawn points / given cameras.
//   node tools/content/preview.mjs path/to/map.bsp outdir [--slices z0,z1,z2] [--cam x,y,z,yaw,pitch]...
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PATHS, fetchAll } from './fetch.mjs';
import { pakEntries } from './lib/archive.mjs';
import { parseBsp } from './lib/bsp.mjs';
import { renderTopDown, renderView } from './lib/raster.mjs';
import { encodePng, drawText, drawRect } from './lib/png.mjs';

const MARK = {
  info_player_deathmatch: [[80, 255, 80], 'dm'], info_player_start: [[80, 255, 80], 'st'],
  info_player_team1: [[255, 80, 80], 'r'], info_player_team2: [[80, 120, 255], 'b'],
  item_flag_team1: [[255, 40, 40], 'flag'], item_flag_team2: [[40, 80, 255], 'flag'],
  weapon_rocketlauncher: [[255, 160, 0], 'rl'], weapon_lightning: [[120, 220, 255], 'lg'], weapon_grenadelauncher: [[255, 120, 0], 'gl'],
  weapon_supernailgun: [[220, 220, 0], 'sng'], weapon_nailgun: [[200, 200, 0], 'ng'], weapon_supershotgun: [[200, 140, 80], 'ssg'],
  item_armorinv: [[255, 0, 0], 'ra'], item_armor2: [[255, 255, 0], 'ya'], item_armor1: [[0, 200, 0], 'ga'],
  item_artifact_super_damage: [[160, 80, 255], 'quad'], item_artifact_invulnerability: [[255, 60, 60], 'pent'], item_artifact_invisibility: [[200, 200, 200], 'ring'],
  item_health: [[255, 255, 255], 'h'], trigger_teleport: [[255, 0, 255], 'tp'], info_teleport_destination: [[255, 120, 255], 'td'],
  trigger_push: [[0, 255, 255], 'jp'], func_plat: [[255, 255, 255], 'lift'],
  item_rockets: [[150, 100, 0], 'r'], item_cells: [[0, 120, 160], 'c'], item_spikes: [[140, 140, 0], 'n'], item_shells: [[140, 90, 50], 's'],
};

export async function preview(bspPath, outDir, { slices = null, cams = [], views = 4, scale } = {}) {
  await fetchAll();
  const pal = pakEntries(readFileSync(join(PATHS.lq, 'pak0.pak'))).get('gfx/palette.lmp');
  const bsp = parseBsp(readFileSync(bspPath));
  const litPath = bspPath.replace(/\.bsp$/, '.lit');
  const lit = existsSync(litPath) ? readFileSync(litPath) : null;
  const name = basename(bspPath, '.bsp');
  mkdirSync(outDir, { recursive: true });
  const outs = [];
  const ranges = slices ? slices.map((z, i) => [z, slices[i + 1] ?? Infinity]) : [[-Infinity, Infinity]];
  for (const [zmin, zmax] of ranges) {
    const td = renderTopDown(bsp, pal, lit, { zmin: zmin === -Infinity ? undefined : zmin - 8, zmax: zmax === Infinity ? undefined : zmax - 8, scale });
    for (const e of bsp.ents) {
      const cn = (e.classname || '').toLowerCase();
      let mk = MARK[cn];
      if (cn === 'item_health' && (+e.spawnflags & 2)) mk = [[80, 160, 255], 'mh'];
      if (!mk) continue;
      let o;
      if (e.origin) o = e.origin.split(/\s+/).map(Number);
      else if (e.model && e.model.startsWith('*')) { const m = bsp.models[+e.model.slice(1)]; o = [0, 1, 2].map((k) => (m.mins[k] + m.maxs[k]) / 2); }
      else continue;
      if (o[2] < zmin - 64 || o[2] > zmax + 64) continue;
      const [X, Y] = td.toPx(o[0], o[1]).map(Math.round);
      drawRect(td.px, td.w, td.h, X - 3, Y - 3, 7, 7, [0, 0, 0]);
      drawRect(td.px, td.w, td.h, X - 2, Y - 2, 5, 5, mk[0]);
      if (/^info_player/.test(cn) && e.angle) {
        const a = +e.angle * Math.PI / 180;
        for (let k = 3; k < 12; k++) drawRect(td.px, td.w, td.h, Math.round(X + Math.cos(a) * k), Math.round(Y - Math.sin(a) * k), 2, 2, mk[0]);
      }
      drawText(td.px, td.w, td.h, X + 5, Y - 2, mk[1], mk[0]);
    }
    const label = zmin === -Infinity ? 'all' : `z${zmin}`;
    drawText(td.px, td.w, td.h, 6, 6, `${name} ${label} 1px=${td.sc.toFixed(1)}u`, [255, 255, 255], 2);
    const f = join(outDir, `${name}-top-${label}.png`);
    writeFileSync(f, encodePng(td.w, td.h, td.px));
    outs.push(f);
  }
  const camList = cams.slice();
  if (!camList.length) {
    const sp = bsp.ents.filter((e) => /^info_player_(deathmatch|start)$/.test(e.classname));
    const step = Math.max(1, Math.floor(sp.length / views));
    for (let i = 0; i < sp.length && camList.length < views; i += step) {
      const o = sp[i].origin.split(/\s+/).map(Number);
      camList.push({ o: [o[0], o[1], o[2] + 22], yaw: +(sp[i].angle || 0), pitch: 5, fov: 100 });
    }
  }
  camList.forEach((c, i) => {
    const v = renderView(bsp, pal, lit, c, 960, 540);
    drawText(v.px, v.w, v.h, 6, 6, `${name} cam${i} ${c.o.map(Math.round).join(',')} yaw ${c.yaw}`, [255, 255, 255], 2);
    const f = join(outDir, `${name}-view${i}.png`);
    writeFileSync(f, encodePng(v.w, v.h, v.px));
    outs.push(f);
  });
  return outs;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2);
  const opts = { cams: [] };
  for (let i = 2; i < a.length; i++) {
    if (a[i] === '--slices') opts.slices = a[++i].split(',').map(Number);
    else if (a[i] === '--cam') { const v = a[++i].split(',').map(Number); opts.cams.push({ o: v.slice(0, 3), yaw: v[3] ?? 0, pitch: v[4] ?? 0, fov: v[5] ?? 100 }); }
    else if (a[i] === '--views') opts.views = +a[++i];
    else if (a[i] === '--scale') opts.scale = +a[++i];
  }
  for (const f of await preview(a[0], a[1] ?? '/tmp/qtprev', opts)) console.log(f);
}
