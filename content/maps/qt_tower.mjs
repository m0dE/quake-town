// qt_tower — "Dark Spire": a dm6-style vertical arena for 2–4 players. A tall atrium open to
// the sky with balconies on three sides (L1, z 192), the RA ledge on the north side (L2,
// z 384: lift from the atrium floor, the east stairs, or a rocket jump), the Quad gallery on
// the south side (jump pad from the atrium floor). West hall (YA, GL) and the north-west
// room (SNG) form one loop, the east room (LG) and the south-east room (MH) the other.
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
import { MapBuilder } from './lib/mapgen.mjs';
import { pillar, lamp, jumpPad, lift, surfaceLight, frustum, fill } from './lib/kit.mjs';

export const info = {
  name: 'qt_tower', title: 'Dark Spire', author: 'Quake Town',
  modes: ['duel', '2on2', 'ffa', 'ca'], players: [2, 6],
};

const SKY = 'sky_orng';
const M = {
  atrium: { floor: 'met_brn_stile', wall: 'met_brn_block', wallLow: 'med_csl_brk15', wallTrim: 'met_brn_trim32', lowH: 96, trimH: 16, ceil: SKY },
  stone: { floor: 'med_csl_flr4_5', wall: 'med_csl_brk15', wallLow: 'med_csl_brk15b', wallTrim: 'met_brn_trim16', lowH: 64, ceil: 'met_brn_flat' },
  metal: { floor: 'met_brn_tile2', wall: 'met_brn_pan4', wallLow: 'met_brn_block', wallTrim: 'met_brn_trim32', lowH: 80, ceil: 'met_brn_grate' },
  hall: { floor: 'met_brn_sqr', wall: 'med_csl_brk18b', wallLow: 'med_csl_brk18_t', wallTrim: 'met_brn_trim16', lowH: 64, ceil: 'met_brn_flat' },
  door: { floor: 'met_brn_slat', wall: 'met_brn_vtrim', ceil: 'met_brn_trim64' },
};
const TX = {
  ledgeTop: 'met_brn_sqrs', ledgeSide: 'met_brn_trim32', ledgeUnder: 'met_brn_grate', col: 'met_brn_stile2', colCap: 'met_brn_trim64',
  stairTop: 'med_csl_stp1', stairSide: 'met_brn_trim16', metal: 'met_brn_flat',
};

/** renderer screenshot cameras: [x, y, eyeZ, pitch, yaw] */
export const shots = [[-200, -300, 46, -8, 60], [300, -300, 238, 10, 135], [0, 600, 430, 20, 270], [-900, -500, 46, -2, 45], [-800, 700, 238, 10, 300], [800, -200, 238, 0, 90], [700, -900, 46, 0, 120]];

