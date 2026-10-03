// qt_aero — "Aerodrome": an aerowalk-style 1on1 map. Platforms and walkways hang in an open
// sky over a lethal void; a teleporter loop (east tower → south deck → west tower), RA high on
// the north deck (jump pad or the long west stairs), YA low on the south deck, MH on a lone pad
// (drop from the north deck or rocket-jump from the east tower), RL in the hub, LG west, GL east.
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
import { MapBuilder } from './lib/mapgen.mjs';
import { platform, pillar, lamp, jumpPad, teleporter, teleDest, gate, surfaceLight, underGlow } from './lib/kit.mjs';

export const info = {
  name: 'qt_aero', title: 'Aerodrome', author: 'Quake Town',
  modes: ['duel', '2on2', 'ffa', 'ca'], players: [2, 4],
};

const SKY = 'sky5_blu';
const T = {
  top: 'aqf074', side: 'aqmetl14', trim: 'aqtrim01', under: 'aqpipe08',
  tower: 't_wall2a', towerTop: 'aqconc03', post: 'aqsupp02', metal: 'met_gry_flat',
  stairTop: 't_flor1b', stairSide: 'aqtrim02', hub: 'aqf075', lamp: 'tlight11',
};

export function build() {
  const m = new MapBuilder({
    message: 'Aerodrome',
    wads: ['lq_tech.wad', 'lq_metal.wad', 'lq_liquidsky.wad', 'lq_utility.wad'],
    worldspawn: {
      _sunlight: '300', _sun_mangle: '-35 -55 0', _sunlight_color: '1 0.92 0.8',
      _sunlight2: '200', _sunlight2_color: '0.55 0.65 1', _minlight: '20', _bounce: '1', _dirt: '1',
      sounds: '0',
    },
  });
  m.requirements = { dmSpawns: 8, counts: { weapon_rocketlauncher: 1, weapon_lightning: 1, weapon_grenadelauncher: 1, item_armorInv: 1, item_armor2: 1 } };
  // the sky: one big open volume
  m.air([-1408, -1280, 0, 1408, 1280, 1344], { floor: SKY, wall: SKY, ceil: SKY });
  // the void kills
  m.brushEnt('trigger_hurt', { dmg: '1000' }, [[[-1400, -1272, 8, 1400, 1272, 180], 'trigger']]);

  const P = { top: T.top, side: T.side, trim: T.trim, under: T.under, border: 'met_gry_sqrd' };
  surfaceLight(m, 'rw33_lit', 90, '1 0.75 0.4');
  surfaceLight(m, 't_lit01', 120, '0.8 0.9 1');
  const G = { post: { top: T.metal, bottom: T.metal, side: T.post }, beam: { top: T.metal, bottom: 'rw33_lit', side: T.trim } };

  // ---- hub (RL) z=384 -------------------------------------------------------------------
  platform(m, [-256, -256, 256, 256], 384, { ...P, top: T.hub }, { thick: 48, taper: 96 });
  pillar(m, 0, 0, 72, 0, 336, { top: T.post, bottom: T.post, side: T.tower });     // central column
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    m.box([sx * 200 - 24, sy * 200 - 24, 240, sx * 200 + 24, sy * 200 + 24, 336], T.post); // braces
    // corner lamp posts
    pillar(m, sx * 232, sy * 232, 8, 384, 472, T.post);
    lamp(m, [sx * 232, sy * 232, 472], { mount: 'floor', size: 10, h: 10, light: 260, color: '1 0.85 0.6' });
  }
  m.box([-48, -48, 384, 48, 48, 392], { top: 'aqf032', side: T.trim });            // RL dais
  m.item('weapon_rocketlauncher', 0, 0, 392);
  // jump pad to the north deck (RA)
  jumpPad(m, 0, 168, 384, [0, 420, 700]);

  // ---- north deck (RA) z=640 ------------------------------------------------------------
  platform(m, [-384, 640, 384, 960], 640, P, { thick: 48, taper: 64 });
  for (const x of [-128, 128]) underGlow(m, x, 800, 528);
  platform(m, [-960, 640, -384, 768], 640, P, { thick: 32 });                       // west arm
  m.box([-384, 960, 592, 384, 992, 832], { top: T.metal, side: T.tower });          // back wall
  m.box([-416, 944, 592, -384, 1008, 864], T.post); m.box([384, 944, 592, 416, 1008, 864], T.post);
  m.box([-384, 960, 832, 384, 1008, 848], { top: T.metal, side: T.trim });
  for (const x of [-256, 0, 256]) lamp(m, [x, 960, 760], { mount: '-y', light: 240, color: '1 0.4 0.3' });
  m.box([-96, 784, 640, -64, 816, 704], T.post); m.box([64, 784, 640, 96, 816, 704], T.post); // cover posts
  pillar(m, -256, 800, 40, 0, 592, { top: T.post, bottom: T.post, side: T.tower });
  pillar(m, 256, 800, 40, 0, 592, { top: T.post, bottom: T.post, side: T.tower });
  pillar(m, -672, 704, 32, 0, 608, { top: T.post, bottom: T.post, side: T.tower });
  m.item('item_armorInv', 0, 880, 640);
  m.item('item_rockets', -320, 880, 640);
  m.item('item_health', 300, 680, 640);

  // ---- south deck (YA) z=256 ------------------------------------------------------------
  platform(m, [-384, -960, 384, -640], 256, P, { thick: 48, taper: 64 });
  for (const x of [-128, 128]) underGlow(m, x, -800, 144);
  m.stairs([-64, -640, 64, -256], '+y', 256, 384, { top: T.stairTop, side: T.stairSide });
  pillar(m, -256, -800, 40, 0, 208, { top: T.post, bottom: T.post, side: T.tower });
  pillar(m, 256, -800, 40, 0, 208, { top: T.post, bottom: T.post, side: T.tower });
  m.box([-384, -992, 208, 384, -960, 352], { top: T.metal, side: T.tower });         // low back wall
  for (const x of [-192, 192]) lamp(m, [x, -960, 320], { mount: '+y', light: 220, color: '0.6 0.8 1' });
  m.item('item_armor2', 0, -880, 256);
  m.item('item_health', -340, -680, 256);
  m.item('item_shells', 120, -700, 256);
  teleporter(m, 340, -880, 256, '-x', 'aero_w');
  teleDest(m, 288, -760, 256, 180, 'aero_s');

  // ---- west tower (LG) z=448 ------------------------------------------------------------
  m.box([-1088, -288, 0, -704, 288, 448], { top: T.towerTop, bottom: T.tower, side: T.tower });
  m.box([-1088, -288, 432, -704, 288, 448], { top: T.towerTop, side: T.trim });
  // shelter on top
  m.box([-1088, -160, 448, -1056, 160, 640], T.tower);
  m.box([-1088, -176, 448, -1040, -160, 640], T.post); m.box([-1088, 160, 448, -1040, 176, 640], T.post);
  m.box([-1088, -176, 640, -912, 176, 672], { top: T.metal, bottom: T.metal, side: T.trim });
  lamp(m, [-1000, 0, 640], { mount: 'ceil', light: 260, color: '0.5 0.8 1' });
  m.item('weapon_lightning', -1000, 0, 448);
  m.item('item_cells', -960, -230, 448);
  m.item('item_health', -760, -240, 448);
  // bridge hub → west tower (gentle ramp 384 → 448)
  m.ramp([-704, -48, 384, -256, 48, 448], '-x', { top: T.stairTop, side: T.side });
  // long stairs west tower → north deck west arm (448 → 640)
  m.stairs([-960, 288, -832, 640], '+y', 448, 640, { top: T.stairTop, side: T.stairSide });
  pillar(m, -896, 464, 24, 0, 432, T.post);
  gate(m, [-480, 0], 'x', 64, 416, 128, G);
  gate(m, [-896, 560], 'y', 80, 576, 144, G);
  teleDest(m, -800, -200, 448, 90, 'aero_w');

  // ---- east tower (GL) z=320, gap bridge from the hub --------------------------------------
  m.box([704, -288, 0, 1088, 288, 320], { top: T.towerTop, bottom: T.tower, side: T.tower });
  m.box([704, -288, 304, 1088, 288, 320], { top: T.towerTop, side: T.trim });
  platform(m, [256, -48, 416, 48], 384, P, { thick: 24 });                         // hub stub
  platform(m, [576, -48, 704, 48], 352, P, { thick: 24 });                         // far stub (gap 160)
  m.box([672, -48, 320, 704, 48, 336], { top: T.stairTop, side: T.stairSide });   // step down
  gate(m, [640, 0], 'x', 64, 352, 120, G);
  // tower facade: light strips
  for (const y of [-192, -64, 64, 192]) m.box([700, y - 8, 64, 704, y + 8, 296], { top: T.metal, bottom: T.metal, side: 't_lit01' });
  for (const y of [-192, -64, 64, 192]) m.box([-704, y - 8, 64, -700, y + 8, 424], { top: T.metal, bottom: T.metal, side: 't_lit01' });
  m.item('weapon_grenadelauncher', 960, -160, 320);
  m.item('item_rockets', 800, 200, 320);
  m.item('item_health', 1000, 230, 320);
  teleporter(m, 1040, 120, 320, '-x', 'aero_s');
  lamp(m, [760, -280, 400], { mount: '+y', light: 200, color: '1 0.7 0.4' });

  // ---- mega-health pad z=512 ------------------------------------------------------------
  platform(m, [544, 544, 672, 672], 512, { ...P, top: 'aqf032', border: null }, { thick: 32, taper: 40 });
  pillar(m, 608, 608, 20, 0, 480, T.post);
  lamp(m, [608, 608, 720], { mount: 'ceil', light: 200, color: '0.4 0.6 1' });
  m.box([592, 592, 704, 624, 624, 720], T.post);
  m.box([600, 600, 720, 616, 616, 1344], T.post); // hanging cable to the sky
  m.item('item_health', 592, 592, 512, { spawnflags: '2' });

  // ---- distant monoliths (depth cues) ----------------------------------------------------
  for (const [x, y, h] of [[-1240, -1100, 900], [1220, -1080, 700], [1250, 1110, 1000], [-1200, 1080, 760], [0, -1180, 520]]) {
    m.box([x - 48, y - 48, 0, x + 48, y + 48, h], { top: T.metal, bottom: T.tower, side: T.tower });
    lamp(m, [x, y, h], { mount: 'floor', size: 12, h: 12, light: 300, color: '1 0.3 0.2' });
  }

  // ---- spawns -------------------------------------------------------------------------
  m.spawn(-192, -192, 384, 45);
  m.spawn(192, 120, 384, 225);
  m.spawn(-288, 720, 640, 0);
  m.spawn(300, 880, 640, 180);
  m.spawn(-800, 200, 448, 0);
  m.spawn(-640, 704, 640, 0);
  m.spawn(800, -200, 320, 90);
  m.spawn(-288, -900, 256, 0);
  m.spawn(160, -760, 256, 90);
  m.spawn(640, 0, 352, 180);
  m.point('info_intermission', [-700, -700, 900], { mangle: '30 45 0' });
  m.ent('ambient_suck_wind', { origin: '0 0 300' });
  return m;
}
