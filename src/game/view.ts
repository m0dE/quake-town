/*
 * Quake Town — player eye positioning: a port of QW's view.c (V_CalcRefdef,
 * V_CalcBob, V_CalcRoll, V_CalcViewRoll, V_ParseDamage, V_CalcBlend,
 * V_CalcPowerupCshift, V_CalcIntermissionRefdef, V_AddIdle).
 *
 * Copyright (C) 1996-1997 Id Software, Inc.
 * Copyright (C) 2026 Quake Town contributors.
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation; either version 2 of the License, or (at your option) any later version.
 *
 * One change of substance: QW advances bob, the damage kick, the screen tints
 * and the stair smoothing by `host_frametime`, a second clock. Here every one of
 * them advances by the DRAWN self clock (sim seconds between this frame's self
 * time and the last one's), so nothing on screen moves on anything but `view()`.
 */
import { CV, IT } from '../sim/abi.js';
import type { Cvars } from '../console/cvars.js';
import type { RenderCamera } from '../render/types.js';

const DEG = Math.PI / 180;

export interface SelfPose {
  /** Interpolated origin. */
  origin: [number, number, number];
  /** The later frame's velocity (the one that carried the body across the segment). */
  velocity: [number, number, number];
  onground: boolean;
  viewOfsZ: number;
  punchPitch: number;
  dead: boolean;
  gibbed: boolean;
  items: number;
  intermission: boolean;
  /** Sim's v_angle (for intermission / dead / spectating someone). */
  vAngle: [number, number, number];
}

export function angleVectors(angles: ArrayLike<number>, forward: number[], right: number[], up: number[]): void {
  const ay = angles[1] * DEG, ap = angles[0] * DEG, ar = angles[2] * DEG;
  const sy = Math.sin(ay), cy = Math.cos(ay), sp = Math.sin(ap), cp = Math.cos(ap), sr = Math.sin(ar), cr = Math.cos(ar);
  forward[0] = cp * cy; forward[1] = cp * sy; forward[2] = -sp;
  right[0] = -1 * sr * sp * cy + -1 * cr * -sy; right[1] = -1 * sr * sp * sy + -1 * cr * cy; right[2] = -1 * sr * cp;
  up[0] = cr * sp * cy + -sr * -sy; up[1] = cr * sp * sy + -sr * cy; up[2] = cr * cp;
}

interface Cshift { color: [number, number, number]; percent: number }

export class ViewCalc {
  private oldz = 0;
  private bob = 0;
  private dmgRoll = 0;
  private dmgPitch = 0;
  private dmgTime = 0;
  private readonly damage: Cshift = { color: [255, 0, 0], percent: 0 };
  private readonly bonus: Cshift = { color: [215, 186, 69], percent: 0 };
  private readonly powerup: Cshift = { color: [0, 0, 0], percent: 0 };
  private lastSelfTime = -1;
  /** Local kick (svc_smallkick / svc_bigkick events): decays 10°/s like QW's DropPunchAngle. */
  private kick = 0;
  private readonly fwd = [0, 0, 0];
  private readonly right = [0, 0, 0];
  private readonly up = [0, 0, 0];
  /** QW's v_blend, 0..1 rgba. */
  readonly blend: [number, number, number, number] = [0, 0, 0, 0];

  constructor(private readonly cvars: Cvars) {}

  reset(): void {
    this.oldz = 0; this.bob = 0; this.dmgTime = 0; this.damage.percent = 0; this.bonus.percent = 0; this.kick = 0; this.lastSelfTime = -1;
  }

  /** svc_damage (V_ParseDamage): `from` is the inflictor's origin, `simorg`/`angles` ours. */
  parseDamage(armor: number, blood: number, from: ArrayLike<number>, simorg: ArrayLike<number>, angles: ArrayLike<number>): void {
    let count = blood * 0.5 + armor * 0.5;
    if (count < 10) count = 10;
    const d = this.damage;
    d.percent = Math.max(0, Math.min(150, d.percent + 3 * count));
    if (armor > blood) d.color = [200, 100, 100];
    else if (armor) d.color = [220, 50, 50];
    else d.color = [255, 0, 0];
    const dir = [from[0] - simorg[0], from[1] - simorg[1], from[2] - simorg[2]];
    const len = Math.hypot(dir[0], dir[1], dir[2]);
    if (len > 0) { dir[0] /= len; dir[1] /= len; dir[2] /= len; }
    angleVectors(angles, this.fwd, this.right, this.up);
    this.dmgRoll = count * (dir[0] * this.right[0] + dir[1] * this.right[1] + dir[2] * this.right[2]) * this.cvars.num('v_kickroll');
    this.dmgPitch = count * (dir[0] * this.fwd[0] + dir[1] * this.fwd[1] + dir[2] * this.fwd[2]) * this.cvars.num('v_kickpitch');
    this.dmgTime = this.cvars.num('v_kicktime');
  }

