// Quake Town map kit: higher-level pieces on top of MapBuilder (platforms, pillars, lamps,
// jump pads, teleporters, lifts, railings). Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.

/** Floating/standing platform: top surface at z, slab `thick` deep, optional trim band. */
export function platform(m, [x0, y0, x1, y1], z, t, { thick = 32, trim = t.trim, trimH = 16, border = t.border, bw = 32, taper = 0 } = {}) {
  if (border && x1 - x0 > 3 * bw && y1 - y0 > 3 * bw) {
    // top surface: a border frame of another texture around the field (flush, same height)
    const zz = z - 4;
    m.box([x0 + bw, y0 + bw, zz, x1 - bw, y1 - bw, z], { top: t.top, side: t.top, bottom: t.side });
    m.box([x0, y0, zz, x1, y0 + bw, z], { top: border, side: trim ?? t.side, bottom: t.side });
    m.box([x0, y1 - bw, zz, x1, y1, z], { top: border, side: trim ?? t.side, bottom: t.side });
    m.box([x0, y0 + bw, zz, x0 + bw, y1 - bw, z], { top: border, side: trim ?? t.side, bottom: t.side });
    m.box([x1 - bw, y0 + bw, zz, x1, y1 - bw, z], { top: border, side: trim ?? t.side, bottom: t.side });
    z = zz; thick -= 4;
  }
  if (taper > 0) {
    // floating island underside: a frustum below the slab
    const i = Math.min(taper, (x1 - x0) / 2 - 16, (y1 - y0) / 2 - 16);
    frustum(m, [x0, y0, x1, y1], [x0 + i, y0 + i, x1 - i, y1 - i], z - thick - taper, z - thick, { top: t.side, bottom: t.under ?? t.side, side: t.under ?? t.side });
  }
  if (trim) {
    m.box([x0, y0, z - trimH, x1, y1, z], { top: t.top, bottom: t.under ?? t.side, side: trim });
    m.box([x0, y0, z - thick, x1, y1, z - trimH], { top: t.side, bottom: t.under ?? t.side, side: t.side });
  } else {
    m.box([x0, y0, z - thick, x1, y1, z], { top: t.top, bottom: t.under ?? t.side, side: t.side });
  }
}

/** Square pillar from z0 to z1 centred at (x,y) with half-size r. */
export function pillar(m, x, y, r, z0, z1, tex) {
  m.det.box([x - r, y - r, z0, x + r, y + r, z1], typeof tex === 'string' ? { top: tex, bottom: tex, side: tex } : tex);
}

/** A lamp: a small fullbright fixture box plus a light entity just below/in front of it. */
export function lamp(m, [x, y, z], { size = 8, h = 8, tex = 'tlight11', light = 220, color = null, wait = null, mount = 'ceil', side = 'met_gry_flat', delay = null } = {}) {
  if (mount === 'ceil') {
    m.det.box([x - size, y - size, z - h, x + size, y + size, z], { top: side, bottom: tex, side });
    m.light([x, y, z - h - 12], light, { ...(color ? { _color: color } : {}), ...(wait ? { wait } : {}), ...(delay ? { delay } : {}) });
  } else if (mount === 'floor') {
    m.det.box([x - size, y - size, z, x + size, y + size, z + h], { top: tex, bottom: side, side });
    m.light([x, y, z + h + 12], light, { ...(color ? { _color: color } : {}), ...(wait ? { wait } : {}), ...(delay ? { delay } : {}) });
  } else {
    // wall mount facing direction mount = '+x' | '-x' | '+y' | '-y'
    const d = { '+x': [1, 0], '-x': [-1, 0], '+y': [0, 1], '-y': [0, -1] }[mount];
    const b = d[0] ? [x, y - size, z - h, x + d[0] * 6, y + size, z + h] : [x - size, y, z - h, x + size, y + d[1] * 6, z + h];
    const bb = [Math.min(b[0], b[3]), Math.min(b[1], b[4]), b[2], Math.max(b[0], b[3]), Math.max(b[1], b[4]), b[5]];
    const faces = { top: side, bottom: side, side };
    faces[d[0] > 0 ? 'e' : d[0] < 0 ? 'w' : d[1] > 0 ? 'n' : 's'] = tex;
    m.det.box(bb, faces);
    m.light([x + d[0] * 20, y + d[1] * 20, z], light, { ...(color ? { _color: color } : {}), ...(wait ? { wait } : {}), ...(delay ? { delay } : {}) });
  }
}

