// World geometry for drawing: faces → vertex arrays, lightmap atlas pages with per-face
// style blocks, batches per texture × lightmap page, PVS + frustum + backface culling into a
// dynamic index buffer, and RecursiveLightPoint for model lighting.
// Copyright (C) 1996-1997 Id Software, Inc. (algorithms from QW/client/gl_rsurf.c,
// gl_rlight.c, gl_model.c). Copyright (C) 2026 Quake Town contributors.
//
// This program is free software; you can redistribute it and/or modify it under the terms
// of the GNU General Public License as published by the Free Software Foundation; either
// version 2 of the License, or (at your option) any later version.

import { type Bsp, decompressVis, pointInLeaf } from './bsp';

export type SurfKind = 'lm' | 'sky' | 'warp' | 'cutout';

export interface TexInfoSet {
  /** per BSP miptex index: kind, and the animation chain (indices of miptex) */
  kind: SurfKind[];
  anims: (number[] | null)[];
  altAnims: (number[] | null)[];
}

export interface Batch {
  /** index into the batch table */
  id: number;
  kind: SurfKind;
  /** BSP miptex index (the chain base for animated textures) */
  tex: number;
  page: number;
  /** world faces of this batch (submodel faces are not here) */
  faces: Int32Array;
  /** faces visible this frame (prefix of `visFaces`), front to back */
  visCount: number;
  visFaces: Int32Array;
  /** visible faces a dynamic light reaches (drawn with the dlight shader variant) */
  litCount: number;
  litFaces: Int32Array;
}

export interface LightmapPage {
  width: number;
  height: number;
  data: Uint8Array; // RGBA
}

export interface SubmodelBatches {
  /** groups into this submodel's static index buffer: batch id, start, count */
  groups: { batch: number; start: number; count: number }[];
  indices: Uint32Array;
}

const MAX_PAGE_W = 2048;
const MAX_PAGE_H = 4096;

/** Texture kinds and animation chains, like Mod_LoadTextures' sequencing. */
export function classifyTextures(bsp: Bsp): TexInfoSet {
  const n = bsp.textures.length;
  const kind: SurfKind[] = new Array(n).fill('lm');
  const anims: (number[] | null)[] = new Array(n).fill(null);
  const altAnims: (number[] | null)[] = new Array(n).fill(null);
  const byName = new Map<string, number>();
  bsp.textures.forEach((t, i) => { if (t) byName.set(t.name, i); });
  for (let i = 0; i < n; i++) {
    const t = bsp.textures[i];
    if (!t) continue;
    if (t.name.startsWith('sky')) kind[i] = 'sky';
    else if (t.name.startsWith('*')) kind[i] = 'warp';
    else if (t.name.startsWith('{')) kind[i] = 'cutout';
    if (t.name[0] !== '+' || t.name.length < 2) continue;
    const rest = t.name.slice(2);
    const a: number[] = [], b: number[] = [];
    for (let k = 0; k < 10; k++) {
      const d = byName.get('+' + String(k) + rest);
      if (d === undefined) break;
      a.push(d);
    }
    for (let k = 0; k < 10; k++) {
      const d = byName.get('+' + String.fromCharCode(97 + k) + rest);
      if (d === undefined) break;
      b.push(d);
    }
    anims[i] = a.length ? a : b.length ? b : null;
    altAnims[i] = b.length ? b : null;
    if (t.name[1] >= 'a' && t.name[1] <= 'j') { anims[i] = b.length ? b : null; altAnims[i] = a.length ? a : null; }
  }
  return { kind, anims, altAnims };
}

