/*
 * Quake Town — offline loopback node. Ported from the Freedoom Deathmatch shell (same team, GPL).
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 */
/**
 * Offline stand-in for an arrr-network node (ported from vibe-strike; voice removed).
 *
 * Offline play runs at 77 Hz like the app's rooms, on a drift-corrected timer (setInterval(13) drifts and bunches).
 *
 * It behaves like the node as far as the lockstep can observe, so offline play
 * runs exactly the same code paths as a live room: an INITIAL_STATE with no
 * snapshot at frame 0, one ordered batch per tick, the local player's `join`
 * (server-generated shape, `data.type` + `data.user`) on the first tick, every
 * input stamped with `clientId`/`clientHash`, and the majority hash for F-1
 * riding on tick F.
 *
 * An input lands in the frame it names, as the node's `admitInput` has it: held
 * until that tick when it is early (at most MAX_HOLD_TICKS ahead), into the next
 * tick when it names none or arrives late. Every SLACK_REPORT_EVERY frames the
 * node reports, per input, the frame it named and how early it came
 * (INPUT_SLACK) - the prediction's beat learns its lead from that report and
 * the clock is fed from it, so a stand-in that sequenced everything at once
 * would have every predicted input land one or two ticks before its frame and
 * the prediction corrected on nearly every tick.
 *
 * Shapes mirror what the live node was observed to send (tools/net/LIFECYCLE.md):
 * TICK inputs carry {seq, data, clientId, clientHash} and no frame.
 */
import { hashClientId, type DisconnectInfo, type HistoryInput, type NetworkInput } from 'arrr-network';

/** The part of arrr-network's `Connection` the lockstep uses. A real Connection satisfies it. */
export interface Transport {
  send(data: unknown, targetFrame?: number): void;
  sendSnapshot(snapshot: unknown, hash: string): void;
  sendStateHash(frame: number, hash: number): void;
  requestResync(): void;
  leaveRoom(): void;
  close(): void;
  readonly connected: boolean;
  readonly clientId: string | null;
  readonly node: string | null;
  onResyncSnapshot?: (data: Uint8Array, frame: number, inputs: NetworkInput[]) => void;
  /** Set by the lockstep: the node's slack report, per input the frame it named and how early it arrived. */
  onInputSlack?: (frame: number, samples: { target: number; slack: number }[]) => void;
}

/** The subset of arrr-network's ConnectOptions the loopback honours. */
export interface LoopbackOptions {
  tickRate: number;
  user: { id: string } & Record<string, unknown>;
  onConnect: (snapshot: unknown, inputs: HistoryInput[], frame: number, node: string | null, fps: number, clientId: string) => void;
  onTick: (frame: number, inputs: NetworkInput[], snapshotFrame?: number, snapshotHash?: string, majorityHash?: number) => void;
  onDisconnect: (info: DisconnectInfo) => void;
}

/** The node's cap on how far ahead an input may be held (arrr-node input-batcher.ts). */
const MAX_HOLD_TICKS = 40;
/** How often the node reports slack, in frames (arrr-node input-batcher.ts). */
const SLACK_REPORT_EVERY = 20;

export function connectLoopback(opts: LoopbackOptions): Promise<Transport> {
  const clientId = 'local-' + opts.user.id;
  const clientHash = hashClientId(clientId);
  const period = 1000 / Math.max(1, opts.tickRate);
  let frame = 0;
  let seq = 0;
  let open = true;
  let joined = false;
  /** Sequenced for the next tick: named no frame, or a frame already passed. */
  let outbox: unknown[] = [];
  /** Held for the frame they name. */
  const held = new Map<number, unknown[]>();
  let slack: { target: number; slack: number }[] = [];
  const hashes = new Map<number, number>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextAt = 0;

  /** An input as the node delivers it on a tick: sender, sequence, payload, and the sender's hash (a TICK names senders by hash). */
  const stamp = (data: unknown): NetworkInput => ({ seq: seq++, data, clientId, clientHash });

  const shut = (): void => {
    if (!open) return;
    open = false;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    // Only this client ever shuts the loopback (leaveRoom, close), so the close is
    // clean and ours - what a real node's socket reports for the same call.
    setTimeout(() => opts.onDisconnect({ code: 1000, reason: '', wasClean: true, byClient: true }), 0);
  };

  const transport: Transport = {
    send(data, targetFrame) {
      if (!open) return;
      const next = frame + 1;
      const target = typeof targetFrame === 'number' ? targetFrame : next;
      const early = Math.min(MAX_HOLD_TICKS, target - next);
      slack.push({ target, slack: early });
      if (early > 0) {
        const at = next + early;
        const due = held.get(at);
        if (due) due.push(data); else held.set(at, [data]);
      } else outbox.push(data);
    },
    sendSnapshot() { /* offline: nobody to catch up */ },
    sendStateHash(f, h) {
      if (!open) return;
      hashes.set(f, h >>> 0);
      hashes.delete(f - 64);
    },
    requestResync() { /* a single voter never disagrees with the majority */ },
    leaveRoom() { shut(); },
    close() { shut(); },
    get connected() { return open; },
    get clientId() { return clientId; },
    get node() { return 'loopback'; },
  };

  return new Promise((resolve) => {
    setTimeout(() => {
      // Like the SDK: onConnect first, then the connection resolves.
      opts.onConnect(null, [], 0, null, opts.tickRate, clientId);
      resolve(transport);
      const fire = (): void => {
        frame++;
        const batch: NetworkInput[] = [];
        if (!joined) {
          joined = true;
          batch.push(stamp({ type: 'join', clientId, user: opts.user }));
        }
        // What was held for this frame, then everything sequenced since the
        // previous tick - the node's order.
        const due = held.get(frame);
        held.delete(frame);
        const sent = outbox;
        outbox = [];
        for (const data of due ?? []) batch.push(stamp(data));
        for (const data of sent) batch.push(stamp(data));
        opts.onTick(frame, batch, 0, undefined, hashes.get(frame - 1) ?? 0);
        if (frame % SLACK_REPORT_EVERY === 0 && slack.length) {
          const samples = slack;
          slack = [];
          transport.onInputSlack?.(frame, samples);
        }
      };
      // Drift-corrected: every tick is due at a multiple of the period from the
      // start; a late timer delivers what is overdue (at most 4 at once, as a
      // node's backlog would) and the next one aims at the next boundary.
      nextAt = performance.now() + period;
      const loop = (): void => {
        if (!open) return;
        const now = performance.now();
        let n = 0;
        while (now >= nextAt && n < 4) { fire(); nextAt += period; n++; }
        if (now - nextAt > period * 8) nextAt = now + period;     // a hidden tab: do not replay minutes
        timer = setTimeout(loop, Math.max(0, nextAt - performance.now()));
      };
      timer = setTimeout(loop, period);
    }, 0);
  });
}
