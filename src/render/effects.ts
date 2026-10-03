// Client-side effects: particles (R_ParticleExplosion, R_BlobExplosion, R_RunParticleEffect,
// R_LavaSplash, R_TeleportSplash, R_RocketTrail, R_DrawParticles physics), dynamic lights
// (CL_AllocDlight / CL_NewDlight / CL_DecayLights), explosion sprites and lightning beams
// (CL_ParseTEnt, CL_ParseBeam, CL_UpdateBeams, CL_UpdateExplosions).
// Ported from QW/client/r_part.c, cl_tent.c, cl_ents.c, cl_main.c.
// Copyright (C) 1996-1997 Id Software, Inc. Copyright (C) 2026 Quake Town contributors.
//
// This program is free software; you can redistribute it and/or modify it under the terms
// of the GNU General Public License as published by the Free Software Foundation; either
// version 2 of the License, or (at your option) any later version.
//
// Everything here is client-side cosmetics: it uses Math.random like QW used rand(), and
// never feeds back into the sim. Storage is preallocated (no allocation per frame).

const ramp1 = [0x6f, 0x6d, 0x6b, 0x69, 0x67, 0x65, 0x63, 0x61];
const ramp2 = [0x6f, 0x6e, 0x6d, 0x6c, 0x6b, 0x6a, 0x68, 0x66];
const ramp3 = [0x6d, 0x6b, 6, 5, 4, 3];

export const PT_STATIC = 0, PT_GRAV = 1, PT_SLOWGRAV = 2, PT_FIRE = 3, PT_EXPLODE = 4, PT_EXPLODE2 = 5, PT_BLOB = 6, PT_BLOB2 = 7;

function rand(): number { return (Math.random() * 0x8000) | 0; }

export class Particles {
  readonly max: number;
  readonly org: Float32Array;
  readonly vel: Float32Array;
  readonly color: Uint8Array;
  readonly ramp: Float32Array;
  readonly die: Float32Array;
  readonly type: Uint8Array;
  count = 0;
  private tracercount = 0;
  private time = 0;

  constructor(max = 4096) {
    this.max = max;
    this.org = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.color = new Uint8Array(max);
    this.ramp = new Float32Array(max);
    this.die = new Float32Array(max);
    this.type = new Uint8Array(max);
  }

  clear(): void { this.count = 0; }

  private alloc(): number {
    if (this.count >= this.max) return -1;
    const i = this.count++;
    this.vel[i * 3] = this.vel[i * 3 + 1] = this.vel[i * 3 + 2] = 0;
    this.ramp[i] = 0;
    return i;
  }

  setTime(t: number): void { this.time = t; }

  explosion(x: number, y: number, z: number): void {
    for (let i = 0; i < 1024; i++) {
      const p = this.alloc();
      if (p < 0) return;
      this.die[p] = this.time + 5;
      this.color[p] = ramp1[0];
      this.ramp[p] = rand() & 3;
      this.type[p] = i & 1 ? PT_EXPLODE : PT_EXPLODE2;
      this.org[p * 3] = x + ((rand() % 32) - 16); this.vel[p * 3] = (rand() % 512) - 256;
      this.org[p * 3 + 1] = y + ((rand() % 32) - 16); this.vel[p * 3 + 1] = (rand() % 512) - 256;
      this.org[p * 3 + 2] = z + ((rand() % 32) - 16); this.vel[p * 3 + 2] = (rand() % 512) - 256;
    }
  }

  blobExplosion(x: number, y: number, z: number): void {
    for (let i = 0; i < 1024; i++) {
      const p = this.alloc();
      if (p < 0) return;
      this.die[p] = this.time + 1 + (rand() & 8) * 0.05;
      if (i & 1) { this.type[p] = PT_BLOB; this.color[p] = 66 + (rand() % 6); }
      else { this.type[p] = PT_BLOB2; this.color[p] = 150 + (rand() % 6); }
      this.org[p * 3] = x + ((rand() % 32) - 16); this.vel[p * 3] = (rand() % 512) - 256;
      this.org[p * 3 + 1] = y + ((rand() % 32) - 16); this.vel[p * 3 + 1] = (rand() % 512) - 256;
      this.org[p * 3 + 2] = z + ((rand() % 32) - 16); this.vel[p * 3 + 2] = (rand() % 512) - 256;
    }
  }