export class WorldGeometry {
  readonly bsp: Bsp;
  readonly tex: TexInfoSet;
  // vertex arrays (shared by world + submodels)
  readonly position: Float32Array;
  readonly normal: Float32Array;
  readonly st: Float32Array;
  readonly lm: Float32Array; // u, v, step
  readonly styles: Uint8Array; // 4 per vertex
  readonly numVerts: number;
  /** triangle-list vertex indices of every face, run per face */
  readonly faceIdx: Uint32Array;
  readonly faceIdxStart: Int32Array;
  readonly faceIdxCount: Int32Array;
  readonly faceBatch: Int32Array;
  readonly pages: LightmapPage[] = [];
  readonly facePage: Int32Array;
  readonly batches: Batch[] = [];
  readonly submodels: SubmodelBatches[] = [];
  /** dynamic index buffer of the world (capacity = all world face indices) */
  readonly worldIndices: Uint32Array;
  /** filled by cull(): per batch start/count into worldIndices (plain faces, then lit faces) */
  readonly batchStart: Int32Array;
  readonly batchCount: Int32Array;
  readonly litStart: Int32Array;
  readonly litCount: Int32Array;
  /** batches in the order they were first reached front to back (draw them in this order) */
  readonly order: Int32Array;
  orderCount = 0;
  /** per face bounding sphere (x, y, z, r) for dlight tests */
  readonly faceSphere: Float32Array;
  /** whether the map has light data at all (else everything is fullbright, like Quake) */
  readonly hasLight: boolean;

  // culling state
  private visRow: Uint8Array;
  private lastLeaf = -2;
  private visStamp = 0;
  private nodeVis: Int32Array;
  private leafVis: Int32Array;
  private faceVis: Int32Array;
  private nodeParent: Int32Array;
  private leafParent: Int32Array;
  private stack: Int32Array;
  private batchSeen: Int32Array;
  private frameNo = 0;
  stats = { leafs: 0, faces: 0, indices: 0 };

