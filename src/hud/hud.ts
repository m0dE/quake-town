/*
 * Quake Town — the 2D layer over the 3D view: status bar (classic QW sbar or a
 * modern minimal layout), crosshair, centerprint, kill feed, match clock and
 * ready-up/countdown, scoreboard, intermission stats, net graph, fps.
 * The console and the notify/chat lines draw on the same canvas (src/console).
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 * (SCR_CenterPrint / SCR_DrawCenterString behaviour follows QW's screen.c,
 *  Copyright (C) 1996-1997 Id Software, Inc., GPL-2.0-or-later.)
 */
import { CV, IT, PHASE_COUNTDOWN, PHASE_INTERMISSION, PHASE_OVERTIME, PHASE_PLAYING, PHASE_ROUNDBREAK, PHASE_WARMUP } from '../sim/abi.js';
import type { Cvars } from '../console/cvars.js';
import { Draw2D, Gfx, plainText } from './gfx.js';
import { drawCrosshair, crosshairFromCvars } from '../settings/crosshair.js';
import { Sbar, type PlayerRow, type TeamRow } from './sbar.js';

export type { PlayerRow, TeamRow };

export interface MatchInfo {
  phase: number;
  /** seconds left in the phase (countdown / match / overtime), or -1 when the phase has no clock */
  left: number;
  score1: number;
  score2: number;
  round: number;
  mode: string;
}

export interface NetInfo {
  fps: number;
  ping: number | null;
  delayMs: number;
  lead: number;
  rollbacks: number;
  mispredictions: number;
  desyncs: number;
  starvations: number;
  stepUs: number;
  status: string | null;
}

export interface HudState {
  now: number;
  /** sim seconds of the drawn self clock (face anim, weapon flash) */
  time: number;
  /** the ClientView drawn (ours, or the followed player's), null in free-fly spectating */
  cv: Int32Array | null;
  spectator: boolean;
  /** spectator line: "Tracking X, [JUMP] for next" etc. */
  specLine: string;
  rows: PlayerRow[];
  teams: TeamRow[];
  teamplay: boolean;
  showScores: boolean;
  intermission: boolean;
  match: MatchInfo | null;
  net: NetInfo;
  /** a notice in the middle (connecting, server full, reconnecting) */
  notice: string;
  /** the console covers this fraction of the screen (0..1): skip what it hides */
  consoleFrac: number;
  /** the mouse is not captured: say how to resume */
  paused: boolean;
  /** the 3D view is not there (no WebGL / no renderer) */
  noView?: boolean;
}

interface Kill { killer: string; victim: string; weapon: string; at: number; mine: boolean; color: string }

const WEAPON_GLYPH: Record<number, string> = {
  0: 'world', 1: 'axe', 2: 'sg', 3: 'ssg', 4: 'ng', 5: 'sng', 6: 'gl', 7: 'rl', 8: 'lg', 9: 'discharge', 10: 'telefrag',
  11: 'squish', 12: 'lava', 13: 'slime', 14: 'water', 15: 'fall', 16: 'suicide', 17: 'teamkill',
};

export class Hud {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly draw: Draw2D;
  readonly gfx: Gfx;
  private readonly sbar: Sbar;
  private center = { lines: [] as string[], until: 0, start: 0 };
  private kills: Kill[] = [];
  private faceUntil = -1;
  private readonly graph = new Float32Array(240);
  private graphAt = 0;
  private dpr = 1;

  constructor(host: HTMLElement, gfx: Gfx, private readonly cvars: Cvars) {
    this.gfx = gfx;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'qt-hud';
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;image-rendering:pixelated;z-index:2';
    host.append(this.canvas);
    this.ctx = this.canvas.getContext('2d', { alpha: true })!;
    this.draw = new Draw2D(gfx);
    this.sbar = new Sbar(gfx);
    this.resize();
  }

