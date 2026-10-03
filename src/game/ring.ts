/*
 * Quake Town — a history of whole-world snapshots keyed by absolute frame.
 * Ported from the Freedoom Deathmatch shell (same team, GPL).
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 */
/**
 * A history of whole-world snapshots keyed by ABSOLUTE frame, read at a
 * fractional frame - the SDK's `FrameRing` contract (sdk/src/lockstep/render.ts)
 * over typed arrays instead of a Map per entity, because a Quake world is a
 * few hundred edicts per tick.
 *
 *   - recorded from the tick callbacks, never from the render loop;
 *   - recording frame f drops anything newer (a rebuilt prediction replays
 *     f, f+1, ... over entries from a world nobody will have);
 *   - read as the bracketing pair (floor(t), floor(t)+1) and a fraction,
 *     never past the newest entry (no extrapolation of characters).
 */
export class TicRing<T> {
  private readonly frames = new Map<number, T>();
  private newestFrame = -Infinity;

  constructor(private readonly depth = 96) {}

  record(frame: number, value: T): void {
    if (frame <= this.newestFrame) for (let f = frame; f <= this.newestFrame; f++) this.frames.delete(f);
    this.frames.set(frame, value);
    this.newestFrame = frame;
    for (const f of this.frames.keys()) { if (f < frame - this.depth) this.frames.delete(f); else break; }
  }

  get(frame: number): T | undefined { return this.frames.get(frame); }

  /** The bracketing pair at fractional frame t; `b === a` with frac 0 when only one side exists. */
  pair(t: number): { a: T; b: T; frac: number; frame: number } | null {
    const f0 = Math.floor(t);
    const a = this.frames.get(f0);
    const b = this.frames.get(f0 + 1);
    if (a && b) return { a, b, frac: t - f0, frame: f0 };
    if (a) return { a, b: a, frac: 0, frame: f0 };
    if (b) return { a: b, b, frac: 0, frame: f0 + 1 };
    // Off the back of the ring (a stall drew older than we keep): hold the oldest.
    // Off the front: hold the newest. Never invent.
    if (!this.frames.size) return null;
    const newest = this.frames.get(this.newestFrame);
    if (t > this.newestFrame && newest) return { a: newest, b: newest, frac: 0, frame: this.newestFrame };
    const first = this.frames.entries().next().value as [number, T];
    return { a: first[1], b: first[1], frac: 0, frame: first[0] };
  }

  latest(): T | undefined { return this.frames.get(this.newestFrame); }
  get newest(): number { return this.newestFrame; }
  get size(): number { return this.frames.size; }
  clear(): void { this.frames.clear(); this.newestFrame = -Infinity; }
}