  /** V_BonusFlash_f: the `bf` command (item pickups). */
  bonusFlash(): void { this.bonus.color = [215, 186, 69]; this.bonus.percent = 50; }

  /** svc_smallkick (-2) / svc_bigkick (-4). */
  punch(big: boolean): void { this.kick = big ? -4 : -2; }

  /**
   * V_CalcRefdef for one drawn frame. `selfTime` is the drawn self clock in sim
   * seconds; `angles` are the view angles the player is steering with.
   * Returns the gun bob (for the viewmodel).
   */
  calc(cam: RenderCamera, pose: SelfPose, angles: ArrayLike<number>, selfTime: number, spectator: boolean): number {
    let dt = this.lastSelfTime < 0 ? 0 : selfTime - this.lastSelfTime;
    if (dt < 0 || dt > 0.25) dt = 0;    // a reseat or a seek: no tint/kick decay jump
    this.lastSelfTime = selfTime;
    const c = this.cvars;
    const o = cam.origin, a = cam.angles;

    // tints decay (V_UpdatePalette)
    this.damage.percent = Math.max(0, this.damage.percent - dt * 150);
    this.bonus.percent = Math.max(0, this.bonus.percent - dt * 100);
    if (this.kick < 0) this.kick = Math.min(0, this.kick + 10 * dt);
    this.calcPowerup(pose.items);

    if (pose.intermission) {
      // V_CalcIntermissionRefdef: always idle
      o[0] = pose.origin[0]; o[1] = pose.origin[1]; o[2] = pose.origin[2];
      a[0] = pose.vAngle[0]; a[1] = pose.vAngle[1]; a[2] = pose.vAngle[2];
      a[2] += Math.sin(selfTime * 0.5) * 0.1;
      a[0] += Math.sin(selfTime * 1) * 0.3;
      a[1] += Math.sin(selfTime * 2) * 0.3;
      this.calcBlend();
      return 0;
    }

    // V_CalcBob, on the drawn clock (bobtime = sim time)
    let bob = this.bob;
    if (!spectator && pose.onground) {
      const cycleLen = c.num('cl_bobcycle') || 0.6;
      const up = c.num('cl_bobup');
      let cycle = (selfTime - Math.floor(selfTime / cycleLen) * cycleLen) / cycleLen;
      cycle = cycle < up ? (Math.PI * cycle) / up : Math.PI + (Math.PI * (cycle - up)) / (1 - up);
      bob = Math.hypot(pose.velocity[0], pose.velocity[1]) * c.num('cl_bob');
      bob = bob * 0.3 + bob * 0.7 * Math.sin(cycle);
      if (bob > 4) bob = 4; else if (bob < -7) bob = -7;
      this.bob = bob;
    } else if (spectator) bob = 0;

    o[0] = pose.origin[0] + 1 / 16;
    o[1] = pose.origin[1] + 1 / 16;
    o[2] = pose.origin[2] + bob + 1 / 16;

    a[0] = angles[0]; a[1] = angles[1]; a[2] = 0;
    // V_CalcViewRoll
    a[2] += this.calcRoll(angles, pose.velocity);
    if (this.dmgTime > 0) {
      const kt = c.num('v_kicktime') || 0.5;
      a[2] += (this.dmgTime / kt) * this.dmgRoll;
      a[0] += (this.dmgTime / kt) * this.dmgPitch;
      this.dmgTime -= dt;
    }

    if (pose.gibbed) o[2] += 8;
    else if (pose.dead) o[2] -= 16;
    else o[2] += pose.viewOfsZ || 22;
    if (pose.dead) a[2] = 80;

    // punch: the sim's punchangle plus the kick events
    a[0] += pose.punchPitch + this.kick;

    // smooth out stair step ups
    const z = pose.origin[2];
    if (pose.onground && z - this.oldz > 0 && z - this.oldz < 24) {
      this.oldz += dt * 80;
      if (this.oldz > z) this.oldz = z;
      if (z - this.oldz > 12) this.oldz = z - 12;
      o[2] += this.oldz - z;
    } else this.oldz = z;

    this.calcBlend();
    return bob;
  }

