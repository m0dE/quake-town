/*
 * Quake Town — the classic status bar and scoreboards: a port of QW's sbar.c
 * (Sbar_DrawNormal, Sbar_DrawInventory, Sbar_DrawFrags, Sbar_DrawFace,
 * Sbar_DrawNum, Sbar_DeathmatchOverlay, Sbar_TeamOverlay, Sbar_MiniDeathmatchOverlay).
 *
 * Copyright (C) 1996-1997 Id Software, Inc.
 * Copyright (C) 2026 Quake Town contributors.
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation; either version 2 of the License, or (at your option) any later version.
 */
import { CV, IT, ST } from '../sim/abi.js';
import { Gfx, type Draw2D, type Pic } from './gfx.js';

/** One scoreboard line, built by the game from ClientRows + userinfo + pings. */
export interface PlayerRow {
  slot: number;
  name: string;
  team: string;
  top: number;
  bottom: number;
  frags: number;
  ping: number;
  bot: boolean;
  me: boolean;
  /** 24 qt stats (ClientRow words 8..31) */
  stats: ArrayLike<number>;
  /** sim seconds the player has been in, for the `time` column (minutes) */
  minutes: number;
}

export interface TeamRow { team: string; frags: number; players: number; ping: number; mine: boolean; top: number; bottom: number }

const WEAPON_NAMES = ['shotgun', 'sshotgun', 'nailgun', 'snailgun', 'rlaunch', 'srlaunch', 'lightng'];

export class Sbar {
  private nums: (Pic | null)[][] = [[], []];
  private weapons: (Pic | null)[][] = [];
  private ammo: (Pic | null)[] = [];
  private armor: (Pic | null)[] = [];
  private items: (Pic | null)[] = [];
  private sigils: (Pic | null)[] = [];
  private faces: (Pic | null)[][] = [];
  private faceInvis: Pic | null; private faceInvuln: Pic | null; private faceInvisInvuln: Pic | null; private faceQuad: Pic | null;
  private sbar: Pic | null; private ibar: Pic | null; private scorebar: Pic | null; private disc: Pic | null;
  /** IT_ bit → the sim time it was picked up (inventory flash). */
  private readonly gotAt = new Map<number, number>();
  private lastItems = 0;

  constructor(private readonly gfx: Gfx) {
    const w = (n: string): Pic | null => gfx.wadPic(n);
    for (let i = 0; i < 10; i++) { this.nums[0][i] = w(`num_${i}`); this.nums[1][i] = w(`anum_${i}`); }
    this.nums[0][10] = w('num_minus'); this.nums[1][10] = w('anum_minus');
    this.weapons[0] = WEAPON_NAMES.map((n) => w(`inv_${n}`));
    this.weapons[1] = WEAPON_NAMES.map((n) => w(`inv2_${n}`));
    for (let i = 0; i < 5; i++) this.weapons[2 + i] = WEAPON_NAMES.map((n) => w(`inva${i + 1}_${n}`));
    this.ammo = ['sb_shells', 'sb_nails', 'sb_rocket', 'sb_cells'].map(w);
    this.armor = ['sb_armor1', 'sb_armor2', 'sb_armor3'].map(w);
    this.items = ['sb_key1', 'sb_key2', 'sb_invis', 'sb_invuln', 'sb_suit', 'sb_quad'].map(w);
    this.sigils = ['sb_sigil1', 'sb_sigil2', 'sb_sigil3', 'sb_sigil4'].map(w);
    for (let f = 0; f < 5; f++) this.faces[4 - f] = [w(`face${f + 1}`), w(`face_p${f + 1}`)];
    this.faceInvis = w('face_invis'); this.faceInvuln = w('face_invul2'); this.faceInvisInvuln = w('face_inv2'); this.faceQuad = w('face_quad');
    this.sbar = w('sbar'); this.ibar = w('ibar'); this.scorebar = w('scorebar'); this.disc = w('disc');
  }

  get ok(): boolean { return !!this.sbar; }

  /** Track pickups for the weapon flash (QW cl.item_gettime). */
  noteItems(items: number, time: number): void {
    const got = items & ~this.lastItems;
    if (got) for (let b = 0; b < 32; b++) if (got & (1 << b)) this.gotAt.set(1 << b, time);
    this.lastItems = items;
  }