  resize(): void {
    this.dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * this.dpr || innerWidth * this.dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * this.dpr || innerHeight * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  /** Device pixels per virtual unit: QW at 640 wide is scale 1 per 2 pixels, so ~ width/640. */
  scale(): number {
    const base = Math.max(1, Math.round((this.canvas.width / 640) * (this.cvars.num('hud_scale') || 1)));
    return Math.max(1, Math.min(base, Math.floor(this.canvas.height / 200)));
  }

  /** svc_centerprint: shown for scr_centertime seconds. */
  centerPrint(text: string, now: number): void {
    const t = plainText(text).replace(/\n+$/, '');
    if (!t) { this.center.lines = []; return; }
    this.center.lines = t.split('\n');
    this.center.start = now;
    this.center.until = now + (this.cvars.num('scr_centertime') || 2) * 1000;
  }

  /** An obituary for the kill feed. */
  kill(killer: string, victim: string, deathtype: number, mine: boolean, now: number): void {
    this.kills.push({ killer, victim, weapon: WEAPON_GLYPH[deathtype] ?? '?', at: now, mine, color: mine ? '#ffd25a' : '#e8e0d0' });
    if (this.kills.length > 6) this.kills.shift();
  }

  /** The face's pain frame (QW cl.faceanimtime = time + 0.2). */
  pain(time: number): void { this.faceUntil = time + 0.2; }

  /** Per rendered frame. `afterHud` draws over it (the console). */
  frame(st: HudState, afterHud?: (d: Draw2D) => void): void {
    this.resize();
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const d = this.draw;
    d.begin(ctx, this.scale(), this.canvas.width, this.canvas.height);
    const net = st.net;
    this.graph[this.graphAt++ % this.graph.length] = net.delayMs;

    if (st.consoleFrac < 1) {
      const modern = this.cvars.get('hud_layout') === 'modern';
      if (st.intermission) {
        this.sbar.matchStats(d, st.rows, st.teams, st.teamplay, this.matchHeadline(st));
      } else {
        if (st.cv && !st.spectator) this.crosshair(d, st.cv);
        if (st.cv) {
          const dead = st.cv[CV.deadflag] !== 0 || st.cv[CV.health] <= 0;
          if (modern) this.modern(d, st.cv, st);
          else if (this.sbar.ok && !(st.showScores || dead)) this.sbar.draw(d, st.cv, st.time, st.time < this.faceUntil, st.rows, this.cvars.num('viewsize') || 100, this.cvars.num('cl_hudswap') !== 0);
          if (st.showScores || (dead && !st.spectator)) this.sbar.scoreboard(d, st.rows, st.teams, st.teamplay, this.scoreTitle(st));
        } else if (st.showScores) this.sbar.scoreboard(d, st.rows, st.teams, st.teamplay, this.scoreTitle(st));
        if (st.spectator) {
          if (modern || !this.sbar.ok) d.string(Math.floor((d.w - st.specLine.length * 8) / 2), d.h - 12, st.specLine, true);
          else if (!st.cv) this.sbar.drawSpectator(d, 'SPECTATOR MODE', st.specLine);
          else d.string(Math.floor((d.w - st.specLine.length * 8) / 2), d.h - 60, st.specLine, true);
        }
        this.matchClock(d, st);
        this.killFeed(d, st.now);
      }
      this.centerString(d, st.now);
      if (st.notice) this.noticeBox(d, st.notice);
      if (st.paused && !st.intermission) this.noticeBox(d, 'Click to play', true);
      this.netInfo(d, st);
    }
    afterHud?.(d);
  }

  private scoreTitle(st: HudState): string {
    const m = st.match;
    if (!m) return '';
    const mode = m.mode.toUpperCase();
    if (st.teamplay && m.phase >= PHASE_PLAYING) return `${mode}  ${m.score1} : ${m.score2}`;
    return mode;
  }

  private matchHeadline(st: HudState): string {
    if (st.teamplay && st.teams.length >= 2) {
      const [a, b] = st.teams;
      return a.frags === b.frags ? 'The match is a draw' : `Team ${a.team} wins the match`;
    }
    const top = st.rows[0];
    return top ? `${top.name} wins the match` : '';
  }

  // ---------------------------------------------------------------- crosshair
  private crosshair(d: Draw2D, cv: Int32Array): void {
    if (!this.cvars.num('crosshair') || cv[CV.deadflag] || cv[CV.intermission]) return;
    // The settings part's shapes, so the menu's designer and the game draw the same thing.
    const scale = d.s / 2 * (this.cvars.num('hud_scale') || 1);
    const cx = this.canvas.width / 2 + this.cvars.num('cl_crossx') * d.s;
    const cy = this.canvas.height / 2 + this.cvars.num('cl_crossy') * d.s;
    drawCrosshair(d.ctx, cx, cy, crosshairFromCvars(Math.max(1, scale)));
  }

  // ---------------------------------------------------------------- modern HUD
  private modern(d: Draw2D, cv: Int32Array, st: HudState): void {
    const big = (x: number, y: number, n: number, low: boolean, align: 'left' | 'right'): void => {
      const s = String(n);
      const scale = 2;
      const w = s.length * 8 * scale;
      d.string(align === 'left' ? x : x - w, y, s, false, this.gfx.font(low ? '#ff5040' : '#f2ead8'), scale);
    };
    const health = cv[CV.health], armor = cv[CV.armor], ammo = cv[CV.currentammo];
    const items = cv[CV.items];
    const y = d.h - 22;
    // health and armour, bottom left
    d.fillCss(4, y - 4, 112, 22, 'rgba(10,8,6,0.45)');
    big(10, y, Math.max(0, health), health <= 25, 'left');
    const armorColor = items & IT.ARMOR3 ? '#ff4030' : items & IT.ARMOR2 ? '#ffd040' : items & IT.ARMOR1 ? '#50d050' : '#8a8478';
    d.fillCss(62, y, 3, 16, armorColor);
    big(70, y, armor, false, 'left');
    // ammo, bottom right, with the weapon's ammo kind
    const kind = items & IT.SHELLS ? 'shells' : items & IT.NAILS ? 'nails' : items & IT.ROCKETS ? 'rockets' : items & IT.CELLS ? 'cells' : '';
    d.fillCss(d.w - 116, y - 4, 112, 22, 'rgba(10,8,6,0.45)');
    if (kind) {
      big(d.w - 10, y, ammo, ammo <= 10, 'right');
      d.string(d.w - 110, y + 5, kind, true);
    }
    // weapons owned, a row above the ammo
    const names = ['SG', 'SSG', 'NG', 'SNG', 'GL', 'RL', 'LG'];
    let wx = d.w - 7 * 26 - 6;
    for (let i = 0; i < 7; i++) {
      const has = (items & (IT.SHOTGUN << i)) !== 0;
      const active = cv[CV.weapon] === (IT.SHOTGUN << i);
      const ammoOf = [CV.shells, CV.shells, CV.nails, CV.nails, CV.rockets, CV.rockets, CV.cells][i];
      if (has) {
        if (active) d.fillCss(wx - 1, y - 18, 25, 10, 'rgba(255,210,90,0.25)');
        d.string(wx + 12 - names[i].length * 4, y - 17, names[i], !active || cv[ammoOf] === 0);
      }
      wx += 26;
    }
    // powerups
    let px = 120;
    for (const [bit, label, color] of [[IT.QUAD, 'QUAD', '#5080ff'], [IT.INVULNERABILITY, 'PENT', '#ff4030'], [IT.INVISIBILITY, 'RING', '#c0c0c0']] as const) {
      if (items & bit) { d.fillCss(px, y, 40, 14, color); d.string(px + 4, y + 3, label); px += 44; }
    }
    // frags + rank, top right
    const me = st.rows.find((r) => r.me);
    if (me) {
      const rank = st.rows.indexOf(me) + 1;
      const lead = st.rows[0] && st.rows[0] !== me ? me.frags - st.rows[0].frags : st.rows[1] ? me.frags - st.rows[1].frags : 0;
      const text = `${me.frags}  #${rank}/${st.rows.length}  ${lead >= 0 ? '+' : ''}${lead}`;
      d.string(d.w - text.length * 8 - 6, 4, text);
    }
  }

  // ---------------------------------------------------------------- match clock and phases
  private matchClock(d: Draw2D, st: HudState): void {
    const m = st.match;
    if (!m) return;
    const mmss = (s: number): string => { const t = Math.max(0, Math.ceil(s)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
    let text = '';
    let alt = false;
    switch (m.phase) {
      case PHASE_WARMUP: text = 'WARMUP  -  F1 ready  F2 not ready'; alt = true; break;
      case PHASE_COUNTDOWN: {
        const n = Math.max(0, Math.ceil(m.left));
        const s = String(n);
        const sc = 4;
        d.string(Math.floor((d.w - s.length * 8 * sc) / 2), Math.floor(d.h * 0.25), s, true, this.gfx.chars, sc);
        text = 'match begins in'; alt = true;
        break;
      }
      case PHASE_PLAYING: text = m.left >= 0 ? mmss(m.left) : ''; break;
      case PHASE_OVERTIME: text = m.left >= 0 ? `OVERTIME ${mmss(m.left)}` : 'SUDDEN DEATH'; alt = true; break;
      case PHASE_ROUNDBREAK: text = `ROUND ${m.round}  ${m.score1} : ${m.score2}`; alt = true; break;
      case PHASE_INTERMISSION: return;
    }
    if (!text) return;
    const y = m.phase === PHASE_COUNTDOWN ? Math.floor(d.h * 0.25) - 12 : 4;
    d.string(Math.floor((d.w - text.length * 8) / 2), y, text, alt);
    if (st.teamplay && (m.phase === PHASE_PLAYING || m.phase === PHASE_OVERTIME)) {
      const sc = `${m.score1} : ${m.score2}`;
      d.string(Math.floor((d.w - sc.length * 8) / 2), y + 10, sc, true);
    }
  }

  private killFeed(d: Draw2D, now: number): void {
    if (!this.cvars.num('hud_killfeed')) return;
    this.kills = this.kills.filter((k) => now - k.at < 5000);
    let y = 16;
    for (const k of this.kills) {
      const text = k.killer && k.killer !== k.victim ? `${k.killer} [${k.weapon}] ${k.victim}` : `[${k.weapon}] ${k.victim}`;
      const x = d.w - text.length * 8 - 6;
      if (k.mine) d.fillCss(x - 2, y - 1, text.length * 8 + 4, 10, 'rgba(120,20,10,0.55)');
      d.string(x, y, text, k.mine);
      y += 10;
    }
  }

  /** SCR_DrawCenterString: lines centred, at 35 % of the height. */
  private centerString(d: Draw2D, now: number): void {
    const c = this.center;
    if (!c.lines.length || now > c.until) return;
    let y = c.lines.length <= 4 ? Math.floor(d.h * 0.35) : 48;
    for (const line of c.lines) {
      d.string(Math.floor((d.w - line.length * 8) / 2), y, line);
      y += 8;
    }
  }

  private noticeBox(d: Draw2D, text: string, low = false): void {
    const w = Math.min(36, text.length + 2);
    const x = Math.floor((d.w - (w + 2) * 8) / 2);
    const y = low ? Math.floor(d.h * 0.62) : Math.floor(d.h * 0.42);
    d.textBox(x, y, w, 1);
    d.string(x + 16, y + 8, text.slice(0, w));
  }

  private netInfo(d: Draw2D, st: HudState): void {
    const n = st.net;
    const lines: string[] = [];
    if (this.cvars.num('show_fps')) lines.push(`${Math.round(n.fps)} fps`);
    const show = this.cvars.num('show_net');
    if (show) {
      lines.push(`ping ${n.ping === null ? '-' : Math.round(n.ping)}  delay ${Math.round(n.delayMs)}ms  lead ${n.lead}`);
      lines.push(`rollbacks ${n.rollbacks}  mispred ${n.mispredictions}  desync ${n.desyncs}  starve ${n.starvations}`);
      lines.push(`sim ${n.stepUs.toFixed(0)}us/tick`);
    }
    if (this.cvars.num('show_speed') && st.cv) {
      const f = new Float32Array(st.cv.buffer, st.cv.byteOffset, st.cv.length);
      lines.push(`${Math.round(Math.hypot(f[CV.velocity], f[CV.velocity + 1]))} ups`);
    }
    let y = d.h - 24 - 8 * lines.length - (this.cvars.get('hud_layout') === 'modern' ? 0 : 26);
    for (const l of lines) { d.string(d.w - l.length * 8 - 2, y, l); y += 8; }
    if (show >= 2) {
      // the playout delay over the last 240 frames, ms (QW's net graph spirit)
      const gx = d.w - 244, gy = d.h - 90;
      d.fillCss(gx, gy - 40, 240, 40, 'rgba(0,0,0,0.4)');
      const ctx = d.ctx, s = d.s;
      ctx.fillStyle = '#7cfc6a';
      for (let i = 0; i < 240; i++) {
        const v = this.graph[(this.graphAt + i) % 240];
        const h = Math.min(40, v / 5);
        ctx.fillRect((gx + i) * s, (gy - h) * s, s, Math.max(1, h * s));
      }
    }
  }

  dispose(): void { this.canvas.remove(); }
}
