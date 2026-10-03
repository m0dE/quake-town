// Quake BSP29 / BSP2 reader for content tools: stats, entities, hull point checks, traces
// and face geometry for previews.
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.

export const CONTENTS = { EMPTY: -1, SOLID: -2, WATER: -3, SLIME: -4, LAVA: -5, SKY: -6 };

export function parseBsp(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const ver = b.readInt32LE(0);
  const bsp2 = b.toString('latin1', 0, 4) === 'BSP2';
  if (!bsp2 && ver !== 29) throw new Error(`unsupported BSP version ${ver}`);
  const lump = (i) => ({ ofs: b.readInt32LE(4 + i * 8), len: b.readInt32LE(8 + i * 8) });
  const L = {};
  ['entities', 'planes', 'textures', 'vertexes', 'visibility', 'nodes', 'texinfo', 'faces', 'lighting',
    'clipnodes', 'leafs', 'marksurfaces', 'edges', 'surfedges', 'models'].forEach((n, i) => { L[n] = lump(i); });
  const ents = parseEntities(b.toString('latin1', L.entities.ofs, L.entities.ofs + L.entities.len).replace(/\0.*$/s, ''));
  const planes = [];
  for (let o = L.planes.ofs; o < L.planes.ofs + L.planes.len; o += 20) {
    planes.push({ n: [b.readFloatLE(o), b.readFloatLE(o + 4), b.readFloatLE(o + 8)], d: b.readFloatLE(o + 12), type: b.readInt32LE(o + 16) });
  }
  const verts = [];
  for (let o = L.vertexes.ofs; o < L.vertexes.ofs + L.vertexes.len; o += 12) verts.push([b.readFloatLE(o), b.readFloatLE(o + 4), b.readFloatLE(o + 8)]);
  const clip = [];
  const csz = bsp2 ? 12 : 8;
  for (let o = L.clipnodes.ofs; o < L.clipnodes.ofs + L.clipnodes.len; o += csz) {
    clip.push(bsp2 ? [b.readInt32LE(o), b.readInt32LE(o + 4), b.readInt32LE(o + 8)] : [b.readInt32LE(o), b.readInt16LE(o + 4), b.readInt16LE(o + 6)]);
  }
  const nsz = bsp2 ? 44 : 24;
  const nodes = [];
  for (let o = L.nodes.ofs; o < L.nodes.ofs + L.nodes.len; o += nsz) {
    nodes.push(bsp2 ? [b.readInt32LE(o), b.readInt32LE(o + 4), b.readInt32LE(o + 8)] : [b.readInt32LE(o), b.readInt16LE(o + 4), b.readInt16LE(o + 6)]);
  }
  const lsz = bsp2 ? 44 : 28;
  const leafs = [];
  for (let o = L.leafs.ofs; o < L.leafs.ofs + L.leafs.len; o += lsz) leafs.push({ contents: b.readInt32LE(o), visofs: b.readInt32LE(o + 4) });
  const models = [];
  for (let o = L.models.ofs; o < L.models.ofs + L.models.len; o += 64) {
    models.push({ mins: [b.readFloatLE(o), b.readFloatLE(o + 4), b.readFloatLE(o + 8)], maxs: [b.readFloatLE(o + 12), b.readFloatLE(o + 16), b.readFloatLE(o + 20)],
      head: [0, 1, 2, 3].map((k) => b.readInt32LE(o + 36 + k * 4)), firstface: b.readInt32LE(o + 56), numfaces: b.readInt32LE(o + 60) });
  }
  // textures
  const texNames = [];
  const tex = [];
  if (L.textures.len) {
    const n = b.readInt32LE(L.textures.ofs);
    for (let i = 0; i < n; i++) {
      const off = b.readInt32LE(L.textures.ofs + 4 + i * 4);
      if (off < 0) { texNames.push(''); tex.push(null); continue; }
      const t = L.textures.ofs + off;
      let nm = b.toString('latin1', t, t + 16); nm = nm.slice(0, nm.indexOf('\0') >= 0 ? nm.indexOf('\0') : 16);
      texNames.push(nm);
      const w = b.readUInt32LE(t + 16), h = b.readUInt32LE(t + 20), o0 = b.readUInt32LE(t + 24);
      tex.push({ name: nm, w, h, pixels: o0 ? b.subarray(t + o0, t + o0 + w * h) : null });
    }
  }
  const texinfo = [];
  for (let o = L.texinfo.ofs; o < L.texinfo.ofs + L.texinfo.len; o += 40) {
    const v = []; for (let k = 0; k < 8; k++) v.push(b.readFloatLE(o + k * 4));
    texinfo.push({ s: v.slice(0, 4), t: v.slice(4, 8), miptex: b.readInt32LE(o + 32), flags: b.readInt32LE(o + 36) });
  }
  const esz = bsp2 ? 8 : 4;
  const edges = [];
  for (let o = L.edges.ofs; o < L.edges.ofs + L.edges.len; o += esz) edges.push(bsp2 ? [b.readUInt32LE(o), b.readUInt32LE(o + 4)] : [b.readUInt16LE(o), b.readUInt16LE(o + 2)]);
  const surfedges = [];
  for (let o = L.surfedges.ofs; o < L.surfedges.ofs + L.surfedges.len; o += 4) surfedges.push(b.readInt32LE(o));
  const fsz = bsp2 ? 28 : 20;
  const faces = [];
  for (let o = L.faces.ofs; o < L.faces.ofs + L.faces.len; o += fsz) {
    let plane, side, first, num, ti, styles, light;
    if (bsp2) { plane = b.readInt32LE(o); side = b.readInt32LE(o + 4); first = b.readInt32LE(o + 8); num = b.readInt32LE(o + 12); ti = b.readInt32LE(o + 16); styles = o + 20; light = b.readInt32LE(o + 24); }
    else { plane = b.readUInt16LE(o); side = b.readInt16LE(o + 2); first = b.readInt32LE(o + 4); num = b.readInt16LE(o + 8); ti = b.readInt16LE(o + 10); styles = o + 12; light = b.readInt32LE(o + 16); }
    const pts = [];
    for (let k = 0; k < num; k++) {
      const se = surfedges[first + k];
      pts.push(verts[se >= 0 ? edges[se][0] : edges[-se][1]]);
    }
    const p = planes[plane];
    const n = side ? p.n.map((x) => -x) : p.n;
    faces.push({ pts, n, texinfo: ti, light, styles: [b[styles], b[styles + 1], b[styles + 2], b[styles + 3]] });
  }
  return { bsp2, version: bsp2 ? 'BSP2' : 'BSP29', ents, planes, verts, clip, nodes, leafs, models, texNames, tex, texinfo, faces,
    lighting: b.subarray(L.lighting.ofs, L.lighting.ofs + L.lighting.len), visLen: L.visibility.len, lumps: L, bytes: b.length };
}

