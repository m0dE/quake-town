// progs/flag.mdl for Quake Town CTF — built entirely in code (our own work; the model is
// released under BSD-3-Clause like the LibreQuake art it ships with).
// A pole with a waving cloth, two skins (0 = red team1, 1 = blue team2), 8 wave frames
// "wave1".."wave8" (loop them at ~10 Hz), origin at the foot of the pole, height 74 to
// match ThreeWave's setsize('-16 -16 0', '16 16 74').
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later (this generator).
import { ANORMS } from '../../tools/content/lib/anorms.mjs';

const SKIN_W = 64, SKIN_H = 48;
const POLE_H = 74, POLE_R = 1.25;
const CLOTH_L = 34, CLOTH_H = 24, CLOTH_TOP = 72;
const NX = 8, NY = 4; // cloth quads
const FRAMES = 8;

/** nearest palette index among the lit (non-fullbright) colours 0..223 */
function nearest(pal, r, g, b) {
  let best = 0, bd = Infinity;
  for (let i = 1; i < 224; i++) {
    const dr = pal[i * 3] - r, dg = pal[i * 3 + 1] - g, db = pal[i * 3 + 2] - b;
    const d = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

function skin(pal, base) {
  const px = new Uint8Array(SKIN_W * SKIN_H);
  const [r, g, b] = base;
  for (let y = 0; y < SKIN_H; y++) {
    for (let x = 0; x < SKIN_W; x++) {
      let c;
      if (x >= 48) {
        // pole: brushed metal, darker at the edges of the strip
        const e = Math.abs(x - 55.5) / 8;
        const v = 150 - e * 60 + ((x * 7 + y * 3) % 5) * 3;
        c = [v, v * 0.95, v * 0.85];
      } else if (y < 32) {
        // cloth 48×32: border, field, emblem (a diamond with a ring)
        const border = x < 2 || x > 45 || y < 2 || y > 29;
        const dx = Math.abs(x - 22) / 11, dy = Math.abs(y - 16) / 11;
        const diamond = dx + dy < 1 && dx + dy > 0.62;
        const core = dx + dy < 0.32;
        const weave = ((x + y) & 1) ? 0.94 : 1.0; // cloth weave
        const fold = 0.88 + 0.12 * Math.cos(x / 48 * Math.PI * 3); // painted folds
        let k = weave * fold;
        if (border) c = [r * 0.45, g * 0.45, b * 0.45];
        else if (diamond || core) c = [235 * k, 225 * k, 200 * k];
        else c = [r * k, g * k, b * k];
      } else {
        // unused rows: dark
        c = [30, 30, 30];
      }
      px[y * SKIN_W + x] = nearest(pal, c[0], c[1], c[2]);
    }
  }
  return px;
}

function geometry() {
  const st = []; // [onseam, s, t]
  const tris = []; // [facesfront, a, b, c]
  const verts = []; // per frame: function(frame) -> [[x,y,z]...]
  // pole: 4 faces, each 4 verts (no shared seams)
  const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  for (let f = 0; f < 4; f++) {
    const a = corners[f], b = corners[(f + 1) % 4];
    const base = st.length;
    const s0 = 48 + f * 4, s1 = s0 + 4;
    st.push([0, s0, SKIN_H - 1], [0, s1, SKIN_H - 1], [0, s1, 0], [0, s0, 0]);
    verts.push(() => [a[0] * POLE_R, a[1] * POLE_R, 0]);
    verts.push(() => [b[0] * POLE_R, b[1] * POLE_R, 0]);
    verts.push(() => [b[0] * POLE_R, b[1] * POLE_R, POLE_H]);
    verts.push(() => [a[0] * POLE_R, a[1] * POLE_R, POLE_H]);
    tris.push([1, base, base + 1, base + 2], [1, base, base + 2, base + 3]);
  }
  // knob on top: a small pyramid
  {
    const base = st.length;
    for (let f = 0; f < 4; f++) {
      const a = corners[f];
      st.push([0, 50 + f * 3, 2]);
      verts.push(() => [a[0] * 2.4, a[1] * 2.4, POLE_H]);
    }
    st.push([0, 56, 0]);
    verts.push(() => [0, 0, POLE_H + 4]);
    for (let f = 0; f < 4; f++) tris.push([1, base + f, base + (f + 1) % 4, base + 4]);
  }
  // cloth grid
  const cbase = st.length;
  for (let j = 0; j <= NY; j++) {
    for (let i = 0; i <= NX; i++) {
      const u = i / NX, v = j / NY;
      st.push([0, Math.min(47, Math.round(u * 47)), Math.min(31, Math.round(v * 31))]);
      verts.push((fr) => {
        const ph = (fr / FRAMES) * Math.PI * 2;
        const amp = 5.5 * u;
        const y = amp * Math.sin(u * Math.PI * 2.2 - ph) + 1.2 * u * Math.sin(v * Math.PI - ph * 0.5);
        const droop = 3.5 * u * u + 1.5 * u * Math.sin(ph + u * 3);
        const x = POLE_R + u * CLOTH_L * (1 - 0.06 * Math.abs(Math.sin(u * Math.PI * 2.2 - ph)));
        const z = CLOTH_TOP - v * CLOTH_H - droop * (0.4 + 0.6 * v);
        return [x, y, z];
      });
    }
  }
  const idx = (i, j) => cbase + j * (NX + 1) + i;
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      const a = idx(i, j), b = idx(i + 1, j), c = idx(i + 1, j + 1), d = idx(i, j + 1);
      tris.push([1, a, b, c], [1, a, c, d]); // one side
      tris.push([1, a, c, b], [1, a, d, c]); // other side (double-sided cloth)
    }
  }
  return { st, tris, verts };
}

