// GPU textures from Quake indexed images.
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
import * as THREE from 'three';
import type { Bsp } from './bsp';
import type { Palette } from './palette';
import type { SurfKind } from './world';
import type { TextureFilter } from './types';

export function rgbaTexture(data: Uint8Array, w: number, h: number, mip = true, repeat = true): THREE.DataTexture {
  const t = new THREE.DataTexture(data as Uint8Array<ArrayBuffer>, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.flipY = false;
  t.generateMipmaps = mip;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/**
 * gl_texturemode: 'nearest' = GL_NEAREST_MIPMAP_LINEAR magnified as nearest (the classic
 * look), 'linear' = trilinear + anisotropy.
 */
export function applyFilter(t: THREE.Texture, filter: TextureFilter, aniso: number): void {
  const mip = t.generateMipmaps;
  const mag = filter === 'nearest' ? THREE.NearestFilter : THREE.LinearFilter;
  const min = mip ? (filter === 'nearest' ? THREE.NearestMipmapLinearFilter : THREE.LinearMipmapLinearFilter) : mag;
  const an = filter === 'nearest' ? 1 : Math.max(1, aniso);
  if (t.magFilter !== mag || t.minFilter !== min || t.anisotropy !== an) {
    t.magFilter = mag; t.minFilter = min; t.anisotropy = an;
    t.needsUpdate = true;
  }
}

export function checkerTexture(): THREE.DataTexture {
  const d = new Uint8Array(16 * 16 * 4);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const j = (y * 16 + x) * 4;
    const on = ((x >> 3) ^ (y >> 3)) & 1;
    d[j] = on ? 200 : 40; d[j + 1] = on ? 40 : 40; d[j + 2] = on ? 200 : 40; d[j + 3] = 255;
  }
  return rgbaTexture(d, 16, 16);
}

export interface WorldTextures {
  /** per miptex index (null = missing) */
  tex: (THREE.DataTexture | null)[];
  size: Float32Array; // w, h per miptex
  /** sky layers per miptex index of a sky texture */
  skyBack: (THREE.DataTexture | null)[];
  skyFront: (THREE.DataTexture | null)[];
  /** average colour of each texture (r_drawflat / fog fallbacks) */
  missing: THREE.DataTexture;
}

export function buildWorldTextures(bsp: Bsp, pal: Palette, kinds: SurfKind[]): WorldTextures {
  const n = bsp.textures.length;
  const tex: (THREE.DataTexture | null)[] = new Array(n).fill(null);
  const skyBack: (THREE.DataTexture | null)[] = new Array(n).fill(null);
  const skyFront: (THREE.DataTexture | null)[] = new Array(n).fill(null);
  const size = new Float32Array(n * 2);
  const missing = checkerTexture();
  for (let i = 0; i < n; i++) {
    const m = bsp.textures[i];
    if (!m) continue;
    size[i * 2] = m.width || 64; size[i * 2 + 1] = m.height || 64;
    if (!m.pixels) { tex[i] = null; continue; }
    const k = kinds[i];
    if (k === 'sky' && m.width >= 2) {
      // R_InitSky: right half = solid back layer, left half = front layer with index 0 transparent
      const hw = m.width >> 1, h = m.height;
      const back = new Uint8Array(hw * h), front = new Uint8Array(hw * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < hw; x++) {
        front[y * hw + x] = m.pixels[y * m.width + x];
        back[y * hw + x] = m.pixels[y * m.width + x + hw];
      }
      skyBack[i] = rgbaTexture(pal.toRGBA(back, hw, h, -1, 'cutout'), hw, h);
      skyFront[i] = rgbaTexture(pal.toRGBA(front, hw, h, 0, 'cutout'), hw, h);
      continue;
    }
    if (k === 'cutout') tex[i] = rgbaTexture(pal.toRGBA(m.pixels, m.width, m.height, 255, 'cutout'), m.width, m.height);
    else if (k === 'warp') tex[i] = rgbaTexture(pal.toRGBA(m.pixels, m.width, m.height, -1, 'cutout'), m.width, m.height);
    else tex[i] = rgbaTexture(pal.toRGBA(m.pixels, m.width, m.height), m.width, m.height);
  }
  return { tex, size, skyBack, skyFront, missing };
}