export function parseEntities(s) {
  const out = [];
  const re = /\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(s))) {
    const e = {};
    const kv = /"([^"]*)"\s*"([^"]*)"/g;
    let k;
    while ((k = kv.exec(m[1]))) e[k[1]] = k[2];
    out.push(e);
  }
  return out;
}

/** contents at point p in hull h (0 = point via nodes, 1 = player, 2 = large) of the world model */
export function pointContents(bsp, h, p) {
  if (h === 0) {
    let n = bsp.models[0].head[0];
    while (n >= 0) {
      const nd = bsp.nodes[n]; const pl = bsp.planes[nd[0]];
      const d = pl.n[0] * p[0] + pl.n[1] * p[1] + pl.n[2] * p[2] - pl.d;
      n = d >= 0 ? nd[1] : nd[2];
    }
    return bsp.leafs[-1 - n].contents;
  }
  let n = bsp.models[0].head[h];
  while (n >= 0) {
    const c = bsp.clip[n]; const pl = bsp.planes[c[0]];
    const d = pl.n[0] * p[0] + pl.n[1] * p[1] + pl.n[2] * p[2] - pl.d;
    n = d >= 0 ? c[1] : c[2];
  }
  return n;
}

/** first z below p (stepping by 1 unit) where hull h becomes solid; returns drop distance or Infinity */
export function dropToFloor(bsp, h, p, max = 4096) {
  for (let dz = 0; dz <= max; dz += 1) {
    const c = pointContents(bsp, h, [p[0], p[1], p[2] - dz]);
    if (c === CONTENTS.SOLID) return dz - 1;
  }
  return Infinity;
}
