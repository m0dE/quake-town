#!/usr/bin/env node
// Playability checks on a compiled BSP with the BSP's own clip hulls (hull 1 = player 32×32×56):
//   - every player spawn / teleport destination stands in empty hull-1 space on a floor
//     (not stuck, not floating), not in liquid, spawns ≥ 64 units apart (no instant telefrag)
//   - every item / weapon fits (hull-1 test at the qw-qc item bbox) and drops to a floor
//   - worldspawn message, sky, required entity counts
//   - walk-reachability (lib/reach.mjs): every spawn and item reachable from the spawns, no one-way spawns
//   node tools/content/check-map.mjs path/to/map.bsp
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
import { readFileSync } from 'node:fs';
import { parseBsp, pointContents, dropToFloor, CONTENTS } from './lib/bsp.mjs';
import { reachability } from './lib/reach.mjs';

const vec = (s) => s.split(/\s+/).map(Number);

export function checkMap(bsp, builder = null, req = builder?.requirements ?? {}) {
  const errs = [], notes = [];
  const ents = bsp.ents;
  const ws = ents[0] || {};
  if (!ws.message) errs.push('worldspawn has no message (title)');
  if (!bsp.texNames.some((n) => n.toLowerCase().startsWith('sky'))) errs.push('no sky texture');
  const spawns = ents.filter((e) => /^info_player_(deathmatch|start|team1|team2)$/.test(e.classname));
  const count = (cn) => ents.filter((e) => e.classname === cn).length;
  const dm = count('info_player_deathmatch');
  if (dm < (req.dmSpawns ?? 8)) errs.push(`only ${dm} info_player_deathmatch (need ≥ ${req.dmSpawns ?? 8})`);
  for (const [cn, n] of Object.entries(req.counts ?? {})) if (count(cn) < n) errs.push(`need ≥ ${n} ${cn}, have ${count(cn)}`);

  const standCheck = (label, o, slack = 2) => {
    const c1 = pointContents(bsp, 1, o);
    if (c1 === CONTENTS.SOLID) { errs.push(`${label} at ${o.join(' ')} is stuck in solid (hull 1)`); return; }
    const c0 = pointContents(bsp, 0, o);
    if (c0 !== CONTENTS.EMPTY) errs.push(`${label} at ${o.join(' ')} is in contents ${c0}`);
    const drop = dropToFloor(bsp, 1, o, 512);
    if (drop > slack) errs.push(`${label} at ${o.join(' ')} floats ${drop} units above the floor`);
    // head room: a jump (45) must not hit the ceiling immediately
    const up = [o[0], o[1], o[2] + 40];
    if (pointContents(bsp, 1, up) === CONTENTS.SOLID) notes.push(`${label} at ${o.join(' ')}: < 40 units head room`);
  };
  spawns.forEach((e) => standCheck(e.classname, vec(e.origin)));
  for (let i = 0; i < spawns.length; i++) for (let j = i + 1; j < spawns.length; j++) {
    const a = vec(spawns[i].origin), b = vec(spawns[j].origin);
    if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 64) errs.push(`spawns too close: ${a.join(' ')} / ${b.join(' ')}`);
  }
  for (const e of ents.filter((x) => x.classname === 'info_teleport_destination')) {
    const o = vec(e.origin); o[2] += 27; // qw-qc adds 27
    standCheck(`teleport destination ${e.targetname}`, o, 8);
    if (!ents.some((t) => t.classname === 'trigger_teleport' && t.target === e.targetname)) errs.push(`teleport destination ${e.targetname} has no trigger`);
  }
  for (const t of ents.filter((x) => x.classname === 'trigger_teleport')) {
    if (!ents.some((d) => d.classname === 'info_teleport_destination' && d.targetname === t.target)) errs.push(`trigger_teleport -> ${t.target} has no destination`);
  }
  // items: qw-qc item bbox '0 0 0'-'32 32 56' (hull-1 offset +16 +16 +24); weapons/armor '-16 -16 0'-'16 16 56'
  let items = 0;
  for (const e of ents.filter((x) => /^(item_|weapon_)/.test(x.classname))) {
    items++;
    const o = vec(e.origin);
    const corner = /^(weapon_|item_armor|item_artifact|item_flag)/.test(e.classname);
    const p = corner ? [o[0], o[1], o[2] + 24] : [o[0] + 16, o[1] + 16, o[2] + 24];
    if (pointContents(bsp, 1, p) === CONTENTS.SOLID) { errs.push(`${e.classname} at ${e.origin} starts in solid`); continue; }
    const drop = dropToFloor(bsp, 1, p, 256);
    if (drop === Infinity) errs.push(`${e.classname} at ${e.origin} has no floor within 256`);
  }
  const reach = reachability(bsp);
  errs.push(...reach.errs);
  notes.push(reach.stats, ...reach.mech);
  const report = [`check: ${spawns.length} spawns (${dm} dm), ${items} items, ${errs.length} errors, ${notes.length} notes`,
    ...errs.map((e) => `  ERROR ${e}`), ...notes.map((n) => `  note ${n}`)].join('\n');
  return { ok: errs.length === 0, errs, notes, report };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkMap(parseBsp(readFileSync(process.argv[2])), null, { dmSpawns: +(process.argv[3] ?? 4) });
  console.log(r.report);
  if (!r.ok) process.exitCode = 1;
}
