/*
 * Quake Town — the qtsim wasm as arrr-network's `lockstep.Sim`.
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 * (Shape ported from the Freedoom Deathmatch shell's doomsim.ts, same team, GPL.)
 *
 * The world lives in wasm memory; the TS state is a handle plus the slot table
 * (slot → member id) and the userinfo each member last sent. Every client runs
 * the same calls in the same order, so the slot a member takes is a pure
 * function of the ordered stream: `world_free_slot` at the moment its `{ j: 1 }`
 * is applied (DESIGN.md "Membership, slots, bots, spectators").
 *
 * Prediction: the SDK builds the predicted world as `deserialize(serialize(s))`.
 * `serialize` hands back a payload that remembers the live world it came from,
 * and `deserialize` of that payload - while the world is still exactly as it
 * was - is `world_clone`, a memcpy in wasm, rather than an encode and a decode.
 * The base64 is only produced when something actually reads `w` (a snapshot
 * going on the wire).
 */
import type { lockstep } from 'arrr-network';
import {
  instantiateQtSim, copyCounted, copyI32, readCString, readNameList, readStrings, withBytes, textBytes, lastError,
  type QtSimExports, CLIENT_WORDS, CV, ENT_WORDS, EVENT_WORDS, ROW_WORDS,
  EV_PRINT, EV_CENTER, EV_STUFF, EV_LIGHTSTYLE,
} from './abi.js';
import { cleanCommand, cleanUserinfo, decodeCmd, infoGet, type UserCmd } from './wire.js';

declare const __BUILD_REV__: string;

/** DESIGN.md "Tick rate": rooms tick at 77 Hz, one QW frame of msec 13. */
export const TICRATE = 77;
export const TICK_SECONDS = 0.013;

export interface QtState {
  /** World handle in the wasm module; 0 once disposed. */
  h: number;
  /** slot → member id ('' = bot-driven or empty). Hashed. */
  slots: string[];
  /** member id → the userinfo it last sent (spectators too, so a later join uses it). Hashed. */
  names: Record<string, string>;
  /** Events of the last step, every tick of it (not hashed, not serialized). */
  ev: Int32Array;
  /** The strings those events reference (index = string index). */
  strs: string[];
  /** Impulses applied this tick, per slot: a second cmd in one tick must not drop the first's impulse. Transient. */
  imp: number[];
}

export interface QtSnapshot { w: string; slots: string[]; names: Record<string, string> }

const SRC = Symbol('qtsim.src');
interface Source { sim: QtSim; h: number; tick: number; hash: number; bytes: Uint8Array }
const EMPTY = new Int32Array(0);
const NO_STRINGS: string[] = [];

/** One instantiated module, with its progs and maps loaded. Many worlds live in it at once. */
export class QtSim {
  readonly version: number;
  private readonly live = new Set<number>();
  private readonly modelCache = new Map<number, string[]>();
  private readonly soundCache = new Map<number, string[]>();
  /** How many worlds this module has made, for leak checks in tests. */
  created = 0;

  constructor(readonly ex: QtSimExports) {
    this.version = ex.sim_version() >>> 0;
  }

  static async create(source: Parameters<typeof instantiateQtSim>[0] | QtSimExports): Promise<QtSim> {
    const ex = (source as QtSimExports).world_new ? source as QtSimExports : await instantiateQtSim(source as Parameters<typeof instantiateQtSim>[0]);
    return new QtSim(ex);
  }

  error(): string { return lastError(this.ex); }

  // ---------------------------------------------------------------- content
  loadProgs(bytes: Uint8Array): number {
    const id = withBytes(this.ex, bytes, (p, n) => this.ex.progs_load(p, n));
    if (id < 0) throw new Error(`the sim refused the progs (${id}): ${this.error()}`);
    return id;
  }

  loadMap(name: string, bytes: Uint8Array): number {
    const nb = textBytes(name);
    const ex = this.ex;
    const np = ex.alloc(Math.max(1, nb.length));
    new Uint8Array(ex.memory.buffer, np, nb.length).set(nb);
    try {
      const id = withBytes(ex, bytes, (p, n) => ex.map_load(np, nb.length, p, n));
      if (id < 0) throw new Error(`the sim refused map ${name} (${id}): ${this.error()}`);
      return id;
    } finally { ex.dealloc(np, Math.max(1, nb.length)); }
  }

