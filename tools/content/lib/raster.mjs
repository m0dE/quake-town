// Software rasterizer for BSP previews: textured + lightmapped (+ .lit colour) faces, either
// top-down orthographic (with an optional z slice) or a perspective camera. Node only.
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function prepFaces(bsp, lit) {
  const out = [];
  for (let fi = 0; fi < bsp.models[0].numfaces; fi++) {
    const f = bsp.faces[bsp.models[0].firstface + fi];
    if (f.pts.length < 3) continue;
    const ti = bsp.texinfo[f.texinfo];
    const tx = bsp.tex[ti.miptex];
    const name = tx ? tx.name.toLowerCase() : '';
    if (name === 'skip' || name === 'trigger' || name === 'clip') continue;
    const s = f.pts.map((p) => dot(p, ti.s) + ti.s[3]);
    const t = f.pts.map((p) => dot(p, ti.t) + ti.t[3]);
    const smin = Math.floor(Math.min(...s) / 16), tmin = Math.floor(Math.min(...t) / 16);
    const lw = Math.ceil(Math.max(...s) / 16) - smin + 1, lh = Math.ceil(Math.max(...t) / 16) - tmin + 1;
    const nstyles = f.styles.filter((x) => x !== 255).length;
    out.push({ f, ti, tx, name, sky: name.startsWith('sky'), turb: name.startsWith('*'),
      d: dot(f.n, f.pts[0]), smin, tmin, lw, lh, light: f.light, lit, nstyles });
  }
  return out;
}

function shade(bsp, pal, F, p) {
  const s = dot(p, F.ti.s) + F.ti.s[3], t = dot(p, F.ti.t) + F.ti.t[3];
  const tx = F.tx;
  let r = 128, g = 128, b = 128, idx = 0;
  if (tx && tx.pixels) {
    const u = ((Math.floor(s) % tx.w) + tx.w) % tx.w, v = ((Math.floor(t) % tx.h) + tx.h) % tx.h;
    idx = tx.pixels[v * tx.w + u];
    r = pal[idx * 3]; g = pal[idx * 3 + 1]; b = pal[idx * 3 + 2];
  }
  if (F.sky || F.turb || idx >= 224) return [r, g, b];
  let lr = 1, lg = 1, lb = 1;
  if (F.light >= 0 && F.nstyles) {
    const ls = Math.max(0, Math.min(F.lw - 1, Math.round(s / 16 - F.smin)));
    const lt = Math.max(0, Math.min(F.lh - 1, Math.round(t / 16 - F.tmin)));
    const i = lt * F.lw + ls;
    if (F.lit) {
      const o = 8 + (F.light + i) * 3;
      lr = F.lit[o] / 128; lg = F.lit[o + 1] / 128; lb = F.lit[o + 2] / 128;
    } else {
      lr = lg = lb = bsp.lighting[F.light + i] / 128;
    }
  } else if (F.light < 0) { lr = lg = lb = 0.5; }
  return [Math.min(255, r * lr), Math.min(255, g * lg), Math.min(255, b * lb)];
}

/** top-down ortho. opts: { scale (units per pixel), zmin, zmax, bounds } -> { w, h, px, map(x,y)->[px,py] } */
export function renderTopDown(bsp, pal, lit, opts = {}) {
  const faces = prepFaces(bsp, lit);
  const m = bsp.models[0];
  const [x0, y0] = [m.mins[0] - 16, m.mins[1] - 16], [x1, y1] = [m.maxs[0] + 16, m.maxs[1] + 16];
  const sc = opts.scale ?? Math.max((x1 - x0) / 1000, (y1 - y0) / 1000, 1);
  const w = Math.ceil((x1 - x0) / sc), h = Math.ceil((y1 - y0) / sc);
  const px = new Uint8Array(w * h * 3).fill(18);
  const zb = new Float32Array(w * h).fill(-Infinity);
  const zmin = opts.zmin ?? -Infinity, zmax = opts.zmax ?? Infinity;
  const toPx = (x, y) => [(x - x0) / sc, (y1 - y) / sc];
  for (const F of faces) {
    const nz = F.f.n[2];
    if (nz < 0.2 && !F.turb) continue; // floors, slopes and liquid tops only
    const zs = F.f.pts.map((p) => p[2]);
    if (Math.max(...zs) < zmin || Math.min(...zs) > zmax) continue;
    const poly = F.f.pts.map((p) => toPx(p[0], p[1]));
    fillPoly(poly, w, h, (X, Y) => {
      const wx = x0 + (X + 0.5) * sc, wy = y1 - (Y + 0.5) * sc;
      const wz = (F.d - F.f.n[0] * wx - F.f.n[1] * wy) / nz;
      if (wz > zmax + 1 || wz < zmin - 1) return;
      const i = Y * w + X;
      if (wz <= zb[i]) return;
      zb[i] = wz;
      const c = shade(bsp, pal, F, [wx, wy, wz]);
      px[i * 3] = c[0]; px[i * 3 + 1] = c[1]; px[i * 3 + 2] = c[2];
    });
  }
  // walls: darken pixels along vertical faces' footprints
  for (const F of faces) {
    if (Math.abs(F.f.n[2]) > 0.2) continue;
    const zs = F.f.pts.map((p) => p[2]);
    if (Math.max(...zs) < zmin || Math.min(...zs) > zmax) continue;
    const pts = F.f.pts.map((p) => toPx(p[0], p[1]));
    for (let k = 0; k < pts.length; k++) line(pts[k], pts[(k + 1) % pts.length], w, h, (i) => {
      px[i * 3] *= 0.35; px[i * 3 + 1] *= 0.35; px[i * 3 + 2] *= 0.35;
    });
  }
  return { w, h, px, toPx, sc };
}