  runEffect(x: number, y: number, z: number, dx: number, dy: number, dz: number, color: number, count: number): void {
    const scale = count > 130 ? 3 : count > 20 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const p = this.alloc();
      if (p < 0) return;
      this.die[p] = this.time + 0.1 * (rand() % 5);
      this.color[p] = (color & ~7) + (rand() & 7);
      this.type[p] = PT_GRAV;
      this.org[p * 3] = x + scale * ((rand() & 15) - 8); this.vel[p * 3] = dx * 15;
      this.org[p * 3 + 1] = y + scale * ((rand() & 15) - 8); this.vel[p * 3 + 1] = dy * 15;
      this.org[p * 3 + 2] = z + scale * ((rand() & 15) - 8); this.vel[p * 3 + 2] = dz * 15;
    }
  }

  lavaSplash(x: number, y: number, z: number): void {
    for (let i = -16; i < 16; i++) for (let j = -16; j < 16; j++) {
      const p = this.alloc();
      if (p < 0) return;
      this.die[p] = this.time + 2 + (rand() & 31) * 0.02;
      this.color[p] = 224 + (rand() & 7);
      this.type[p] = PT_GRAV;
      let d0 = j * 8 + (rand() & 7), d1 = i * 8 + (rand() & 7), d2 = 256;
      this.org[p * 3] = x + d0; this.org[p * 3 + 1] = y + d1; this.org[p * 3 + 2] = z + (rand() & 63);
      const l = Math.hypot(d0, d1, d2) || 1;
      d0 /= l; d1 /= l; d2 /= l;
      const vel = 50 + (rand() & 63);
      this.vel[p * 3] = d0 * vel; this.vel[p * 3 + 1] = d1 * vel; this.vel[p * 3 + 2] = d2 * vel;
    }
  }

  teleportSplash(x: number, y: number, z: number): void {
    for (let i = -16; i < 16; i += 4) for (let j = -16; j < 16; j += 4) for (let k = -24; k < 32; k += 4) {
      const p = this.alloc();
      if (p < 0) return;
      this.die[p] = this.time + 0.2 + (rand() & 7) * 0.02;
      this.color[p] = 7 + (rand() & 7);
      this.type[p] = PT_GRAV;
      let d0 = j * 8, d1 = i * 8, d2 = k * 8;
      this.org[p * 3] = x + i + (rand() & 3); this.org[p * 3 + 1] = y + j + (rand() & 3); this.org[p * 3 + 2] = z + k + (rand() & 3);
      const l = Math.hypot(d0, d1, d2) || 1;
      d0 /= l; d1 /= l; d2 /= l;
      const vel = 50 + (rand() & 63);
      this.vel[p * 3] = d0 * vel; this.vel[p * 3 + 1] = d1 * vel; this.vel[p * 3 + 2] = d2 * vel;
    }
  }

  /** R_RocketTrail: 0 rocket, 1 grenade smoke, 2 blood, 3 tracer, 4 slight blood, 5 tracer2, 6 voor trail */
  trail(sx: number, sy: number, sz: number, ex: number, ey: number, ez: number, type: number): void {
    let vx = ex - sx, vy = ey - sy, vz = ez - sz;
    let len = Math.hypot(vx, vy, vz);
    if (len <= 0) return;
    vx /= len; vy /= len; vz /= len;
    while (len > 0) {
      len -= 3;
      const p = this.alloc();
      if (p < 0) return;
      this.die[p] = this.time + 2;
      const o = p * 3;
      if (type === 4 || type === 2) {
        this.type[p] = PT_SLOWGRAV;
        this.color[p] = 67 + (rand() & 3);
        this.org[o] = sx + ((rand() % 6) - 3); this.org[o + 1] = sy + ((rand() % 6) - 3); this.org[o + 2] = sz + ((rand() % 6) - 3);
        if (type === 4) len -= 3;
      } else if (type === 6) {
        this.color[p] = 9 * 16 + 8 + (rand() & 3);
        this.type[p] = PT_STATIC;
        this.die[p] = this.time + 0.3;
        this.org[o] = sx + ((rand() & 15) - 8); this.org[o + 1] = sy + ((rand() & 15) - 8); this.org[o + 2] = sz + ((rand() & 15) - 8);
      } else if (type === 1 || type === 0) {
        this.ramp[p] = (rand() & 3) + (type === 1 ? 2 : 0);
        this.color[p] = ramp3[this.ramp[p] | 0];
        this.type[p] = PT_FIRE;
        this.org[o] = sx + ((rand() % 6) - 3); this.org[o + 1] = sy + ((rand() % 6) - 3); this.org[o + 2] = sz + ((rand() % 6) - 3);
      } else if (type === 3 || type === 5) {
        this.die[p] = this.time + 0.5;
        this.type[p] = PT_STATIC;
        this.color[p] = (type === 3 ? 52 : 230) + ((this.tracercount & 4) << 1);
        this.tracercount++;
        this.org[o] = sx; this.org[o + 1] = sy; this.org[o + 2] = sz;
        if (this.tracercount & 1) { this.vel[o] = 30 * vy; this.vel[o + 1] = 30 * -vx; }
        else { this.vel[o] = 30 * -vy; this.vel[o + 1] = 30 * vx; }
      }
      sx += vx * 3; sy += vy * 3; sz += vz * 3;
    }
  }

  /** R_DrawParticles' physics step, removing dead particles (swap with last). */
  update(time: number, frametime: number): void {
    this.time = time;
    const time3 = frametime * 15, time2 = frametime * 10, time1 = frametime * 5;
    const grav = frametime * 800 * 0.05;
    const dvel = 4 * frametime;
    let i = 0;
    while (i < this.count) {
      if (this.die[i] < time) { this.kill(i); continue; }
      const o = i * 3;
      this.org[o] += this.vel[o] * frametime;
      this.org[o + 1] += this.vel[o + 1] * frametime;
      this.org[o + 2] += this.vel[o + 2] * frametime;
      switch (this.type[i]) {
        case PT_FIRE:
          this.ramp[i] += time1;
          if (this.ramp[i] >= 6) this.die[i] = -1; else this.color[i] = ramp3[this.ramp[i] | 0];
          this.vel[o + 2] += grav;
          break;
        case PT_EXPLODE:
          this.ramp[i] += time2;
          if (this.ramp[i] >= 8) this.die[i] = -1; else this.color[i] = ramp1[this.ramp[i] | 0];
          this.vel[o] += this.vel[o] * dvel; this.vel[o + 1] += this.vel[o + 1] * dvel; this.vel[o + 2] += this.vel[o + 2] * dvel;
          this.vel[o + 2] -= grav;
          break;
        case PT_EXPLODE2:
          this.ramp[i] += time3;
          if (this.ramp[i] >= 8) this.die[i] = -1; else this.color[i] = ramp2[this.ramp[i] | 0];
          this.vel[o] -= this.vel[o] * frametime; this.vel[o + 1] -= this.vel[o + 1] * frametime; this.vel[o + 2] -= this.vel[o + 2] * frametime;
          this.vel[o + 2] -= grav;
          break;
        case PT_BLOB:
          this.vel[o] += this.vel[o] * dvel; this.vel[o + 1] += this.vel[o + 1] * dvel; this.vel[o + 2] += this.vel[o + 2] * dvel;
          this.vel[o + 2] -= grav;
          break;
        case PT_BLOB2:
          this.vel[o] -= this.vel[o] * dvel; this.vel[o + 1] -= this.vel[o + 1] * dvel;
          this.vel[o + 2] -= grav;
          break;
        case PT_SLOWGRAV:
        case PT_GRAV:
          this.vel[o + 2] -= grav;
          break;
      }
      i++;
    }
  }

  private kill(i: number): void {
    const last = --this.count;
    if (i === last) return;
    this.org[i * 3] = this.org[last * 3]; this.org[i * 3 + 1] = this.org[last * 3 + 1]; this.org[i * 3 + 2] = this.org[last * 3 + 2];
    this.vel[i * 3] = this.vel[last * 3]; this.vel[i * 3 + 1] = this.vel[last * 3 + 1]; this.vel[i * 3 + 2] = this.vel[last * 3 + 2];
    this.color[i] = this.color[last]; this.ramp[i] = this.ramp[last]; this.die[i] = this.die[last]; this.type[i] = this.type[last];
  }
}

