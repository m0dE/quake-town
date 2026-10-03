/*
 * Quake Town — the network session. Ported from the Freedoom Deathmatch shell (same team, GPL).
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 */
/**
 * The game's seam onto arrr-network's lockstep layer (a lean port of
 * vibe-strike's NetSession).
 *
 * The netcode is the SDK's `lockstep.Lockstep`: server clock, playout,
 * input beat, prediction, desync, snapshots, catch-up, reconnect. This file
 * owns only what that layer does not:
 *
 *   - how the connection is opened (a real node, or the offline loopback),
 *   - the channel that rides the ordered stream WITHOUT being gameplay - app
 *     messages (chat `{ say, team }`, ping reports `{ ping }`, looks `{ look }`),
 *     which the sim ignores (it acts only on `c`/`j`/`u`/`k`),
 *   - the names players joined with, read off their join inputs,
 *   - the numbers the HUD reads.
 *
 * It must never grow a render clock: everything drawn comes off
 * `lockstep.view(now)` (harness/INTEGRATION.md).
 */
import { connect, lockstep, type Connection, type IdentitySession, type NetworkInput } from 'arrr-network';
import { connectLoopback } from './loopback.js';
import { ticksPerFrameFor, TICRATE, type QtApp, type QtState } from '../sim/qtsim.js';
import { isSimInput } from '../sim/wire.js';

/** Hash (and so vote on) every Nth frame. Must be the same on every client of a room. */
export const HASH_EVERY = 1;

export type AppMessageHandler = (player: string | null, data: unknown) => void;

export interface SessionOptions {
  app: QtApp;
  /** Room name as the player knows it; namespaced with the app name on the wire. */
  room: string;
  appId: string;
  apiKey?: string;
  centralServiceUrl?: string;
  nodeUrl?: string;
  /** MUST be `identity.userId` when signed in: the node stamps the join from the token. */
  playerId: string;
  playerName: string;
  identity?: IdentitySession;
  predict?: boolean;
  offline?: boolean;
  /** Publish cadence in tics. */
  snapshotEvery: number;
  makeInput: (ctx?: lockstep.SimContext) => unknown;
  onConfirmedTick: (state: QtState, frame: number) => void;
  onPredictedTick: (state: QtState, frame: number) => void;
  onStatus?: (text: string) => void;
}

export interface NetStats {
  room: string;
  offline: boolean;
  connected: boolean;
  tickRate: number;
  frame: number;
  rtt: number | null;
  delayMs: number;
  starvations: number;
  lead: number;
  mispredictions: number;
  rollbacks: number;
  reseats: number;
  desyncs: number;
  resyncs: number;
  verdicts: number;
  noVerdict: number;
  reconnects: number;
  snapshotsPublished: number;
  roster: string[];
  errors: string[];
}

export class NetSession {
  readonly lockstep: lockstep.Lockstep<QtState, unknown>;
  readonly roomId: string;
  private readonly opts: SessionOptions;
  private conn: Connection | null = null;
  /** Non-gameplay payloads that came back in the ordered stream. */
  onAppMessage: AppMessageHandler | null = null;
  /** A join seen in the stream: who, and the name they joined with. */
  onJoin: ((player: string, name: string) => void) | null = null;
  private status = 'Connecting';
  /** The rate the node said at connect (0 until then). */
  nodeFps = 0;

  constructor(opts: SessionOptions) {
    this.opts = opts;
    // A Quake Town room id already ends in `-quaketown` (DESIGN "Room config"); a bare name gets it.
    this.roomId = opts.room.endsWith(`-${opts.app.name}`) ? opts.room : `${opts.room}-${opts.app.name}`;
    this.lockstep = new lockstep.Lockstep<QtState, unknown>({
      sim: opts.app,
      player: opts.playerId,
      room: this.roomId,
      predict: opts.predict ?? true,
      fps: TICRATE,
      snapshotEvery: opts.snapshotEvery,
      // world_hash is ~50-80 µs (measured in Node, qt_aero, 4-8 slots): every frame is affordable.
      hashEvery: HASH_EVERY,
      dial: (events, hints) => this.dial(events, hints),
      inputSource: (ctx) => opts.makeInput(ctx),
      onConfirmedTick: (s, f) => opts.onConfirmedTick(s, f),
      onPredictedTick: (s, f) => opts.onPredictedTick(s, f),
      onConnected: () => this.setStatus(opts.offline ? 'Offline' : 'Connected'),
      onDisconnected: () => this.setStatus('Reconnecting'),
      onError: (e) => this.setStatus(`Network: ${e}`),
      onDesync: (e) => this.setStatus(`Resynchronising (frame ${e.frame})`),
    });
  }