  mapName(mapId: number): string { return readCString(this.ex, this.ex.map_name(mapId)); }
  mapCount(): number { return this.ex.map_count() >>> 0; }

  // ---------------------------------------------------------------- worlds
  newWorld(progsId: number, mapId: number, seed: number, serverinfo: string): number {
    const h = withBytes(this.ex, textBytes(serverinfo), (p, n) => this.ex.world_new(progsId, mapId, seed >>> 0, p, n));
    if (h <= 0) throw new Error(`world_new failed: ${this.error()}`);
    this.live.add(h);
    this.created++;
    return h;
  }

  clone(h: number): number {
    const h2 = this.ex.world_clone(h);
    if (h2 <= 0) throw new Error(`world_clone failed: ${this.error()}`);
    this.live.add(h2);
    this.created++;
    return h2;
  }

  free(h: number): void {
    if (!this.live.delete(h)) return;
    this.ex.world_free(h);
  }

  isLive(h: number): boolean { return this.live.has(h); }
  get liveCount(): number { return this.live.size; }

  serialize(h: number): Uint8Array {
    const len = this.ex.world_serialize(h);
    return new Uint8Array(this.ex.memory.buffer, this.ex.world_buf_ptr(), len).slice();
  }

  deserialize(bytes: Uint8Array): number {
    const h = withBytes(this.ex, bytes, (p, n) => this.ex.world_deserialize(p, n));
    if (h <= 0) throw new Error(`world_deserialize refused the snapshot: ${this.error()}`);
    this.live.add(h);
    this.created++;
    return h;
  }

  hash(h: number): number { return this.ex.world_hash(h) >>> 0; }
  tickCount(h: number): number { return this.ex.world_tick_count(h) >>> 0; }
  mapOf(h: number): number { return this.ex.world_map(h); }
  tick(h: number): void { this.ex.world_tick(h); }

  // ---------------------------------------------------------------- membership
  freeSlot(h: number): number { return this.ex.world_free_slot(h); }
  join(h: number, slot: number, ui: string): void { withBytes(this.ex, textBytes(ui), (p, n) => this.ex.world_client_join(h, slot, p, n)); }
  leave(h: number, slot: number): void { this.ex.world_client_leave(h, slot); }
  idle(h: number, slot: number): void { this.ex.world_client_idle(h, slot); }
  setUserinfo(h: number, slot: number, ui: string): void { withBytes(this.ex, textBytes(ui), (p, n) => this.ex.world_set_userinfo(h, slot, p, n)); }
  command(h: number, slot: number, cmd: string): void { withBytes(this.ex, textBytes(cmd), (p, n) => this.ex.world_client_command(h, slot, p, n)); }
  setCmd(h: number, slot: number, c: UserCmd): void {
    this.ex.world_set_cmd(h, slot, c.pitch, c.yaw, c.forward, c.side, c.up, c.buttons, c.impulse);
  }
  setCvar(h: number, name: string, value: string): void {
    const f = this.ex.world_set_cvar;
    if (!f) return;
    const nb = textBytes(name);
    withBytes(this.ex, nb, (np, nn) => withBytes(this.ex, textBytes(value), (vp, vn) => f.call(this.ex, h, np, nn, vp, vn)));
  }

  // ---------------------------------------------------------------- views (copies)
  /** count × 20 words (EntView). */
  ents(h: number): Int32Array { return copyCounted(this.ex, this.ex.world_view_ents(h), ENT_WORDS); }
  /** One ClientView (64 words). */
  client(h: number, slot: number): Int32Array { return copyI32(this.ex, this.ex.world_view_client(h, slot), CLIENT_WORDS); }
  /** maxclients × 32 words (ClientRow). */
  clients(h: number): Int32Array { return copyCounted(this.ex, this.ex.world_view_clients(h), ROW_WORDS); }
  clientInfo(h: number, slot: number): string { return readCString(this.ex, this.ex.world_client_info(h, slot)); }
  serverinfo(h: number): string { return readCString(this.ex, this.ex.world_serverinfo(h)); }
  lightstyles(h: number): string[] { return readStrings(this.ex, this.ex.world_lightstyles(h), 64); }

