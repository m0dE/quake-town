// BSP29 / BSP2 loader for drawing (faces, texinfo, miptex, lightmaps, nodes/leafs, PVS).
// Copyright (C) 1996-1997 Id Software, Inc. (layout and algorithms from QW/client/gl_model.c,
// bspfile.h, gl_rlight.c). Copyright (C) 2026 Quake Town contributors.
//
// This program is free software; you can redistribute it and/or modify it under the terms
// of the GNU General Public License as published by the Free Software Foundation; either
// version 2 of the License, or (at your option) any later version.

const LUMP_ENTITIES = 0, LUMP_PLANES = 1, LUMP_TEXTURES = 2, LUMP_VERTEXES = 3, LUMP_VISIBILITY = 4,
  LUMP_NODES = 5, LUMP_TEXINFO = 6, LUMP_FACES = 7, LUMP_LIGHTING = 8, LUMP_LEAFS = 10,
  LUMP_MARKSURFACES = 11, LUMP_EDGES = 12, LUMP_SURFEDGES = 13, LUMP_MODELS = 14;

export const TEX_SPECIAL = 1;

export interface MipTex {
  name: string;
  width: number;
  height: number;
  /** palette indices of mip level 0 (null if the texture is external / missing) */
  pixels: Uint8Array | null;
}

export interface BspModel {
  mins: Float32Array;
  maxs: Float32Array;
  origin: Float32Array;
  headnode: number;
  visleafs: number;
  firstface: number;
  numfaces: number;
}

export interface Bsp {
  version: 'BSP29' | 'BSP2';
  entities: string;
  /** planes: normal xyz, dist (4 floats each) and type */
  planes: Float32Array;
  planeType: Uint8Array;
  vertices: Float32Array;
  textures: (MipTex | null)[];
  /** texinfo: vecs (8 floats each) */
  texVecs: Float32Array;
  texMip: Int32Array;
  texFlags: Int32Array;
  /** faces */
  numFaces: number;
  facePlane: Int32Array;
  faceSide: Uint8Array;
  faceFirstEdge: Int32Array;
  faceNumEdges: Int32Array;
  faceTexinfo: Int32Array;
  faceStyles: Uint8Array; // 4 per face
  faceLightofs: Int32Array;
  /** computed (CalcSurfaceExtents) */
  faceTexMins: Int32Array; // 2 per face
  faceExtents: Int32Array; // 2 per face
  edges: Uint32Array; // 2 per edge
  surfedges: Int32Array;
  /** nodes: plane, child0, child1 (negative = -(leaf+1)), firstface, numfaces, mins/maxs */
  numNodes: number;
  nodePlane: Int32Array;
  nodeChildren: Int32Array; // 2 per node
  nodeFirstFace: Int32Array;
  nodeNumFaces: Int32Array;
  nodeBounds: Float32Array; // 6 per node
  /** leafs */
  numLeafs: number;
  leafContents: Int32Array;
  leafVisofs: Int32Array;
  leafBounds: Float32Array; // 6 per leaf
  leafFirstMark: Int32Array;
  leafNumMark: Int32Array;
  marksurfaces: Int32Array;
  visdata: Uint8Array;
  /** grey lightmap samples (lump 8) */
  lighting: Uint8Array;
  /** rgb lightmap samples from a .lit file (3 bytes per sample), or null */
  lit: Uint8Array | null;
  models: BspModel[];
}

function lump(dv: DataView, i: number): [number, number] {
  return [dv.getInt32(4 + i * 8, true), dv.getInt32(8 + i * 8, true)];
}

function readName(b: Uint8Array, o: number, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) {
    const c = b[o + i];
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s;
}

