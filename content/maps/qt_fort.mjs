// qt_fort — "Twin Keeps": a big symmetric 4on4 / CTF map. Two keeps (red west, blue east)
// face each other across an open courtyard split by a water moat with the Quad on the bridge.
// Each keep has three ways in: the main gate (ground), two upper doors from the courtyard's
// corner ramparts onto the hall mezzanines, and a flooded tunnel from the moat into the keep's
// cistern. The flag stands on a dais in the flag room behind the hall.
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
import { MapBuilder } from './lib/mapgen.mjs';
import { pillar, lamp, surfaceLight, fill } from './lib/kit.mjs';

export const info = {
  name: 'qt_fort', title: 'Twin Keeps', author: 'Quake Town',
  modes: ['ctf', '4on4', 'ffa', '2on2'], players: [6, 16],
};

const SKY = 'sky5_blu';
const WATER = '*water2';
const C = {
  court: { floor: 'med_cobstn1_1', wall: 'med_csl_brk18b', wallLow: 'med_csl_brk18_t', wallTrim: 'med_trim3_1', lowH: 96, trimH: 16, ceil: SKY },
  moat: { floor: 'med_rock3', wall: 'med_rock3', ceil: SKY },
  tunnel: { floor: 'med_rock3', wall: 'med_csl_brk18b', ceil: 'med_rock3' },
  gate: { floor: 'med_csl_flr4_3', wall: 'med_csl_brk18b', ceil: 'med_csl_flr1_1' },
};
const TEAM = {
  red: {
    s: -1, flag: 'item_flag_team1', spawn: 'info_player_team1', light: '1 0.78 0.68', banner: 'med_csl_brk17_f',
    hall: { floor: 'med_csl_flr5_1', wall: 'med_csl_brk17', wallLow: 'med_csl_brk17b', wallTrim: 'med_trim4_1', lowH: 80, ceil: 'med_roof1' },
    room: { floor: 'med_csl_flr4_5', wall: 'med_csl_brk17', wallLow: 'med_csl_brk17b', wallTrim: 'med_trim4_1', lowH: 64, ceil: 'med_roof2' },
  },
  blue: {
    s: 1, flag: 'item_flag_team2', spawn: 'info_player_team2', light: '0.72 0.8 1', banner: 'med_csl_brk6_2',
    hall: { floor: 'med_csl_flr1_1', wall: 'med_csl_brk6_2', wallLow: 'med_csl_brk6_1', wallTrim: 'med_trim4_1', lowH: 80, ceil: 'med_roof1' },
    room: { floor: 'med_csl_flr4_3', wall: 'med_csl_brk6_2', wallLow: 'med_csl_brk6_1', wallTrim: 'med_trim4_1', lowH: 64, ceil: 'med_roof2' },
  },
};
const TX = { ledgeTop: 'med_csl_flr4_3', ledgeSide: 'med_trim3_1', stairTop: 'med_csl_stp1', stairSide: 'med_trim3_1', col: 'med_csl_brk18b', cap: 'med_trim3_1', rail: 'med_csl_trm1' };

/** renderer screenshot cameras: [x, y, eyeZ, pitch, yaw] */
export const shots = [[1950, 140, 70, 4, 330], [-700, -700, 260, 8, 30], [0, -820, 120, -6, 90], [640, 0, 60, -4, 0], [1300, 300, 46, 0, 180], [1850, 300, 80, 4, 340], [-1300, -500, 260, 12, 20], [700, 0, -180, 0, 180]];

