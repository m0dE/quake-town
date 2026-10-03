/*
 * Quake Town — sound: Quake WAVs from the VFS through WebAudio, spatialized and
 * channelled like QW's snd_dma.c (S_StartSound, SND_PickChannel, SND_Spatialize,
 * S_StaticSound, S_UpdateAmbientSounds).
 *
 * Copyright (C) 1996-1997 Id Software, Inc.
 * Copyright (C) 2026 Quake Town contributors.
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation; either version 2 of the License, or (at your option) any later version.
 *
 * Rules kept from QW:
 *   - a new sound on the same entity and channel (channel != 0) replaces the old one;
 *   - the listener's own entity is heard unspatialized at full volume;
 *   - distance falloff: scale = (1 - dist × attenuation / 1000), left/right =
 *     scale × (1 ∓ dot(listener right, direction)), recomputed every frame;
 *   - ATTN_NONE (0) is heard everywhere at full volume.
 */
import type { Vfs } from '../content/types.js';

const NOMINAL_CLIP = 1000;
const MAX_CHANNELS = 64;

export interface WavInfo { rate: number; samples: Float32Array; loopStart: number }

/** Parse a RIFF WAV (8/16-bit PCM, mono or stereo → mono) with QW's `cue ` loop start. */
export function parseWav(bytes: Uint8Array): WavInfo | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || dv.getUint32(0, false) !== 0x52494646 || dv.getUint32(8, false) !== 0x57415645) return null;
  let at = 12;
  let rate = 11025, channels = 1, bits = 8, loopStart = -1;
  let data: Uint8Array | null = null;
  while (at + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
    const len = dv.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      channels = dv.getUint16(body + 2, true);
      rate = dv.getUint32(body + 4, true);
      bits = dv.getUint16(body + 14, true);
    } else if (id === 'data') {
      data = bytes.subarray(body, Math.min(bytes.length, body + len));
    } else if (id === 'cue ' && len >= 28) {
      loopStart = dv.getUint32(body + 24, true);
    }
    at = body + len + (len & 1);
  }
  if (!data || (bits !== 8 && bits !== 16) || channels < 1) return null;
  const frameBytes = (bits / 8) * channels;
  const n = Math.floor(data.length / frameBytes);
  const out = new Float32Array(n);
  const ddv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) {
      const o = i * frameBytes + c * (bits / 8);
      s += bits === 8 ? (data[o] - 128) / 128 : ddv.getInt16(o, true) / 32768;
    }
    out[i] = s / channels;
  }
  return { rate, samples: out, loopStart };
}

interface Channel {
  ent: number;
  chan: number;
  name: string;
  src: AudioBufferSourceNode;
  left: GainNode;
  right: GainNode;
  origin: [number, number, number];
  vol: number;
  attn: number;
  fixed: boolean;        // static / ambient: never replaced by entity channel rules
  started: number;
  ended: boolean;
}

export class Audio {
  readonly ctx: AudioContext | null;
  private readonly master: GainNode | null;
  private readonly buffers = new Map<string, AudioBuffer | null>();
  private readonly channels: Channel[] = [];
  private readonly listener = { origin: [0, 0, 0], right: [1, 0, 0] };
  /** The entity heard unspatialized (the local player's, or the one being followed). */
  viewEntity = 0;
  private volume = 0.7;
  private vfsList: Vfs[] = [];

  constructor(vfs: Vfs | null) {
    if (vfs) this.vfsList = [vfs];
    let ctx: AudioContext | null = null;
    try { ctx = new AudioContext({ latencyHint: 'interactive' }); } catch { ctx = null; }
    this.ctx = ctx;
    this.master = ctx ? ctx.createGain() : null;
    if (ctx && this.master) this.master.connect(ctx.destination);
    // Browsers start the context suspended until a gesture.
    const resume = (): void => { void this.ctx?.resume().catch(() => {}); };
    addEventListener('pointerdown', resume, { once: false, passive: true });
    addEventListener('keydown', resume, { once: false, passive: true });
    this.disposers.push(() => { removeEventListener('pointerdown', resume); removeEventListener('keydown', resume); });
  }

  private readonly disposers: (() => void)[] = [];

