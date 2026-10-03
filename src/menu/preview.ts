/**
 * The character preview, on the start screen and the Customize screen.
 *
 * When the renderer's `renderCharacterPreview` is wired (deps.renderPreview), the 3D model
 * is drawn. Until then this placeholder draws a pixel-art ranger in the chosen shirt and
 * pants rows, turning slowly, so colour picking already works.
 *
 * Licence: GPL-2.0-or-later.
 */
import { playerLook, rowRamp, type PlayerLook } from '../settings/index.js';
import type { MenuDeps } from './types.js';

/** The renderer preview's own turn (render/preview.ts previewAutoYaw), degrees. */
const autoYaw = (t: number): number => -30 + t * 24;

export function drawPlaceholder(canvas: HTMLCanvasElement, look: PlayerLook, t: number, turn = 0): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const u = Math.max(2, Math.floor(H / 64));          // one sprite pixel
  const ang = t * 0.6 + turn;
  const c = Math.cos(ang);
  const facing = c >= 0;
  const sx = Math.max(0.28, Math.abs(c));             // width squash = the turn
  const side = Math.sin(ang);
  const cx = Math.round(W / 2);
  const top = Math.round(H / 2 - 26 * u);

  const shirt = rowRamp(look.topcolor);
  const pants = rowRamp(look.bottomcolor);
  const armor = ['#2a221b', '#3a3027', '#4d4135', '#62533f'];
  const skin = '#b07b55';

  // floor plate and its shadow
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.ellipse(cx, top + 49 * u, 13 * u, 3 * u, 0, 0, Math.PI * 2);
  ctx.fill();

  const px = (x: number, y: number, w: number, h: number, col: string): void => {
    // x, w in sprite units around the centre line, squashed by the turn
    const x0 = Math.round(cx + x * sx * u);
    const x1 = Math.round(cx + (x + w) * sx * u);
    ctx.fillStyle = col;
    ctx.fillRect(Math.min(x0, x1), top + y * u, Math.max(u / 2, Math.abs(x1 - x0)), h * u);
  };
  // light from the upper left: the left half of each part is lighter when facing us
  const lit = (x: number, w: number, y: number, h: number, ramp: string[], hi: number, lo: number): void => {
    const half = w / 2;
    px(x, y, half, h, ramp[facing ? hi : lo]);
    px(x + half, y, half, h, ramp[facing ? lo : hi]);
  };

  // gun on the far side is drawn first
  const gunX = side > 0 ? -12 : 9;
  if ((side > 0) === facing) px(gunX, 19, 3, 12, '#1d1915');

  // legs + boots
  lit(-7, 6, 25, 16, pants, 11, 7);
  lit(1, 6, 25, 16, pants, 10, 6);
  px(-7, 41, 6, 6, armor[1]); px(1, 41, 6, 6, armor[1]);
  px(-7, 46, 6, 1, armor[0]); px(1, 46, 6, 1, armor[0]);
  // belt
  px(-8, 23, 16, 2, armor[0]);
  px(-1, 23, 2, 2, '#9a6a2a');
  // torso
  lit(-8, 16, 10, 13, shirt, 12, 7);
  // armour plate on the chest + shoulder pads
  px(-6, 12, 12, 7, armor[facing ? 2 : 1]);
  px(-6, 12, 12, 1, armor[3]);
  px(-10, 9, 5, 4, armor[2]); px(5, 9, 5, 4, armor[2]);
  // arms
  lit(-11, 3, 13, 11, shirt, 9, 6);
  lit(8, 3, 13, 11, shirt, 8, 5);
  px(-11, 24, 3, 2, skin); px(8, 24, 3, 2, skin);
  // neck + head
  px(-2, 8, 4, 2, skin);
  px(-4, 0, 8, 8, armor[2]);
  px(-4, 0, 8, 1, armor[3]);
  if (facing) {
    px(-3, 3, 6, 2, '#f0b45a');                   // visor
    px(-3, 5, 6, 1, '#9a4a1a');
  } else {
    px(-4, 5, 8, 2, armor[1]);
  }
  // gun on the near side
  if ((side > 0) !== facing) px(gunX, 19, 3, 12, '#1d1915');
}

/**
 * A turning character canvas: the renderer's 3D model when `deps.renderPreview` is wired,
 * the placeholder otherwise. Drag turns it. `start()` / `stop()` run the animation.
 */
export function characterView(deps: MenuDeps, className = 'preview'): { canvas: HTMLCanvasElement; start(): void; stop(): void } {
  const canvas = document.createElement('canvas');
  canvas.className = className;
  canvas.width = 360;
  canvas.height = 480;
  canvas.setAttribute('aria-label', 'Your character');
  let raf = 0;
  let turn = 0;
  let dragX: number | null = null;
  // Once the player turns the model by hand it stays where they leave it: no more auto turn.
  let heldYaw: number | null = null;
  let heldT = 0;
  let now = 0;
  canvas.addEventListener('pointerdown', (e) => {
    dragX = e.clientX;
    canvas.setPointerCapture(e.pointerId);
    if (heldYaw === null) { heldT = now; heldYaw = autoYaw(now); }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (dragX === null) return;
    const dx = e.clientX - dragX;
    dragX = e.clientX;
    turn += dx / 80;
    if (heldYaw !== null) heldYaw += dx * 0.5;
  });
  canvas.addEventListener('pointerup', () => { dragX = null; });
  canvas.addEventListener('pointercancel', () => { dragX = null; });

  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const t0 = performance.now();
  const frame = (): void => {
    const t = reduce ? 0.9 : (performance.now() - t0) / 1000;
    now = t;
    const look = playerLook();
    if (deps.renderPreview) {
      // The renderer sizes its own WebGL canvas. `t` animates (idle stance); the yaw turns by
      // itself until the player drags it, then holds where they left it.
      deps.renderPreview(canvas, look, t, heldYaw ?? undefined);
    } else {
      const dpr = Math.min(2, devicePixelRatio || 1);
      const w = Math.round(canvas.clientWidth * dpr);
      const hh = Math.round(canvas.clientHeight * dpr);
      if (w && hh && (canvas.width !== w || canvas.height !== hh)) { canvas.width = w; canvas.height = hh; }
      drawPlaceholder(canvas, look, heldYaw === null ? t : heldT, turn);
    }
    raf = requestAnimationFrame(frame);
  };
  return {
    canvas,
    start() { cancelAnimationFrame(raf); raf = requestAnimationFrame(frame); },
    stop() { cancelAnimationFrame(raf); },
  };
}