  /** Sbar_DrawNum */
  private num(d: Draw2D, x: number, y: number, n: number, digits: number, color: number): void {
    let s = String(Math.trunc(n));
    if (s.length > digits) s = s.slice(s.length - digits);
    if (s.length < digits) x += (digits - s.length) * 24;
    for (const ch of s) {
      d.pic(x, y, this.nums[color][ch === '-' ? 10 : ch.charCodeAt(0) - 48]);
      x += 24;
    }
  }

  /**
   * The whole bar at the bottom centre. `ox` = left of the 320-wide bar, `by` = top of
   * the 24-high main bar (the inventory is the 24 lines above it).
   */
  draw(d: Draw2D, cv: Int32Array, time: number, faceAnim: boolean, frags: PlayerRow[], viewsize: number, hudswap: boolean): void {
    const ox = Math.floor((d.w - 320) / 2);
    const by = d.h - 24;
    const items = cv[CV.items];
    this.noteItems(items, time);
    const headsup = viewsize >= 110;
    // inventory
    if (viewsize < 120) {
      if (!headsup) d.pic(ox, by - 24, this.ibar);
      for (let i = 0; i < 7; i++) {
        if (!(items & (IT.SHOTGUN << i))) continue;
        const t = this.gotAt.get(IT.SHOTGUN << i) ?? -100;
        let flash = Math.floor((time - t) * 10);
        if (flash < 0) flash = 0;
        if (flash >= 10) flash = cv[CV.weapon] === IT.SHOTGUN << i ? 1 : 0;
        else flash = (flash % 5) + 2;
        if (headsup) d.subPic(hudswap ? 0 : d.w - 24, by - 68 - (7 - i) * 16, this.weapons[flash][i], 0, 0, 24, 16);
        else d.pic(ox + i * 24, by - 16, this.weapons[flash][i]);
      }
      for (let i = 0; i < 4; i++) {
        const v = String(Math.max(0, Math.min(999, cv[CV.shells + i]))).padStart(3, ' ');
        if (headsup) {
          const hx = hudswap ? 0 : d.w - 42, hy = by - 24 - (4 - i) * 11;
          d.subPic(hx, hy, this.ibar, 3 + i * 48, 0, 42, 11);
          for (let k = 0; k < 3; k++) if (v[k] !== ' ') d.char(hx + 3 + k * 8, hy, 18 + v.charCodeAt(k) - 48);
        } else {
          for (let k = 0; k < 3; k++) if (v[k] !== ' ') d.char(ox + (6 * i + 1 + k) * 8 - 2, by - 24, 18 + v.charCodeAt(k) - 48);
        }
      }
      for (let i = 0; i < 6; i++) if (items & (1 << (17 + i))) d.pic(ox + 192 + i * 16, by - 16, this.items[i]);
      for (let i = 0; i < 4; i++) if (items & (1 << (28 + i))) d.pic(ox + 320 - 32 + i * 8, by - 16, this.sigils[i]);
      if (!headsup) this.drawFrags(d, ox, by, frags);
    }
    // main bar
    d.pic(ox, by, this.sbar);
    if (items & IT.INVULNERABILITY) { this.num(d, ox + 24, by, 666, 3, 1); d.pic(ox, by, this.disc); }
    else {
      const armor = cv[CV.armor];
      this.num(d, ox + 24, by, armor, 3, armor <= 25 ? 1 : 0);
      if (items & IT.ARMOR3) d.pic(ox, by, this.armor[2]);
      else if (items & IT.ARMOR2) d.pic(ox, by, this.armor[1]);
      else if (items & IT.ARMOR1) d.pic(ox, by, this.armor[0]);
    }
    this.face(d, ox + 112, by, cv, faceAnim);
    const health = cv[CV.health];
    this.num(d, ox + 136, by, health, 3, health <= 25 ? 1 : 0);
    const ammoIcon = items & IT.SHELLS ? 0 : items & IT.NAILS ? 1 : items & IT.ROCKETS ? 2 : items & IT.CELLS ? 3 : -1;
    if (ammoIcon >= 0) d.pic(ox + 224, by, this.ammo[ammoIcon]);
    const ammo = cv[CV.currentammo];
    this.num(d, ox + 248, by, ammo, 3, ammo <= 10 ? 1 : 0);
    // wider screens: the mini scoreboard to the right of the bar (Sbar_MiniDeathmatchOverlay)
    if (d.w >= 512 && !headsup) this.mini(d, ox + 324, by - 24, frags);
  }

