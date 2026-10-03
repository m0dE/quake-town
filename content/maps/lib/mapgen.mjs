// Quake Town map generator: brush geometry in code, deterministic .map output.
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
//
// Model: a map is a union of AIR boxes ("rooms") carved out of solid. Each air box owns a
// shell of solid slabs around it; every slab has every other air box subtracted from it.
// The result is sealed by construction (no leaks), and every wall face takes the material of
// the room it faces (floor / wall / ceiling textures). On top of that come DETAIL brushes
// (stairs, pillars, platforms, ramps, trims, lamps), liquids and brush entities.

const T = 16; // shell thickness

export class MapBuilder {
  constructor({ message, worldspawn = {}, wads = [] }) {
    this.message = message;
    this.worldspawn = worldspawn;
    this.wads = wads;
    this.airs = []; // { b:[x0,y0,z0,x1,y1,z1], mat }
    this.world = []; // brushes: { planes:[{pts,tex}] }
    this.detail = []; // func_detail brushes (no vis portals): decoration
    this.det = { box: (b, tex) => this.box(b, tex, this.detail), brush: (p, i) => this.brush(p, i, this.detail) };
    this.ents = []; // { props, brushes }
    this.checks = { spawns: [], items: [] };
  }

  // --- air -----------------------------------------------------------------------------
  /** mat: { floor, wall, ceil } texture names (ceil 'sky...' for open sky). */
  air(b, mat) {
    const [x0, y0, z0, x1, y1, z1] = b;
    if (!(x1 > x0 && y1 > y0 && z1 > z0)) throw new Error(`bad air box ${b}`);
    this.airs.push({ b: [x0, y0, z0, x1, y1, z1], mat });
    return this;
  }

  // --- brushes -------------------------------------------------------------------------
  /** axis box; tex = name or { top, bottom, side, n, s, e, w } */
  box(b, tex, target = this.world) {
    const br = boxBrush(b, tex);
    target.push(br);
    return br;
  }
  /** generic convex brush from planes given as 3 points each (any winding) plus an inside point */
  brush(planes, inside, target = this.world) {
    const br = { planes: planes.map(({ pts, tex }) => ({ pts: orient(pts, inside), tex })) };
    target.push(br);
    return br;
  }
  /**
   * Ramp: wedge over the box b rising along dir ('+x','-x','+y','-y') from z0 to z1 (top
   * surface slopes); bottom at b[2]. tex: { top, side }.
   */
  ramp(b, dir, tex, target = this.world) {
    const [x0, y0, z0, x1, y1, z1] = b;
    const lo = z0 + (tex.lip ?? 0); // height at the low end (may be > bottom)
    const P = (x, y, z) => [x, y, z];
    let top;
    if (dir === '+x') top = [P(x0, y0, lo), P(x1, y0, z1), P(x1, y1, z1)];
    else if (dir === '-x') top = [P(x1, y0, lo), P(x0, y0, z1), P(x0, y1, z1)];
    else if (dir === '+y') top = [P(x0, y0, lo), P(x0, y1, z1), P(x1, y1, z1)];
    else top = [P(x0, y1, lo), P(x0, y0, z1), P(x1, y0, z1)];
    const base = z0 - (tex.depth ?? 16);
    const inside = [(x0 + x1) / 2, (y0 + y1) / 2, base + 1];
    const s = tex.side ?? tex.top;
    const planes = [
      { pts: top, tex: tex.top },
      { pts: [P(x0, y0, base), P(x1, y0, base), P(x1, y1, base)], tex: s },
      { pts: [P(x0, y0, 0), P(x0, y1, 0), P(x0, y1, 1)], tex: s },
      { pts: [P(x1, y0, 0), P(x1, y1, 0), P(x1, y1, 1)], tex: s },
      { pts: [P(x0, y0, 0), P(x1, y0, 0), P(x1, y0, 1)], tex: s },
      { pts: [P(x0, y1, 0), P(x1, y1, 0), P(x1, y1, 1)], tex: s },
    ];
    return this.brush(planes, inside, target);
  }
  /**
   * Straight stairs inside the footprint b=[x0,y0,x1,y1] climbing along dir from zFrom to zTo.
   * Every rise ≤ 16 (asserted), the last step lands exactly on zTo. Steps are solid down to zFrom-16.
   */
  stairs(foot, dir, zFrom, zTo, tex) {
    const [x0, y0, x1, y1] = foot;
    const rise = zTo - zFrom;
    const n = Math.ceil(Math.abs(rise) / 16);
    const len = dir[1] === 'x' ? x1 - x0 : y1 - y0;
    const run = len / n;
    if (run < 16) throw new Error(`stairs too steep: run ${run}`);
    for (let i = 0; i < n; i++) {
      const top = zFrom + Math.round((rise * (i + 1)) / n);
      if (Math.abs(top - (zFrom + Math.round((rise * i) / n))) > 16) throw new Error('step > 16');
      // the i-th step covers the part of the run from i*run to the end (solid block)
      const a = Math.round(i * run), b = len;
      let bb;
      if (dir === '+x') bb = [x0 + a, y0, zFrom - 16, x0 + b, y1, top];
      else if (dir === '-x') bb = [x1 - b, y0, zFrom - 16, x1 - a, y1, top];
      else if (dir === '+y') bb = [x0, y0 + a, zFrom - 16, x1, y0 + b, top];
      else bb = [x0, y1 - b, zFrom - 16, x1, y1 - a, top];
      this.box(bb, { top: tex.top, bottom: tex.side, side: tex.side });
    }
  }