  setVfs(vfs: Vfs): void { this.vfsList = [vfs]; this.buffers.clear(); }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.01);
  }

  /** Decode (once) "weapons/r_exp3.wav" from sound/. Null when missing. */
  buffer(name: string): AudioBuffer | null {
    if (!this.ctx || !name) return null;
    const have = this.buffers.get(name);
    if (have !== undefined) return have;
    let buf: AudioBuffer | null = null;
    for (const v of this.vfsList) {
      const bytes = v.get(`sound/${name.toLowerCase()}`);
      if (!bytes) continue;
      const w = parseWav(bytes);
      if (!w || !w.samples.length) break;
      try {
        buf = this.ctx.createBuffer(1, w.samples.length, w.rate);
        buf.copyToChannel(w.samples as Float32Array<ArrayBuffer>, 0);
        (buf as AudioBuffer & { loopStart?: number }).loopStart = w.loopStart;
      } catch { buf = null; }
      break;
    }
    this.buffers.set(name, buf);
    return buf;
  }

  /** Warm the cache (precache list) so the first shot is not decoded mid-frame. */
  precache(names: readonly string[]): void { for (const n of names) if (n) this.buffer(n); }

  /**
   * S_StartSound: `vol` 0..1, `attn` QW attenuation (0 none, 1 normal, 2 idle, 3 static).
   * `ent` 0 = a sound at a point.
   */
  start(ent: number, chan: number, name: string, origin: ArrayLike<number>, vol: number, attn: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || ctx.state !== 'running') return;
    const buf = this.buffer(name);
    if (!buf) return;
    // SND_PickChannel: same entity + channel replaces (channel 0 never does); else the oldest.
    if (chan !== 0 && ent !== 0) {
      for (const c of this.channels) if (!c.fixed && c.ent === ent && c.chan === chan) this.stop(c);
    }
    this.reap();
    if (this.channels.length >= MAX_CHANNELS) {
      let oldest: Channel | null = null;
      for (const c of this.channels) if (!c.fixed && (!oldest || c.started < oldest.started)) oldest = c;
      if (oldest) { this.stop(oldest); this.reap(); }
    }
    const c = this.makeChannel(buf, ent, chan, name, origin, vol, attn, false, false);
    if (c) this.channels.push(c);
  }

  /** S_StaticSound: a looping sound at a point (ambient_* entities). */
  startStatic(name: string, origin: ArrayLike<number>, vol: number, attn: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const buf = this.buffer(name);
    if (!buf) return;
    const c = this.makeChannel(buf, 0, 0, name, origin, vol, attn, true, true);
    if (c) this.channels.push(c);
  }

  stopStatics(): void { for (const c of this.channels) if (c.fixed) this.stop(c); this.reap(); }

  private makeChannel(buf: AudioBuffer, ent: number, chan: number, name: string, origin: ArrayLike<number>, vol: number, attn: number, fixed: boolean, loop: boolean): Channel | null {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    if (loop) {
      src.loop = true;
      const ls = (buf as AudioBuffer & { loopStart?: number }).loopStart ?? -1;
      if (ls > 0) src.loopStart = ls / buf.sampleRate;
    }
    const left = ctx.createGain(), right = ctx.createGain();
    const merge = ctx.createChannelMerger(2);
    src.connect(left); src.connect(right);
    left.connect(merge, 0, 0); right.connect(merge, 0, 1);
    merge.connect(this.master!);
    const c: Channel = { ent, chan, name, src, left, right, origin: [origin[0], origin[1], origin[2]], vol, attn, fixed, started: ctx.currentTime, ended: false };
    this.spatialize(c, true);
    src.onended = () => { c.ended = true; try { merge.disconnect(); } catch { /* gone */ } };
    try { src.start(); } catch { return null; }
    return c;
  }

  /** Per frame: where we hear from. `right` is the listener's right vector. */
  setListener(origin: ArrayLike<number>, right: ArrayLike<number>): void {
    const l = this.listener;
    l.origin[0] = origin[0]; l.origin[1] = origin[1]; l.origin[2] = origin[2];
    l.right[0] = right[0]; l.right[1] = right[1]; l.right[2] = right[2];
    for (const c of this.channels) if (!c.ended) this.spatialize(c, false);
    this.reap();
  }

  /** Move an entity's sounds with it (QW keeps them at their start point; ours follow the body). */
  moveEntity(ent: number, origin: ArrayLike<number>): void {
    for (const c of this.channels) if (c.ent === ent) { c.origin[0] = origin[0]; c.origin[1] = origin[1]; c.origin[2] = origin[2]; }
  }

  private spatialize(c: Channel, now: boolean): void {
    let lv: number, rv: number;
    if (c.ent !== 0 && c.ent === this.viewEntity) { lv = rv = c.vol; }
    else {
      const l = this.listener;
      const dx = c.origin[0] - l.origin[0], dy = c.origin[1] - l.origin[1], dz = c.origin[2] - l.origin[2];
      const len = Math.hypot(dx, dy, dz);
      const dist = (len * c.attn) / NOMINAL_CLIP;
      const dot = len > 0 ? (dx * l.right[0] + dy * l.right[1] + dz * l.right[2]) / len : 0;
      const scale = Math.max(0, 1 - dist);
      rv = c.vol * scale * (1 + dot);
      lv = c.vol * scale * (1 - dot);
      // QW clamps each side to [0, 1]·vol after the pan: never louder than the source.
      if (rv > c.vol) rv = c.vol;
      if (lv > c.vol) lv = c.vol;
    }
    const t = this.ctx!.currentTime;
    if (now) { c.left.gain.value = lv; c.right.gain.value = rv; }
    else { c.left.gain.setTargetAtTime(lv, t, 0.015); c.right.gain.setTargetAtTime(rv, t, 0.015); }
  }

  private stop(c: Channel): void {
    if (c.ended) return;
    c.ended = true;
    try { c.src.stop(); } catch { /* not started */ }
  }

  private reap(): void {
    let w = 0;
    for (let i = 0; i < this.channels.length; i++) { const c = this.channels[i]; if (!c.ended) this.channels[w++] = c; }
    this.channels.length = w;
  }

  /** Play a UI sound (menu clicks, chat beep) without position. */
  local(name: string, vol = 1): void { this.start(-1, 0, name, this.listener.origin, vol, 0); }

  stopAll(): void { for (const c of this.channels) this.stop(c); this.reap(); }

  get active(): number { return this.channels.length; }

  dispose(): void {
    this.stopAll();
    for (const d of this.disposers) d();
    void this.ctx?.close().catch(() => {});
  }
}

/** QW ambient_* entity classnames → their looping sound (misc.qc). */
export const AMBIENT_SOUNDS: Record<string, [string, number]> = {
  ambient_comp_hum: ['ambience/comp1.wav', 1],
  ambient_drone: ['ambience/drone6.wav', 0.5],
  ambient_suck_wind: ['ambience/suck1.wav', 1],
  ambient_flouro_buzz: ['ambience/buzz1.wav', 1],
  ambient_drip: ['ambience/drip1.wav', 0.5],
  ambient_light_buzz: ['ambience/fl_hum1.wav', 0.5],
  ambient_swamp1: ['ambience/swamp1.wav', 0.5],
  ambient_swamp2: ['ambience/swamp2.wav', 0.5],
};
