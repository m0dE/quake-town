#!/usr/bin/env node
// Quake Town content: the `base` pack — the subset of LibreQuake (BSD-3-Clause) that the
// qtdm mod and the HUD need, plus our own progs/flag.mdl. Deterministic pk3.
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchAll, PATHS, ROOT } from './fetch.mjs';
import { pakEntries } from './lib/archive.mjs';
import { writePack, upToDate, stamp, inputsKey } from './lib/packs.mjs';
import { buildFlagMdl } from '../../content/models/flag.mjs';
import { normalizeWav } from './lib/wav.mjs';

// Everything id's qw-qc precaches (models, brush item boxes, sounds), plus what the QW
// client loads itself (cl_tent.c / cl_main.c / sbar / menus).
const MODELS = `player h_player eyes
v_axe v_shot v_shot2 v_nail v_nail2 v_rock v_rock2 v_light
g_shot g_nail g_nail2 g_rock g_rock2 g_light
missile grenade spike s_spike bolt bolt2 bolt3 laser lavaball
armor backpack quaddama invulner invisibl suit
gib1 gib2 gib3 zom_gib
flame flame2 teleport
w_s_key w_g_key m_s_key m_g_key b_s_key b_g_key
end1 end2 end3 end4`.split(/\s+/).map((n) => `progs/${n}.mdl`);
const SPRITES = ['progs/s_explod.spr', 'progs/s_bubble.spr', 'progs/s_light.spr'];
const BOXES = 'b_batt0 b_batt1 b_bh10 b_bh100 b_bh25 b_exbox2 b_explob b_nail0 b_nail1 b_rock0 b_rock1 b_shell0 b_shell1'
  .split(' ').map((n) => `maps/${n}.bsp`);
const SOUNDS = `ambience/buzz1 ambience/comp1 ambience/drip1 ambience/drone6 ambience/fire1 ambience/fl_hum1
ambience/hum1 ambience/suck1 ambience/swamp1 ambience/swamp2 ambience/thunder1 ambience/water1 ambience/wind2
ambience/windfly boss1/sight1 buttons/airbut1 buttons/switch02 buttons/switch04 buttons/switch21 demon/dland2
doors/airdoor1 doors/airdoor2 doors/basesec1 doors/basesec2 doors/basetry doors/baseuse doors/ddoor1 doors/ddoor2
doors/doormv1 doors/drclos4 doors/hydro1 doors/hydro2 doors/latch2 doors/medtry doors/meduse doors/runetry
doors/runeuse doors/stndr1 doors/stndr2 doors/winch2 enforcer/enfire enforcer/enfstop
items/armor1 items/damage items/damage2 items/damage3 items/health1 items/inv1 items/inv2 items/inv3 items/itembk2
items/protect items/protect2 items/protect3 items/r_item1 items/r_item2 items/suit items/suit2 misc/basekey
misc/h2ohit1 misc/medkey misc/menu1 misc/menu2 misc/menu3 misc/null misc/outwater misc/power misc/r_tele1
misc/r_tele2 misc/r_tele3 misc/r_tele4 misc/r_tele5 misc/runekey misc/secret misc/talk misc/trigger1 misc/water1
misc/water2 plats/medplat1 plats/medplat2 plats/plat1 plats/plat2 plats/train1 plats/train2 player/axhit1
player/axhit2 player/death1 player/death2 player/death3 player/death4 player/death5 player/drown1 player/drown2
player/gasp1 player/gasp2 player/gib player/h2odeath player/h2ojump player/inh2o player/inlava player/land
player/land2 player/lburn1 player/lburn2 player/pain1 player/pain2 player/pain3 player/pain4 player/pain5
player/pain6 player/plyrjmp8 player/slimbrn2 player/teledth1 player/tornoff2 player/udeath weapons/ax1
weapons/bounce weapons/grenade weapons/guncock weapons/lhit weapons/lock4 weapons/lstart weapons/pkup
weapons/r_exp3 weapons/ric1 weapons/ric2 weapons/ric3 weapons/rocket1i weapons/sgun1 weapons/shotgn2
weapons/spike2 weapons/tink1`.split(/\s+/).map((n) => `sound/${n}.wav`);
// gfx: palette/colormap, gfx.wad (conchars, sbar, nums, faces, items), every small lmp the
// HUD, intermission and menus use. Not: help/sell screens (single player), pop.lmp (GPL).
const GFX_SKIP = /^gfx\/(help\d|sell|pop)\.lmp$/;

export async function buildBase() {
  await fetchAll();
  const pak0 = join(PATHS.lq, 'pak0.pak'), pak1 = join(PATHS.lq, 'pak1.pak');
  const docs = ['COPYING', 'CREDITS', 'README-IMPORTANT-LICENCE-INFO'].map((d) => join(PATHS.lq, 'docs', d));
  const self = [import.meta.filename, join(ROOT, 'content/models/flag.mjs'), join(ROOT, 'tools/content/lib/archive.mjs'), join(ROOT, 'tools/content/lib/wav.mjs')];
  // pak hashes are pinned by fetch.mjs (zip sha256), so key on the pin + our sources.
  const key = inputsKey([...docs, ...self], readFileSync(join(ROOT, '.cache/fetch.stamp.json'), 'utf8'));
  const prev = upToDate('base', key);
  if (prev) return prev;

  const t0 = Date.now();
  const all = new Map();
  for (const p of [pak0, pak1]) for (const [n, b] of pakEntries(readFileSync(p))) all.set(n, b);
  const files = new Map();
  const missing = [];
  const want = [...MODELS, ...SPRITES, ...BOXES, ...SOUNDS, 'gfx.wad'];
  for (const n of all.keys()) if (n.startsWith('gfx/') && n.endsWith('.lmp') && !GFX_SKIP.test(n)) want.push(n);
  for (const n of want) {
    const b = all.get(n);
    if (b) files.set(n, n.endsWith('.wav') ? normalizeWav(b) : b); else missing.push(n);
  }
  files.set('progs/flag.mdl', buildFlagMdl(all.get('gfx/palette.lmp')));
  for (const d of docs) files.set(`licenses/librequake-${d.split('/').pop().toLowerCase()}.txt`, readFileSync(d));
  files.set('licenses/readme.txt', Buffer.from(
`Quake Town base pack.
Game data from LibreQuake v0.09-beta (https://github.com/lavenderdotpet/LibreQuake),
BSD-3-Clause: see librequake-copying.txt and librequake-credits.txt.
progs/flag.mdl is original Quake Town work (built in code by content/models/flag.mjs),
released under BSD-3-Clause.
No id Software data is included.
`));
  const entry = writePack('base', 'base', files, { title: 'Quake Town base (LibreQuake)', missing });
  stamp('base', key);
  console.log(`base: ${files.size} files, ${(entry.bytes / 1024).toFixed(0)} KB, ${Date.now() - t0} ms` +
    (missing.length ? `; not in LibreQuake: ${missing.join(' ')}` : ''));
  return entry;
}

if (import.meta.url === `file://${process.argv[1]}`) await buildBase();