/** perspective view from cam { o:[x,y,z], yaw, pitch (deg, Quake: pitch>0 looks down), fov } */
export function renderView(bsp, pal, lit, cam, w = 960, h = 540) {
  const faces = prepFaces(bsp, lit);
  const yaw = cam.yaw * Math.PI / 180, pitch = cam.pitch * Math.PI / 180;
  const fwd = [Math.cos(yaw) * Math.cos(pitch), Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch)];
  const right = [Math.sin(yaw), -Math.cos(yaw), 0];
  const up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
  const fx = (w / 2) / Math.tan((cam.fov ?? 100) * Math.PI / 360);
  const px = new Uint8Array(w * h * 3).fill(0);
  const zb = new Float32Array(w * h).fill(Infinity);
  const near = 4;
  for (const F of faces) {
    // backface
    const toCam = [cam.o[0] - F.f.pts[0][0], cam.o[1] - F.f.pts[0][1], cam.o[2] - F.f.pts[0][2]];
    if (dot(toCam, F.f.n) <= 0) continue;
    // to camera space
    let cs = F.f.pts.map((p) => { const d = [p[0] - cam.o[0], p[1] - cam.o[1], p[2] - cam.o[2]]; return [dot(d, right), dot(d, up), dot(d, fwd)]; });
    // clip near
    const clipped = [];
    for (let k = 0; k < cs.length; k++) {
      const a = cs[k], b = cs[(k + 1) % cs.length];
      if (a[2] >= near) clipped.push(a);
      if ((a[2] >= near) !== (b[2] >= near)) { const t = (near - a[2]) / (b[2] - a[2]); clipped.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, near]); }
    }
    if (clipped.length < 3) continue;
    const poly = clipped.map((c) => [w / 2 + (c[0] / c[2]) * fx, h / 2 - (c[1] / c[2]) * fx]);
    const nd = dot(F.f.n, cam.o) - F.d;
    fillPoly(poly, w, h, (X, Y) => {
      const rx = (X + 0.5 - w / 2) / fx, ry = -(Y + 0.5 - h / 2) / fx;
      const dir = [fwd[0] + right[0] * rx + up[0] * ry, fwd[1] + right[1] * rx + up[1] * ry, fwd[2] + right[2] * rx + up[2] * ry];
      const den = dot(F.f.n, dir);
      if (den >= 0) return;
      const t = -nd / den;
      const i = Y * w + X;
      if (t >= zb[i]) return;
      zb[i] = t;
      const p = [cam.o[0] + dir[0] * t, cam.o[1] + dir[1] * t, cam.o[2] + dir[2] * t];
      const c = shade(bsp, pal, F, p);
      px[i * 3] = c[0]; px[i * 3 + 1] = c[1]; px[i * 3 + 2] = c[2];
    });
  }
  return { w, h, px };
}

function fillPoly(poly, w, h, cb) {
  let ymin = Infinity, ymax = -Infinity;
  for (const p of poly) { ymin = Math.min(ymin, p[1]); ymax = Math.max(ymax, p[1]); }
  const ya = Math.max(0, Math.ceil(ymin - 0.5)), yb = Math.min(h - 1, Math.floor(ymax - 0.5));
  for (let Y = ya; Y <= yb; Y++) {
    const yc = Y + 0.5;
    const xs = [];
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k], b = poly[(k + 1) % poly.length];
      if ((a[1] <= yc) !== (b[1] <= yc)) xs.push(a[0] + ((yc - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5)), xb = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let X = xa; X <= xb; X++) cb(X, Y);
    }
  }
}

function line(a, b, w, h, cb) {
  const n = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]))) + 1;
  for (let k = 0; k <= n; k++) {
    const x = Math.floor(a[0] + ((b[0] - a[0]) * k) / n), y = Math.floor(a[1] + ((b[1] - a[1]) * k) / n);
    if (x >= 0 && y >= 0 && x < w && y < h) cb(y * w + x);
  }
}
