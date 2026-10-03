// Quake palette / colormap, fullbright detection, player colour translation, RGBA conversion.
// Copyright (C) 1996-1997 Id Software, Inc. (translation rules from QW/client/gl_rmisc.c
// R_TranslatePlayerSkin). Copyright (C) 2026 Quake Town contributors.
//
// This program is free software; you can redistribute it and/or modify it under the terms
// of the GNU General Public License as published by the Free Software Foundation; either
// version 2 of the License, or (at your option) any later version.

import type { Vfs } from '../content/types';

export const TOP_RANGE = 16; // soldier uniform colours
export const BOTTOM_RANGE = 96;

export class Palette {
  /** 256 × rgb */
  readonly rgb: Uint8Array;
  /** 1 if the index is a fullbright colour (never darkened by the colormap) */
  readonly fullbright: Uint8Array;
  /** packed 0xAABBGGRR per index (little-endian RGBA bytes) */
  readonly rgba32: Uint32Array;

  constructor(palette: Uint8Array, colormap: Uint8Array | null) {
    this.rgb = palette.slice(0, 768);
    this.fullbright = new Uint8Array(256);
    if (colormap && colormap.length >= 64 * 256) {
      // An index is fullbright when even the darkest colormap row maps it to itself
      // (works for the id palette — indices 224..254 — and for LibreQuake's).
      for (let i = 0; i < 256; i++) this.fullbright[i] = colormap[63 * 256 + i] === i && colormap[32 * 256 + i] === i ? 1 : 0;
      this.fullbright[255] = 0;
      let n = 0;
      for (let i = 0; i < 256; i++) n += this.fullbright[i];
      if (n === 0 || n > 64) for (let i = 0; i < 256; i++) this.fullbright[i] = i >= 224 && i < 255 ? 1 : 0;
    } else {
      for (let i = 224; i < 255; i++) this.fullbright[i] = 1;
    }
    this.rgba32 = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      this.rgba32[i] = (255 << 24) | (this.rgb[i * 3 + 2] << 16) | (this.rgb[i * 3 + 1] << 8) | this.rgb[i * 3];
    }
  }

  static fromVfs(vfs: Vfs): Palette {
    const pal = vfs.get('gfx/palette.lmp');
    if (!pal || pal.length < 768) throw new Error('gfx/palette.lmp missing');
    return new Palette(pal, vfs.get('gfx/colormap.lmp'));
  }

  /**
   * Indexed image → RGBA bytes. Alpha encodes the "lit" weight: 255 = lit normally,
   * 0 = fullbright (drawn unlit, emissive). With `transparentIndex` (255 for `{` textures
   * and sprites, 0 for the sky's front layer) that index gets rgb 0 and alpha 0 and
   * `alphaMode` 'cutout' writes alpha 255 for every other pixel (fullbrights ignored).
   */
  toRGBA(src: ArrayLike<number>, w: number, h: number, transparentIndex = -1, alphaMode: 'lit' | 'cutout' = 'lit', translate?: Uint8Array, out?: Uint8Array): Uint8Array {
    const n = w * h;
    const o = out ?? new Uint8Array(n * 4);
    const fb = this.fullbright, rgb = this.rgb;
    for (let i = 0; i < n; i++) {
      let c = src[i];
      if (translate) c = translate[c];
      const j = i * 4;
      if (c === transparentIndex) { o[j] = o[j + 1] = o[j + 2] = 0; o[j + 3] = 0; continue; }
      o[j] = rgb[c * 3]; o[j + 1] = rgb[c * 3 + 1]; o[j + 2] = rgb[c * 3 + 2];
      o[j + 3] = alphaMode === 'cutout' ? 255 : fb[c] ? 0 : 255;
    }
    if (transparentIndex >= 0) bleedRGBA(o, w, h);
    return o;
  }

  color(i: number, out: Float32Array | number[], k = 0): void {
    out[k] = this.rgb[i * 3] / 255; out[k + 1] = this.rgb[i * 3 + 1] / 255; out[k + 2] = this.rgb[i * 3 + 2] / 255;
  }
}

/**
 * Fill rgb of fully transparent texels from opaque neighbours so linear filtering and
 * mipmaps do not pull black fringes in around cut-out edges.
 */
export function bleedRGBA(o: Uint8Array, w: number, h: number): void {
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const j = (y * w + x) * 4;
        if (o[j + 3] !== 0 || o[j] || o[j + 1] || o[j + 2]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const k = (yy * w + xx) * 4;
          if (o[k + 3] === 0) continue;
          r += o[k]; g += o[k + 1]; b += o[k + 2]; n++;
        }
        if (n) { o[j] = r / n; o[j + 1] = g / n; o[j + 2] = b / n; }
      }
    }
  }
}

/**
 * R_TranslatePlayerSkin: the 256-entry translation for QW topcolor/bottomcolor (0..13).
 * Rows 8..13 of the palette run backwards ("the artists made some backwards ranges").
 */
export function playerTranslation(top: number, bottom: number, out = new Uint8Array(256)): Uint8Array {
  for (let i = 0; i < 256; i++) out[i] = i;
  const t = (top & 15) * 16, b = (bottom & 15) * 16;
  for (let i = 0; i < 16; i++) {
    out[TOP_RANGE + i] = t < 128 ? t + i : t + 15 - i;
    out[BOTTOM_RANGE + i] = b < 128 ? b + i : b + 15 - i;
  }
  return out;
}