export function build() {
  const m = new MapBuilder({
    message: 'Dark Spire',
    wads: ['lq_metal.wad', 'lq_medieval.wad', 'lq_tech.wad', 'lq_liquidsky.wad', 'lq_utility.wad'],
    worldspawn: { _sunlight: '180', _sun_mangle: '60 -70 0', _sunlight_color: '1 0.7 0.45', _sunlight2: '60', _sunlight2_color: '1 0.6 0.4', _minlight: '24', _bounce: '1', _dirt: '1', _dirtscale: '1', sounds: '0' },
  });
  m.requirements = { dmSpawns: 8, counts: { weapon_rocketlauncher: 1, weapon_lightning: 1, weapon_grenadelauncher: 1, weapon_supernailgun: 1, item_armorInv: 1, item_armor2: 1, item_artifact_super_damage: 1 } };
  surfaceLight(m, 'met_brn_lit1', 120, '1 0.75 0.45');
  surfaceLight(m, 'met_brn_lit6', 100, '1 0.5 0.3');
  surfaceLight(m, 'tlight11', 160, '1 0.85 0.6');

  // ===== atrium =========================================================================
  m.air([-384, -384, 0, 384, 384, 832], M.atrium);
  m.air([-64, 128, -16, 64, 256, 0], M.door); // lift pit
  const ledge = (b, z) => m.box([b[0], b[1], z - 32, b[2], b[3], z], { top: TX.ledgeTop, bottom: TX.ledgeUnder, side: TX.ledgeSide });
  ledge([-384, -384, -256, 384], 192);     // west balcony (L1)
  ledge([256, -384, 384, 384], 192);       // east balcony (L1)
  ledge([-256, -384, 256, -256], 192);     // south balcony (L1)
  ledge([-384, 256, 384, 384], 384);       // north ledge (L2, RA)
  ledge([-128, -384, 128, -288], 384);     // quad gallery (L2)
  // columns holding the balconies (atrium floor → underside) and the north ledge
  for (const [x, y] of [[-256, -256], [256, -256], [-256, 256], [256, 256], [-256, 0], [256, 0]]) {
    pillar(m, x, y, 16, 0, 160, { top: TX.colCap, bottom: TX.colCap, side: TX.col });
    m.det.box([x - 24, y - 24, 136, x + 24, y + 24, 160], TX.colCap);
    m.det.box([x - 24, y - 24, 0, x + 24, y + 24, 16], TX.colCap);
  }
  for (const x of [-256, 256]) pillar(m, x, 256, 16, 192, 352, { top: TX.colCap, bottom: TX.colCap, side: TX.col });
  for (const x of [-96, 96]) pillar(m, x, -320, 12, 192, 352, { top: TX.colCap, bottom: TX.colCap, side: TX.col });
  // railings: low walls on the balcony edges, with gaps for drops
  const rail = (b) => m.det.box(b, { top: TX.metal, bottom: TX.metal, side: 'met_brn_trim16s' });
  rail([-264, -248, 192, -256, -64, 216]); rail([-264, 64, 192, -256, 248, 216]);
  rail([256, -248, 192, 264, -64, 216]); rail([256, 64, 192, 264, 248, 216]);
  // north ledge front lip and the lift
  lift(m, [-64, 128, 64, 256], 0, 384, { top: 'plat_top2', side: 'plat_side1', speed: 220 });
  m.det.box([-80, 120, -16, -64, 264, 8], 'met_brn_trim16'); m.det.box([64, 120, -16, 80, 264, 8], 'met_brn_trim16');
  // jump pad to the quad gallery
  jumpPad(m, 0, -150, 0, [0, -130, 850], { tex: '+0tek_jump1', side: 'met_brn_trim32' });
  // big central brazier light hanging from a chain and wall lamps
  m.det.box([-8, -8, 560, 8, 8, 832], 'met_brn_vtrim');
  frustum(m, [-40, -40, 40, 40], [-16, -16, 16, 16], 528, 560, { top: TX.metal, bottom: TX.metal, side: 'met_brn_trim16g' });
  m.light([0, 0, 500], 400, { _color: '1 0.6 0.3' });
  for (const [x, y, dir] of [[-376, -128, '+x'], [-376, 128, '+x'], [376, -128, '-x'], [376, 128, '-x'], [-128, -376, '+y'], [128, -376, '+y']]) {
    lamp(m, [x, y, 112], { mount: dir, tex: 'met_brn_lit1', side: 'met_brn_trim16', light: 160, color: '1 0.7 0.4' });
    lamp(m, [x, y, 300], { mount: dir, tex: 'met_brn_lit1', side: 'met_brn_trim16', light: 160, color: '1 0.7 0.4' });
  }
  for (const x of [-256, 0, 256]) lamp(m, [x, 376, 470], { mount: '-y', tex: 'met_brn_lit6', side: 'met_brn_trim16', light: 200, color: '1 0.35 0.2' });
  // floor medallion under the brazier, stained-glass windows high on the atrium walls
  m.box([-128, -128, -16, 128, 128, 2], { top: 'met_brn_rune2', side: 'met_brn_trim16' });
  m.box([-160, -160, -16, 160, 160, 1], { top: 'met_brn_trim32s', side: 'met_brn_trim16' });
  for (const x of [-200, 0, 200]) {
    m.det.box([x - 32, -384, 520, x + 32, -380, 648], 'met_brn_arch2c');
    m.det.box([x - 32, 380, 600, x + 32, 384, 728], 'met_brn_arch2c');
  }
  for (const y of [-200, 0, 200]) {
    m.det.box([-384, y - 32, 520, -380, y + 32, 648], 'met_brn_arch2c');
    m.det.box([380, y - 32, 520, 384, y + 32, 648], 'met_brn_arch2c');
  }
  m.item('weapon_rocketlauncher', 0, -24, 2);
  m.item('item_armorInv', -224, 320, 384);
  m.item('item_artifact_super_damage', 0, -344, 384);
  m.item('item_rockets', 300, -300, 192);
  m.item('item_health', -300, 300, 192);
  m.item('item_shells', 160, 160, 0);

  // ===== north room behind the ledge (L2) ==============================================
  m.air([-384, 384, 384, 384, 768, 608], M.metal);
  m.box([-128, 640, 384, 128, 768, 448], { top: TX.ledgeTop, side: 'met_brn_trim32' }); // dais
  lamp(m, [0, 600, 608], { tex: 'tlight11', side: 'met_brn_trim16', light: 220, color: '1 0.8 0.6' });
  m.item('item_cells', 0, 700, 448);
  m.item('item_health', -300, 700, 384);
  m.item('item_rockets', 300, 700, 384);

  // ===== west hall (L0, YA, GL) + north-west room (L1, SNG) =============================
  m.air([-1088, -640, 0, -512, 320, 352], M.hall);
  m.air([-512, -320, 0, -384, -192, 128], M.door);  // doors to the atrium (under the balcony)
  m.air([-512, 96, 0, -384, 224, 128], M.door);
  m.air([-1088, 256, 192, -512, 832, 448], M.stone);
  m.air([-512, 256, 192, -384, 384, 320], M.door);  // NW room → west balcony
  // stairs along the hall's north wall up to the NW room
  m.stairs([-1024, 192, -640, 320], '+x', 0, 192, { top: TX.stairTop, side: TX.stairSide });
  m.box([-640, 192, -16, -512, 320, 192], { top: TX.ledgeTop, side: 'met_brn_trim32' });
  m.box([-1088, 192, -16, -1024, 320, 192], { top: TX.ledgeTop, side: 'met_brn_trim32' });
  for (const [x, y] of [[-960, -480], [-640, -480], [-960, -64], [-640, -64]]) {
    pillar(m, x, y, 24, 0, 352, { top: TX.colCap, bottom: TX.colCap, side: 'med_csl_brk18b' });
    m.det.box([x - 32, y - 32, 0, x + 32, y + 32, 24], TX.colCap);
  }
  for (const [x, y, d] of [[-1080, -400, '+x'], [-1080, -100, '+x'], [-800, -632, '+y']]) lamp(m, [x, y, 200], { mount: d, tex: 'met_brn_lit1', side: 'met_brn_trim16', light: 200, color: '1 0.75 0.5' });
  m.ent('light_torch_small_walltorch', { origin: '-1072 0 120', light: '150' });
  m.item('item_armor2', -800, -272, 0);
  m.item('weapon_grenadelauncher', -1000, -560, 0);
  m.item('item_rockets', -600, -560, 0);
  m.item('item_health', -1040, 100, 0);
  m.item('item_health', -1040, 40, 0);
  // NW room
  m.box([-1088, 704, 192, -896, 832, 256], { top: TX.ledgeTop, side: 'met_brn_trim32' });
  m.stairs([-896, 704, -832, 832], '-x', 192, 256, { top: TX.stairTop, side: TX.stairSide });
  for (const x of [-960, -640]) lamp(m, [x, 828, 360], { mount: '-y', tex: 'met_brn_lit6', side: 'met_brn_trim16', light: 200, color: '1 0.5 0.3' });
  lamp(m, [-800, 500, 448], { tex: 'tlight11', side: 'met_brn_trim16', light: 220 });
  m.item('weapon_supernailgun', -1000, 760, 256);
  m.item('item_spikes', -700, 760, 192);
  m.item('item_shells', -700, 400, 192);

  // ===== east room (L1, LG) with stairs to the north room ===============================
  m.air([512, -320, 192, 1088, 576, 480], M.metal);
  m.air([384, -128, 192, 512, 128, 320], M.door);   // east balcony → east room
  m.air([384, 576, 384, 1088, 704, 512], M.metal);  // upper corridor → north room
  m.stairs([960, 0, 1088, 448], '+y', 192, 384, { top: TX.stairTop, side: TX.stairSide });
  m.box([960, 448, 176, 1088, 576, 384], { top: TX.ledgeTop, side: 'met_brn_trim32' });
  m.det.box([952, 0, 176, 960, 576, 400], 'met_brn_trim16');
  for (const y of [-200, 200]) lamp(m, [516, y, 380], { mount: '+x', tex: 'met_brn_lit1', side: 'met_brn_trim16', light: 200, color: '0.7 0.8 1' });
  lamp(m, [700, 640, 512], { tex: 'tlight11', side: 'met_brn_trim16', light: 200 });
  lamp(m, [760, 100, 480], { tex: 'tlight11', side: 'met_brn_trim16', light: 220 });
  m.item('weapon_lightning', 800, -240, 192);
  m.item('item_cells', 600, 450, 192);
  m.item('item_health', 1040, -280, 192);

  // ===== south hall (L0, SSG) and south-east room (L0, MH) ==============================
  m.air([-640, -832, 0, 320, -512, 256], M.stone);
  m.air([-96, -512, 0, 96, -384, 144], M.door);     // atrium → south hall
  m.air([320, -768, 0, 448, -576, 144], M.door);    // south hall → south-east room
  m.air([448, -1024, 0, 1088, -384, 320], M.hall);
  m.air([832, -384, 192, 1024, -320, 320], M.door);  // SE stairs → east room
  m.stairs([832, -896, 1024, -448], '+y', 0, 192, { top: TX.stairTop, side: TX.stairSide });
  m.box([832, -448, -16, 1024, -384, 192], { top: TX.ledgeTop, side: 'met_brn_trim32' });
  for (const [x, y] of [[-480, -672], [160, -672]]) pillar(m, x, y, 20, 0, 256, { top: TX.colCap, bottom: TX.colCap, side: 'met_brn_stile2' });
  for (const x of [-400, -80, 240]) lamp(m, [x, -828, 160], { mount: '+y', tex: 'met_brn_lit1', side: 'met_brn_trim16', light: 180, color: '1 0.75 0.5' });
  lamp(m, [640, -700, 320], { tex: 'tlight11', side: 'met_brn_trim16', light: 240 });
  m.ent('light_torch_small_walltorch', { origin: '1080 -900 120', light: '150' });
  m.item('weapon_supershotgun', -300, -700, 0);
  m.item('item_health', 1000, -960, 0, { spawnflags: '2' });
  m.item('item_shells', 520, -960, 0);
  m.item('item_spikes', -560, -760, 0);
  m.item('item_health', 0, -560, 0);

  // ===== fill light ======================================================================
  fill(m, [-384, -384, 384, 384], 120, { spacing: 384, light: 220, color: '1 0.8 0.6' });
  fill(m, [-384, -384, 384, 384], 640, { spacing: 384, light: 260, color: '1 0.75 0.55' });
  fill(m, [-384, 384, 384, 768], 540, { spacing: 384, light: 240 });
  fill(m, [-1088, -640, -512, 320], 280, { spacing: 288, light: 230, color: '0.85 0.85 1' });
  fill(m, [-1088, 256, -512, 832], 380, { spacing: 288, light: 230, color: '1 0.8 0.6' });
  fill(m, [512, -320, 1088, 576], 400, { spacing: 288, light: 230, color: '0.8 0.85 1' });
  fill(m, [-640, -832, 320, -512], 200, { spacing: 320, light: 220, color: '1 0.8 0.6' });
  fill(m, [448, -1024, 1088, -384], 260, { spacing: 288, light: 230, color: '0.85 0.85 1' });

  // ===== spawns =========================================================================
  m.spawn(-200, 200, 0, 315);
  m.spawn(200, -200, 0, 135);
  m.spawn(-900, -300, 0, 0);
  m.spawn(-700, 120, 0, 270);
  m.spawn(-800, 640, 192, 270);
  m.spawn(700, 300, 192, 180);
  m.spawn(640, -200, 192, 90);
  m.spawn(560, -900, 0, 90);
  m.spawn(-500, -720, 0, 0);
  m.spawn(-300, 500, 384, 0);
  m.spawn(320, -180, 192, 90);
  m.point('info_intermission', [-300, -300, 520], { mangle: '25 45 0' });
  return m;
}
