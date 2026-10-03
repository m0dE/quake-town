// MDL (alias model, version 6) and SPR (sprite, version 1) loaders for drawing.
// Copyright (C) 1996-1997 Id Software, Inc. (file layouts from QW/client/modelgen.h,
// spritegn.h, gl_model.c). Copyright (C) 2026 Quake Town contributors.
//
// This program is free software; you can redistribute it and/or modify it under the terms
// of the GNU General Public License as published by the Free Software Foundation; either
// version 2 of the License, or (at your option) any later version.

/** model flags (mdl_t.flags) */
export const MF_ROCKET = 1, MF_GRENADE = 2, MF_GIB = 4, MF_ROTATE = 8, MF_TRACER = 16, MF_ZOMGIB = 32, MF_TRACER2 = 64, MF_TRACER3 = 128;

export interface MdlFrame {
  name: string;
  firstPose: number;
  numPoses: number;
  /** cumulative end times of the poses of a group (empty for single frames) */
  intervals: Float32Array | null;
}

export interface MdlSkin {
  /** palette-index images, one per group member */
  images: Uint8Array[];
  /** cumulative end times for a group skin, null for single */
  intervals: Float32Array | null;
}

export interface Mdl {
  scale: Float32Array;
  origin: Float32Array;
  radius: number;
  flags: number;
  skinWidth: number;
  skinHeight: number;
  skins: MdlSkin[];
  /** unique draw vertices (a stvert split on the seam for back-facing triangles) */
  numDrawVerts: number;
  /** source vertex index per draw vertex */
  drawVertSrc: Uint16Array;
  /** uv per draw vertex (0..1) */
  drawUV: Float32Array;
  indices: Uint16Array;
  numVerts: number;
  numTris: number;
  /** all poses: numPoses × numVerts × 4 bytes (x, y, z, normal index) */
  poses: Uint8Array;
  numPoses: number;
  frames: MdlFrame[];
  /** per pose bbox min/max in model units (6 floats) */
  poseBounds: Float32Array;
}

function readName(b: Uint8Array, o: number, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) { const c = b[o + i]; if (!c) break; s += String.fromCharCode(c); }
  return s;
}

export function loadMdl(data: Uint8Array): Mdl {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (readName(data, 0, 4) !== 'IDPO') throw new Error('not an MDL');
  const version = dv.getInt32(4, true);
  if (version !== 6) throw new Error(`MDL version ${version} unsupported`);
  const f = (o: number) => dv.getFloat32(o, true);
  const i32 = (o: number) => dv.getInt32(o, true);
  const scale = new Float32Array([f(8), f(12), f(16)]);
  const origin = new Float32Array([f(20), f(24), f(28)]);
  const radius = f(32);
  const numSkins = i32(48), skinWidth = i32(52), skinHeight = i32(56), numVerts = i32(60), numTris = i32(64), numFrames = i32(68);
  const flags = i32(76);
  let p = 84;
  const sz = skinWidth * skinHeight;
  const skins: MdlSkin[] = [];
  for (let s = 0; s < numSkins; s++) {
    const type = i32(p); p += 4;
    if (type === 0) {
      skins.push({ images: [data.subarray(p, p + sz)], intervals: null });
      p += sz;
    } else {
      const n = i32(p); p += 4;
      const intervals = new Float32Array(n);
      for (let k = 0; k < n; k++) { intervals[k] = f(p); p += 4; }
      const images: Uint8Array[] = [];
      for (let k = 0; k < n; k++) { images.push(data.subarray(p, p + sz)); p += sz; }
      skins.push({ images, intervals });
    }
  }
  const onseam = new Int32Array(numVerts), st = new Int32Array(numVerts * 2);
  for (let v = 0; v < numVerts; v++) { onseam[v] = i32(p); st[v * 2] = i32(p + 4); st[v * 2 + 1] = i32(p + 8); p += 12; }
  const triFront = new Int32Array(numTris), triVerts = new Int32Array(numTris * 3);
  for (let t = 0; t < numTris; t++) {
    triFront[t] = i32(p);
    triVerts[t * 3] = i32(p + 4); triVerts[t * 3 + 1] = i32(p + 8); triVerts[t * 3 + 2] = i32(p + 12);
    p += 16;
  }
  // frames
  const frames: MdlFrame[] = [];
  const poseOffsets: number[] = [];
  const poseBoundsArr: number[] = [];
  for (let fr = 0; fr < numFrames; fr++) {
    const type = i32(p); p += 4;
    if (type === 0) {
      const name = readName(data, p + 8, 16);
      frames.push({ name, firstPose: poseOffsets.length, numPoses: 1, intervals: null });
      poseBoundsArr.push(data[p], data[p + 1], data[p + 2], data[p + 4], data[p + 5], data[p + 6]);
      poseOffsets.push(p + 24);
      p += 24 + numVerts * 4;
    } else {
      const n = i32(p); p += 4 + 8; // numframes, bboxmin, bboxmax
      const intervals = new Float32Array(n);
      for (let k = 0; k < n; k++) { intervals[k] = f(p); p += 4; }
      const first = poseOffsets.length;
      let name = '';
      for (let k = 0; k < n; k++) {
        if (k === 0) name = readName(data, p + 8, 16);
        poseBoundsArr.push(data[p], data[p + 1], data[p + 2], data[p + 4], data[p + 5], data[p + 6]);
        poseOffsets.push(p + 24);
        p += 24 + numVerts * 4;
      }
      frames.push({ name, firstPose: first, numPoses: n, intervals });
    }
  }
  const numPoses = poseOffsets.length;
  const poses = new Uint8Array(numPoses * numVerts * 4);
  for (let k = 0; k < numPoses; k++) poses.set(data.subarray(poseOffsets[k], poseOffsets[k] + numVerts * 4), k * numVerts * 4);
  const poseBounds = new Float32Array(numPoses * 6);
  for (let k = 0; k < numPoses; k++) {
    for (let j = 0; j < 3; j++) {
      poseBounds[k * 6 + j] = poseBoundsArr[k * 6 + j] * scale[j] + origin[j];
      poseBounds[k * 6 + 3 + j] = poseBoundsArr[k * 6 + 3 + j] * scale[j] + origin[j];
    }
  }

  // draw vertices: split seam verts used by back-facing triangles (GL_MakeAliasModelDisplayLists)
  const map = new Map<number, number>();
  const src: number[] = [], uv: number[] = [];
  const indices = new Uint16Array(numTris * 3);
  for (let t = 0; t < numTris; t++) {
    for (let k = 0; k < 3; k++) {
      const v = triVerts[t * 3 + k];
      const back = !triFront[t] && onseam[v] ? 1 : 0;
      const key = v * 2 + back;
      let idx = map.get(key);
      if (idx === undefined) {
        idx = src.length;
        map.set(key, idx);
        src.push(v);
        let s = st[v * 2];
        if (back) s += skinWidth / 2;
        uv.push((s + 0.5) / skinWidth, (st[v * 2 + 1] + 0.5) / skinHeight);
      }
      // Quake winds triangles clockwise when seen from the front; flip to CCW for GL
      indices[t * 3 + (k === 0 ? 0 : 3 - k)] = idx;
    }
  }
  return {
    scale, origin, radius, flags, skinWidth, skinHeight, skins,
    numDrawVerts: src.length, drawVertSrc: Uint16Array.from(src), drawUV: Float32Array.from(uv), indices,
    numVerts, numTris, poses, numPoses, frames, poseBounds,
  };
}

