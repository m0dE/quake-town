#!/usr/bin/env node
// Compile one of our generated maps: content/maps/<name>.mjs -> .map -> qbsp -> vis -> light.
//   node tools/content/compile-map.mjs qt_aero [--fast]   (outputs in .cache/maps/)
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchAll, PATHS, ROOT, CACHE } from './fetch.mjs';
import { parseBsp } from './lib/bsp.mjs';
import { checkMap } from './check-map.mjs';

export const MAPS_OUT = join(CACHE, 'maps');

function run(tool, args, cwd) {
  const t0 = Date.now();
  let out;
  try {
    out = execFileSync('nice', ['-n', '10', join(PATHS.ericw, tool), ...args], {
      cwd, encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, LD_LIBRARY_PATH: PATHS.ericw },
    });
  } catch (e) {
    const log = String(e.stdout || '') + String(e.stderr || '');
    throw new Error(`${tool} failed:\n${clean(log).slice(-3000)}`);
  }
  return { ms: Date.now() - t0, log: clean(out) };
}
const clean = (s) => s.replace(/\[[ .0-9%]*\]( +est: [0-9:]+)?/g, '').replace(/\r/g, '\n').split('\n').filter((l) => l.trim()).join('\n');

/** returns { name, map, bsp, lit, stats } */
export async function compileMap(name, { fast = false } = {}) {
  await fetchAll();
  const gen = await import(pathToFileURL(join(ROOT, 'content/maps', `${name}.mjs`)).href);
  const builder = gen.build();
  const mapText = builder.toMap();
  mkdirSync(MAPS_OUT, { recursive: true });
  const mapPath = join(MAPS_OUT, `${name}.map`);
  writeFileSync(mapPath, mapText);
  for (const ext of ['bsp', 'lit', 'prt', 'pts', 'log']) rmSync(join(MAPS_OUT, `${name}.${ext}`), { force: true });
  const q = run('qbsp', ['-nopercent', '-leaktest', '-wadpath', PATHS.wads, `${name}.map`], MAPS_OUT);
  const warnings = q.log.split('\n').filter((l) => /WARNING/.test(l));
  if (/leak/i.test(q.log) && existsSync(join(MAPS_OUT, `${name}.pts`))) throw new Error(`${name}: map leaks`);
  const v = run('vis', ['-nopercent', '-threads', '1', ...(fast ? ['-fast'] : []), `${name}.bsp`], MAPS_OUT);
  const l = run('light', ['-nopercent', '-threads', '1', '-lit', ...(fast ? [] : ['-extra', '-bounce', '1']), `${name}.bsp`], MAPS_OUT);
  const bspBytes = readFileSync(join(MAPS_OUT, `${name}.bsp`));
  const litPath = join(MAPS_OUT, `${name}.lit`);
  const lit = existsSync(litPath) ? readFileSync(litPath) : null;
  const bsp = parseBsp(bspBytes);
  if (!bsp.visLen) throw new Error(`${name}: vis did not run (no visdata)`);
  const check = checkMap(bsp, builder);
  const stats = {
    format: bsp.version,
    mapBrushes: builder.stats.shellBrushes + builder.stats.detailBrushes + builder.ents.reduce((a, e) => a + e.brushes.length, 0),
    faces: bsp.faces.length, leafs: bsp.leafs.length, clipnodes: bsp.clip.length, models: bsp.models.length,
    entities: bsp.ents.length, bspKB: Math.round(bspBytes.length / 1024), litKB: lit ? Math.round(lit.length / 1024) : 0,
    qbspMs: q.ms, visMs: v.ms, lightMs: l.ms, warnings: warnings.length,
  };
  writeFileSync(join(MAPS_OUT, `${name}.log`), [q.log, v.log, l.log].join('\n\n'));
  return { name, map: mapText, bsp: bspBytes, lit, stats, check, info: gen.info, warnings };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const name = process.argv[2];
  const r = await compileMap(name, { fast: process.argv.includes('--fast') });
  console.log(JSON.stringify(r.stats));
  for (const w of r.warnings.slice(0, 20)) console.log(w);
  console.log(r.check.report);
  if (!r.check.ok) process.exitCode = 1;
}