  /** Events of the last world_tick, and the strings they reference. */
  events(h: number): { ev: Int32Array; strs: string[] } {
    const ev = copyCounted(this.ex, this.ex.world_events(h), EVENT_WORDS);
    if (!ev.length) return { ev: EMPTY, strs: NO_STRINGS };
    let need = -1;
    for (let i = 0; i < ev.length; i += EVENT_WORDS) {
      const k = ev[i];
      const si = k === EV_PRINT ? ev[i + 3] : k === EV_CENTER || k === EV_STUFF || k === EV_LIGHTSTYLE ? ev[i + 2] : -1;
      if (si > need) need = si;
    }
    return { ev, strs: need >= 0 ? readStrings(this.ex, this.ex.world_strings(h), need + 1) : NO_STRINGS };
  }

  /** precache_model list (index = modelindex), cached per map: it is fixed at spawn. */
  modelNames(h: number): string[] {
    const m = this.mapOf(h);
    let names = this.modelCache.get(m);
    if (!names) { names = readNameListIndexed(this.ex, this.ex.world_model_names(h)); this.modelCache.set(m, names); }
    return names;
  }

  soundNames(h: number): string[] {
    const m = this.mapOf(h);
    let names = this.soundCache.get(m);
    if (!names) { names = readNameListIndexed(this.ex, this.ex.world_sound_names(h)); this.soundCache.set(m, names); }
    return names;
  }

  /** A changelevel may precache differently: drop the caches. */
  forgetNames(): void { this.modelCache.clear(); this.soundCache.clear(); }
}

/**
 * Model/sound lists start with index 0 = "" (DESIGN), which an ordinary name
 * list would read as its terminator. So: the first entry may be empty.
 */
function readNameListIndexed(ex: QtSimExports, ptr: number): string[] {
  if (!ptr) return [];
  const mem = new Uint8Array(ex.memory.buffer);
  if (mem[ptr] === 0) return ['', ...readNameList(ex, ptr + 1)];
  return readNameList(ex, ptr);
}

// ---------------------------------------------------------------- base64

/** Node's Buffer when there is one (tests), without needing Node's types in the browser build. */
const NodeBuffer = (globalThis as unknown as { Buffer?: { from(b: ArrayBufferLike | string, o?: number | string, l?: number): { toString(enc: string): string } & Uint8Array } }).Buffer;