function normalIndex(n) {
  let best = 0, bd = -2;
  for (let i = 0; i < ANORMS.length; i++) {
    const a = ANORMS[i];
    const d = a[0] * n[0] + a[1] * n[1] + a[2] * n[2];
    if (d > bd) { bd = d; best = i; }
  }
  return best;
}

/** Build progs/flag.mdl. `palette` = gfx/palette.lmp bytes (768). */
export function buildFlagMdl(palette) {
  const { st, tris, verts } = geometry();
  const frames = [];
  for (let f = 0; f < FRAMES; f++) frames.push(verts.map((fn) => fn(f)));
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const fr of frames) for (const v of fr) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], v[k]); max[k] = Math.max(max[k], v[k]); }
  const scale = min.map((m, k) => Math.max(1e-3, (max[k] - m) / 255));
  let radius = 0;
  for (const fr of frames) for (const v of fr) radius = Math.max(radius, Math.hypot(v[0], v[1], v[2]));

  const skins = [skin(palette, [200, 30, 24]), skin(palette, [30, 60, 210])];
  const nv = st.length, nt = tris.length;
  const size = 84 + skins.length * (4 + SKIN_W * SKIN_H) + nv * 12 + nt * 16 + FRAMES * (4 + 8 + 16 + nv * 4);
  const buf = Buffer.alloc(size);
  let o = 0;
  const i32 = (v) => { buf.writeInt32LE(v, o); o += 4; };
  const f32 = (v) => { buf.writeFloatLE(v, o); o += 4; };
  buf.write('IDPO', 0, 'latin1'); o = 4;
  i32(6);
  scale.forEach(f32); min.forEach(f32);
  f32(radius);
  f32(0); f32(0); f32(40); // eye position (unused)
  i32(skins.length); i32(SKIN_W); i32(SKIN_H);
  i32(nv); i32(nt); i32(FRAMES);
  i32(0); // synctype ST_SYNC
  i32(0); // flags
  f32(nt ? 30 : 0); // average triangle size (informational)
  for (const s of skins) { i32(0); Buffer.from(s).copy(buf, o); o += s.length; }
  for (const s of st) { i32(s[0]); i32(s[1]); i32(s[2]); }
  for (const t of tris) { i32(t[0]); i32(t[1]); i32(t[2]); i32(t[3]); }
  for (let f = 0; f < FRAMES; f++) {
    const fr = frames[f];
    // per-vertex normals from adjacent triangles (front side only for the cloth)
    const nrm = fr.map(() => [0, 0, 0]);
    for (const t of tris) {
      const a = fr[t[1]], b = fr[t[2]], c = fr[t[3]];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      for (const k of [t[1], t[2], t[3]]) { nrm[k][0] += n[0]; nrm[k][1] += n[1]; nrm[k][2] += n[2]; }
    }
    const q = fr.map((v) => v.map((x, k) => Math.max(0, Math.min(255, Math.round((x - min[k]) / scale[k])))));
    const bmin = [255, 255, 255], bmax = [0, 0, 0];
    for (const v of q) for (let k = 0; k < 3; k++) { bmin[k] = Math.min(bmin[k], v[k]); bmax[k] = Math.max(bmax[k], v[k]); }
    i32(0); // simple frame
    buf[o++] = bmin[0]; buf[o++] = bmin[1]; buf[o++] = bmin[2]; buf[o++] = 0;
    buf[o++] = bmax[0]; buf[o++] = bmax[1]; buf[o++] = bmax[2]; buf[o++] = 0;
    buf.write(`wave${f + 1}`.padEnd(16, '\0'), o, 'latin1'); o += 16;
    for (let i = 0; i < nv; i++) {
      const n = nrm[i], l = Math.hypot(n[0], n[1], n[2]) || 1;
      buf[o++] = q[i][0]; buf[o++] = q[i][1]; buf[o++] = q[i][2];
      buf[o++] = normalIndex([n[0] / l, n[1] / l, n[2] / l]);
    }
  }
  if (o !== size) throw new Error(`flag.mdl size mismatch ${o} != ${size}`);
  return buf;
}