  constructor(bsp: Bsp) {
    this.bsp = bsp;
    this.tex = classifyTextures(bsp);
    this.hasLight = bsp.lighting.length > 0;
    const nf = bsp.numFaces;
    // ---- lightmap allocation
    this.facePage = new Int32Array(nf).fill(-1);
    const faceLmX = new Int32Array(nf), faceLmY = new Int32Array(nf);
    const order: number[] = [];
    for (let f = 0; f < nf; f++) if (this.faceHasLightmap(f)) order.push(f);
    const smaxOf = (f: number) => (bsp.faceExtents[f * 2] >> 4) + 1;
    const tmaxOf = (f: number) => (bsp.faceExtents[f * 2 + 1] >> 4) + 1;
    const nstyles = (f: number) => { let n = 0; while (n < 4 && bsp.faceStyles[f * 4 + n] !== 255) n++; return n; };
    order.sort((a, b) => tmaxOf(b) - tmaxOf(a) || smaxOf(b) * nstyles(b) - smaxOf(a) * nstyles(a));
    let area = 0;
    for (const f of order) area += (smaxOf(f) + 2) * nstyles(f) * (tmaxOf(f) + 2);
    const pageW = area > 700 * 700 ? MAX_PAGE_W : area > 300 * 300 ? 1024 : 512;
    let page = -1, shelfX = 0, shelfY = 0, shelfH = 0, pageH = 0;
    const pageHeights: number[] = [];
    const newPage = () => { if (page >= 0) pageHeights[page] = pageH; page++; shelfX = 0; shelfY = 0; shelfH = 0; pageH = 0; };
    newPage();
    for (const f of order) {
      const w = (smaxOf(f) + 2) * nstyles(f), h = tmaxOf(f) + 2;
      if (shelfX + w > pageW) { shelfY += shelfH; shelfX = 0; shelfH = 0; }
      if (shelfY + h > MAX_PAGE_H) newPage();
      this.facePage[f] = page; faceLmX[f] = shelfX; faceLmY[f] = shelfY;
      shelfX += w;
      if (h > shelfH) shelfH = h;
      if (shelfY + shelfH > pageH) pageH = shelfY + shelfH;
    }
    pageHeights[page] = pageH;
    for (let p = 0; p <= page; p++) {
      let h = 4;
      while (h < pageHeights[p]) h *= 2;
      this.pages.push({ width: pageW, height: h, data: new Uint8Array(pageW * h * 4) });
    }
    if (this.pages.length === 0) this.pages.push({ width: 4, height: 4, data: new Uint8Array(64) });
    // write lightmaps (with a 1-texel clamped border per style block)
    const lit = bsp.lit, gray = bsp.lighting;
    for (const f of order) {
      const pg = this.pages[this.facePage[f]];
      const smax = smaxOf(f), tmax = tmaxOf(f), ns = nstyles(f);
      const size = smax * tmax;
      for (let s = 0; s < ns; s++) {
        const base = bsp.faceLightofs[f] + s * size;
        const bx = faceLmX[f] + s * (smax + 2), by = faceLmY[f];
        for (let y = -1; y <= tmax; y++) {
          const sy = y < 0 ? 0 : y >= tmax ? tmax - 1 : y;
          for (let x = -1; x <= smax; x++) {
            const sx = x < 0 ? 0 : x >= smax ? smax - 1 : x;
            const si = base + sy * smax + sx;
            const di = ((by + 1 + y) * pg.width + bx + 1 + x) * 4;
            if (lit) { pg.data[di] = lit[si * 3]; pg.data[di + 1] = lit[si * 3 + 1]; pg.data[di + 2] = lit[si * 3 + 2]; }
            else { const g = gray[si] ?? 0; pg.data[di] = pg.data[di + 1] = pg.data[di + 2] = g; }
            pg.data[di + 3] = 255;
          }
        }
      }
    }

    // ---- batches: (texture chain base, page, kind)
    const batchKey = new Map<string, number>();
    this.faceBatch = new Int32Array(nf).fill(-1);
    for (let f = 0; f < nf; f++) {
      const mi = bsp.texMip[bsp.faceTexinfo[f]];
      const tex = mi >= 0 && mi < bsp.textures.length ? mi : -1;
      const kind: SurfKind = tex >= 0 ? this.tex.kind[tex] : 'lm';
      const pg = kind === 'lm' || kind === 'cutout' ? Math.max(0, this.facePage[f]) : 0;
      const key = tex + ':' + pg;
      let b = batchKey.get(key);
      if (b === undefined) {
        b = this.batches.length;
        batchKey.set(key, b);
        this.batches.push({ id: b, kind, tex, page: pg, faces: new Int32Array(0), visCount: 0, visFaces: new Int32Array(0), litCount: 0, litFaces: new Int32Array(0) });
      }
      this.faceBatch[f] = b;
    }

    // ---- vertices
    let nv = 0, ni = 0;
    for (let f = 0; f < nf; f++) { nv += bsp.faceNumEdges[f]; ni += Math.max(0, bsp.faceNumEdges[f] - 2) * 3; }
    this.numVerts = nv;
    this.position = new Float32Array(nv * 3);
    this.normal = new Float32Array(nv * 3);
    this.st = new Float32Array(nv * 2);
    this.lm = new Float32Array(nv * 3);
    this.styles = new Uint8Array(nv * 4);
    this.faceIdx = new Uint32Array(ni);
    this.faceIdxStart = new Int32Array(nf);
    this.faceIdxCount = new Int32Array(nf);
    let v = 0, ii = 0;
    const P = bsp.planes, V = bsp.vertices, T = bsp.texVecs;
    for (let f = 0; f < nf; f++) {
      const ti = bsp.faceTexinfo[f] * 8;
      const pi = bsp.facePlane[f] * 4;
      const sign = bsp.faceSide[f] ? -1 : 1;
      const nx = P[pi] * sign, ny = P[pi + 1] * sign, nz = P[pi + 2] * sign;
      const page = this.facePage[f];
      const pg = page >= 0 ? this.pages[page] : null;
      const smax = (bsp.faceExtents[f * 2] >> 4) + 1;
      const first = v;
      for (let e = 0; e < bsp.faceNumEdges[f]; e++) {
        const se = bsp.surfedges[bsp.faceFirstEdge[f] + e];
        const vi = se >= 0 ? bsp.edges[se * 2] : bsp.edges[-se * 2 + 1];
        const x = V[vi * 3], y = V[vi * 3 + 1], z = V[vi * 3 + 2];
        this.position[v * 3] = x; this.position[v * 3 + 1] = y; this.position[v * 3 + 2] = z;
        this.normal[v * 3] = nx; this.normal[v * 3 + 1] = ny; this.normal[v * 3 + 2] = nz;
        const s = x * T[ti] + y * T[ti + 1] + z * T[ti + 2] + T[ti + 3];
        const t = x * T[ti + 4] + y * T[ti + 5] + z * T[ti + 6] + T[ti + 7];
        this.st[v * 2] = s; this.st[v * 2 + 1] = t;
        if (pg) {
          const u = (s - bsp.faceTexMins[f * 2]) / 16 + 0.5 + 1 + faceLmX[f];
          const w = (t - bsp.faceTexMins[f * 2 + 1]) / 16 + 0.5 + 1 + faceLmY[f];
          this.lm[v * 3] = u / pg.width; this.lm[v * 3 + 1] = w / pg.height; this.lm[v * 3 + 2] = (smax + 2) / pg.width;
          for (let k = 0; k < 4; k++) this.styles[v * 4 + k] = bsp.faceStyles[f * 4 + k];
        } else {
          for (let k = 0; k < 4; k++) this.styles[v * 4 + k] = 255;
        }
        v++;
      }
      // triangle fan; wind so the geometric normal matches the face normal (CCW front)
      this.faceIdxStart[f] = ii;
      const n = bsp.faceNumEdges[f];
      let flip = false;
      if (n >= 3) {
        // Newell normal of the polygon
        let gx = 0, gy = 0, gz = 0;
        for (let k = 0; k < n; k++) {
          const a = (first + k) * 3, b = (first + ((k + 1) % n)) * 3;
          const p = this.position;
          gx += (p[a + 1] - p[b + 1]) * (p[a + 2] + p[b + 2]);
          gy += (p[a + 2] - p[b + 2]) * (p[a] + p[b]);
          gz += (p[a] - p[b]) * (p[a + 1] + p[b + 1]);
        }
        flip = gx * nx + gy * ny + gz * nz < 0;
      }
      for (let k = 1; k < n - 1; k++) {
        this.faceIdx[ii++] = first;
        if (flip) { this.faceIdx[ii++] = first + k + 1; this.faceIdx[ii++] = first + k; }
        else { this.faceIdx[ii++] = first + k; this.faceIdx[ii++] = first + k + 1; }
      }
      this.faceIdxCount[f] = ii - this.faceIdxStart[f];
    }

    // ---- world batch face lists
    const w0 = bsp.models[0];
    const counts = new Int32Array(this.batches.length);
    for (let f = w0.firstface; f < w0.firstface + w0.numfaces; f++) counts[this.faceBatch[f]]++;
    for (const b of this.batches) { b.faces = new Int32Array(counts[b.id]); b.visFaces = new Int32Array(counts[b.id]); b.litFaces = new Int32Array(counts[b.id]); }
    counts.fill(0);
    let worldIdx = 0;
    for (let f = w0.firstface; f < w0.firstface + w0.numfaces; f++) {
      const b = this.faceBatch[f];
      this.batches[b].faces[counts[b]++] = f;
      worldIdx += this.faceIdxCount[f];
    }
    this.worldIndices = new Uint32Array(Math.max(3, worldIdx));
    this.batchStart = new Int32Array(this.batches.length);
    this.batchCount = new Int32Array(this.batches.length);
    this.litStart = new Int32Array(this.batches.length);
    this.litCount = new Int32Array(this.batches.length);
    this.order = new Int32Array(this.batches.length);
    this.batchSeen = new Int32Array(this.batches.length);
    this.faceSphere = new Float32Array(nf * 4);
    for (let f = 0; f < nf; f++) {
      const s0 = this.faceIdxStart[f], n = this.faceIdxCount[f];
      if (!n) continue;
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let k = 0; k < n; k++) {
        const v = this.faceIdx[s0 + k] * 3, P = this.position;
        if (P[v] < x0) x0 = P[v]; if (P[v] > x1) x1 = P[v];
        if (P[v + 1] < y0) y0 = P[v + 1]; if (P[v + 1] > y1) y1 = P[v + 1];
        if (P[v + 2] < z0) z0 = P[v + 2]; if (P[v + 2] > z1) z1 = P[v + 2];
      }
      this.faceSphere[f * 4] = (x0 + x1) / 2; this.faceSphere[f * 4 + 1] = (y0 + y1) / 2; this.faceSphere[f * 4 + 2] = (z0 + z1) / 2;
      this.faceSphere[f * 4 + 3] = Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2;
    }