export function loadBsp(data: Uint8Array, litData?: Uint8Array | null): Bsp {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = dv.getInt32(0, true);
  let bsp2: boolean;
  if (magic === 29) bsp2 = false;
  else if (readName(data, 0, 4) === 'BSP2') bsp2 = true;
  else throw new Error(`not a BSP29/BSP2 file (version ${magic})`);

  // entities
  const [eo, el] = lump(dv, LUMP_ENTITIES);
  const entities = new TextDecoder('latin1').decode(data.subarray(eo, eo + el)).replace(/\0+$/, '');

  // planes (20 bytes: normal[3], dist, type)
  const [po, pl] = lump(dv, LUMP_PLANES);
  const numPlanes = pl / 20;
  const planes = new Float32Array(numPlanes * 4);
  const planeType = new Uint8Array(numPlanes);
  for (let i = 0; i < numPlanes; i++) {
    const o = po + i * 20;
    planes[i * 4] = dv.getFloat32(o, true);
    planes[i * 4 + 1] = dv.getFloat32(o + 4, true);
    planes[i * 4 + 2] = dv.getFloat32(o + 8, true);
    planes[i * 4 + 3] = dv.getFloat32(o + 12, true);
    planeType[i] = dv.getInt32(o + 16, true);
  }

  // vertices
  const [vo, vl] = lump(dv, LUMP_VERTEXES);
  const vertices = new Float32Array(vl / 4);
  for (let i = 0; i < vertices.length; i++) vertices[i] = dv.getFloat32(vo + i * 4, true);

  // textures
  const [to, tl] = lump(dv, LUMP_TEXTURES);
  const textures: (MipTex | null)[] = [];
  if (tl > 0) {
    const n = dv.getInt32(to, true);
    for (let i = 0; i < n; i++) {
      const ofs = dv.getInt32(to + 4 + i * 4, true);
      if (ofs < 0) { textures.push(null); continue; }
      const m = to + ofs;
      const name = readName(data, m, 16).toLowerCase();
      const width = dv.getUint32(m + 16, true);
      const height = dv.getUint32(m + 20, true);
      const off0 = dv.getUint32(m + 24, true);
      const pixels = off0 > 0 && m + off0 + width * height <= data.length ? data.slice(m + off0, m + off0 + width * height) : null;
      textures.push({ name, width, height, pixels });
    }
  }

  // texinfo (40 bytes)
  const [tio, til] = lump(dv, LUMP_TEXINFO);
  const numTexinfo = til / 40;
  const texVecs = new Float32Array(numTexinfo * 8);
  const texMip = new Int32Array(numTexinfo);
  const texFlags = new Int32Array(numTexinfo);
  for (let i = 0; i < numTexinfo; i++) {
    const o = tio + i * 40;
    for (let j = 0; j < 8; j++) texVecs[i * 8 + j] = dv.getFloat32(o + j * 4, true);
    texMip[i] = dv.getInt32(o + 32, true);
    texFlags[i] = dv.getInt32(o + 36, true);
  }

  // edges
  const [edo, edl] = lump(dv, LUMP_EDGES);
  const esz = bsp2 ? 8 : 4;
  const numEdges = edl / esz;
  const edges = new Uint32Array(numEdges * 2);
  for (let i = 0; i < numEdges; i++) {
    if (bsp2) { edges[i * 2] = dv.getUint32(edo + i * 8, true); edges[i * 2 + 1] = dv.getUint32(edo + i * 8 + 4, true); }
    else { edges[i * 2] = dv.getUint16(edo + i * 4, true); edges[i * 2 + 1] = dv.getUint16(edo + i * 4 + 2, true); }
  }
  const [so, sl] = lump(dv, LUMP_SURFEDGES);
  const surfedges = new Int32Array(sl / 4);
  for (let i = 0; i < surfedges.length; i++) surfedges[i] = dv.getInt32(so + i * 4, true);

  // faces
  const [fo, fl] = lump(dv, LUMP_FACES);
  const fsz = bsp2 ? 28 : 20;
  const numFaces = fl / fsz;
  const facePlane = new Int32Array(numFaces), faceSide = new Uint8Array(numFaces), faceFirstEdge = new Int32Array(numFaces);
  const faceNumEdges = new Int32Array(numFaces), faceTexinfo = new Int32Array(numFaces), faceStyles = new Uint8Array(numFaces * 4);
  const faceLightofs = new Int32Array(numFaces);
  for (let i = 0; i < numFaces; i++) {
    const o = fo + i * fsz;
    if (bsp2) {
      facePlane[i] = dv.getInt32(o, true); faceSide[i] = dv.getInt32(o + 4, true) ? 1 : 0;
      faceFirstEdge[i] = dv.getInt32(o + 8, true); faceNumEdges[i] = dv.getInt32(o + 12, true);
      faceTexinfo[i] = dv.getInt32(o + 16, true);
      for (let j = 0; j < 4; j++) faceStyles[i * 4 + j] = data[o + 20 + j];
      faceLightofs[i] = dv.getInt32(o + 24, true);
    } else {
      facePlane[i] = dv.getUint16(o, true); faceSide[i] = dv.getInt16(o + 2, true) ? 1 : 0;
      faceFirstEdge[i] = dv.getInt32(o + 4, true); faceNumEdges[i] = dv.getInt16(o + 8, true);
      faceTexinfo[i] = dv.getInt16(o + 10, true);
      for (let j = 0; j < 4; j++) faceStyles[i * 4 + j] = data[o + 12 + j];
      faceLightofs[i] = dv.getInt32(o + 16, true);
    }
  }

  // CalcSurfaceExtents (in double precision like QuakeSpasm/ericw-tools to get the exact lightmap size)
  const faceTexMins = new Int32Array(numFaces * 2), faceExtents = new Int32Array(numFaces * 2);
  for (let f = 0; f < numFaces; f++) {
    const ti = faceTexinfo[f] * 8;
    let min0 = Infinity, min1 = Infinity, max0 = -Infinity, max1 = -Infinity;
    for (let e = 0; e < faceNumEdges[f]; e++) {
      const se = surfedges[faceFirstEdge[f] + e];
      const v = se >= 0 ? edges[se * 2] : edges[-se * 2 + 1];
      const x = vertices[v * 3], y = vertices[v * 3 + 1], z = vertices[v * 3 + 2];
      const s = x * texVecs[ti] + y * texVecs[ti + 1] + z * texVecs[ti + 2] + texVecs[ti + 3];
      const t = x * texVecs[ti + 4] + y * texVecs[ti + 5] + z * texVecs[ti + 6] + texVecs[ti + 7];
      if (s < min0) min0 = s; if (s > max0) max0 = s;
      if (t < min1) min1 = t; if (t > max1) max1 = t;
    }
    const bmin0 = Math.floor(min0 / 16), bmin1 = Math.floor(min1 / 16);
    const bmax0 = Math.ceil(max0 / 16), bmax1 = Math.ceil(max1 / 16);
    faceTexMins[f * 2] = bmin0 * 16; faceTexMins[f * 2 + 1] = bmin1 * 16;
    faceExtents[f * 2] = (bmax0 - bmin0) * 16; faceExtents[f * 2 + 1] = (bmax1 - bmin1) * 16;
  }

  // nodes
  const [no, nl] = lump(dv, LUMP_NODES);
  const nsz = bsp2 ? 44 : 24;
  const numNodes = nl / nsz;
  const nodePlane = new Int32Array(numNodes), nodeChildren = new Int32Array(numNodes * 2);
  const nodeFirstFace = new Int32Array(numNodes), nodeNumFaces = new Int32Array(numNodes), nodeBounds = new Float32Array(numNodes * 6);
  for (let i = 0; i < numNodes; i++) {
    const o = no + i * nsz;
    nodePlane[i] = dv.getInt32(o, true);
    if (bsp2) {
      nodeChildren[i * 2] = dv.getInt32(o + 4, true); nodeChildren[i * 2 + 1] = dv.getInt32(o + 8, true);
      for (let j = 0; j < 6; j++) nodeBounds[i * 6 + j] = dv.getFloat32(o + 12 + j * 4, true);
      nodeFirstFace[i] = dv.getUint32(o + 36, true); nodeNumFaces[i] = dv.getUint32(o + 40, true);
    } else {
      // BSP29 children are int16; values >= 0 are nodes, negative are -(leaf+1). Large maps
      // store children as unsigned (> 32767 → leaf) like QuakeSpasm's handling.
      for (let c = 0; c < 2; c++) {
        let v = dv.getUint16(o + 4 + c * 2, true);
        nodeChildren[i * 2 + c] = v < numNodes ? v : v - 65536;
      }
      for (let j = 0; j < 6; j++) nodeBounds[i * 6 + j] = dv.getInt16(o + 8 + j * 2, true);
      nodeFirstFace[i] = dv.getUint16(o + 20, true); nodeNumFaces[i] = dv.getUint16(o + 22, true);
    }
  }

  // leafs
  const [lo, ll] = lump(dv, LUMP_LEAFS);
  const lsz = bsp2 ? 44 : 28;
  const numLeafs = ll / lsz;
  const leafContents = new Int32Array(numLeafs), leafVisofs = new Int32Array(numLeafs), leafBounds = new Float32Array(numLeafs * 6);
  const leafFirstMark = new Int32Array(numLeafs), leafNumMark = new Int32Array(numLeafs);
  for (let i = 0; i < numLeafs; i++) {
    const o = lo + i * lsz;
    leafContents[i] = dv.getInt32(o, true);
    leafVisofs[i] = dv.getInt32(o + 4, true);
    if (bsp2) {
      for (let j = 0; j < 6; j++) leafBounds[i * 6 + j] = dv.getFloat32(o + 8 + j * 4, true);
      leafFirstMark[i] = dv.getUint32(o + 32, true); leafNumMark[i] = dv.getUint32(o + 36, true);
    } else {
      for (let j = 0; j < 6; j++) leafBounds[i * 6 + j] = dv.getInt16(o + 8 + j * 2, true);
      leafFirstMark[i] = dv.getUint16(o + 20, true); leafNumMark[i] = dv.getUint16(o + 22, true);
    }
  }

  const [mo, ml] = lump(dv, LUMP_MARKSURFACES);
  const msz = bsp2 ? 4 : 2;
  const marksurfaces = new Int32Array(ml / msz);
  for (let i = 0; i < marksurfaces.length; i++) marksurfaces[i] = bsp2 ? dv.getUint32(mo + i * 4, true) : dv.getUint16(mo + i * 2, true);

  const [viso, visl] = lump(dv, LUMP_VISIBILITY);
  const visdata = data.slice(viso, viso + visl);
  const [lio, lil] = lump(dv, LUMP_LIGHTING);
  const lighting = data.slice(lio, lio + lil);

  let lit: Uint8Array | null = null;
  if (litData && litData.length >= 8 && readName(litData, 0, 4) === 'QLIT') {
    const ver = new DataView(litData.buffer, litData.byteOffset, litData.byteLength).getInt32(4, true);
    if (ver === 1 && litData.length - 8 >= lil * 3) lit = litData.slice(8, 8 + lil * 3);
  }

  // models (64 bytes)
  const [moo, mol] = lump(dv, LUMP_MODELS);
  const models: BspModel[] = [];
  for (let i = 0; i < mol / 64; i++) {
    const o = moo + i * 64;
    const f = (k: number) => dv.getFloat32(o + k * 4, true);
    models.push({
      mins: new Float32Array([f(0) - 1, f(1) - 1, f(2) - 1]),
      maxs: new Float32Array([f(3) + 1, f(4) + 1, f(5) + 1]),
      origin: new Float32Array([f(6), f(7), f(8)]),
      headnode: dv.getInt32(o + 36, true),
      visleafs: dv.getInt32(o + 52, true),
      firstface: dv.getInt32(o + 56, true),
      numfaces: dv.getInt32(o + 60, true),
    });
  }

  return {
    version: bsp2 ? 'BSP2' : 'BSP29', entities, planes, planeType, vertices, textures, texVecs, texMip, texFlags,
    numFaces, facePlane, faceSide, faceFirstEdge, faceNumEdges, faceTexinfo, faceStyles, faceLightofs, faceTexMins, faceExtents,
    edges, surfedges, numNodes, nodePlane, nodeChildren, nodeFirstFace, nodeNumFaces, nodeBounds,
    numLeafs, leafContents, leafVisofs, leafBounds, leafFirstMark, leafNumMark, marksurfaces, visdata, lighting, lit, models,
  };
}