// ---------------------------------------------------------------------------------------- dlights

export const MAX_DLIGHT_SLOTS = 64;

/** dlight colour types of CL_NewDlight: 0 orange (rockets, explosions, muzzle), 1 blue, 2 red, 3 purple */
export const DL_COLORS = [
  [0.2, 0.1, 0.05], [0.05, 0.05, 0.3], [0.5, 0.05, 0.05], [0.5, 0.05, 0.4],
];
/** Colours the modern renderer lights with (QW lit the world white) */
export const DL_LIGHT_COLORS = [
  [1.0, 0.78, 0.5], [0.35, 0.45, 1.6], [1.6, 0.35, 0.3], [1.2, 0.35, 1.3],
];

export class Dlights {
  readonly key = new Int32Array(MAX_DLIGHT_SLOTS);
  readonly origin = new Float32Array(MAX_DLIGHT_SLOTS * 3);
  readonly radius = new Float32Array(MAX_DLIGHT_SLOTS);
  readonly die = new Float32Array(MAX_DLIGHT_SLOTS);
  readonly decay = new Float32Array(MAX_DLIGHT_SLOTS);
  readonly minlight = new Float32Array(MAX_DLIGHT_SLOTS);
  readonly type = new Uint8Array(MAX_DLIGHT_SLOTS);
  time = 0;