  private async dial(events: lockstep.TransportEvents, hints?: lockstep.DialHints): Promise<lockstep.TransportConnection> {
    const app = this.opts.app;
    // Read AFTER the lockstep applied the tick, so the roster has mapped this
    // tick's joins and every payload has a sender.
    const seen = (inputs: NetworkInput[]): void => {
      for (const input of inputs) {
        const data = (input as { data?: unknown }).data;
        if (data === undefined || data === null) continue;
        const lc = lockstep.lifecycleOf(input as lockstep.StreamInput);
        if (lc) {
          if ((lc.kind === 'join' || lc.kind === 'reconnect') && lc.player) {
            const name = (data as { user?: { name?: unknown } }).user?.name;
            if (typeof name === 'string') this.onJoin?.(lc.player, name);
          }
          continue;
        }
        if (isSimInput(data) || !this.onAppMessage) continue;
        const cid = (input as { clientId?: string }).clientId;
        const player = cid ? this.lockstep.world.roster.owner.get(String(cid)) ?? null : null;
        try { this.onAppMessage(player, data); } catch { /* an app message is never worth a dead tick */ }
      }
    };
    const wrapped: lockstep.TransportEvents = {
      ...events,
      // The node says its rate here, before any tick is stepped: one network
      // frame is one QW frame (msec 13) at 77 Hz, more if the node runs slower.
      onConnect: (snapshot, inputs, frame, node, fps, clientId) => {
        app.ticksPerFrame = ticksPerFrameFor(fps > 0 ? fps : TICRATE);
        this.nodeFps = fps;
        if (fps > 0 && fps !== TICRATE) console.warn(`[net] the room ticks at ${fps} Hz, not ${TICRATE}: ${app.ticksPerFrame} sim ticks per frame`);
        events.onConnect(snapshot, inputs, frame, node, fps, clientId);
        seen(inputs as NetworkInput[]);
      },
      onTick: (frame, inputs, sf, sh, maj) => { events.onTick(frame, inputs, sf, sh, maj); seen(inputs as NetworkInput[]); },
    };
    const user = { id: this.opts.playerId, name: this.opts.playerName, v: app.version, ...(hints ? { publishes: hints.publishes } : {}) };

    if (this.opts.offline) {
      const t = await connectLoopback({
        tickRate: TICRATE,
        user,
        onConnect: wrapped.onConnect,
        onTick: wrapped.onTick,
        onDisconnect: wrapped.onDisconnect,
      });
      this.conn = t as unknown as Connection;
      return t as unknown as lockstep.TransportConnection;
    }

    const c = await connect(this.roomId, {
      appId: this.opts.appId,
      apiKey: this.opts.apiKey,
      ...(this.opts.identity ? { identity: this.opts.identity } : {}),
      centralServiceUrl: this.opts.centralServiceUrl,
      nodeUrl: this.opts.nodeUrl,
      // Only a starting value for an app central has never seen (a local
      // cluster's); an app that exists keeps the rate set in its console.
      fps: TICRATE,
      user,
      onConnect: wrapped.onConnect,
      onTick: wrapped.onTick,
      onVerdict: wrapped.onVerdict,
      onDisconnect: wrapped.onDisconnect,
      onError: wrapped.onError,
      onClientsUpdate: wrapped.onClientsUpdate,
    });
    this.conn = c;
    return c as unknown as lockstep.TransportConnection;
  }

  private setStatus(text: string): void {
    this.status = text;
    this.opts.onStatus?.(text);
  }

  get statusText(): string { return this.status; }
  get playerId(): string { return this.opts.playerId; }
  /** The node this client is connected to (the room's authority or a replica), null offline. */
  get nodeId(): string | null { return this.opts.offline ? null : (this.conn as unknown as { node?: string | null } | null)?.node ?? null; }
  get offline(): boolean { return this.opts.offline === true; }

  async start(): Promise<void> { await this.lockstep.start(); }

  leave(): void {
    try { this.conn?.leaveRoom(); } catch { /* leaving a dead socket is not an error */ }
    this.lockstep.stop();
    this.conn = null;
  }

  /**
   * Broadcast a payload the sim does NOT treat as gameplay: sequenced like an
   * input, skipped by the sim, handed to every client's `onAppMessage`.
   * Small and infrequent only.
   */
  /** Send a sim input outside the beat (`{ j }`, `{ u }`, `{ k }`): sequenced, applied on every client. */
  sendSimInput(data: { j: 0 | 1 } | { u: string } | { k: string }): boolean {
    if (!this.lockstep.connected) return false;
    try { this.lockstep.send(data); } catch { return false; }
    return true;
  }

  sendAppMessage(data: unknown): boolean {
    if (!this.lockstep.connected || isSimInput(data)) return false;
    try { this.lockstep.send(data); } catch { return false; }
    return true;
  }

  stats(): NetStats {
    const r = this.lockstep.report();
    const d = r.desync as unknown as { disagreed: number; resyncs: number; verdicts: number; noVerdict?: number };
    return {
      room: this.roomId,
      offline: this.offline,
      connected: this.lockstep.connected,
      tickRate: this.lockstep.fps,
      frame: this.lockstep.frame,
      rtt: this.lockstep.roundTripMs,
      delayMs: r.playout.delayMs,
      starvations: r.playout.starvations,
      lead: r.prediction?.lead ?? 0,
      mispredictions: r.prediction?.mispredictions ?? 0,
      rollbacks: r.prediction?.rollbacks ?? 0,
      reseats: r.prediction?.reseats ?? 0,
      desyncs: d.disagreed,
      resyncs: d.resyncs,
      verdicts: d.verdicts,
      noVerdict: d.noVerdict ?? 0,
      reconnects: r.reconnects,
      snapshotsPublished: r.snapshotsPublished,
      roster: r.roster,
      errors: r.errors,
    };
  }
}
