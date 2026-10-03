/**
 * Crosshair shapes, drawn the same way by the menu's designer and the in-game HUD:
 * `drawCrosshair(ctx, cx, cy, { shape, size, color, alpha, scale })`.
 *
 *   0 off   1 the "+" character   2 cross with gap   3 small cross   4 dot
 *   5 circle with dot   6 cross with dot   7 chevron
 *
 * Shapes are on an integer pixel grid so they stay crisp; `size` (crosshairsize) and
 * `scale` (device pixels per CSS px × hud_scale) multiply the base 1px stroke.
 *
 * Licence: GPL-2.0-or-later.
 */
import { cvars } from './cvars.js';
import { paletteCss } from './palette.js';

export interface CrosshairStyle {
  shape: number;
  size: number;
  /** CSS colour. */
  color: string;
  alpha: number;
  /** Device pixels per unit (default 1). */
  scale?: number;
}

export const CROSSHAIR_NAMES = ['Off', 'Plus', 'Gap cross', 'Small cross', 'Dot', 'Ring', 'Cross dot', 'Chevron'];

export function crosshairFromCvars(scale = 1): CrosshairStyle {
  return {
    shape: cvars.num('crosshair'), size: cvars.num('crosshairsize'),
    color: paletteCss(cvars.num('crosshaircolor')), alpha: cvars.num('crosshairalpha'), scale,
  };
}

export function drawCrosshair(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: CrosshairStyle): void {
  if (!s.shape) return;
  const t = Math.max(1, Math.round((s.scale ?? 1) * s.size));   // stroke width, device px
  const x0 = Math.round(cx);
  const y0 = Math.round(cy);
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, s.alpha));
  const rect = (x: number, y: number, w: number, h: number): void => {
    // A dark outline first so the shape reads on any wall, then the colour.
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  };
  const fill = (x: number, y: number, w: number, h: number): void => { ctx.fillStyle = s.color; ctx.fillRect(x, y, w, h); };
  const both = (parts: [number, number, number, number][]): void => {
    for (const p of parts) rect(...p);
    for (const p of parts) fill(...p);
  };
  const half = Math.floor(t / 2);
  switch (s.shape) {
    case 1: { // "+" like the conchars character: short arms, no gap
      const L = 4 * t;
      both([[x0 - L, y0 - half, 2 * L + t, t], [x0 - half, y0 - L, t, 2 * L + t]]);
      break;
    }
    case 2: { const g = 3 * t, L = 5 * t;
      both([[x0 - g - L, y0 - half, L, t], [x0 + g + t, y0 - half, L, t], [x0 - half, y0 - g - L, t, L], [x0 - half, y0 + g + t, t, L]]);
      break; }
    case 3: { const g = 2 * t, L = 3 * t;
      both([[x0 - g - L, y0 - half, L, t], [x0 + g + t, y0 - half, L, t], [x0 - half, y0 - g - L, t, L], [x0 - half, y0 + g + t, t, L]]);
      break; }
    case 4: both([[x0 - t, y0 - t, 2 * t + (t % 2), 2 * t + (t % 2)]]); break;
    case 5: {
      const r = 7 * t;
      ctx.lineWidth = t + 2; ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath(); ctx.arc(x0 + 0.5, y0 + 0.5, r, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = t; ctx.strokeStyle = s.color;
      ctx.beginPath(); ctx.arc(x0 + 0.5, y0 + 0.5, r, 0, Math.PI * 2); ctx.stroke();
      both([[x0 - half, y0 - half, t, t]]);
      break;
    }
    case 6: { const g = 3 * t, L = 4 * t;
      both([[x0 - g - L, y0 - half, L, t], [x0 + g + t, y0 - half, L, t], [x0 - half, y0 - g - L, t, L], [x0 - half, y0 + g + t, t, L], [x0 - half, y0 - half, t, t]]);
      break; }
    case 7: {
      const L = 6 * t;
      const parts: [number, number, number, number][] = [];
      for (let k = 0; k < L; k += t) { parts.push([x0 - k - half, y0 + k + t, t, t], [x0 + k - half, y0 + k + t, t, t]); }
      both(parts);
      break;
    }
    default: break;
  }
  ctx.restore();
}