export function toBase64(bytes: Uint8Array): string {
  if (NodeBuffer) return NodeBuffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  if (NodeBuffer) return new Uint8Array(NodeBuffer.from(text, 'base64'));
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------- the lockstep app

export interface QtApp extends lockstep.Sim<QtState, unknown> {
  readonly name: string;
  readonly version: string;
  readonly sim: QtSim;
  readonly maxclients: number;
  /** Sim ticks per network frame: max(1, round(77 / node fps)). Set at connect, before any step. */
  ticksPerFrame: number;
  slotOf(s: QtState, id: string): number;
  /** Counters for tests: how often prediction took the clone path vs the byte path. */
  readonly stats: { clones: number; decodes: number; encodes: number; steps: number; stepMs: number };
  /**
   * A tap on every call that changes a state, in order (demo recording): the
   * recorder keeps the ones made on the confirmed world.
   */
  tap: ((s: QtState, op: SimOp) => void) | null;
}

/** One call on a state, as a demo replays it. */
export type SimOp =
  | ['a', string]                 // addPlayer
  | ['r', string]                 // removePlayer
  | ['d', string]                 // disconnectPlayer
  | ['i', string, unknown]        // applyInput(sender, data)
  | ['s', number];                // step (frame)

/** The room namespace suffix (DESIGN "Room config": `qt1.<cfg>-quaketown`). */
export const APP_NAME = 'quaketown';

export function ticksPerFrameFor(fps: number): number {
  return Math.max(1, Math.round(TICRATE / Math.max(1, fps)));
}

export const DEFAULT_USERINFO = '\\name\\player\\team\\\\topcolor\\0\\bottomcolor\\0';

export interface QtAppOptions {
  progsId: number;
  mapId: number;
  /** QW serverinfo the world is made from (DESIGN "Room config" → serverinfo). */
  serverinfo: string;
  /** Pack ids in the version string: two clients with different content never share a room silently. */
  packs?: string[];
  rev?: string;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function createQtApp(sim: QtSim, opts: QtAppOptions): QtApp {
  const maxclients = Math.max(2, Math.min(32, Number(infoGet(opts.serverinfo, 'maxclients')) || 16));
  const stats = { clones: 0, decodes: 0, encodes: 0, steps: 0, stepMs: 0 };
  const rev = opts.rev ?? (typeof __BUILD_REV__ === 'string' ? __BUILD_REV__ : 'dev');
  const slotOf = (s: QtState, id: string): number => (id ? s.slots.indexOf(id) : -1);
  const packTag = (opts.packs ?? []).map((p) => p.slice(0, 12)).join('.');

  const join = (s: QtState, id: string): void => {
    let slot = slotOf(s, id);
    if (slot < 0) {
      slot = sim.freeSlot(s.h);
      if (slot < 0 || slot >= s.slots.length) return;    // full: stays a spectator
      s.slots[slot] = id;
    }
    sim.join(s.h, slot, s.names[id] ?? DEFAULT_USERINFO);
  };

  const app: QtApp = {
    name: APP_NAME,
    version: `qtsim-${sim.version}+${packTag || 'nopacks'}+${rev}`,
    sim,
    maxclients,
    ticksPerFrame: 1,
    stats,
    slotOf,
    tap: null,

    init(ctx) {
      const h = sim.newWorld(opts.progsId, opts.mapId, ctx.seed, opts.serverinfo);
      // Everyone starts as a spectator (DESIGN "Membership"): the roster needs nothing here.
      return { h, slots: new Array<string>(maxclients).fill(''), names: {}, ev: EMPTY, strs: NO_STRINGS, imp: [] };
    },

    addPlayer(s, id) {
      app.tap?.(s, ['a', id]);
      // A member arriving is a spectator; a RECONNECT of a member that held a slot plays again.
      if (slotOf(s, id) >= 0) join(s, id);
    },

    removePlayer(s, id) {
      app.tap?.(s, ['r', id]);
      const slot = slotOf(s, id);
      if (slot >= 0) { sim.leave(s.h, slot); s.slots[slot] = ''; }
      delete s.names[id];
    },

    disconnectPlayer(s, id) {
      app.tap?.(s, ['d', id]);
      const slot = slotOf(s, id);
      if (slot >= 0) sim.idle(s.h, slot);
    },

    applyInput(s, data, _ctx, sender) {
      if (!sender || typeof data !== 'object' || data === null) return;
      app.tap?.(s, ['i', sender, data]);
      const d = data as Record<string, unknown>;
      if (d.c !== undefined) {
        const slot = slotOf(s, sender);
        if (slot < 0) return;
        const cmd = decodeCmd(d);
        if (!cmd) return;
        // Last cmd wins, but an impulse already delivered this tick is kept.
        if (!cmd.impulse && s.imp[slot]) cmd.impulse = s.imp[slot];
        else if (cmd.impulse) s.imp[slot] = cmd.impulse;
        sim.setCmd(s.h, slot, cmd);
        return;
      }
      if (d.j === 1) { join(s, sender); return; }
      if (d.j === 0) {
        const slot = slotOf(s, sender);
        if (slot >= 0) { sim.leave(s.h, slot); s.slots[slot] = ''; }
        return;
      }
      if (d.u !== undefined) {
        const ui = cleanUserinfo(d.u);
        if (ui === null) return;
        s.names[sender] = ui;
        const slot = slotOf(s, sender);
        if (slot >= 0) sim.setUserinfo(s.h, slot, ui);
        return;
      }
      if (d.k !== undefined) {
        const cmd = cleanCommand(d.k);
        const slot = slotOf(s, sender);
        if (cmd && slot >= 0) sim.command(s.h, slot, cmd);
      }
    },

    step(s, ctx) {
      app.tap?.(s, ['s', ctx?.frame ?? 0]);
      const t0 = now();
      if (s.imp.length) s.imp.length = 0;
      const n = app.ticksPerFrame;
      if (n === 1) {
        sim.tick(s.h);
        const e = sim.events(s.h);
        s.ev = e.ev; s.strs = e.strs;
      } else {
        // Several sim ticks per frame (a node slower than 77 Hz): concatenate the
        // events, re-basing string indices so they stay unique.
        const parts: Int32Array[] = [];
        const strs: string[] = [];
        let len = 0;
        for (let i = 0; i < n; i++) {
          sim.tick(s.h);
          const e = sim.events(s.h);
          if (e.ev.length) {
            const ev = e.ev.slice();
            const base = strs.length;
            for (let k = 0; k < ev.length; k += EVENT_WORDS) {
              const kind = ev[k];
              if (kind === EV_PRINT) ev[k + 3] += base;
              else if (kind === EV_CENTER || kind === EV_STUFF || kind === EV_LIGHTSTYLE) ev[k + 2] += base;
            }
            strs.push(...e.strs);
            parts.push(ev);
            len += ev.length;
          }
        }
        const ev = new Int32Array(len);
        let at = 0;
        for (const p of parts) { ev.set(p, at); at += p.length; }
        s.ev = ev; s.strs = strs;
      }
      stats.steps++;
      stats.stepMs += now() - t0;
    },

    hash(s) {
      // The world's own hash, then the slot table and the userinfos over it (FNV-1a).
      let h = sim.hash(s.h) ^ 0x811c9dc5;
      for (let i = 0; i < s.slots.length; i++) {
        const id = s.slots[i];
        if (!id) continue;
        h = Math.imul(h ^ i, 16777619);
        for (let k = 0; k < id.length; k++) h = Math.imul(h ^ id.charCodeAt(k), 16777619);
      }
      for (const id of Object.keys(s.names).sort()) {
        const v = s.names[id];
        for (let k = 0; k < id.length; k++) h = Math.imul(h ^ id.charCodeAt(k), 16777619);
        for (let k = 0; k < v.length; k++) h = Math.imul(h ^ v.charCodeAt(k), 16777619);
      }
      return h >>> 0;
    },

    serialize(s): QtSnapshot {
      // The bytes are taken now (a memcpy out of wasm): a transport may hold the
      // payload and read it after this world has stepped on. Only the base64 waits.
      const bytes = sim.serialize(s.h);
      const src: Source = { sim, h: s.h, tick: sim.tickCount(s.h), hash: sim.hash(s.h), bytes };
      let text: string | null = null;
      const out = { slots: [...s.slots], names: { ...s.names } } as QtSnapshot;
      Object.defineProperty(out, 'w', {
        enumerable: true,
        get() {
          if (text === null) { stats.encodes++; text = toBase64(bytes); }
          return text;
        },
      });
      Object.defineProperty(out, SRC, { value: src, enumerable: false });
      return out;
    },

    deserialize(json) {
      const snap = json as QtSnapshot & { [SRC]?: Source };
      if (!snap || !Array.isArray(snap.slots)) throw new Error('qtsim: not a snapshot');
      const slots = new Array<string>(maxclients).fill('');
      for (let i = 0; i < maxclients; i++) { const v = snap.slots[i]; if (typeof v === 'string') slots[i] = v; }
      const names: Record<string, string> = {};
      if (snap.names && typeof snap.names === 'object') {
        for (const [k, v] of Object.entries(snap.names)) { const ui = cleanUserinfo(v); if (ui !== null) names[k] = ui; }
      }
      const src = snap[SRC];
      let h: number;
      if (src && src.sim === sim) {
        if (sim.isLive(src.h) && sim.tickCount(src.h) === src.tick && sim.hash(src.h) === src.hash) {
          stats.clones++;
          h = sim.clone(src.h);
        } else {
          stats.decodes++;
          h = sim.deserialize(src.bytes);
        }
      } else {
        if (typeof snap.w !== 'string') throw new Error('qtsim: snapshot has no world');
        stats.decodes++;
        h = sim.deserialize(fromBase64(snap.w));
      }
      return { h, slots, names, ev: EMPTY, strs: NO_STRINGS, imp: [] };
    },

    dispose(s) {
      if (s.h) sim.free(s.h);
      s.h = 0;
    },

    fingerprint(s, player) {
      const slot = slotOf(s, player);
      if (slot < 0) return '-';
      const cv = sim.client(s.h, slot);
      const f = new Float32Array(cv.buffer, cv.byteOffset, cv.length);
      // 1/8 unit: QW's own network precision for origins.
      const q = (v: number): number => Math.round(v * 8);
      return `${slot},${q(f[CV.origin])},${q(f[CV.origin + 1])},${q(f[CV.origin + 2])},${cv[CV.health]}`;
    },

    status(s) {
      return { tick: sim.tickCount(s.h), humans: s.slots.filter(Boolean).length, members: Object.keys(s.names).length };
    },
  };
  return app;
}
