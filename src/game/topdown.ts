/*
 * Quake Town — a top-down view for when there is no 3D renderer (no WebGL, or a
 * build without src/render): the same RenderFrame, drawn as a radar. Also what
 * the shell's own tests screenshot before the renderer exists.
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 */
import type { RenderFrame } from '../render/types.js';

export interface RendererLike {
  loadMap(name: string): Promise<void>;
  draw(frame: RenderFrame): void;
  resize(w: number, h: number, dpr: number): void;
  setSettings?(s: Record<string, unknown>): void;
  stats?(): { drawCalls: number; tris: number; ms: number };
  dispose?(): void;
}

export class TopDownView implements RendererLike {
  private readonly ctx: CanvasRenderingContext2D;
  private scale = 0.35;
  private trail: { x: number; y: number; a: number }[] = [];

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  async loadMap(): Promise<void> { /* nothing to load */ }

  resize(w: number, h: number, dpr: number): void {
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.scale = Math.min(this.canvas.width, this.canvas.height) / 2400;
  }

  draw(f: RenderFrame): void {
    const c = this.ctx, W = this.canvas.width, H = this.canvas.height;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#17120d';
    c.fillRect(0, 0, W, H);
    const cam = f.camera;
    const s = this.scale;
    const cx = W / 2, cy = H / 2;
    const toX = (x: number): number => cx + (x - cam.origin[0]) * s;
    const toY = (y: number): number => cy - (y - cam.origin[1]) * s;
    // grid every 128 units
    c.strokeStyle = 'rgba(200,160,90,0.10)';
    c.lineWidth = 1;
    const g = 128 * s;
    const ox = toX(Math.floor(cam.origin[0] / 128) * 128), oy = toY(Math.floor(cam.origin[1] / 128) * 128);
    for (let x = ox % g; x < W; x += g) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
    for (let y = oy % g; y < H; y += g) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
    // arena walls of the fake sim (±1024)
    c.strokeStyle = 'rgba(220,180,110,0.6)';
    c.lineWidth = 2;
    c.strokeRect(toX(-1024), toY(1024), 2048 * s, 2048 * s);
    for (let i = 0; i < f.entityCount; i++) {
      const e = f.entities[i];
      const x = toX(e.origin[0]), y = toY(e.origin[1]);
      const yaw = (e.angles[1] * Math.PI) / 180;
      if (e.model.includes('player')) {
        c.fillStyle = e.isLocalPlayer ? '#ffd25a' : e.colors ? `hsl(${e.colors.top * 26},70%,55%)` : '#d0d0d0';
        c.beginPath(); c.arc(x, y, Math.max(3, 16 * s), 0, Math.PI * 2); c.fill();
        c.strokeStyle = c.fillStyle; c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(yaw) * 40 * s, y - Math.sin(yaw) * 40 * s); c.stroke();
      } else if (e.model.includes('missile') || e.model.includes('grenade') || e.model.includes('spike')) {
        c.fillStyle = '#ff8a3a';
        c.fillRect(x - 3, y - 3, 6, 6);
        this.trail.push({ x: e.origin[0], y: e.origin[1], a: 1 });
      } else {
        c.fillStyle = '#7cc4ff';
        c.fillRect(x - 4, y - 4, 8, 8);
      }
    }
    for (const t of this.trail) { c.fillStyle = `rgba(255,140,60,${t.a * 0.5})`; c.fillRect(toX(t.x) - 1, toY(t.y) - 1, 2, 2); t.a -= 0.02; }
    this.trail = this.trail.filter((t) => t.a > 0).slice(-400);
    for (let i = 0; i < f.eventCount; i++) {
      const ev = f.events[i];
      if (ev.kind === 2 && (ev.a === 3 || ev.a === 4)) { c.fillStyle = 'rgba(255,200,80,0.8)'; c.beginPath(); c.arc(toX(ev.x), toY(ev.y), 60 * s, 0, Math.PI * 2); c.fill(); }
    }
    // the view cone
    const yaw = (cam.angles[1] * Math.PI) / 180;
    c.strokeStyle = 'rgba(255,210,90,0.5)';
    const half = (cam.fov / 2) * (Math.PI / 180);
    c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(yaw + half) * 300 * s, cy - Math.sin(yaw + half) * 300 * s);
    c.moveTo(cx, cy); c.lineTo(cx + Math.cos(yaw - half) * 300 * s, cy - Math.sin(yaw - half) * 300 * s); c.stroke();
    if (f.camera.blend[3] > 0) { c.fillStyle = `rgba(${f.camera.blend[0] * 255},${f.camera.blend[1] * 255},${f.camera.blend[2] * 255},${f.camera.blend[3]})`; c.fillRect(0, 0, W, H); }
  }

  dispose(): void { /* the canvas goes with the game */ }
}