  // --- entities ------------------------------------------------------------------------
  ent(classname, props = {}, brushes = null) {
    const e = { props: { classname, ...props }, brushes: brushes ?? [] };
    this.ents.push(e);
    return e;
  }
  /** point entity at [x,y,z] */
  point(classname, o, props = {}) {
    const e = this.ent(classname, { origin: o.map(fmt).join(' '), ...props });
    if (/^info_player_/.test(classname)) this.checks.spawns.push({ classname, o });
    else if (/^(item_|weapon_)/.test(classname)) this.checks.items.push({ classname, o });
    return e;
  }
  /** a player spawn standing on the floor at height z (origin = feet + 24) */
  spawn(x, y, z, angle, classname = 'info_player_deathmatch') {
    return this.point(classname, [x, y, z + 24], { angle: String(angle) });
  }
  /** an item resting on the floor at z (items drop to floor at spawn) */
  item(classname, x, y, z, props = {}) {
    return this.point(classname, [x, y, z + 8], props);
  }
  light(o, light, props = {}) {
    return this.ent('light', { origin: o.map(fmt).join(' '), light: String(light), ...props });
  }
  /** a brush entity (func_plat, trigger_teleport, …) from boxes */
  brushEnt(classname, props, boxes) {
    const brushes = boxes.map(([b, tex]) => boxBrush(b, tex));
    return this.ent(classname, props, brushes);
  }

  // --- output --------------------------------------------------------------------------
  shell() {
    const out = [];
    const airs = this.airs;
    airs.forEach((A, ai) => {
      const [x0, y0, z0, x1, y1, z1] = A.b;
      const m = A.mat;
      // six slabs, z slabs cover the expanded footprint so corners are sealed
      const slabs = [
        { b: [x0 - T, y0 - T, z0 - T, x1 + T, y1 + T, z0], face: 'top', tex: m.floor },
        { b: [x0 - T, y0 - T, z1, x1 + T, y1 + T, z1 + T], face: 'bottom', tex: m.ceil },
        { b: [x0 - T, y0 - T, z0, x0, y1 + T, z1], face: 'e', tex: m.wall },
        { b: [x1, y0 - T, z0, x1 + T, y1 + T, z1], face: 'w', tex: m.wall },
        { b: [x0, y0 - T, z0, x1, y0, z1], face: 'n', tex: m.wall },
        { b: [x0, y1, z0, x1, y1 + T, z1], face: 's', tex: m.wall },
      ];
      // optional wall bands: wallLow below z0+lowH, a trim band, wall above
      if (m.wallLow || m.wallTrim) {
        const lowH = m.lowH ?? 64, trimH = m.wallTrim ? (m.trimH ?? 16) : 0;
        const zA = Math.min(z1, z0 + lowH), zB = Math.min(z1, zA + trimH);
        const banded = [];
        for (const s of slabs) {
          if (s.face === 'top' || s.face === 'bottom') { banded.push(s); continue; }
          const [a0, a1, , a3, a4] = s.b;
          if (zA > z0) banded.push({ b: [a0, a1, z0, a3, a4, zA], face: s.face, tex: m.wallLow ?? m.wall });
          if (zB > zA) banded.push({ b: [a0, a1, zA, a3, a4, zB], face: s.face, tex: m.wallTrim });
          if (z1 > zB) banded.push({ b: [a0, a1, zB, a3, a4, z1], face: s.face, tex: m.wall });
        }
        slabs.length = 0; slabs.push(...banded);
      }
      for (const s of slabs) {
        const faces = { top: m.wall, bottom: m.wall, n: m.wall, s: m.wall, e: m.wall, w: m.wall };
        faces[s.face] = s.tex;
        let pieces = [{ b: s.b, faces }];
        for (let bi = 0; bi < airs.length; bi++) {
          if (bi === ai) continue;
          pieces = pieces.flatMap((p) => subtract(p, airs[bi]));
          if (!pieces.length) break;
        }
        // a sky ceiling must be all sky, or qbsp makes the brush SOLID (rockets would explode on the sky)
        if (s.face === 'bottom' && /^sky/i.test(s.tex || '')) for (const p of pieces) for (const k of Object.keys(p.faces)) p.faces[k] = s.tex;
        out.push(...pieces);
      }
    });
    return out;
  }

