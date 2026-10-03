/*
 * Quake Town — demos (.qtd): the world as it was when recording started plus
 * every confirmed tick's ordered calls; playback steps the sim. Saved to
 * IndexedDB and downloadable.
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 *
 * File: "QTD1" + deflate(JSON {
 *   v: 1, version, serverinfo, packs, maps: [names in load order], player, recordedAt,
 *   startFrame, snapshot: { w, slots, names },
 *   ticks: [[frame, op, op, ...], ...]       op = SimOp minus the closing step
 * })
 * A demo plays back only on the same sim build and content (version string).
 */
import { deflateSync, inflateSync, strToU8, strFromU8 } from 'fflate';
import type { QtApp, QtSnapshot, QtState, SimOp } from '../sim/qtsim.js';

export interface DemoHeader {
  v: 1;
  version: string;
  serverinfo: string;
  packs: string[];
  maps: string[];
  player: string;
  playerName: string;
  recordedAt: number;
  startFrame: number;
  snapshot: QtSnapshot;
}

export interface DemoFile extends DemoHeader { ticks: [number, ...SimOp[]][] }

const MAGIC = [0x51, 0x54, 0x44, 0x31]; // QTD1

export function encodeDemo(d: DemoFile): Uint8Array {
  const body = deflateSync(strToU8(JSON.stringify(d)), { level: 6 });
  const out = new Uint8Array(4 + body.length);
  out.set(MAGIC, 0);
  out.set(body, 4);
  return out;
}

export function decodeDemo(bytes: Uint8Array): DemoFile {
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) throw new Error('not a Quake Town demo (.qtd)');
  const d = JSON.parse(strFromU8(inflateSync(bytes.subarray(4)))) as DemoFile;
  if (d.v !== 1 || !d.snapshot || !Array.isArray(d.ticks)) throw new Error('unsupported demo version');
  return d;
}

/** Records the confirmed world's calls while attached. */
export class DemoRecorder {
  private ticks: [number, ...SimOp[]][] = [];
  private cur: SimOp[] = [];
  private readonly header: DemoHeader;
  private prevTap: QtApp['tap'];
  stopped = false;

  /**
   * `confirmed` names the state the room agrees on (lockstep.world.state): the
   * prediction's calls on its own copies are not recorded.
   */
  constructor(private readonly app: QtApp, state: QtState, frame: number, meta: Omit<DemoHeader, 'v' | 'version' | 'snapshot' | 'startFrame' | 'recordedAt'>, private readonly confirmed: () => QtState | null) {
    const snap = app.serialize!(state) as QtSnapshot;
    this.header = { v: 1, version: app.version, recordedAt: Date.now(), startFrame: frame, snapshot: { w: snap.w, slots: snap.slots, names: snap.names }, ...meta };
    this.prevTap = app.tap;
    app.tap = (s, op) => {
      this.prevTap?.(s, op);
      if (this.stopped || s !== this.confirmed()) return;
      if (op[0] === 's') { this.ticks.push([op[1], ...this.cur]); this.cur = []; }
      else this.cur.push(op);
    };
  }

  get frames(): number { return this.ticks.length; }
  get seconds(): number { return this.ticks.length * 0.013; }

  stop(): DemoFile {
    this.stopped = true;
    if (this.app.tap) this.app.tap = this.prevTap;
    return { ...this.header, ticks: this.ticks };
  }
}

/**
 * Plays a demo by stepping a world. `seek` replays from the snapshot (fast: no
 * drawing). `onFrame` is called after every step so the game records its rings.
 */
export class DemoPlayer {
  state: QtState;
  /** index into ticks of the NEXT tick to step */
  pos = 0;

  constructor(readonly app: QtApp, readonly demo: DemoFile, private readonly onFrame: (s: QtState, frame: number, seeking: boolean) => void) {
    this.state = app.deserialize!(demo.snapshot) as QtState;
  }

  get frame(): number { return this.pos > 0 ? this.demo.ticks[this.pos - 1][0] : this.demo.startFrame; }
  get length(): number { return this.demo.ticks.length; }
  get done(): boolean { return this.pos >= this.demo.ticks.length; }

  /** Step one recorded tick. */
  step(seeking = false): boolean {
    if (this.done) return false;
    const [frame, ...ops] = this.demo.ticks[this.pos++];
    const ctx = { frame, player: '', roster: [], rng: () => 0 } as never;
    const app = this.app, s = this.state;
    for (const op of ops) {
      switch (op[0]) {
        case 'a': app.addPlayer!(s, op[1], ctx); break;
        case 'r': app.removePlayer!(s, op[1], ctx); break;
        case 'd': app.disconnectPlayer!(s, op[1], ctx); break;
        case 'i': app.applyInput(s, op[2], ctx, op[1]); break;
      }
    }
    app.step(s, ctx);
    this.onFrame(s, frame, seeking);
    return true;
  }

  /** Go to tick index `target` (0..length): forward by stepping, back by replaying from the start. */
  seek(target: number): void {
    target = Math.max(0, Math.min(this.length, Math.floor(target)));
    if (target < this.pos) {
      this.app.dispose!(this.state);
      this.state = this.app.deserialize!(this.demo.snapshot) as QtState;
      this.pos = 0;
    }
    // the last 96 ticks are stepped as live frames so the rings are full when drawing resumes
    while (this.pos < target) this.step(this.pos < target - 96);
  }

  dispose(): void { this.app.dispose!(this.state); }
}

// ---------------------------------------------------------------- storage

const DB = 'quaketown-demos';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('demos'); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function saveDemo(name: string, bytes: Uint8Array): Promise<void> {
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction('demos', 'readwrite');
    tx.objectStore('demos').put(bytes, name);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  d.close();
}

export async function loadDemo(name: string): Promise<Uint8Array | null> {
  const d = await db();
  const v = await new Promise<Uint8Array | null>((resolve, reject) => {
    const r = d.transaction('demos').objectStore('demos').get(name);
    r.onsuccess = () => resolve((r.result as Uint8Array | undefined) ?? null);
    r.onerror = () => reject(r.error);
  });
  d.close();
  return v;
}

export async function listDemos(): Promise<string[]> {
  const d = await db();
  const v = await new Promise<string[]>((resolve, reject) => {
    const r = d.transaction('demos').objectStore('demos').getAllKeys();
    r.onsuccess = () => resolve((r.result as IDBValidKey[]).map(String).sort());
    r.onerror = () => reject(r.error);
  });
  d.close();
  return v;
}

export function downloadDemo(name: string, bytes: Uint8Array): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }));
  a.download = name.endsWith('.qtd') ? name : `${name}.qtd`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
