// QW screen blends for the shell: damage flash, bonus flash, powerup tints, damage kicks.
// Port of QW/client/view.c (V_ParseDamage, V_BonusFlash, V_CalcPowerupCshift, V_CalcBlend,
// the cshift drop in V_UpdatePalette and V_CalcViewRoll's damage kick).
// Copyright (C) 1996-1997 Id Software, Inc. Copyright (C) 2026 Quake Town contributors.
//
// This program is free software; you can redistribute it and/or modify it under the terms
// of the GNU General Public License as published by the Free Software Foundation; either
// version 2 of the License, or (at your option) any later version.
//
// The liquid tint (cshift_water/slime/lava) is NOT here: the renderer adds it from the
// camera contents. Feed `rgba` into RenderFrame.camera.blend.

export const IT_INVISIBILITY = 1 << 19;
export const IT_INVULNERABILITY = 1 << 20;
export const IT_SUIT = 1 << 21;
export const IT_QUAD = 1 << 22;

const DMG_ARMOR = [200, 100, 100], DMG_MIXED = [220, 50, 50], DMG_BLOOD = [255, 0, 0];

export class ViewBlend {
  /** the blend for RenderFrame.camera.blend (rgba 0..1) */
  readonly rgba = new Float32Array(4);
  private dmgPercent = 0;
  private dmgColor = new Float32Array([255, 0, 0]);
  private bonusPercent = 0;
  /** damage kick (degrees) to add to the camera: roll and pitch, decaying over v_kicktime */
  dmgRoll = 0;
  dmgPitch = 0;
  private dmgTime = 0;
  /** gl_cshiftpercent (0..100) */
  cshiftPercent = 100;
  kickTime = 0.5;
  kickRoll = 0.6;
  kickPitch = 0.6;

  /**
   * V_ParseDamage for a damage Event (kind 6): `save` = dmg_save (armor), `take` = dmg_take
   * (blood), `fromX/Y/Z` the inflictor origin, eye + view angles of the local player.
   */
  damage(save: number, take: number, fromX: number, fromY: number, fromZ: number,
    eyeX: number, eyeY: number, eyeZ: number, pitch: number, yaw: number): void {
    let count = take * 0.5 + save * 0.5;
    if (count < 10) count = 10;
    this.dmgPercent = Math.min(150, Math.max(0, this.dmgPercent + 3 * count));
    if (save > take) this.dmgColor.set(DMG_ARMOR);
    else if (save) this.dmgColor.set(DMG_MIXED);
    else this.dmgColor.set(DMG_BLOOD);
    let dx = fromX - eyeX, dy = fromY - eyeY, dz = fromZ - eyeZ;
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    const d = Math.PI / 180;
    const cp = Math.cos(pitch * d), sp = Math.sin(pitch * d), cy = Math.cos(yaw * d), sy = Math.sin(yaw * d);
    const fx = cp * cy, fy = cp * sy, fz = -sp;
    const rx = sy, ry = -cy; // right (roll 0)
    this.dmgRoll = count * (dx * rx + dy * ry) * this.kickRoll;
    this.dmgPitch = count * (dx * fx + dy * fy + dz * fz) * this.kickPitch;
    this.dmgTime = this.kickTime;
  }

  /** V_BonusFlash (item pickup) */
  bonus(): void { this.bonusPercent = 50; }

  /** Per rendered frame: decay the flashes and compute `rgba` for the current items (QW IT_* bits). */
  update(frametime: number, items: number): Float32Array {
    this.dmgPercent = Math.max(0, this.dmgPercent - frametime * 150);
    this.bonusPercent = Math.max(0, this.bonusPercent - frametime * 100);
    this.dmgTime = Math.max(0, this.dmgTime - frametime);
    if (this.dmgTime <= 0) { this.dmgRoll = 0; this.dmgPitch = 0; }
    const o = this.rgba;
    o[0] = o[1] = o[2] = o[3] = 0;
    const k = this.cshiftPercent / 100;
    if (items & IT_QUAD) this.add(0, 0, 255, 30 * k);
    else if (items & IT_SUIT) this.add(0, 255, 0, 20 * k);
    else if (items & IT_INVISIBILITY) this.add(100, 100, 100, 100 * k);
    else if (items & IT_INVULNERABILITY) this.add(255, 255, 0, 30 * k);
    this.add(this.dmgColor[0], this.dmgColor[1], this.dmgColor[2], this.dmgPercent * k);
    this.add(215, 186, 69, this.bonusPercent * k);
    return o;
  }

  /** current roll kick to add to the camera (V_CalcViewRoll: v_dmg_roll * v_dmg_time / v_kicktime) */
  get kickRollNow(): number { return this.kickTime > 0 ? this.dmgRoll * this.dmgTime / this.kickTime : 0; }
  /** current pitch kick to add to the camera */
  get kickPitchNow(): number { return this.kickTime > 0 ? this.dmgPitch * this.dmgTime / this.kickTime : 0; }

  private add(r: number, g: number, b: number, percent: number): void {
    const a2 = percent / 255;
    if (a2 <= 0) return;
    const o = this.rgba;
    const a = o[3] + a2 * (1 - o[3]);
    const f = a2 / a;
    o[0] = o[0] * (1 - f) + (r / 255) * f;
    o[1] = o[1] * (1 - f) + (g / 255) * f;
    o[2] = o[2] * (1 - f) + (b / 255) * f;
    o[3] = Math.min(1, a);
  }
}