export function build() {
  const m = new MapBuilder({
    message: 'Twin Keeps',
    wads: ['lq_medieval.wad', 'lq_metal.wad', 'lq_terra.wad', 'lq_liquidsky.wad', 'lq_tech.wad', 'lq_utility.wad'],
    worldspawn: { _sunlight: '260', _sun_mangle: '30 -50 0', _sunlight_color: '1 0.93 0.82', _sunlight2: '140', _sunlight2_color: '0.6 0.7 1', _minlight: '20', _bounce: '1', _dirt: '1', sounds: '0' },
  });
  m.requirements = {
    dmSpawns: 12,
    counts: { item_flag_team1: 1, item_flag_team2: 1, info_player_team1: 6, info_player_team2: 6, item_artifact_super_damage: 1, weapon_rocketlauncher: 2 },
  };
  surfaceLight(m, 'tlight11', 160, '1 0.85 0.65');

  // ===== courtyard + moat + bridge (quad) =============================================
  m.air([-768, -896, 0, 768, 896, 768], C.court);
  m.air([-160, -896, -256, 160, 896, 0], C.moat);
  m.box([-160, -896, -256, 160, 896, -24], WATER);
  m.box([-192, -112, -32, 192, 112, 0], { top: 'med_csl_flr4_5', bottom: 'med_rock3', side: 'med_trim3_1' }); // bridge deck
  for (const x of [-96, 96]) m.box([x - 24, -88, -256, x + 24, 88, -32], 'med_csl_brk18b');                  // bridge piers
  for (const y of [-112, 112]) { m.det.box([-192, y - (y > 0 ? 0 : 8), 0, 192, y + (y > 0 ? 8 : 0), 24], TX.rail); }
  m.item('item_artifact_super_damage', 0, 0, 0);
  m.light([0, 0, 120], 300, { _color: '0.7 0.5 1', wait: '0.6' });
  // courtyard cover
  for (const [x, y] of [[-448, -224], [-448, 160], [448, -224], [448, 160]]) m.box([x - 32, y, 0, x + 32, y + 64, 72], { top: TX.ledgeTop, side: 'med_csl_brk18b' });
  for (const [x, y] of [[-320, -640], [320, -640], [-320, 640], [320, 640]]) {
    pillar(m, x, y, 32, 0, 320, { top: TX.cap, bottom: TX.cap, side: TX.col });
    m.det.box([x - 40, y - 40, 0, x + 40, y + 40, 24], TX.cap);
    m.det.box([x - 40, y - 40, 296, x + 40, y + 40, 320], TX.cap);
    lamp(m, [x, y, 320], { mount: 'floor', size: 12, h: 12, light: 260, color: '1 0.8 0.5' });
  }
  for (const x of [-400, 400]) for (const y of [-800, 800]) m.item('item_health', x, y, 0);
  m.item('item_rockets', -500, 0, 0); m.item('item_rockets', 468, -32, 0);
  m.item('item_cells', -280, -16, 0); m.item('item_cells', 248, -16, 0);

  // castle-wall look: a string course and merlons high on the long courtyard walls
  for (const sy of [-1, 1]) {
    const yi = sy > 0 ? 880 : -896, yo = sy > 0 ? 896 : -880;
    m.det.box([-768, Math.min(yi, yo), 432, 768, Math.max(yi, yo), 448], 'med_trim3_1');
    for (let x = -736; x < 768; x += 96) m.det.box([x, Math.min(yi, yo), 448, x + 48, Math.max(yi, yo), 496], { top: 'med_csl_brk18_t', bottom: 'med_csl_brk18_t', side: 'med_csl_brk18b' });
  }
  for (const t of Object.values(TEAM)) keep(m, t);

  // intermission view over the courtyard
  m.point('info_intermission', [0, -760, 520], { mangle: '25 90 0' });
  return m;
}

