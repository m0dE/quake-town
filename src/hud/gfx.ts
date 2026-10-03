/*
 * Quake Town — 2D pics: gfx.wad (WAD2) lumps, .lmp qpics, the palette and the
 * conchars font, turned into canvases once and drawn with integer scaling
 * (QW draw.c's Draw_PicFromWad / Draw_CachePic / Draw_Character).
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 */
import type { Vfs } from '../content/types.js';

export interface Pic { w: number; h: number; canvas: HTMLCanvasElement | OffscreenCanvas }

type Canvas2D = CanvasRenderingContext2D;

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** A fallback palette (QW's first rows approximated) for when gfx/palette.lmp is missing. */
function greyPalette(): Uint8Array {
  const p = new Uint8Array(768);
  for (let i = 0; i < 256; i++) { p[i * 3] = p[i * 3 + 1] = p[i * 3 + 2] = i; }
  return p;
}

export class Gfx {
  readonly palette: Uint8Array;
  private readonly wad = new Map<string, Uint8Array>();
  private readonly pics = new Map<string, Pic | null>();
  /** conchars: 16×16 glyphs of 8×8, index 0 transparent. */
  readonly chars: Pic | null;
  /** The same font tinted white→colour, cached per colour. */
  private readonly tinted = new Map<string, Pic>();

  constructor(private readonly vfs: Vfs) {
    this.palette = vfs.get('gfx/palette.lmp') ?? greyPalette();
    const wad = vfs.get('gfx.wad');
    if (wad) this.readWad(wad);
    const cc = this.wad.get('conchars');
    // QW Draw_Init: conchars colour 0 is the transparent one.
    this.chars = cc && cc.length >= 128 * 128 ? this.fromIndexed(cc.subarray(cc.length - 128 * 128), 128, 128, 0) : this.fallbackFont();
  }

  private readWad(b: Uint8Array): void {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'WAD2') return;
    const n = dv.getInt32(4, true), ofs = dv.getInt32(8, true);
    for (let i = 0; i < n; i++) {
      const at = ofs + i * 32;
      if (at + 32 > b.length) break;
      const pos = dv.getInt32(at, true), size = dv.getInt32(at + 4, true);
      let name = '';
      for (let k = 0; k < 16; k++) { const c = b[at + 16 + k]; if (!c) break; name += String.fromCharCode(c); }
      if (pos >= 0 && pos + size <= b.length) this.wad.set(name.toLowerCase(), b.subarray(pos, pos + size));
    }
  }

  /** Palette index → css colour. */
  css(index: number, alpha = 1): string {
    const p = this.palette, i = (index & 255) * 3;
    return alpha >= 1 ? `rgb(${p[i]},${p[i + 1]},${p[i + 2]})` : `rgba(${p[i]},${p[i + 1]},${p[i + 2]},${alpha})`;
  }

  rgb(index: number): [number, number, number] { const i = (index & 255) * 3; return [this.palette[i], this.palette[i + 1], this.palette[i + 2]]; }

  /** QW Sbar_ColorForMap: a colour row (0..13) → its palette index for fills. */
  static rowColor(row: number): number { const m = Math.max(0, Math.min(13, row | 0)) * 16; return m + 8; }

  private fromIndexed(data: Uint8Array, w: number, h: number, transparent = 255, transparent2 = -1): Pic {
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d') as Canvas2D;
    const img = ctx.createImageData(w, h);
    const p = this.palette;
    for (let i = 0; i < w * h; i++) {
      const c = data[i];
      if (c === transparent || c === transparent2) continue;
      img.data[i * 4] = p[c * 3]; img.data[i * 4 + 1] = p[c * 3 + 1]; img.data[i * 4 + 2] = p[c * 3 + 2]; img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return { w, h, canvas };
  }

  private qpic(b: Uint8Array): Pic | null {
    if (b.length < 8) return null;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const w = dv.getInt32(0, true), h = dv.getInt32(4, true);
    if (w <= 0 || h <= 0 || w > 4096 || h > 4096 || 8 + w * h > b.length) return null;
    return this.fromIndexed(b.subarray(8), w, h);
  }

  /** A pic from gfx.wad by name ("sbar", "num_3", "face1"). */
  wadPic(name: string): Pic | null {
    const key = `wad:${name}`;
    let p = this.pics.get(key);
    if (p !== undefined) return p;
    const b = this.wad.get(name.toLowerCase());
    p = b ? this.qpic(b) : null;
    this.pics.set(key, p);
    return p;
  }

  /** A .lmp from the VFS ("gfx/ranking.lmp"). */
  lmp(path: string): Pic | null {
    let p = this.pics.get(path);
    if (p !== undefined) return p;
    const b = this.vfs.get(path);
    p = b ? (path.endsWith('conback.lmp') ? this.conback(b) : this.qpic(b)) : null;
    this.pics.set(path, p);
    return p;
  }

  /** conback is opaque (index 255 is a colour there, not a hole). */
  private conback(b: Uint8Array): Pic | null {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const w = dv.getInt32(0, true), h = dv.getInt32(4, true);
    if (w <= 0 || h <= 0 || 8 + w * h > b.length) return null;
    return this.fromIndexed(b.subarray(8), w, h, -1);
  }

  private fallbackFont(): Pic {
    // No gfx.wad: draw ASCII with the system monospace font into the same 16×16 grid.
    const canvas = makeCanvas(128, 128);
    const ctx = canvas.getContext('2d') as Canvas2D;
    ctx.font = 'bold 8px monospace';
    ctx.textBaseline = 'top';
    for (let i = 0; i < 256; i++) {
      const ch = String.fromCharCode(i & 127);
      if ((i & 127) < 32) continue;
      ctx.fillStyle = i >= 128 ? '#c8a050' : '#d0d0d0';
      ctx.fillText(ch, (i & 15) * 8, (i >> 4) * 8);
    }
    return { w: 128, h: 128, canvas };
  }

  /** The font recoloured (modern HUD tints); white glyphs keep their shading. */
  font(color: string | null): Pic | null {
    if (!color || !this.chars) return this.chars;
    let t = this.tinted.get(color);
    if (t) return t;
    const canvas = makeCanvas(128, 128);
    const ctx = canvas.getContext('2d') as Canvas2D;
    ctx.drawImage(this.chars.canvas as CanvasImageSource, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 128, 128);
    t = { w: 128, h: 128, canvas };
    this.tinted.set(color, t);
    return t;
  }
}

/**
 * Integer-scaled drawing in QW's virtual screen units. `s` device pixels per unit;
 * (0,0) is the top left of the virtual screen.
 */
export class Draw2D {
  ctx!: Canvas2D;
  s = 2;
  /** virtual width/height */
  w = 320;
  h = 200;

  constructor(readonly gfx: Gfx) {}

  begin(ctx: Canvas2D, s: number, devW: number, devH: number): void {
    this.ctx = ctx;
    this.s = s;
    this.w = Math.floor(devW / s);
    this.h = Math.floor(devH / s);
    ctx.imageSmoothingEnabled = false;
  }

  pic(x: number, y: number, p: Pic | null, alpha = 1): void {
    if (!p) return;
    const c = this.ctx;
    if (alpha < 1) c.globalAlpha = alpha;
    c.drawImage(p.canvas as CanvasImageSource, Math.round(x * this.s), Math.round(y * this.s), p.w * this.s, p.h * this.s);
    if (alpha < 1) c.globalAlpha = 1;
  }

  subPic(x: number, y: number, p: Pic | null, sx: number, sy: number, w: number, h: number): void {
    if (!p) return;
    this.ctx.drawImage(p.canvas as CanvasImageSource, sx, sy, w, h, Math.round(x * this.s), Math.round(y * this.s), w * this.s, h * this.s);
  }

  /** Draw_Character: `num` 0..255 of conchars, at 8×8 units. */
  char(x: number, y: number, num: number, font: Pic | null = this.gfx.chars, scale = 1): void {
    num &= 255;
    if (!font || num === 32) return;
    const s = this.s * scale;
    this.ctx.drawImage(font.canvas as CanvasImageSource, (num & 15) * 8, (num >> 4) * 8, 8, 8, Math.round(x * this.s), Math.round(y * this.s), 8 * s, 8 * s);
  }

  /** Draw_String. `alt` sets the high bit (the brown/gold half), Draw_Alt_String. */
  string(x: number, y: number, text: string, alt = false, font: Pic | null = this.gfx.chars, scale = 1): void {
    for (let i = 0; i < text.length; i++) this.char(x + i * 8 * scale, y, text.charCodeAt(i) | (alt ? 128 : 0), font, scale);
  }

  fill(x: number, y: number, w: number, h: number, paletteIndex: number, alpha = 1): void {
    this.ctx.fillStyle = this.gfx.css(paletteIndex, alpha);
    this.ctx.fillRect(Math.round(x * this.s), Math.round(y * this.s), Math.round(w * this.s), Math.round(h * this.s));
  }

  fillCss(x: number, y: number, w: number, h: number, css: string): void {
    this.ctx.fillStyle = css;
    this.ctx.fillRect(Math.round(x * this.s), Math.round(y * this.s), Math.round(w * this.s), Math.round(h * this.s));
  }

  /** Draw_FadeScreen-ish: darken the whole view. */
  fade(alpha = 0.5): void {
    this.ctx.fillStyle = `rgba(0,0,0,${alpha})`;
    this.ctx.fillRect(0, 0, this.w * this.s, this.h * this.s);
  }

  /** M_DrawTextBox: the menu box pics around a w×h (in chars) area. */
  textBox(x: number, y: number, width: number, lines: number): void {
    const g = this.gfx;
    let cx = x, cy = y;
    this.pic(cx, cy, g.lmp('gfx/box_tl.lmp'));
    for (let n = 0; n < lines; n++) { cy += 8; this.pic(cx, cy, g.lmp('gfx/box_ml.lmp')); }
    this.pic(cx, cy + 8, g.lmp('gfx/box_bl.lmp'));
    cx += 8;
    for (let w = width; w > 0; w -= 2) {
      cy = y;
      this.pic(cx, cy, g.lmp('gfx/box_tm.lmp'));
      const mid = g.lmp('gfx/box_mm.lmp');
      for (let n = 0; n < lines; n++) { cy += 8; this.pic(cx, cy, n === 1 ? g.lmp('gfx/box_mm2.lmp') ?? mid : mid); }
      this.pic(cx, cy + 8, g.lmp('gfx/box_bm.lmp'));
      cx += 16;
    }
    cy = y;
    this.pic(cx, cy, g.lmp('gfx/box_tr.lmp'));
    for (let n = 0; n < lines; n++) { cy += 8; this.pic(cx, cy, g.lmp('gfx/box_mr.lmp')); }
    this.pic(cx, cy + 8, g.lmp('gfx/box_br.lmp'));
  }
}

/** Quake's text: chars ≥ 128 are the gold set; for measuring and plain-text logs. */
export function plainText(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i) & 127;
    out += c === 10 ? '\n' : c < 32 ? (c === 16 ? '[' : c === 17 ? ']' : c >= 18 && c <= 27 ? String(c - 18) : ' ') : String.fromCharCode(c);
  }
  return out;
}