/** Mod_PointInLeaf from a headnode: returns the leaf index. */
export function pointInLeaf(bsp: Bsp, x: number, y: number, z: number, headnode = 0): number {
  let n = headnode;
  const p = bsp.planes;
  while (n >= 0) {
    const pi = bsp.nodePlane[n] * 4;
    const d = x * p[pi] + y * p[pi + 1] + z * p[pi + 2] - p[pi + 3];
    n = bsp.nodeChildren[n * 2 + (d >= 0 ? 0 : 1)];
  }
  return -1 - n;
}

/**
 * Mod_DecompressVis into `out` (one bit per leaf, leaf 1 = bit 0, like Quake).
 * Leaf 0 or no visdata → everything visible.
 */
export function decompressVis(bsp: Bsp, leaf: number, out: Uint8Array): void {
  const row = (bsp.models[0].visleafs + 7) >> 3;
  const ofs = leaf > 0 ? bsp.leafVisofs[leaf] : -1;
  if (ofs < 0 || bsp.visdata.length === 0) { out.fill(0xff, 0, row); return; }
  const v = bsp.visdata;
  let i = ofs, o = 0;
  while (o < row && i < v.length) {
    if (v[i]) { out[o++] = v[i++]; continue; }
    let c = v[i + 1];
    i += 2;
    while (c-- > 0 && o < row) out[o++] = 0;
  }
  while (o < row) out[o++] = 0;
}

/** Parse the entities lump into key/value records. */
export function parseEntities(text: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  const re = /"([^"]*)"|([{}])/g;
  let cur: Record<string, string> | null = null;
  let key: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[2] === '{') { cur = {}; key = null; }
    else if (m[2] === '}') { if (cur) out.push(cur); cur = null; }
    else if (cur) {
      if (key === null) key = m[1];
      else { cur[key] = m[1]; key = null; }
    }
  }
  return out;
}