  /** The spectator bar (scorebar + text). */
  drawSpectator(d: Draw2D, line1: string, line2: string): void {
    const ox = Math.floor((d.w - 320) / 2);
    const by = d.h - 24;
    d.pic(ox, by, this.scorebar);
    d.string(ox + 160 - line1.length * 4, by + 4, line1);
    d.string(ox + 160 - line2.length * 4, by + 12, line2);
  }

  private face(d: Draw2D, x: number, y: number, cv: Int32Array, anim: boolean): void {
    const items = cv[CV.items];
    if ((items & (IT.INVISIBILITY | IT.INVULNERABILITY)) === (IT.INVISIBILITY | IT.INVULNERABILITY)) { d.pic(x, y, this.faceInvisInvuln); return; }
    if (items & IT.QUAD) { d.pic(x, y, this.faceQuad); return; }
    if (items & IT.INVISIBILITY) { d.pic(x, y, this.faceInvis); return; }
    if (items & IT.INVULNERABILITY) { d.pic(x, y, this.faceInvuln); return; }
    const h = cv[CV.health];
    const f = h >= 100 ? 4 : Math.max(0, Math.floor(h / 20));
    d.pic(x, y, this.faces[f]?.[anim ? 1 : 0] ?? null);
  }

  /** Sbar_DrawFrags: the top four in the inventory bar. */
  private drawFrags(d: Draw2D, ox: number, by: number, rows: PlayerRow[]): void {
    let x = 23;
    const y = by - 23;
    for (let i = 0; i < Math.min(4, rows.length); i++) {
      const s = rows[i];
      d.fill(ox + x * 8 + 10, y, 28, 4, Gfx.rowColor(s.top));
      d.fill(ox + x * 8 + 10, y + 4, 28, 3, Gfx.rowColor(s.bottom));
      const num = String(s.frags).padStart(3, ' ').slice(-3);
      for (let k = 0; k < 3; k++) d.char(ox + (x + 1 + k) * 8, by - 24, num.charCodeAt(k));
      if (s.me) { d.char(ox + x * 8 + 2, by - 24, 16); d.char(ox + (x + 4) * 8 - 4, by - 24, 17); }
      x += 4;
    }
  }

  private mini(d: Draw2D, x: number, top: number, rows: PlayerRow[]): void {
    const lines = 6;
    let i = Math.max(0, rows.findIndex((r) => r.me) - (lines >> 1));
    if (i > rows.length - lines) i = Math.max(0, rows.length - lines);
    let y = top;
    for (; i < rows.length && y < d.h - 7; i++) {
      const s = rows[i];
      d.fill(x, y + 1, 40, 3, Gfx.rowColor(s.top));
      d.fill(x, y + 4, 40, 4, Gfx.rowColor(s.bottom));
      const num = String(s.frags).padStart(3, ' ').slice(-3);
      for (let k = 0; k < 3; k++) d.char(x + 8 + k * 8, y, num.charCodeAt(k));
      if (s.me) { d.char(x, y, 16); d.char(x + 32, y, 17); }
      d.string(x + 48, y, s.name.slice(0, 16));
      y += 8;
    }
  }