/** Pose of `frame` at `time` (group frames animate on their intervals, like R_AliasSetupFrame). */
export function mdlPose(m: Mdl, frame: number, time: number): number {
  if (frame < 0 || frame >= m.frames.length) frame = 0;
  const fr = m.frames[frame];
  if (fr.numPoses <= 1 || !fr.intervals) return fr.firstPose;
  const full = fr.intervals[fr.numPoses - 1];
  const t = time - Math.floor(time / full) * full;
  let i = 0;
  while (i < fr.numPoses - 1 && fr.intervals[i] <= t) i++;
  return fr.firstPose + i;
}

export function mdlSkinImage(m: Mdl, skin: number, time: number): number {
  if (skin < 0 || skin >= m.skins.length) skin = 0;
  const s = m.skins[skin];
  if (!s.intervals || s.images.length <= 1) return 0;
  const full = s.intervals[s.images.length - 1];
  const t = time - Math.floor(time / full) * full;
  let i = 0;
  while (i < s.images.length - 1 && s.intervals[i] <= t) i++;
  return i;
}

// ---------------------------------------------------------------------------------------
// SPR

export interface SprFrame {
  /** origin[0] (left, negative) and origin[1] (up) like dspriteframe_t */
  left: number;
  up: number;
  width: number;
  height: number;
  pixels: Uint8Array;
}

export interface Spr {
  type: number;
  radius: number;
  maxWidth: number;
  maxHeight: number;
  /** groups: each entry a list of frames + cumulative intervals */
  frames: { images: SprFrame[]; intervals: Float32Array | null }[];
}

export function loadSpr(data: Uint8Array): Spr {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (readName(data, 0, 4) !== 'IDSP') throw new Error('not a sprite');
  const type = dv.getInt32(8, true);
  const radius = dv.getFloat32(12, true);
  const maxWidth = dv.getInt32(16, true), maxHeight = dv.getInt32(20, true);
  const n = dv.getInt32(24, true);
  let p = 36;
  const readFrame = (): SprFrame => {
    const left = dv.getInt32(p, true), up = dv.getInt32(p + 4, true), width = dv.getInt32(p + 8, true), height = dv.getInt32(p + 12, true);
    p += 16;
    const pixels = data.subarray(p, p + width * height);
    p += width * height;
    return { left, up, width, height, pixels };
  };
  const frames: Spr['frames'] = [];
  for (let i = 0; i < n; i++) {
    const t = dv.getInt32(p, true); p += 4;
    if (t === 0) frames.push({ images: [readFrame()], intervals: null });
    else {
      const k = dv.getInt32(p, true); p += 4;
      const intervals = new Float32Array(k);
      for (let j = 0; j < k; j++) { intervals[j] = dv.getFloat32(p, true); p += 4; }
      const images: SprFrame[] = [];
      for (let j = 0; j < k; j++) images.push(readFrame());
      frames.push({ images, intervals });
    }
  }
  return { type, radius, maxWidth, maxHeight, frames };
}