  /** The stair offset applied to the camera this frame (the gun takes it too). */
  get stepOffset(): number { return 0; }

  private calcRoll(angles: ArrayLike<number>, vel: ArrayLike<number>): number {
    angleVectors(angles, this.fwd, this.right, this.up);
    let side = vel[0] * this.right[0] + vel[1] * this.right[1] + vel[2] * this.right[2];
    const sign = side < 0 ? -1 : 1;
    side = Math.abs(side);
    const value = this.cvars.num('cl_rollangle');
    const speed = this.cvars.num('cl_rollspeed') || 200;
    side = side < speed ? (side * value) / speed : value;
    return side * sign;
  }

  private calcPowerup(items: number): void {
    const p = this.powerup;
    if (items & IT.QUAD) { p.color = [0, 0, 255]; p.percent = 30; }
    else if (items & IT.SUIT) { p.color = [0, 255, 0]; p.percent = 20; }
    else if (items & IT.INVISIBILITY) { p.color = [100, 100, 100]; p.percent = 100; }
    else if (items & IT.INVULNERABILITY) { p.color = [255, 255, 0]; p.percent = 30; }
    else p.percent = 0;
  }

  /** V_CalcBlend over damage, bonus, powerup (the liquid tint is the renderer's). */
  private calcBlend(): void {
    let r = 0, g = 0, b = 0, a = 0;
    const scale = this.cvars.num('gl_polyblend') === 0 ? 0 : (this.cvars.has('gl_cshiftpercent') ? this.cvars.num('gl_cshiftpercent') : 100);
    for (const s of [this.damage, this.bonus, this.powerup]) {
      let a2 = ((s.percent * scale) / 100) / 255;
      if (!a2) continue;
      a = a + a2 * (1 - a);
      a2 = a2 / a;
      r = r * (1 - a2) + s.color[0] * a2;
      g = g * (1 - a2) + s.color[1] * a2;
      b = b * (1 - a2) + s.color[2] * a2;
    }
    this.blend[0] = r / 255; this.blend[1] = g / 255; this.blend[2] = b / 255;
    this.blend[3] = Math.max(0, Math.min(1, a));
  }
}

/** Read a SelfPose out of a ClientView pair at `frac`. */
export function poseFrom(a: Int32Array, b: Int32Array, frac: number, out: SelfPose): SelfPose {
  const fa = new Float32Array(a.buffer, a.byteOffset, a.length);
  const fb = new Float32Array(b.buffer, b.byteOffset, b.length);
  // A teleport (respawn, teleporter) is a cut, never a line across the map.
  const jump = Math.abs(fb[CV.origin] - fa[CV.origin]) > 64 || Math.abs(fb[CV.origin + 1] - fa[CV.origin + 1]) > 64 || Math.abs(fb[CV.origin + 2] - fa[CV.origin + 2]) > 64;
  const k = jump ? (frac < 0.5 ? 0 : 1) : frac;
  for (let i = 0; i < 3; i++) {
    out.origin[i] = fa[CV.origin + i] + (fb[CV.origin + i] - fa[CV.origin + i]) * k;
    out.velocity[i] = fb[CV.velocity + i];
    out.vAngle[i] = lerpAngle(fa[CV.vAngle + i], fb[CV.vAngle + i], k);
  }
  out.viewOfsZ = fa[CV.viewOfsZ] + (fb[CV.viewOfsZ] - fa[CV.viewOfsZ]) * k;
  out.punchPitch = fa[CV.punch] + (fb[CV.punch] - fa[CV.punch]) * k;
  const cur = k < 0.5 ? a : b;
  out.onground = cur[CV.onground] !== 0;
  out.dead = cur[CV.deadflag] !== 0;
  out.gibbed = out.dead && cur[CV.health] < -40;
  out.items = cur[CV.items];
  out.intermission = cur[CV.intermission] !== 0;
  return out;
}

export function newPose(): SelfPose {
  return { origin: [0, 0, 0], velocity: [0, 0, 0], onground: true, viewOfsZ: 22, punchPitch: 0, dead: false, gibbed: false, items: 0, intermission: false, vAngle: [0, 0, 0] };
}

/** Shortest-way interpolation of angles in degrees. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  d -= Math.round(d / 360) * 360;
  return a + d * t;
}