  /**
   * Sbar_DeathmatchOverlay (+showscores) with Quake Town's extra columns:
   * ping, frags, deaths, efficiency, team.
   */
  scoreboard(d: Draw2D, rows: PlayerRow[], teams: TeamRow[], teamplay: boolean, title: string): void {
    const ranking = this.gfx.lmp('gfx/ranking.lmp');
    if (ranking) d.pic(Math.floor((d.w - ranking.w) / 2), 0, ranking);
    const width = teamplay ? 44 : 39;
    const x = Math.floor((d.w - width * 8) / 2);
    let y = ranking ? 24 : 8;
    if (title) { d.string(Math.floor((d.w - title.length * 8) / 2), y, title, true); y += 12; }
    const head = teamplay ? 'ping frags dths eff  team name' : 'ping frags dths eff  name';
    d.string(x, y, head); y += 8;
    const rule = (n: number): string => `\x1d${'\x1e'.repeat(Math.max(0, n - 2))}\x1f`;
    d.string(x, y, [rule(4), rule(5), rule(4), rule(4), ...(teamplay ? [rule(4)] : []), rule(16)].join(' ')); y += 8;
    const skip = rows.length > 16 ? 8 : 10;
    for (const s of rows) {
      if (y > d.h - 10) break;
      d.string(x, y, String(Math.min(999, Math.max(0, s.ping))).padStart(4, ' '));
      d.fill(x + 40, y, 40, 4, Gfx.rowColor(s.top));
      d.fill(x + 40, y + 4, 40, 4, Gfx.rowColor(s.bottom));
      d.string(x + 48, y, String(s.frags).padStart(3, ' ').slice(-3));
      if (s.me) { d.char(x + 40, y, 16); d.char(x + 72, y, 17); }
      d.string(x + 88, y, String(s.stats[ST.deaths] ?? 0).padStart(4, ' '));
      const eff = Math.round((s.stats[ST.eff] ?? 0) / 100);
      d.string(x + 128, y, `${String(eff).padStart(3, ' ')}%`);
      let nx = x + 168;
      if (teamplay) { d.string(nx, y, s.team.slice(0, 4)); nx += 40; }
      d.string(nx, y, s.name.slice(0, 16) + (s.bot ? ' \x8a' : ''), s.me);
      y += skip;
    }
    if (teamplay && teams.length) {
      y += 8;
      d.string(x, y, 'team  frags players ping'); y += 8;
      for (const t of teams) {
        d.fill(x, y, 32, 4, Gfx.rowColor(t.top)); d.fill(x, y + 4, 32, 4, Gfx.rowColor(t.bottom));
        d.string(x, y, t.team.slice(0, 4).padEnd(4, ' '), t.mine);
        d.string(x + 48, y, String(t.frags).padStart(5, ' '));
        d.string(x + 104, y, String(t.players).padStart(4, ' '));
        d.string(x + 152, y, String(t.ping).padStart(4, ' '));
        y += 10;
      }
    }
  }

  /** The intermission match stats screen (frags, deaths, accuracy per weapon, pickups). */
  matchStats(d: Draw2D, rows: PlayerRow[], teams: TeamRow[], teamplay: boolean, headline: string): void {
    const complete = this.gfx.lmp('gfx/complete.lmp');
    let y = 8;
    if (complete) { d.pic(Math.floor((d.w - complete.w) / 2), y, complete); y += complete.h + 8; }
    if (headline) { d.string(Math.floor((d.w - headline.length * 8) / 2), y, headline, true); y += 16; }
    if (teamplay && teams.length) {
      const line = teams.map((t) => `${t.team.slice(0, 8)} ${t.frags}`).join('  vs  ');
      d.string(Math.floor((d.w - line.length * 8) / 2), y, line); y += 16;
    }
    const cols = 'name             frg dth eff  dmg+  dmg-  RL%  LG%  SG% SSG%  GL%  RA YA GA MH  Q  P';
    const x = Math.max(0, Math.floor((d.w - cols.length * 8) / 2));
    d.string(x, y, cols, true); y += 10;
    const pct = (hits: number, shots: number): string => (shots > 0 ? `${Math.round((hits * 100) / shots)}`.padStart(4, ' ') : '   -');
    for (const s of rows) {
      if (y > d.h - 10) break;
      const st = s.stats;
      d.fill(x - 4, y + 2, 2, 4, Gfx.rowColor(s.top));
      const text = `${s.name.slice(0, 16).padEnd(16, ' ')} ${String(s.frags).padStart(3, ' ')} ${String(st[ST.deaths] ?? 0).padStart(3, ' ')} ${String(Math.round((st[ST.eff] ?? 0) / 100)).padStart(3, ' ')}% ${String(st[ST.dmgGiven] ?? 0).padStart(5, ' ')} ${String(st[ST.dmgTaken] ?? 0).padStart(5, ' ')}`
        + ` ${pct(st[ST.rlHits], st[ST.rlShots])} ${pct(st[ST.lgHits], st[ST.lgShots])} ${pct(st[ST.sgHits], st[ST.sgShots])} ${pct(st[ST.ssgHits], st[ST.ssgShots])} ${pct(st[ST.glHits], st[ST.glShots])}`
        + `  ${String(st[ST.ra] ?? 0).padStart(2, ' ')} ${String(st[ST.ya] ?? 0).padStart(2, ' ')} ${String(st[ST.ga] ?? 0).padStart(2, ' ')} ${String(st[ST.mh] ?? 0).padStart(2, ' ')} ${String(st[ST.quad] ?? 0).padStart(2, ' ')} ${String(st[ST.pent] ?? 0).padStart(2, ' ')}`;
      d.string(x, y, text, s.me);
      y += 9;
    }
  }
}