    // ---- submodels: static index buffers grouped by batch
    for (let m = 0; m < bsp.models.length; m++) {
      const mod = bsp.models[m];
      const byBatch = new Map<number, number[]>();
      let total = 0;
      for (let f = mod.firstface; f < mod.firstface + mod.numfaces; f++) {
        const b = this.faceBatch[f];
        let l = byBatch.get(b);
        if (!l) byBatch.set(b, (l = []));
        l.push(f);
        total += this.faceIdxCount[f];
      }
      const indices = new Uint32Array(Math.max(3, total));
      const groups: SubmodelBatches['groups'] = [];
      let o = 0;
      for (const [b, faces] of byBatch) {
        const start = o;
        for (const f of faces) for (let k = 0; k < this.faceIdxCount[f]; k++) indices[o++] = this.faceIdx[this.faceIdxStart[f] + k];
        groups.push({ batch: b, start, count: o - start });
      }
      this.submodels[m] = { groups, indices };
    }

    // culling state
    this.visRow = new Uint8Array(((bsp.models[0].visleafs + 7) >> 3) + 4);
    this.nodeVis = new Int32Array(bsp.numNodes);
    this.leafVis = new Int32Array(bsp.numLeafs);
    this.faceVis = new Int32Array(nf);
    this.nodeParent = new Int32Array(bsp.numNodes).fill(-1);
    this.leafParent = new Int32Array(bsp.numLeafs).fill(-1);
    for (let n = 0; n < bsp.numNodes; n++) {
      for (let c = 0; c < 2; c++) {
        const ch = bsp.nodeChildren[n * 2 + c];
        if (ch >= 0) this.nodeParent[ch] = n; else this.leafParent[-1 - ch] = n;
      }
    }
    this.stack = new Int32Array(bsp.numNodes * 2 + 64);
  }

  private faceHasLightmap(f: number): boolean {
    const bsp = this.bsp;
    if (bsp.faceLightofs[f] < 0 || bsp.faceStyles[f * 4] === 255) return false;
    const mi = bsp.texMip[bsp.faceTexinfo[f]];
    const k = mi >= 0 && mi < bsp.textures.length ? this.tex.kind[mi] : 'lm';
    return k === 'lm' || k === 'cutout';
  }

  /** leaf the point is in (world model) */
  leafAt(x: number, y: number, z: number): number {
    return pointInLeaf(this.bsp, x, y, z, this.bsp.models[0].headnode);
  }

  /** is the leaf in the PVS of the current view leaf (call after cull()) */
  leafVisible(leaf: number): boolean {
    if (leaf <= 0) return true;
    return this.leafVis[leaf] === this.visStamp;
  }

  /**
   * R_MarkLeaves + R_RecursiveWorldNode: on a camera leaf change, the PVS marks leaves,
   * their faces and their ancestor nodes; every frame the node tree is walked front to back
   * with a frustum test per node, and each node's marked, camera-facing faces are appended
   * to their batch — so the index buffer is close to front-to-back order (early-z). Faces a
   * dynamic light reaches (`dl` = x, y, z, radius × numDl) go to the batch's lit list, drawn
   * with the dlight shader variant; the rest skip the light loop. `planes` = frustum planes
   * (nx, ny, nz, d), inside where n·p - d >= 0. No allocation.
   */
  cull(cx: number, cy: number, cz: number, planes: Float32Array, numPlanes: number, novis: boolean, dl?: Float32Array, numDl = 0): void {
    this.markLeaves(cx, cy, cz, novis);
    this.walk(cx, cy, cz, planes, numPlanes, dl, numDl);
  }

  /** R_MarkLeaves: PVS of the camera leaf → leaf/node/face marks (only when the leaf changes). */
  markLeaves(cx: number, cy: number, cz: number, novis: boolean): void {
    const bsp = this.bsp;
    const leaf = this.leafAt(cx, cy, cz);
    const key = novis ? -3 : leaf;
    if (key !== this.lastLeaf) {
      this.lastLeaf = key;
      const stamp = ++this.visStamp;
      const nl = bsp.models[0].visleafs;
      if (novis || leaf <= 0 || bsp.leafContents[leaf] === -2) this.visRow.fill(0xff);
      else decompressVis(bsp, leaf, this.visRow);
      for (let i = 0; i < nl; i++) {
        if (!(this.visRow[i >> 3] & (1 << (i & 7)))) continue;
        const l = i + 1;
        this.leafVis[l] = stamp;
        const fm = bsp.leafFirstMark[l], nm = bsp.leafNumMark[l];
        for (let k = 0; k < nm; k++) this.faceVis[bsp.marksurfaces[fm + k]] = stamp;
        let n = this.leafParent[l];
        while (n >= 0 && this.nodeVis[n] !== stamp) { this.nodeVis[n] = stamp; n = this.nodeParent[n]; }
      }
    }
  }

  /** R_RecursiveWorldNode over the marked nodes (call markLeaves first). */
  walk(cx: number, cy: number, cz: number, planes: Float32Array, numPlanes: number, dl?: Float32Array, numDl = 0): void {
    const bsp = this.bsp;
    const stamp = this.visStamp;
    const frame = ++this.frameNo;
    for (let b = 0; b < this.batches.length; b++) { this.batches[b].visCount = 0; this.batches[b].litCount = 0; }
    this.orderCount = 0;
    const NB = bsp.nodeBounds, P = bsp.planes, FS = this.faceSphere;
    let nodes = 0, faces = 0;
    // explicit stack: n >= 0 visit node n; n < 0 emit the faces of node (-1 - n)
    const st = this.stack;
    let sp = 0;
    st[sp++] = bsp.models[0].headnode;
    while (sp > 0) {
      const n = st[--sp];
      if (n < 0) {
        const nd = -1 - n;
        const ff = bsp.nodeFirstFace[nd], nf = bsp.nodeNumFaces[nd];
        for (let k = 0; k < nf; k++) {
          const f = ff + k;
          if (this.faceVis[f] !== stamp) continue;
          const pi = bsp.facePlane[f] * 4;
          let d = cx * P[pi] + cy * P[pi + 1] + cz * P[pi + 2] - P[pi + 3];
          if (bsp.faceSide[f]) d = -d;
          if (d < -0.01) continue; // back facing (BACKFACE_EPSILON)
          const bi = this.faceBatch[f];
          const b = this.batches[bi];
          if (this.batchSeen[bi] !== frame) { this.batchSeen[bi] = frame; this.order[this.orderCount++] = bi; }
          let lit = false;
          if (numDl > 0 && dl && (b.kind === 'lm' || b.kind === 'cutout')) {
            const x = FS[f * 4], y = FS[f * 4 + 1], z = FS[f * 4 + 2], r = FS[f * 4 + 3];
            for (let i = 0; i < numDl; i++) {
              const dx = dl[i * 4] - x, dy = dl[i * 4 + 1] - y, dz = dl[i * 4 + 2] - z, rr = dl[i * 4 + 3] + r;
              if (dx * dx + dy * dy + dz * dz < rr * rr) { lit = true; break; }
            }
          }
          if (lit) b.litFaces[b.litCount++] = f; else b.visFaces[b.visCount++] = f;
          faces++;
        }
        continue;
      }
      if (this.nodeVis[n] !== stamp) continue;
      const o = n * 6;
      let out = false;
      for (let p = 0; p < numPlanes; p++) {
        const px = planes[p * 4], py = planes[p * 4 + 1], pz = planes[p * 4 + 2];
        const x = px >= 0 ? NB[o + 3] : NB[o], y = py >= 0 ? NB[o + 4] : NB[o + 1], z = pz >= 0 ? NB[o + 5] : NB[o + 2];
        if (px * x + py * y + pz * z - planes[p * 4 + 3] < 0) { out = true; break; }
      }
      if (out) continue;
      nodes++;
      const pi = bsp.nodePlane[n] * 4;
      const side = cx * P[pi] + cy * P[pi + 1] + cz * P[pi + 2] - P[pi + 3] >= 0 ? 0 : 1;
      const front = bsp.nodeChildren[n * 2 + side], back = bsp.nodeChildren[n * 2 + 1 - side];
      // pop order: front, node faces, back
      if (back >= 0) st[sp++] = back;
      if (bsp.nodeNumFaces[n]) st[sp++] = -1 - n;
      if (front >= 0) st[sp++] = front;
    }
    // write indices batch by batch in first-reached order: plain faces, then lit faces
    let o = 0;
    const out = this.worldIndices, src = this.faceIdx;
    for (let b = 0; b < this.batches.length; b++) { this.batchCount[b] = 0; this.litCount[b] = 0; }
    for (let k = 0; k < this.orderCount; k++) {
      const b = this.order[k];
      const bt = this.batches[b];
      this.batchStart[b] = o;
      for (let i = 0; i < bt.visCount; i++) {
        const f = bt.visFaces[i];
        let s = this.faceIdxStart[f];
        const e = s + this.faceIdxCount[f];
        while (s < e) out[o++] = src[s++];
      }
      this.batchCount[b] = o - this.batchStart[b];
      this.litStart[b] = o;
      for (let i = 0; i < bt.litCount; i++) {
        const f = bt.litFaces[i];
        let s = this.faceIdxStart[f];
        const e = s + this.faceIdxCount[f];
        while (s < e) out[o++] = src[s++];
      }
      this.litCount[b] = o - this.litStart[b];
    }
    this.stats.leafs = nodes; this.stats.faces = faces; this.stats.indices = o;
  }

  /**
   * R_LightPoint: light (rgb, Quake units 0..255+, style values applied) at the floor below
   * (x,y,z), sampled bilinearly from the lightmap of the surface the downward ray hits.
   * `styleValues` = 64 floats, 1.0 = 'm'. Writes rgb into out[0..2]; returns false if nothing was hit.
   */
  lightPoint(x: number, y: number, z: number, styleValues: Float32Array, out: Float32Array): boolean {
    out[0] = out[1] = out[2] = 0;
    if (!this.hasLight) { out[0] = out[1] = out[2] = 255; return true; }
    return this.recursiveLightPoint(this.bsp.models[0].headnode, x, y, z, x, y, z - 2048, styleValues, out);
  }

  private recursiveLightPoint(node: number, sx: number, sy: number, sz: number, ex: number, ey: number, ez: number, sv: Float32Array, out: Float32Array): boolean {
    const bsp = this.bsp;
    for (;;) {
      if (node < 0) return false; // leaf: didn't hit anything
      const pi = bsp.nodePlane[node] * 4, P = bsp.planes;
      const front = sx * P[pi] + sy * P[pi + 1] + sz * P[pi + 2] - P[pi + 3];
      const back = ex * P[pi] + ey * P[pi + 1] + ez * P[pi + 2] - P[pi + 3];
      const side = front < 0 ? 1 : 0;
      if ((back < 0 ? 1 : 0) === side) { node = bsp.nodeChildren[node * 2 + side]; continue; }
      const frac = front / (front - back);
      const mx = sx + (ex - sx) * frac, my = sy + (ey - sy) * frac, mz = sz + (ez - sz) * frac;
      // go down front side
      if (this.recursiveLightPoint(bsp.nodeChildren[node * 2 + side], sx, sy, sz, mx, my, mz, sv, out)) return true;
      if ((back < 0 ? 1 : 0) === side) return false;
      // check for impact on this node
      const T = bsp.texVecs;
      const ff = bsp.nodeFirstFace[node], nf = bsp.nodeNumFaces[node];
      for (let k = 0; k < nf; k++) {
        const f = ff + k;
        const mi = bsp.texMip[bsp.faceTexinfo[f]];
        if (bsp.texFlags[bsp.faceTexinfo[f]] & 1) continue; // SURF_DRAWTILED / special
        if (mi >= 0 && mi < bsp.textures.length && this.tex.kind[mi] !== 'lm' && this.tex.kind[mi] !== 'cutout') continue;
        const ti = bsp.faceTexinfo[f] * 8;
        const s = mx * T[ti] + my * T[ti + 1] + mz * T[ti + 2] + T[ti + 3];
        const t = mx * T[ti + 4] + my * T[ti + 5] + mz * T[ti + 6] + T[ti + 7];
        const ds = s - bsp.faceTexMins[f * 2], dt = t - bsp.faceTexMins[f * 2 + 1];
        if (ds < 0 || dt < 0 || ds > bsp.faceExtents[f * 2] || dt > bsp.faceExtents[f * 2 + 1]) continue;
        if (bsp.faceLightofs[f] < 0) return true; // hit, black
        const smax = (bsp.faceExtents[f * 2] >> 4) + 1, tmax = (bsp.faceExtents[f * 2 + 1] >> 4) + 1;
        const fs = ds / 16, ft = dt / 16;
        const x0 = Math.min(Math.floor(fs), smax - 1), y0 = Math.min(Math.floor(ft), tmax - 1);
        const x1 = Math.min(x0 + 1, smax - 1), y1 = Math.min(y0 + 1, tmax - 1);
        const ax = fs - x0, ay = ft - y0;
        const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay;
        const lit = bsp.lit, gray = bsp.lighting;
        let base = bsp.faceLightofs[f];
        for (let st = 0; st < 4; st++) {
          const style = bsp.faceStyles[f * 4 + st];
          if (style === 255) break;
          const scale = sv[style];
          const i00 = base + y0 * smax + x0, i10 = base + y0 * smax + x1, i01 = base + y1 * smax + x0, i11 = base + y1 * smax + x1;
          if (lit) {
            for (let c = 0; c < 3; c++) {
              out[c] += scale * (lit[i00 * 3 + c] * w00 + lit[i10 * 3 + c] * w10 + lit[i01 * 3 + c] * w01 + lit[i11 * 3 + c] * w11);
            }
          } else {
            const g = scale * (gray[i00] * w00 + gray[i10] * w10 + gray[i01] * w01 + gray[i11] * w11);
            out[0] += g; out[1] += g; out[2] += g;
          }
          base += smax * tmax;
        }
        return true;
      }
      // go down back side
      sx = mx; sy = my; sz = mz;
      node = bsp.nodeChildren[node * 2 + 1 - side];
    }
  }
}