  clear(): void { this.die.fill(0); this.radius.fill(0); this.key.fill(0); }

  /** CL_AllocDlight: reuse the slot with the same key, else a dead one, else slot 0. */
  alloc(key: number): number {
    if (key) for (let i = 0; i < MAX_DLIGHT_SLOTS; i++) if (this.key[i] === key) return this.reset(i, key);
    for (let i = 0; i < MAX_DLIGHT_SLOTS; i++) if (this.die[i] < this.time || this.radius[i] <= 0) return this.reset(i, key);
    return this.reset(0, key);
  }

  private reset(i: number, key: number): number {
    this.key[i] = key; this.decay[i] = 0; this.minlight[i] = 0; this.type[i] = 0;
    return i;
  }

  set(key: number, x: number, y: number, z: number, radius: number, life: number, type: number, decay = 0, minlight = 0): void {
    const i = this.alloc(key);
    this.origin[i * 3] = x; this.origin[i * 3 + 1] = y; this.origin[i * 3 + 2] = z;
    this.radius[i] = radius; this.die[i] = this.time + life; this.type[i] = type; this.decay[i] = decay; this.minlight[i] = minlight;
  }

  /** CL_DecayLights */
  update(time: number, frametime: number): void {
    this.time = time;
    for (let i = 0; i < MAX_DLIGHT_SLOTS; i++) {
      if (this.die[i] < time || this.radius[i] <= 0) continue;
      this.radius[i] -= frametime * this.decay[i];
      if (this.radius[i] < 0) this.radius[i] = 0;
    }
  }

  alive(i: number): boolean { return this.die[i] >= this.time && this.radius[i] > 0; }
}

// ---------------------------------------------------------------------------------------- tents

export const MAX_BEAMS = 8;
export const MAX_EXPLOSIONS = 8;

export class TempEnts {
  readonly beamEnt = new Int32Array(MAX_BEAMS);
  readonly beamModel: string[] = new Array(MAX_BEAMS).fill('');
  readonly beamEnd = new Float32Array(MAX_BEAMS);
  readonly beamStart = new Float32Array(MAX_BEAMS * 3);
  readonly beamStop = new Float32Array(MAX_BEAMS * 3);
  readonly exOrigin = new Float32Array(MAX_EXPLOSIONS * 3);
  readonly exStart = new Float32Array(MAX_EXPLOSIONS);
  readonly exModel: string[] = new Array(MAX_EXPLOSIONS).fill('');

  clear(): void { this.beamModel.fill(''); this.exModel.fill(''); }

  beam(ent: number, model: string, time: number, sx: number, sy: number, sz: number, ex: number, ey: number, ez: number): void {
    let b = -1;
    for (let i = 0; i < MAX_BEAMS; i++) if (this.beamModel[i] && this.beamEnt[i] === ent) { b = i; break; }
    if (b < 0) for (let i = 0; i < MAX_BEAMS; i++) if (!this.beamModel[i] || this.beamEnd[i] < time) { b = i; break; }
    if (b < 0) return;
    this.beamEnt[b] = ent; this.beamModel[b] = model; this.beamEnd[b] = time + 0.2;
    this.beamStart[b * 3] = sx; this.beamStart[b * 3 + 1] = sy; this.beamStart[b * 3 + 2] = sz;
    this.beamStop[b * 3] = ex; this.beamStop[b * 3 + 1] = ey; this.beamStop[b * 3 + 2] = ez;
  }

  explosion(model: string, time: number, x: number, y: number, z: number): void {
    let idx = -1;
    for (let i = 0; i < MAX_EXPLOSIONS; i++) if (!this.exModel[i]) { idx = i; break; }
    if (idx < 0) {
      let t = time; idx = 0;
      for (let i = 0; i < MAX_EXPLOSIONS; i++) if (this.exStart[i] < t) { t = this.exStart[i]; idx = i; }
    }
    this.exModel[idx] = model; this.exStart[idx] = time;
    this.exOrigin[idx * 3] = x; this.exOrigin[idx * 3 + 1] = y; this.exOrigin[idx * 3 + 2] = z;
  }
}