/** one keep; everything is written for the blue (east, s = +1) side and mirrored by s */
function keep(m, t) {
  const s = t.s;
  const B = (x0, y0, z0, x1, y1, z1) => [Math.min(s * x0, s * x1), y0, z0, Math.max(s * x0, s * x1), y1, z1];
  const F = (x0, y0, x1, y1) => [Math.min(s * x0, s * x1), y0, Math.max(s * x0, s * x1), y1];
  const dir = (d) => (d[1] === 'x' && s < 0 ? (d[0] === '+' ? '-x' : '+x') : d);
  const ang = (a) => (s > 0 ? a : (540 - a) % 360);
  const X = (x) => s * x;

  // --- courtyard side: corner ramparts with stairs, banners, gate --------------------------
  for (const sy of [-1, 1]) {
    const y0 = sy > 0 ? 512 : -896, y1 = sy > 0 ? 896 : -512;
    m.box(B(512, y0, -16, 768, y1, 192), { top: TX.ledgeTop, bottom: TX.ledgeTop, side: TX.ledgeSide });       // rampart
    const sf = sy > 0 ? [640, 256, 768, 512] : [640, -512, 768, -256];
    m.stairs(F(...sf), sy > 0 ? '+y' : '-y', 0, 192, { top: TX.stairTop, side: TX.stairSide });
    m.det.box(B(504, y0, 192, 512, y1, 216), TX.rail);                                                           // lip
    m.air(B(768, sy > 0 ? 512 : -640, 192, 1024, sy > 0 ? 640 : -512, 320), C.gate);                          // upper door
    m.item('item_health', X(600), sy * 820, 192);
    const ty = sy > 0 ? 832 : -832;
    m.det.box(B(704, ty - 64, 192, 768, ty + 64, 448), { top: 'med_csl_brk18_t', bottom: TX.cap, side: 'med_csl_brk18b' });
    lamp(m, [X(700), ty, 360], { mount: s > 0 ? '-x' : '+x', tex: 'tlight11', side: 'med_trim3_1', light: 220, color: t.light });
  }
  m.det.box(B(764, -384, 160, 768, -192, 448), { top: 'med_trim4_1', bottom: 'med_trim4_1', side: t.banner });  // banners
  m.det.box(B(764, 192, 160, 768, 384, 448), { top: 'med_trim4_1', bottom: 'med_trim4_1', side: t.banner });
  for (const y of [-288, 288]) lamp(m, [X(760), y, 480], { mount: s > 0 ? '-x' : '+x', tex: 'tlight11', side: 'med_trim3_1', light: 240, color: t.light });
  m.air(B(768, -128, 0, 1024, 128, 192), C.gate);                                                              // main gate
  m.det.box(B(768, -144, 192, 800, 144, 224), 'med_trim3_1');

  // --- hall: two mezzanines (z 192) with stairs, cistern stairwell in the floor ------------
  m.air(B(1024, -640, 0, 1664, 640, 384), t.hall);
  for (const sy of [-1, 1]) {
    const y0 = sy > 0 ? 384 : -640, y1 = sy > 0 ? 640 : -384;
    m.box(B(1024, y0, 160, 1536, y1, 192), { top: TX.ledgeTop, bottom: 'med_roof2', side: TX.ledgeSide });
    m.box(B(1536, sy > 0 ? 448 : -640, 160, 1664, sy > 0 ? 640 : -448, 192), { top: TX.ledgeTop, bottom: 'med_roof2', side: TX.ledgeSide });
    m.stairs(F(1536, sy > 0 ? 64 : -448, 1664, sy > 0 ? 448 : -64), sy > 0 ? '+y' : '-y', 0, 192, { top: TX.stairTop, side: TX.stairSide });
    for (const x of [1152, 1408]) {
      pillar(m, X(x), sy * 400, 16, 0, 160, { top: TX.cap, bottom: TX.cap, side: TX.col });
      m.det.box(B(x - 24, sy * 400 - 24, 136, x + 24, sy * 400 + 24, 160), TX.cap);
    }
    m.det.box(B(1024, sy > 0 ? 376 : -384, 192, 1536, sy > 0 ? 384 : -376, 216), TX.rail);                    // mezzanine lip
  }
  m.item('item_armor2', X(1200), 0, 0);
  m.item('weapon_grenadelauncher', X(1120), -540, 0);
  m.item('weapon_lightning', X(1280), 540, 192);
  m.item('weapon_supernailgun', X(1280), -540, 192);
  m.item('item_spikes', X(1120), -460, 192); m.item('item_cells', X(1120), 470, 192);
  m.item('item_shells', X(1120), 540, 0);
  fill(m, F(1024, -640, 1664, 640), 300, { spacing: 320, light: 240, color: t.light });
  for (const y of [-200, 200]) lamp(m, [X(1660), y, 260], { mount: s > 0 ? '-x' : '+x', tex: 'tlight11', side: 'med_trim3_1', light: 200, color: t.light });

  // --- flooded tunnel from the moat to the cistern, stairwell up into the hall -------------
  m.air(B(160, -64, -256, 1088, 64, -128), C.tunnel);
  m.box(B(160, -64, -256, 1088, 64, -128), WATER);
  // air pocket halfway (no stretch of the flooded route is longer than ~400 units)
  m.air(B(560, -64, -128, 720, 64, -40), C.tunnel);
  m.light([X(640), 0, -64], 180, { _color: '0.6 0.85 1', wait: '0.6' });
  m.air(B(1088, -256, -256, 1664, 256, -64), t.room);                                                          // cistern
  m.box(B(1088, -256, -256, 1280, 256, -144), WATER);
  m.air(B(1280, -96, -256, 1600, 96, 0), t.room);                                                               // stairwell
  m.stairs(F(1280, -96, 1600, 96), dir('+x'), -256, 0, { top: TX.stairTop, side: TX.stairSide });
  m.det.box(B(1272, -104, 0, 1600, -96, 32), TX.rail); m.det.box(B(1272, 96, 0, 1600, 104, 32), TX.rail);
  m.det.box(B(1272, -96, 0, 1280, 96, 32), TX.rail);
  m.light([X(1180), 0, -96], 200, { _color: '0.5 0.8 1', wait: '0.6' });
  m.light([X(400), 0, -150], 160, { _color: '0.4 0.7 1', wait: '0.6' });
  m.light([X(800), 0, -150], 160, { _color: '0.4 0.7 1', wait: '0.6' });
  m.item('item_health', X(1450), 180, -256);
  m.item('item_rockets', X(1450), -200, -256);

  // --- flag room ----------------------------------------------------------------------
  m.air(B(1792, -576, 0, 2304, 576, 352), t.room);
  m.air(B(1664, -128, 0, 1792, 128, 160), C.gate);
  m.air(B(1664, 384, 0, 1792, 512, 160), C.gate);
  m.air(B(1664, -512, 0, 1792, -384, 160), C.gate);
  m.box(B(1984, -128, -16, 2240, 128, 12), { top: 'med_csl_flr5_2', side: TX.ledgeSide });
  m.box(B(2016, -96, -16, 2208, 96, 24), { top: 'med_csl_flr5_2', side: TX.ledgeSide });
  m.point(t.flag, [X(2112), 0, 24 + 8]);
  for (const [x, y] of [[1920, -448], [1920, 448], [2176, -448], [2176, 448]]) {
    pillar(m, X(x), y, 24, 0, 352, { top: TX.cap, bottom: TX.cap, side: TX.col });
    m.det.box(B(x - 32, y - 32, 0, x + 32, y + 32, 24), TX.cap);
  }
  lamp(m, [X(2112), 0, 352], { tex: 'tlight11', side: 'med_trim3_1', light: 300, color: t.light, size: 16 });
  fill(m, F(1792, -576, 2304, 576), 260, { spacing: 384, light: 230, color: t.light });
  m.item('weapon_rocketlauncher', X(1880), 0, 0);
  m.item('item_health', X(2250), -500, 0, { spawnflags: '2' });
  m.item('item_rockets', X(2250), 460, 0);
  m.item('item_health', X(2250), 360, 0);

  // --- spawns: 6 team spawns in the keep, 6 deathmatch spawns on this half --------------
  for (const [x, y, a] of [[2000, -400, 180], [2000, 400, 180], [2240, -240, 180], [2240, 240, 180], [1900, -200, 90], [1900, 200, 270]]) m.spawn(X(x), y, 0, ang(a), t.spawn);
  for (const [x, y, z, a] of [[1300, -300, 0, 180], [1300, 300, 0, 180], [1200, 520, 192, 180], [1200, -520, 192, 180], [600, -400, 0, 180], [600, 400, 0, 180], [2100, -300, 0, 180]]) m.spawn(X(x), y, z, ang(a));
}