/** Jump pad at (x,y) on floor z: a visual pad brush plus a trigger_push.
 *  vel: [vx, vy, vz] desired launch velocity (qw-qc sets velocity = speed*movedir*10). */
export function jumpPad(m, x, y, z, vel, { r = 32, tex = '+0tek_jump1', side = 'met_gry_flat' } = {}) {
  m.det.box([x - r, y - r, z, x + r, y + r, z + 4], { top: tex, bottom: side, side });
  const sp = Math.hypot(...vel);
  const pitch = -Math.atan2(vel[2], Math.hypot(vel[0], vel[1])) * 180 / Math.PI;
  const yaw = Math.atan2(vel[1], vel[0]) * 180 / Math.PI;
  const props = Math.hypot(vel[0], vel[1]) < 1e-6
    ? { angle: '-1', speed: String(Math.round(sp / 10)) }
    : { angles: `${pitch.toFixed(2)} ${yaw.toFixed(2)} 0`, speed: String(Math.round(sp / 10)) };
  m.brushEnt('trigger_push', props, [[[x - r + 8, y - r + 8, z + 4, x + r - 8, y + r - 8, z + 24], 'trigger']]);
  m.light([x, y, z + 24], 120, { _color: '0.4 0.8 1' });
}

/** Teleporter booth: a frame with a warping portal (func_illusionary) and trigger_teleport.
 *  Facing dir is the side players enter from ('+x','-x','+y','-y'). */
export function teleporter(m, x, y, z, dir, target, { frame = 'tele_frame1', portal = '*tele1', w = 64, h = 112, color = '0.7 0.5 1' } = {}) {
  const across = dir[1] === 'x' ? 'y' : 'x';
  const s = dir[0] === '+' ? 1 : -1;
  // back wall + side posts + lintel, all world brushes
  const B = (a0, a1, d0, d1, z0, z1) => (across === 'y'
    ? [x + Math.min(d0, d1) * 1, y + a0, z0, x + Math.max(d0, d1), y + a1, z1]
    : [x + a0, y + Math.min(d0, d1), z0, x + a1, y + Math.max(d0, d1), z1]);
  const hw = w / 2;
  // depth coordinates along dir: back wall at -s*24..-s*16 relative
  const d = (v) => v * s;
  m.det.box(B(-hw - 16, hw + 16, d(-32), d(-16), z, z + h + 16), frame);            // back
  m.det.box(B(-hw - 16, -hw, d(-16), d(8), z, z + h + 16), frame);                  // post
  m.det.box(B(hw, hw + 16, d(-16), d(8), z, z + h + 16), frame);                    // post
  m.det.box(B(-hw, hw, d(-16), d(8), z + h, z + h + 16), frame);                    // lintel
  m.det.box(B(-hw - 16, hw + 16, d(-32), d(8), z - 8, z), 'met_gry_flat');          // sill
  m.brushEnt('func_illusionary', {}, [[B(-hw, hw, d(-16), d(-12), z, z + h), portal]]);
  m.brushEnt('trigger_teleport', { target }, [[B(-hw + 8, hw - 8, d(-12), d(4), z, z + h - 8), 'trigger']]);
  m.light(across === 'y' ? [x + d(24), y, z + h - 16] : [x, y + d(24), z + h - 16], 160, { _color: color });
}
export function teleDest(m, x, y, z, angle, name) {
  // qw-qc adds 27 to the destination origin; feet at z → origin z - 3
  m.point('info_teleport_destination', [x, y, z - 3], { targetname: name, angle: String(angle) });
}