  toMap() {
    const lines = [];
    const ws = { classname: 'worldspawn', message: this.message, wad: this.wads.join(';'), ...this.worldspawn };
    lines.push('// Generated by Quake Town content/maps (GPL-2.0-or-later). Do not edit; edit the generator.');
    lines.push('{');
    for (const [k, v] of Object.entries(ws)) lines.push(`"${k}" "${v}"`);
    const pieces = this.shell();
    for (const p of pieces) lines.push(brushText(boxBrush(p.b, p.faces)));
    for (const br of this.world) lines.push(brushText(br));
    lines.push('}');
    if (this.detail.length) {
      lines.push('{', '"classname" "func_detail"');
      for (const br of this.detail) lines.push(brushText(br));
      lines.push('}');
    }
    for (const e of this.ents) {
      lines.push('{');
      for (const [k, v] of Object.entries(e.props)) lines.push(`"${k}" "${v}"`);
      for (const br of e.brushes) lines.push(brushText(br));
      lines.push('}');
    }
    this.stats = { airs: this.airs.length, shellBrushes: pieces.length, detailBrushes: this.world.length + this.detail.length, entities: this.ents.length };
    return lines.join('\n') + '\n';
  }

  /** player-clearance assertions on air boxes the generator marks walkable */
  bounds() {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const a of this.airs) for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k], a.b[k]); b[k + 3] = Math.max(b[k + 3], a.b[k + 3]); }
    return b;
  }
}

function fmt(v) { return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000); }

/** subtract air box A from solid piece p (axis boxes), returning remaining pieces; faces created on
 *  A's boundary take A's material. */
function subtract(p, A) {
  const [a0, a1, a2, a3, a4, a5] = A.b;
  const b = p.b;
  if (a0 >= b[3] || a3 <= b[0] || a1 >= b[4] || a4 <= b[1] || a2 >= b[5] || a5 <= b[2]) return [p];
  const out = [];
  let cur = b.slice();
  const m = A.mat;
  // split along x
  if (a0 > cur[0]) { out.push({ b: [cur[0], cur[1], cur[2], a0, cur[4], cur[5]], faces: { ...p.faces, e: m.wall } }); cur[0] = a0; }
  if (a3 < cur[3]) { out.push({ b: [a3, cur[1], cur[2], cur[3], cur[4], cur[5]], faces: { ...p.faces, w: m.wall } }); cur[3] = a3; }
  if (a1 > cur[1]) { out.push({ b: [cur[0], cur[1], cur[2], cur[3], a1, cur[5]], faces: { ...p.faces, n: m.wall } }); cur[1] = a1; }
  if (a4 < cur[4]) { out.push({ b: [cur[0], a4, cur[2], cur[3], cur[4], cur[5]], faces: { ...p.faces, s: m.wall } }); cur[4] = a4; }
  if (a2 > cur[2]) { out.push({ b: [cur[0], cur[1], cur[2], cur[3], cur[4], a2], faces: { ...p.faces, top: m.floor } }); cur[2] = a2; }
  if (a5 < cur[5]) { out.push({ b: [cur[0], cur[1], a5, cur[3], cur[4], cur[5]], faces: { ...p.faces, bottom: m.ceil } }); cur[5] = a5; }
  return out;
}

// Face naming: 'top' (+z), 'bottom' (-z), 'e' = the -x face? No: name by the direction the
// face's normal points. e = +x, w = -x, n = +y, s = -y. (slab 'e' above means the slab on the
// west side of the room whose +x face looks into the room.)
export function boxBrush(b, tex) {
  const [x0, y0, z0, x1, y1, z1] = b;
  if (!(x1 > x0 && y1 > y0 && z1 > z0)) throw new Error(`degenerate box ${b}`);
  const t = typeof tex === 'string' ? { top: tex, bottom: tex, side: tex } : tex;
  const side = (k) => t[k] ?? t.side ?? t.top;
  const inside = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
  const planes = [
    { pts: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1]], tex: t.top ?? t.side },
    { pts: [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0]], tex: t.bottom ?? t.side },
    { pts: [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], tex: side('e') },
    { pts: [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1]], tex: side('w') },
    { pts: [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1]], tex: side('n') },
    { pts: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1]], tex: side('s') },
  ];
  return { planes: planes.map(({ pts, tex }) => ({ pts: orient(pts, inside), tex })) };
}

/** order the 3 points so the plane normal (Quake: (p0-p1)×(p2-p1)) points away from `inside` */
function orient(pts, inside) {
  const [p0, p1, p2] = pts;
  const a = sub(p0, p1), b = sub(p2, p1);
  const n = cross(a, b);
  const d = dot(n, sub(inside, p1));
  if (d === 0) throw new Error(`inside point on plane ${JSON.stringify(pts)}`);
  return d < 0 ? pts : [p2, p1, p0];
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function brushText(br) {
  const l = ['{'];
  for (const { pts, tex } of br.planes) {
    l.push(`( ${pts[0].map(fmt).join(' ')} ) ( ${pts[1].map(fmt).join(' ')} ) ( ${pts[2].map(fmt).join(' ')} ) ${tex || 'skip'} 0 0 0 1 1`);
  }
  l.push('}');
  return l.join('\n');
}