/** func_plat lift: the brush is placed at its TOP position (qw-qc lowers it by height). */
export function lift(m, [x0, y0, x1, y1], zBottom, zTop, { top = 'plat_top1', side = 'plat_side1', speed = 200 } = {}) {
  const height = zTop - zBottom;
  m.brushEnt('func_plat', { height: String(height), speed: String(speed), sounds: '2' },
    [[[x0, y0, zTop - 16, x1, y1, zTop], { top, bottom: side, side }]]);
}

/** a low railing along an edge (blocks walking off, not shooting); h ≤ 32 */
export function rail(m, b, h, tex, z) { m.box([b[0], b[1], z, b[2], b[3], z + h], tex); }

/** a frustum brush: rectangle `top` at z1, rectangle `bot` at z0 (both [x0,y0,x1,y1]) */
export function frustum(m, top, bot, z0, z1, tex) {
  const T = (x, y) => [x, y, z1], B = (x, y) => [x, y, z0];
  const inside = [(top[0] + top[2] + bot[0] + bot[2]) / 4, (top[1] + top[3] + bot[1] + bot[3]) / 4, (z0 + z1) / 2];
  return m.det.brush([
    { pts: [T(top[0], top[1]), T(top[2], top[1]), T(top[2], top[3])], tex: tex.top },
    { pts: [B(bot[0], bot[1]), B(bot[2], bot[1]), B(bot[2], bot[3])], tex: tex.bottom },
    { pts: [T(top[0], top[1]), T(top[2], top[1]), B(bot[2], bot[1])], tex: tex.side },
    { pts: [T(top[0], top[3]), T(top[2], top[3]), B(bot[2], bot[3])], tex: tex.side },
    { pts: [T(top[0], top[1]), T(top[0], top[3]), B(bot[0], bot[3])], tex: tex.side },
    { pts: [T(top[2], top[1]), T(top[2], top[3]), B(bot[2], bot[3])], tex: tex.side },
  ], inside);
}

/** an arch/gate over a walkway: two posts and a beam. axis = 'x' (walkway runs along x) or 'y' */
export function gate(m, c, axis, halfW, z, h, tex, { beam = 24, post = 16 } = {}) {
  const [x, y] = c;
  if (axis === 'x') {
    m.det.box([x - post / 2, y - halfW - post, z, x + post / 2, y - halfW, z + h], tex.post);
    m.det.box([x - post / 2, y + halfW, z, x + post / 2, y + halfW + post, z + h], tex.post);
    m.det.box([x - post / 2 - 4, y - halfW - post, z + h, x + post / 2 + 4, y + halfW + post, z + h + beam], tex.beam);
  } else {
    m.det.box([x - halfW - post, y - post / 2, z, x - halfW, y + post / 2, z + h], tex.post);
    m.det.box([x + halfW, y - post / 2, z, x + halfW + post, y + post / 2, z + h], tex.post);
    m.det.box([x - halfW - post, y - post / 2 - 4, z + h, x + halfW + post, y + post / 2 + 4, z + h + beam], tex.beam);
  }
}

/** ericw surface light: every face with texture `tex` emits light */
export function surfaceLight(m, tex, light, color = null, extra = {}) {
  m.light([0, 0, 0], light, { _surface: tex, ...(color ? { _color: color } : {}), ...extra });
}

/** a glowing panel under a floating platform (bottom face fullbright texture + light pointing down) */
export function underGlow(m, x, y, z, { r = 24, tex = 't_lit07', side = 'met_gry_flat', light = 160, color = '0.6 0.8 1' } = {}) {
  m.det.box([x - r, y - r, z - 8, x + r, y + r, z], { top: side, bottom: tex, side });
  m.light([x, y, z - 32], light, { _color: color });
}
