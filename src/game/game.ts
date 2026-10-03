/*
 * Quake Town — a match: the lockstep session (or a demo), the rings it records,
 * and the frame loop that turns `lockstep.view(now)` into a RenderFrame, sounds
 * and the HUD.
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 * (Shape ported from the Freedoom Deathmatch shell's game.ts, same team, GPL.)
 *
 * The rules (arrr-mono harness/INTEGRATION.md, sdk/docs/lockstep.md):
 *   - ONE clock: `renderTimes(ls.view(now))` at the rAF timestamp, once per
 *     frame. Bob, kick, tints and stair smoothing advance on the drawn self
 *     clock too (view.ts), never on wall time.
 *   - everyone else from the CONFIRMED ring at `others`, the bracketing pair
 *     lerped, never past the newest entry (no extrapolation of characters);
 *   - the local player (camera, gun, body) from the PREDICTED ring at `self`,
 *     with the live mouse angles so the view turns on the frame the mouse moves;
 *   - own projectiles from the predicted world too (zero-latency rockets), with
 *     their explosion taken from the prediction and the confirmed one skipped;
 *   - a body that moved more than 64 units in one tick teleported: a cut;
 *   - events are released when the drawn clock reaches their tick, once each,
 *     however often a rollback replays the prediction.
 */
import { lockstep, type IdentitySession } from 'arrr-network';
import {
  CV, CLIENT_WORDS, ENT_WORDS, E_NUM, E_SERIAL, E_MODEL, E_FRAME, E_SKIN, E_COLORMAP, E_EFFECTS, E_MOVE, E_ORIGIN, E_ANGLES,
  E_VELOCITY, E_OWNER, E_ALPHA, EVENT_WORDS, ROW_WORDS, R_STATE, R_FRAGS, R_TOP, R_BOTTOM, R_STATS, R_ENTNUM,
  EV_SOUND, EV_TEMP, EV_PRINT, EV_CENTER, EV_MUZZLE, EV_DAMAGE, EV_KICK, EV_STUFF, EV_LIGHTSTYLE, EV_INTERMISSION,
  EV_OBITUARY, EV_MATCH, EV_CHANGELEVEL, EV_PICKUP, MOVETYPE_FLY, MOVETYPE_FLYMISSILE, MOVETYPE_BOUNCE, MOVETYPE_TOSS,
  TE_EXPLOSION, TE_TAREXPLOSION, TE_SPIKE, TE_SUPERSPIKE, TE_WIZSPIKE, TE_KNIGHTSPIKE, PRINT_CHAT, PHASE_INTERMISSION,
  CLIENT_HUMAN, CLIENT_IDLE, CLIENT_BOT, ST,
} from '../sim/abi.js';
import { createQtApp, TICRATE, TICK_SECONDS, type QtApp, type QtSim, type QtState } from '../sim/qtsim.js';
import { encodeCmd, parseInfo, cleanCommand } from '../sim/wire.js';
import { NetSession } from '../net/session.js';
import { rememberNodeRtt } from '../rooms/ping.js';
import { TicRing } from './ring.js';
import { ViewCalc, poseFrom, newPose, lerpAngle, angleVectors, type SelfPose } from './view.js';
import { TopDownView, type RendererLike } from './topdown.js';
import { PausePanel } from './pause.js';
import { Input, type KeyDest } from '../input/input.js';
import type { CommandSystem } from '../console/commands.js';
import type { Console } from '../console/console.js';
import type { Cvars } from '../console/cvars.js';
import { Hud, type PlayerRow, type TeamRow, type MatchInfo, type HudState } from '../hud/hud.js';
import type { Gfx } from '../hud/gfx.js';
import { Audio, AMBIENT_SOUNDS } from '../audio/audio.js';
import { DemoPlayer, DemoRecorder, encodeDemo, saveDemo, downloadDemo, type DemoFile } from '../demo/demo.js';
import { createRenderFrame, type RenderFrame, type RenderEntity } from '../render/types.js';
import type { Vfs } from '../content/types.js';

const { renderTimes } = lockstep;
const TELEPORT = 64;
const SNAPSHOT_EVERY = TICRATE * 10;
const RING = 160;

export interface GameOptions {
  sim: QtSim;
  progsId: number;
  /** map name → map id, every map of the rotation loaded */
  maps: Map<string, number>;
  serverinfo: string;
  packs: string[];
  roomId: string;
  offline: boolean;
  spectate: boolean;
  appId: string;
  apiKey?: string;
  central?: string;
  nodeUrl?: string;
  identity?: IdentitySession | null;
  playerId: string;
  vfs: Vfs | null;
  host: HTMLElement;
  makeRenderer: (canvas: HTMLCanvasElement) => Promise<RendererLike | null>;
  cvars: Cvars;
  cmds: CommandSystem;
  console: Console;
  gfx: Gfx;
  userinfo: () => string;
  /** Play this demo instead of connecting. */
  demo?: DemoFile;
  /** Show the pause panel while the mouse is free (off for scripted tests). */
  pausePanel?: boolean;
}

/** One confirmed frame, as the loop keeps it. */
interface Snap {
  ents: Int32Array;
  rows: Int32Array;
  /** the ClientView of the viewed slot (ours, or the followed player's) */
  cv: Int32Array | null;
  viewSlot: number;
  slots: string[];
  index?: Map<number, number>;
}

/** One predicted frame: our ClientView and the world's ents (for our own projectiles). */
interface SelfSnap { cv: Int32Array; ents: Int32Array; index?: Map<number, number> }

interface Queued { frame: number; ev: Int32Array; strs: string[] }

function indexOf(s: { ents: Int32Array; index?: Map<number, number> }): Map<number, number> {
  if (s.index) return s.index;
  const m = new Map<number, number>();
  for (let i = 0, n = s.ents.length / ENT_WORDS; i < n; i++) m.set(s.ents[i * ENT_WORDS + E_NUM], i);
  s.index = m;
  return m;
}

const f32 = (a: Int32Array): Float32Array => new Float32Array(a.buffer, a.byteOffset, a.length);
const isProjectile = (move: number): boolean => { const mt = move & 255; return mt === MOVETYPE_FLYMISSILE || mt === MOVETYPE_FLY || mt === MOVETYPE_BOUNCE || mt === MOVETYPE_TOSS; };

export class Game {
  onLeave: ((reason: string) => void) | null = null;

  readonly app: QtApp;
  readonly net: NetSession | null;
  readonly input: Input;
  readonly hud: Hud;
  readonly audio: Audio;
  private renderer: RendererLike | null = null;
  private readonly canvas: HTMLCanvasElement;
  private readonly view: ViewCalc;
  private readonly pose: SelfPose = newPose();
  private readonly frame: RenderFrame = createRenderFrame(512, 256);
  private readonly confirmed = new TicRing<Snap>(RING);
  private readonly selfRing = new TicRing<SelfSnap>(RING);
  private readonly cq: Queued[] = [];
  private readonly pq = new Map<number, Queued>();
  private lastReleasedOthers = -1;
  private lastReleasedSelf = -1;
  private lastPredictedAt = -1e9;
  private predExpl: { x: number; y: number; z: number; at: number }[] = [];
  private lightstyles: string[] = new Array(64).fill('m');
  private match: MatchInfo | null = null;
  private mySlot = -1;
  private myEnt = 0;
  private raf = 0;
  private disposed = false;
  private lastNow = 0;
  private drawn = 0;
  private drawnSince = 0;
  private fps = 0;
  private fpsAt = 0;
  private fpsFrames = 0;
  private joinSentAt = -1e9;
  private wantPlay: boolean;
  private helloAt = 0;
  private pingAt = 0;
  private readonly pings = new Map<string, number>();
  private names: { name: string; team: string; top: number; bottom: number; bot: boolean }[] = [];
  private namesAt = -1e9;
  private rowsCache: { rows: PlayerRow[]; teams: TeamRow[]; at: number } = { rows: [], teams: [], at: -1e9 };
  private readonly teamplay: boolean;
  private readonly mode: string;
  private notice = '';
  private specFree = true;
  private specTarget = -1;
  private specOrigin: [number, number, number] = [0, 0, 128];
  private specPrev = { attack: false, jump: false };
  private lastFixFrame = -1;
  private recorder: DemoRecorder | null = null;
  private demo: DemoPlayer | null = null;
  private demoClock = 0;
  private demoPaused = false;
  private mapName = '';
  private readonly unsub: (() => void)[] = [];
  /** For the probe / tests: the clocks drawn this frame. */
  lastTimes: { others: number; self: number; predicted: boolean } | null = null;
  /** For the probe: remote bodies as drawn this frame, id → metres. */
  readonly drawnBodies = new Map<string, { x: number; y: number; z: number }>();

  static async start(opts: GameOptions, progress: (label: string) => void): Promise<Game> {
    const g = new Game(opts);
    progress('Loading the map');
    await g.initRenderer();
    if (g.net) {
      progress('Connecting');
      try { await g.net.start(); } catch (err) { g.dispose(); throw err; }
    }
    g.loop();
    return g;
  }

  private constructor(private readonly opts: GameOptions) {
    const si = parseInfo(opts.serverinfo);
    this.teamplay = Number(si.get('teamplay') ?? 0) > 0;
    this.mode = si.get('mode') ?? 'ffa';
    const firstMap = (si.get('rotation') ?? '').split(/\s+/).filter(Boolean)[0] ?? [...opts.maps.keys()][0];
    const mapId = opts.maps.get(firstMap) ?? [...opts.maps.values()][0];
    this.mapName = firstMap;
    this.app = createQtApp(opts.sim, { progsId: opts.progsId, mapId, serverinfo: opts.serverinfo, packs: opts.packs });
    this.wantPlay = !opts.spectate && !opts.demo;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'qt-view';
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;z-index:1';
    opts.host.append(this.canvas);
    this.hud = new Hud(opts.host, opts.gfx, opts.cvars);
    this.audio = new Audio(opts.vfs);
    this.audio.setVolume(opts.cvars.num('volume'));
    this.view = new ViewCalc(opts.cvars);

    this.input = new Input(this.canvas, opts.cmds, opts.cvars, {
      keyDest: () => this.keyDest(),
      textKey: (e) => opts.console.key(e),
      lockLost: () => { /* the "Click to play" box shows; Esc again opens nothing else */ },
    });
    opts.console.onToggle = (open) => { if (open) { this.input.releaseAll(); this.input.unlock(); } };
    opts.console.onChat = (text, team) => this.say(text, team);

    this.unsub.push(opts.cvars.onChange('volume', (_n, v) => this.audio.setVolume(Number(v))));
    for (const k of ['name', 'team', 'topcolor', 'bottomcolor', 'skin']) {
      this.unsub.push(opts.cvars.onChange(k, () => { this.userinfoDirty = true; }));
    }

    if (opts.demo) {
      this.net = null;
      this.demo = new DemoPlayer(this.app, opts.demo, (s, f, seeking) => this.onConfirmed(s, f, seeking));
      this.wantPlay = false;
    } else {
      this.net = new NetSession({
        app: this.app,
        room: opts.roomId,
        appId: opts.appId,
        ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
        centralServiceUrl: opts.central,
        nodeUrl: opts.nodeUrl,
        playerId: opts.playerId,
        playerName: parseInfo(opts.userinfo()).get('name') ?? 'player',
        ...(opts.identity ? { identity: opts.identity } : {}),
        offline: opts.offline,
        snapshotEvery: SNAPSHOT_EVERY,
        makeInput: () => encodeCmd(this.input.cmd()),
        onConfirmedTick: (s, f) => this.onConfirmed(s, f, false),
        onPredictedTick: (s, f) => this.onPredicted(s, f),
      });
      this.net.onAppMessage = (player, data) => this.onAppMessage(player, data);
      this.net.onJoin = (player) => { if (player !== opts.playerId) this.helloAt = Math.min(this.helloAt, performance.now() + 300); };
    }
    addEventListener('resize', this.resize);
    if (opts.pausePanel !== false) {
      this.pause = new PausePanel(opts.host, {
        resume: () => { this.pause?.show(false); this.input.lock(); },
        leave: () => this.onLeave?.(''),
        console: () => { this.pause?.show(false); opts.cmds.exec('toggleconsole'); },
      }, opts.demo ? 'Demo' : 'Quake Town');
    }
  }

  private pause: PausePanel | null = null;
  private userinfoDirty = false;

  private keyDest(): KeyDest {
    const c = this.opts.console.keyDest;
    return c ?? 'game';
  }

  private async initRenderer(): Promise<void> {
    let r: RendererLike | null = null;
    try { r = await this.opts.makeRenderer(this.canvas); } catch (err) { console.warn('[game] no 3D renderer:', err); r = null; }
    if (!r) r = new TopDownView(this.canvas);
    this.renderer = r;
    this.resize();
    try { await r.loadMap(this.mapName); } catch (err) { console.warn(`[game] the renderer could not load ${this.mapName}:`, err); }
  }

  // ------------------------------------------------------------------ the stream

  private onConfirmed(s: QtState, f: number, seeking: boolean): void {
    const sim = this.app.sim;
    // A catch-up replays history the picture will never show: no copies, only the bookkeeping.
    if (this.net?.lockstep.catchup.active) {
      for (let i = 0; i < s.ev.length; i += EVENT_WORDS) if (s.ev[i] === EV_CHANGELEVEL) this.mapStartFrame = f;
      this.mySlot = this.app.slotOf(s, this.opts.playerId);
      return;
    }
    const slot = this.app.slotOf(s, this.opts.playerId);
    this.mySlot = slot;
    const rows = sim.clients(s.h);
    this.myEnt = slot >= 0 ? rows[slot * ROW_WORDS + R_ENTNUM] || slot + 1 : 0;
    const viewSlot = slot >= 0 ? slot : this.demo ? this.demoViewSlot(s) : this.specFree ? -1 : this.specTarget;
    const snap: Snap = {
      ents: sim.ents(s.h),
      rows,
      cv: viewSlot >= 0 ? sim.client(s.h, viewSlot) : null,
      viewSlot,
      slots: s.slots.slice(),
    };
    this.confirmed.record(f, snap);
    if (!Number.isFinite(this.mapStartFrame)) this.mapStartFrame = f - sim.tickCount(s.h);
    for (let i = 0; i < s.ev.length; i += EVENT_WORDS) if (s.ev[i] === EV_CHANGELEVEL) this.mapStartFrame = f;
    if (this.app.sim.ex.world_stopped?.(s.h)) this.fatal(`the mod stopped: ${this.app.sim.error()}`);
    // fixangle without a prediction (spectating someone, a demo, before the prediction arms)
    if (snap.cv && snap.cv[CV.fixangle] && (slot < 0 || !this.net?.lockstep.prediction) && f > this.lastFixFrame) {
      this.lastFixFrame = f;
      if (slot >= 0 || this.demo) { const fa = f32(snap.cv); this.input.setAngles(fa[CV.fixAngles], fa[CV.fixAngles + 1]); }
    }
    if (seeking) return;
    this.arrivals[this.arrivalAt++ % this.arrivals.length] = performance.now();
    if (s.ev.length) this.cq.push({ frame: f, ev: s.ev, strs: s.strs });
    if (this.cq.length > 600) this.cq.splice(0, this.cq.length - 600);
  }

  private demoViewSlot(s: QtState): number {
    const id = this.opts.demo?.player ?? '';
    return id ? s.slots.indexOf(id) : -1;
  }

  private onPredicted(s: QtState, f: number): void {
    const slot = this.app.slotOf(s, this.opts.playerId);
    if (slot < 0) return;
    const sim = this.app.sim;
    const cv = sim.client(s.h, slot);
    this.selfRing.record(f, { cv, ents: sim.ents(s.h) });
    this.lastPredictedAt = performance.now();
    // svc_setangle: the sim turned us (teleport, respawn) - once per frame, whatever a rollback replays
    if (cv[CV.fixangle] && f > this.lastFixFrame) {
      this.lastFixFrame = f;
      const fa = f32(cv);
      this.input.setAngles(fa[CV.fixAngles], fa[CV.fixAngles + 1]);
    }
    // our own events, released on the self clock; a rebuild re-records frames not yet released
    for (const k of this.pq.keys()) if (k >= f) this.pq.delete(k);
    if (s.ev.length && f > this.lastReleasedSelf) this.pq.set(f, { frame: f, ev: s.ev, strs: s.strs });
    if (this.pq.size > 256) for (const k of this.pq.keys()) { if (k < f - 200) this.pq.delete(k); else break; }
  }

  private get predicting(): boolean { return this.mySlot >= 0 && performance.now() - this.lastPredictedAt < 500; }

  // ------------------------------------------------------------------ events

  private soundName(idx: number): string { return this.app.sim.soundNames(this.worldH())[idx] ?? ''; }
  private modelName(idx: number): string { return idx > 0 ? this.app.sim.modelNames(this.worldH())[idx] ?? '' : ''; }
  private worldH(): number { return (this.demo ? this.demo.state.h : this.net?.lockstep.world.state?.h) ?? 0; }

  /** Release confirmed events of ticks the drawn clock has reached. */
  private releaseConfirmed(upTo: number): void {
    const own = this.predicting;
    while (this.cq.length && this.cq[0].frame <= upTo) {
      const q = this.cq.shift()!;
      if (q.frame <= this.lastReleasedOthers) continue;
      this.lastReleasedOthers = q.frame;
      const ev = q.ev;
      for (let i = 0; i < ev.length; i += EVENT_WORDS) this.confirmedEvent(ev, i, q.strs, own);
    }
  }

  private releasePredicted(upTo: number): void {
    for (const [f, q] of this.pq) {
      if (f > upTo) break;
      this.pq.delete(f);
      if (f <= this.lastReleasedSelf) continue;
      this.lastReleasedSelf = f;
      const prevFrame = this.selfRing.get(f - 1);
      const ev = q.ev;
      for (let i = 0; i < ev.length; i += EVENT_WORDS) this.predictedEvent(ev, i, prevFrame ?? null);
    }
  }

  /** Our own: weapon/jump sounds, kicks, muzzle flash, and explosions of our own projectiles. */
  private predictedEvent(ev: Int32Array, i: number, prev: SelfSnap | null): void {
    const kind = ev[i];
    const fv = new Float32Array(ev.buffer, ev.byteOffset + i * 4, EVENT_WORDS);
    if (kind === EV_SOUND && ev[i + 1] === this.myEnt && (ev[i + 2] === 1 || ev[i + 2] === 4)) {
      this.audio.start(ev[i + 1], ev[i + 2], this.soundName(ev[i + 3]), [fv[5], fv[6], fv[7]], ev[i + 4] / 255, ev[i + 8] / 64);
    } else if (kind === EV_KICK && ev[i + 1] === this.mySlot) this.view.punch(ev[i + 2] === 1);
    else if (kind === EV_MUZZLE && ev[i + 1] === this.myEnt) this.pushRenderEvent(ev, i);
    else if (kind === EV_TEMP && (ev[i + 1] === TE_EXPLOSION || ev[i + 1] === TE_TAREXPLOSION) && prev && this.opts.cvars.num('cl_predict_projectiles')) {
      // ours if one of our projectiles was within reach of it the frame before
      const x = fv[5], y = fv[6], z = fv[7];
      const pe = prev.ents, pf = f32(pe);
      for (let k = 0; k < pe.length; k += ENT_WORDS) {
        if (pe[k + E_OWNER] !== this.myEnt || !isProjectile(pe[k + E_MOVE])) continue;
        if (Math.hypot(pf[k + E_ORIGIN] - x, pf[k + E_ORIGIN + 1] - y, pf[k + E_ORIGIN + 2] - z) < 80) {
          this.predExpl.push({ x, y, z, at: performance.now() });
          this.tempEntity(ev, i);
          break;
        }
      }
    }
  }

  private confirmedEvent(ev: Int32Array, i: number, strs: string[], own: boolean): void {
    const kind = ev[i];
    const fv = new Float32Array(ev.buffer, ev.byteOffset + i * 4, EVENT_WORDS);
    const me = this.mySlot;
    const now = performance.now();
    switch (kind) {
      case EV_SOUND: {
        const ent = ev[i + 1], chan = ev[i + 2];
        if (own && ent === this.myEnt && (chan === 1 || chan === 4)) return;     // played off the prediction
        this.audio.start(ent, chan, this.soundName(ev[i + 3]), [fv[5], fv[6], fv[7]], ev[i + 4] / 255, ev[i + 8] / 64);
        return;
      }
      case EV_TEMP: {
        const te = ev[i + 1];
        if (te === TE_EXPLOSION || te === TE_TAREXPLOSION) {
          this.predExpl = this.predExpl.filter((p) => now - p.at < 1500);
          const k = this.predExpl.findIndex((p) => Math.hypot(p.x - fv[5], p.y - fv[6], p.z - fv[7]) < 96);
          if (k >= 0) { this.predExpl.splice(k, 1); return; }   // already drawn and heard from the prediction
        }
        this.tempEntity(ev, i);
        return;
      }
      case EV_MUZZLE:
        if (own && ev[i + 1] === this.myEnt) return;
        this.pushRenderEvent(ev, i);
        return;
      case EV_PRINT: {
        const target = ev[i + 1];
        if (target !== -1 && target !== me) return;
        const text = strs[ev[i + 3]] ?? '';
        this.opts.console.print(text);
        if (ev[i + 2] === PRINT_CHAT && this.opts.cvars.num('cl_chatsound') !== 0) this.audio.local('misc/talk.wav');
        return;
      }
      case EV_CENTER: {
        const target = ev[i + 1];
        if (target === -1 || target === me) this.hud.centerPrint(strs[ev[i + 2]] ?? '', now);
        return;
      }
      case EV_DAMAGE: {
        if (ev[i + 1] !== this.viewSlot()) return;
        const snap = this.confirmed.latest();
        const o = this.pose.origin;
        this.view.parseDamage(ev[i + 2], ev[i + 3], [fv[5], fv[6], fv[7]], o, this.input.viewangles);
        this.hud.pain(this.selfTime);
        void snap;
        return;
      }
      case EV_KICK:
        if (ev[i + 1] === me && !own) this.view.punch(ev[i + 2] === 1);
        return;
      case EV_STUFF: {
        const target = ev[i + 1];
        if (target === -1 || target === me) this.stuffText(strs[ev[i + 2]] ?? '');
        return;
      }
      case EV_LIGHTSTYLE:
        if (ev[i + 1] >= 0 && ev[i + 1] < 64) this.lightstyles[ev[i + 1]] = strs[ev[i + 2]] ?? 'm';
        return;
      case EV_INTERMISSION:
        this.pushRenderEvent(ev, i);
        return;
      case EV_OBITUARY: {
        const victim = ev[i + 1], killer = ev[i + 2];
        const vn = this.slotName(victim), kn = killer >= 0 ? this.slotName(killer) : '';
        this.hud.kill(killer >= 0 && killer !== victim ? kn : '', vn, ev[i + 3], victim === me || killer === me, now);
        return;
      }
      case EV_MATCH:
        this.match = {
          phase: ev[i + 1], score1: ev[i + 2], score2: ev[i + 3], round: ev[i + 4], mode: this.mode,
          left: -1,
        };
        this.matchEnd = fv[5];
        this.matchCountdown = fv[6];
        return;
      case EV_CHANGELEVEL: {
        const name = this.app.sim.mapName(ev[i + 1]);
        this.app.sim.forgetNames();
        this.lightstyles = this.app.sim.lightstyles(this.worldH());
        if (name && name !== this.mapName) {
          this.mapName = name;
          void this.renderer?.loadMap(name).catch((e) => console.warn(e));
        }
        return;
      }
      case EV_PICKUP:
        if (ev[i + 1] === me) this.view.bonusFlash();
        return;
    }
  }

  private matchEnd = 0;
  private matchCountdown = 0;
  /** world tick count at the last changelevel (sim time = 1 + (ticks - base) × 0.013) */
  /**
   * The frame at which the current map started (sim time 1.0): QW's sv.time restarts on a
   * changelevel. Sim time at frame f = 1 + (f - mapStartFrame) × 0.013.
   */
  private mapStartFrame = NaN;
  private simTimeAt(frame: number): number { return Number.isFinite(this.mapStartFrame) ? 1 + (frame - this.mapStartFrame) * TICK_SECONDS : 1; }

  /** QW CL_ParseTEnt's sounds, then the effect for the renderer. */
  private tempEntity(ev: Int32Array, i: number): void {
    const te = ev[i + 1];
    const fv = new Float32Array(ev.buffer, ev.byteOffset + i * 4, EVENT_WORDS);
    const o = [fv[5], fv[6], fv[7]];
    if (te === TE_EXPLOSION || te === TE_TAREXPLOSION) this.audio.start(-1, 0, 'weapons/r_exp3.wav', o, 1, 1);
    else if (te === TE_SPIKE || te === TE_SUPERSPIKE) {
      const r = Math.random();
      this.audio.start(-1, 0, r < 0.8 ? 'weapons/tink1.wav' : r < 0.87 ? 'weapons/ric1.wav' : r < 0.93 ? 'weapons/ric2.wav' : 'weapons/ric3.wav', o, 1, 1);
    } else if (te === TE_WIZSPIKE) this.audio.start(-1, 0, 'wizard/hit.wav', o, 1, 1);
    else if (te === TE_KNIGHTSPIKE) this.audio.start(-1, 0, 'hknight/hit.wav', o, 1, 1);
    this.pushRenderEvent(ev, i);
  }

  private pushRenderEvent(ev: Int32Array, i: number): void {
    const f = this.frame;
    if (f.eventCount >= f.events.length) f.events.push({ kind: 0, a: 0, b: 0, c: 0, d: 0, x: 0, y: 0, z: 0, ex: 0, ey: 0, ez: 0 });
    const r = f.events[f.eventCount++];
    const fv = new Float32Array(ev.buffer, ev.byteOffset + i * 4, EVENT_WORDS);
    r.kind = ev[i]; r.a = ev[i + 1]; r.b = ev[i + 2]; r.c = ev[i + 3]; r.d = ev[i + 4];
    r.x = fv[5]; r.y = fv[6]; r.z = fv[7];
    if (ev[i] === EV_TEMP) { r.ex = fv[8]; r.ey = fv[9]; r.ez = fv[4]; } else { r.ex = 0; r.ey = 0; r.ez = 0; }
  }

  /** stufftext from the mod, through a whitelist (never binds, never cvars that matter). */
  private stuffText(text: string): void {
    const allowed = new Set(['bf', 'echo', 'play', 'playvol', 'centerview', 'v_cshift', 'cmd', 'menu_end']);
    const cmds = this.opts.cmds;
    cmds.restricted = (n) => allowed.has(n);
    try { cmds.exec(text); } finally { cmds.restricted = null; }
  }

  // ------------------------------------------------------------------ people

  private viewSlot(): number { return this.mySlot >= 0 ? this.mySlot : this.specFree ? -1 : this.specTarget; }

  private refreshNames(now: number): void {
    if (now - this.namesAt < 500) return;
    this.namesAt = now;
    const h = this.worldH();
    if (!h) return;
    const sim = this.app.sim;
    const n = this.app.maxclients;
    const out: typeof this.names = [];
    for (let s = 0; s < n; s++) {
      const info = parseInfo(sim.clientInfo(h, s));
      out.push({
        name: (info.get('name') || `player${s}`).slice(0, 24), team: info.get('team') ?? '',
        top: Number(info.get('topcolor')) || 0, bottom: Number(info.get('bottomcolor')) || 0, bot: info.get('*bot') === '1',
      });
    }
    this.names = out;
  }

  slotName(slot: number): string { return this.names[slot]?.name ?? `player${slot}`; }

  private scoreRows(now: number, snap: Snap): { rows: PlayerRow[]; teams: TeamRow[] } {
    if (now - this.rowsCache.at < 250) return this.rowsCache;
    const rows: PlayerRow[] = [];
    const r = snap.rows;
    const myId = this.opts.playerId;
    const viewed = snap.viewSlot;
    for (let s = 0; s < r.length / ROW_WORDS; s++) {
      const o = s * ROW_WORDS;
      const state = r[o + R_STATE];
      if (state === 0) continue;
      const nm = this.names[s];
      const id = snap.slots[s];
      const ping = id === myId ? Math.round(this.net?.lockstep.roundTripMs ?? 0) : id ? this.pings.get(id) ?? 0 : state === CLIENT_BOT ? 0 : 0;
      rows.push({
        slot: s, name: nm?.name ?? `player${s}`, team: nm?.team ?? '', top: r[o + R_TOP], bottom: r[o + R_BOTTOM],
        frags: r[o + R_FRAGS], ping, bot: state === CLIENT_BOT || state === CLIENT_IDLE, me: s === viewed,
        stats: r.subarray(o + R_STATS, o + R_STATS + 24), minutes: 0,
      });
    }
    rows.sort((a, b) => b.frags - a.frags || (a.stats[ST.deaths] ?? 0) - (b.stats[ST.deaths] ?? 0) || a.slot - b.slot);
    const teams: TeamRow[] = [];
    if (this.teamplay) {
      const by = new Map<string, TeamRow>();
      const mine = this.names[viewed]?.team ?? '';
      for (const p of rows) {
        let t = by.get(p.team);
        if (!t) { t = { team: p.team || '----', frags: 0, players: 0, ping: 0, mine: p.team === mine, top: p.top, bottom: p.bottom }; by.set(p.team, t); }
        t.frags += p.frags; t.players++; t.ping += p.ping;
      }
      for (const t of by.values()) { t.ping = Math.round(t.ping / Math.max(1, t.players)); teams.push(t); }
      teams.sort((a, b) => b.frags - a.frags);
    }
    this.rowsCache = { rows, teams, at: now };
    return this.rowsCache;
  }

  private onAppMessage(player: string | null, data: unknown): void {
    if (!player || typeof data !== 'object' || data === null) return;
    const d = data as { say?: unknown; team?: unknown; ping?: unknown };
    if (typeof d.ping === 'number' && Number.isFinite(d.ping)) this.pings.set(player, Math.max(0, Math.min(9999, Math.round(d.ping))));
    if (typeof d.say === 'string' && d.say.trim()) {
      const snap = this.confirmed.latest();
      const slot = snap ? snap.slots.indexOf(player) : -1;
      const name = slot >= 0 ? this.slotName(slot) : `spectator`;
      const text = d.say.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 120);
      if (d.team) {
        const mySlot = this.mySlot;
        const myTeam = mySlot >= 0 ? this.names[mySlot]?.team : null;
        if (slot >= 0 && myTeam !== null && this.names[slot]?.team !== myTeam) return;
        this.opts.console.print(`(${name}): ${text}\n`);
      } else this.opts.console.print(`${name}: ${text}\n`);
      if (this.opts.cvars.num('cl_chatsound') !== 0 || !this.opts.cvars.has('cl_chatsound')) this.audio.local('misc/talk.wav');
    }
  }

  say(text: string, team: boolean): void {
    if (!this.net) { this.opts.console.print(`${text}\n`); return; }
    if (!this.net.sendAppMessage(team ? { say: text, team: 1 } : { say: text })) this.opts.console.print('not connected\n');
  }

  /** A console command for the mod (`ready`, `break`, `kill`, `vote …`): `{ k }`. */
  modCommand(line: string): boolean {
    const c = cleanCommand(line);
    if (!c || !this.net) return false;
    return this.net.sendSimInput({ k: c });
  }

  /** `bf`: the bonus flash (item pickups, stuffed by the mod). */
  bonusFlash(): void { this.view.bonusFlash(); }

  /**
   * ezQuake's `weapon 7 5 4 3 2 1`: the first listed weapon we own and have ammo
   * for, as its impulse. Reads the predicted ClientView (what the HUD shows).
   */
  weaponCommand(list: number[]): void {
    const cv = this.selfRing.latest()?.cv ?? this.confirmed.latest()?.cv;
    if (!cv) return;
    const items = cv[CV.items];
    const has = [0, 4096, 1, 2, 4, 8, 16, 32, 64];
    const ammo = [0, 0, cv[CV.shells], cv[CV.shells] >= 2 ? 1 : 0, cv[CV.nails], cv[CV.nails] >= 2 ? 1 : 0, cv[CV.rockets], cv[CV.rockets], cv[CV.cells]];
    for (const w of list) {
      if (!(w >= 1 && w <= 8)) continue;
      if (!(items & has[w])) continue;
      if (w > 1 && ammo[w] <= 0) continue;
      this.opts.cmds.exec(`impulse ${w}`);
      return;
    }
  }

  join(play: boolean): void {
    this.wantPlay = play;
    if (!this.net) return;
    if (play) { this.net.sendSimInput({ u: this.opts.userinfo() }); this.net.sendSimInput({ j: 1 }); this.joinSentAt = performance.now(); }
    else this.net.sendSimInput({ j: 0 });
  }

  /** Name/colour now and then: userinfo after a change, our ping every 3 s. */
  private chatter(now: number): void {
    const net = this.net;
    if (!net || !net.lockstep.connected) return;
    if (this.wantPlay && this.mySlot < 0 && now - this.joinSentAt > 4000) {
      this.join(true);
      if (this.joinSentAt > 0 && now > 6000 + this.connectedAt && this.mySlot < 0) this.notice = 'Server full - spectating';
    }
    if (this.mySlot >= 0 && this.notice === 'Server full - spectating') this.notice = '';
    if (this.userinfoDirty) { this.userinfoDirty = false; net.sendSimInput({ u: this.opts.userinfo() }); }
    if (now >= this.pingAt) {
      this.pingAt = now + 3000;
      const rtt = net.lockstep.roundTripMs;
      if (rtt !== null && !net.offline) {
        net.sendAppMessage({ ping: Math.round(rtt) });
        // the server list shows this node's real ping next time
        const node = net.nodeId;
        if (node) rememberNodeRtt(node, rtt);
      }
    }
    void this.helloAt;
  }

  private connectedAt = 0;
  private fatalShown = false;

  /** The world cannot go on (a QuakeC error): say so once, and leave. */
  private fatal(text: string): void {
    if (this.fatalShown) return;
    this.fatalShown = true;
    this.opts.console.print(`${text}\n`);
    setTimeout(() => this.onLeave?.(text), 0);
  }

  // ------------------------------------------------------------------ the frame

  private loop(): void {
    const tick = (now: number): void => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(tick);
      try { this.draw(now); } catch (err) { console.error(err); }
    };
    this.raf = requestAnimationFrame(tick);
  }

  private selfTime = 0;

  /** The two drawn clocks this frame (absolute fractional frames). */
  private times(now: number): { others: number; self: number; predicted: boolean } | null {
    if (this.demo) {
      const dt = this.lastNow ? Math.min(0.25, (now - this.lastNow) / 1000) : 0;
      const speed = this.demoPaused ? 0 : this.opts.cvars.num('cl_demospeed') || 1;
      this.demoClock += dt * TICRATE * speed;
      // step the demo up to the clock, at most a second of ticks per frame
      let n = 0;
      const start = this.opts.demo!.startFrame;
      while (!this.demo.done && this.demo.frame < start + this.demoClock + 1 && n++ < TICRATE) this.demo.step();
      if (this.demo.done) this.demoClock = Math.min(this.demoClock, this.demo.frame - start - 1);
      const t = start + this.demoClock;
      return { others: t, self: t, predicted: false };
    }
    const ls = this.net!.lockstep;
    const t = renderTimes(ls.view(now));
    if (!t) return null;
    return { others: t.others, self: t.self, predicted: t.drawSelfFromPrediction };
  }

  /** rAF timestamp of the last drawn frame (the probe's `at`). */
  lastDrawAt = 0;

  private draw(now: number): void {
    this.lastDrawAt = now;
    if (!this.drawnSince) this.drawnSince = now;
    this.drawn++;
    this.fpsFrames++;
    if (now - this.fpsAt >= 500) { this.fps = (this.fpsFrames * 1000) / Math.max(1, now - this.fpsAt); this.fpsAt = now; this.fpsFrames = 0; }
    const dt = this.lastNow ? Math.min(0.1, (now - this.lastNow) / 1000) : 0;
    this.input.frame(dt);
    const t = this.times(now);
    this.lastNow = now;
    if (this.net?.lockstep.connected && !this.connectedAt) { this.connectedAt = now; if (this.wantPlay) this.join(true); }
    this.chatter(now);
    this.refreshNames(now);
    if (this.ambientsFor !== this.mapName && this.worldH() && this.audio.ctx?.state === 'running') this.startAmbients(this.mapName);
    this.frame.eventCount = 0;

    const cv = this.opts.cvars;
    const f = this.frame;
    const pair = t ? this.confirmed.pair(t.others) : null;
    this.lastTimes = t;
    if (!t || !pair) {
      this.hudFrame(now, null, null, 0);
      return;
    }
    // events of ticks the drawn clocks have reached
    this.releaseConfirmed(Math.floor(t.others) + 1);
    if (t.predicted) this.releasePredicted(Math.floor(t.self) + 1);

    const { a, b, frac } = pair;
    f.time = t.others * TICK_SECONDS;
    this.selfTime = t.self * TICK_SECONDS;
    f.lightstyles = this.lightstyles;

    // --- the viewed player's ClientView pair: predicted ring at self, else confirmed
    let ca: Int32Array | null = null, cb: Int32Array | null = null, cfrac = 0;
    let selfEnts: { a: SelfSnap; b: SelfSnap; frac: number } | null = null;
    if (this.mySlot >= 0 && t.predicted) {
      const sp = this.selfRing.pair(t.self);
      if (sp) { ca = sp.a.cv; cb = sp.b.cv; cfrac = sp.frac; selfEnts = sp; }
    }
    if (!ca) {
      const cp = this.confirmed.pair(this.mySlot >= 0 ? t.self : t.others);
      if (cp && cp.a.cv && cp.b.cv && cp.a.viewSlot === cp.b.viewSlot) { ca = cp.a.cv; cb = cp.b.cv; cfrac = cp.frac; }
      else if (cp?.b.cv) { ca = cb = cp.b.cv; cfrac = 0; }
    }

    // --- camera
    const cam = f.camera;
    cam.fov = cv.num('fov') || 90;
    let viewmodelBob = 0;
    const spectating = this.mySlot < 0 && !this.demo;
    let drawCv: Int32Array | null = null;
    if (ca && cb) {
      poseFrom(ca, cb, cfrac, this.pose);
      drawCv = cfrac < 0.5 ? ca : cb;
      const following = this.mySlot < 0;
      const angles = following ? this.pose.vAngle : this.input.viewangles;
      if (following && !this.demo && cv.num('cl_chasecam')) {
        this.chaseCamera(cam, this.pose);
      } else {
        viewmodelBob = this.view.calc(cam, this.pose, this.pose.dead && !following ? [this.input.viewangles[0], this.input.viewangles[1], 0] : angles, this.selfTime, following);
      }
      f.viewEntity = drawCv[CV.entnum];
      this.audio.viewEntity = drawCv[CV.entnum];
    } else {
      // free-fly spectator (or nothing to look at yet)
      this.freeFly(dt);
      cam.origin[0] = this.specOrigin[0]; cam.origin[1] = this.specOrigin[1]; cam.origin[2] = this.specOrigin[2];
      cam.angles[0] = this.input.viewangles[0]; cam.angles[1] = this.input.viewangles[1]; cam.angles[2] = 0;
      cam.blend[3] = 0;
      f.viewEntity = 0;
      this.audio.viewEntity = 0;
    }
    if (ca && cb) { cam.blend[0] = this.view.blend[0]; cam.blend[1] = this.view.blend[1]; cam.blend[2] = this.view.blend[2]; cam.blend[3] = this.view.blend[3]; }
    if (spectating) this.spectatorControls(b);

    // --- viewmodel
    if (drawCv && ca && cb && !this.pose.dead && !this.pose.intermission && !(this.mySlot < 0 && cv.num('cl_chasecam') && !this.demo) && cv.num('r_drawviewmodel') !== 0) {
      const vm = f.viewmodel ?? (f.viewmodel = { model: '', frame: 0, prevFrame: -1, frameLerp: 0, effects: 0, bob: 0 });
      vm.model = this.modelName(cb[CV.weaponmodel]);
      vm.frame = cb[CV.weaponframe];
      vm.prevFrame = -1;
      vm.frameLerp = 0;
      vm.effects = drawCv[CV.effects];
      vm.bob = viewmodelBob;
      if (!vm.model) f.viewmodel = null;
    } else f.viewmodel = null;

    // --- entities
    this.buildEntities(a, b, frac, selfEnts, drawCv);

    // --- sound listener
    angleVectors(cam.angles, this.fwd, this.right, this.up);
    this.audio.setListener(cam.origin, this.right);

    const r0 = performance.now();
    this.renderer?.draw(f);
    this.renderMs = performance.now() - r0;
    this.adaptResolution(now);
    this.hudFrame(now, b, drawCv, t.others);
  }

  private readonly fwd = [0, 0, 0];
  private readonly right = [0, 0, 0];
  private readonly up = [0, 0, 0];
  private renderMs = 0;

  // ------------------------------------------------------------------ adaptive resolution
  // r_dynres: the frame interval is the measure (it includes GPU time, which renderMs does
  // not). Over 22 ms on average (under ~45 fps) the render scale steps down, under 14 ms it
  // steps back up to r_scale. A vsynced 60 Hz display sits at 16.7 ms and never moves.
  private dynScale = 1;
  private dynLast = 0;
  private dynSum = 0;
  private dynCount = 0;
  private adaptResolution(now: number): void {
    const dt = this.dynLast ? now - this.dynLast : 0;
    this.dynLast = now;
    if (dt <= 0 || dt > 250) return; // first frame, or a hidden tab
    this.dynSum += dt;
    if (++this.dynCount < 30) return;
    const avg = this.dynSum / this.dynCount;
    this.dynSum = 0; this.dynCount = 0;
    const c = this.opts.cvars;
    const enabled = !c.has('r_dynres') || c.num('r_dynres') !== 0;
    let next = enabled ? this.dynScale : 1;
    if (enabled && avg > 22) next = Math.max(0.5, this.dynScale * 0.85);
    else if (enabled && avg < 14) next = Math.min(1, this.dynScale * 1.1);
    if (Math.abs(next - this.dynScale) < 0.01) return;
    this.dynScale = next;
    const user = c.has('r_scale') ? Math.max(0.25, Math.min(1, c.num('r_scale') || 1)) : 1;
    this.renderer?.setSettings?.({ resolutionScale: user * next });
  }

  private buildEntities(a: Snap, b: Snap, frac: number, selfEnts: { a: SelfSnap; b: SelfSnap; frac: number } | null, drawCv: Int32Array | null): void {
    const f = this.frame;
    const ia = indexOf(a);
    const A = a.ents, B = b.ents, FA = f32(A), FB = f32(B);
    const nb = B.length / ENT_WORDS;
    const myEnt = this.myEnt;
    const viewEnt = drawCv ? drawCv[CV.entnum] : -1;
    const ownFromPrediction = !!selfEnts && this.opts.cvars.num('cl_predict_projectiles') !== 0;
    const thirdPerson = this.mySlot < 0 && !this.demo && this.opts.cvars.num('cl_chasecam') !== 0;
    const maxc = this.app.maxclients;
    let n = 0;
    this.drawnBodies.clear();
    for (let j = 0; j < nb; j++) {
      const ob = j * ENT_WORDS;
      const num = B[ob + E_NUM];
      const move = B[ob + E_MOVE];
      if (ownFromPrediction && B[ob + E_OWNER] === myEnt && isProjectile(move)) continue;
      if (num === myEnt && selfEnts) continue;           // our body comes from the prediction below
      const ja = ia.get(num);
      const same = ja !== undefined && A[ja * ENT_WORDS + E_SERIAL] === B[ob + E_SERIAL];
      const oa = same ? ja! * ENT_WORDS : ob;
      const SA = same ? A : B, FSA = same ? FA : FB;
      const e = this.entSlot(n++);
      const proj = isProjectile(move);
      let k = frac;
      if (same) {
        const dx = FB[ob + E_ORIGIN] - FSA[oa + E_ORIGIN], dy = FB[ob + E_ORIGIN + 1] - FSA[oa + E_ORIGIN + 1], dz = FB[ob + E_ORIGIN + 2] - FSA[oa + E_ORIGIN + 2];
        if (Math.abs(dx) > TELEPORT || Math.abs(dy) > TELEPORT || Math.abs(dz) > TELEPORT) k = frac < 0.5 ? 0 : 1;
      }
      if (!same && proj && frac < 1) {
        // fired during this tick: a projectile is a computable line, run it back along its velocity
        const back = (1 - frac) * TICK_SECONDS;
        e.origin[0] = FB[ob + E_ORIGIN] - FB[ob + E_VELOCITY] * back;
        e.origin[1] = FB[ob + E_ORIGIN + 1] - FB[ob + E_VELOCITY + 1] * back;
        e.origin[2] = FB[ob + E_ORIGIN + 2] - FB[ob + E_VELOCITY + 2] * back;
      } else {
        for (let c = 0; c < 3; c++) (e.origin as unknown as number[])[c] = FSA[oa + E_ORIGIN + c] + (FB[ob + E_ORIGIN + c] - FSA[oa + E_ORIGIN + c]) * k;
      }
      for (let c = 0; c < 3; c++) (e.angles as unknown as number[])[c] = lerpAngle(FSA[oa + E_ANGLES + c], FB[ob + E_ANGLES + c], k);
      this.fillEnt(e, B, FB, ob, SA, oa, k, num === viewEnt && !thirdPerson);
      if (num >= 1 && num <= maxc && num !== myEnt) {
        const id = b.slots[num - 1] || `bot${num - 1}`;
        this.drawnBodies.set(id, { x: e.origin[0] * 0.0254, y: e.origin[1] * 0.0254, z: e.origin[2] * 0.0254 });
      }
    }
    // our body and our own projectiles, from the prediction at the self clock
    if (selfEnts) {
      const PA = selfEnts.a.ents, PB = selfEnts.b.ents, PFA = f32(PA), PFB = f32(PB);
      const pia = indexOf(selfEnts.a);
      const sf = selfEnts.frac;
      for (let j = 0, np = PB.length / ENT_WORDS; j < np; j++) {
        const ob = j * ENT_WORDS;
        const num = PB[ob + E_NUM];
        const own = num === myEnt || (ownFromPrediction && PB[ob + E_OWNER] === myEnt && isProjectile(PB[ob + E_MOVE]));
        if (!own) continue;
        const ja = pia.get(num);
        const same = ja !== undefined && PA[ja * ENT_WORDS + E_SERIAL] === PB[ob + E_SERIAL];
        const oa = same ? ja! * ENT_WORDS : ob;
        const SA = same ? PA : PB, FSA = same ? PFA : PFB;
        const e = this.entSlot(n++);
        if (num === myEnt) {
          // the body is where the camera is: the same pose
          for (let c = 0; c < 3; c++) (e.origin as unknown as number[])[c] = this.pose.origin[c];
          e.angles[0] = -this.input.viewangles[0] / 3; e.angles[1] = this.input.viewangles[1]; e.angles[2] = 0;
        } else if (!same && sf < 1) {
          const back = (1 - sf) * TICK_SECONDS;
          for (let c = 0; c < 3; c++) (e.origin as unknown as number[])[c] = PFB[ob + E_ORIGIN + c] - PFB[ob + E_VELOCITY + c] * back;
          for (let c = 0; c < 3; c++) (e.angles as unknown as number[])[c] = PFB[ob + E_ANGLES + c];
        } else {
          for (let c = 0; c < 3; c++) (e.origin as unknown as number[])[c] = FSA[oa + E_ORIGIN + c] + (PFB[ob + E_ORIGIN + c] - FSA[oa + E_ORIGIN + c]) * sf;
          for (let c = 0; c < 3; c++) (e.angles as unknown as number[])[c] = lerpAngle(FSA[oa + E_ANGLES + c], PFB[ob + E_ANGLES + c], sf);
        }
        this.fillEnt(e, PB, PFB, ob, SA, oa, sf, num === myEnt);
      }
    }
    f.entityCount = n;
    f.thirdPerson = thirdPerson;
  }

  private entSlot(i: number): RenderEntity {
    const list = this.frame.entities;
    if (i >= list.length) list.push({ num: 0, serial: 0, model: '', frame: 0, prevFrame: -1, frameLerp: 0, skin: 0, colors: null, effects: 0, origin: [0, 0, 0], angles: [0, 0, 0], alpha: 1, isLocalPlayer: false });
    return list[i];
  }

  private readonly colorCache: { top: number; bottom: number }[] = [];

  private fillEnt(e: RenderEntity, B: Int32Array, FB: Float32Array, ob: number, A: Int32Array, oa: number, k: number, local: boolean): void {
    e.num = B[ob + E_NUM];
    e.serial = B[ob + E_SERIAL];
    e.model = this.modelName(B[ob + E_MODEL]);
    e.frame = B[ob + E_FRAME];
    // QW animates at 10 Hz (think every 0.1 s): the renderer lerps a frame change over that
    // tenth on the drawn sim clock (r_lerpmodels), not over one 13 ms tick.
    e.prevFrame = -1;
    e.frameLerp = 0;
    void A; void oa; void k;
    e.skin = B[ob + E_SKIN];
    e.effects = B[ob + E_EFFECTS];
    const alpha = FB[ob + E_ALPHA];
    e.alpha = alpha > 0 && alpha <= 1 ? alpha : 1;
    e.isLocalPlayer = local;
    const cm = B[ob + E_COLORMAP];
    if (cm > 0) {
      const snap = this.confirmed.latest();
      const r = snap?.rows;
      const slot = cm - 1;
      const c = this.colorCache[slot] ?? (this.colorCache[slot] = { top: 0, bottom: 0 });
      if (r && slot * ROW_WORDS < r.length) { c.top = r[slot * ROW_WORDS + R_TOP]; c.bottom = r[slot * ROW_WORDS + R_BOTTOM]; }
      e.colors = c;
    } else e.colors = null;
  }

  // ------------------------------------------------------------------ spectating

  private spectatorControls(b: Snap): void {
    const attack = this.input.down('attack'), jump = this.input.down('jump');
    const live: number[] = [];
    for (let s = 0; s < b.rows.length / ROW_WORDS; s++) if (b.rows[s * ROW_WORDS + R_STATE] !== 0) live.push(s);
    if (attack && !this.specPrev.attack && live.length) {
      // [ATTACK] follows the next player
      const i = live.indexOf(this.specTarget);
      this.specTarget = live[(i + 1) % live.length];
      this.specFree = false;
    }
    if (jump && !this.specPrev.jump) {
      // [JUMP] goes back to flying around
      if (!this.specFree) {
        this.specFree = true;
        this.specOrigin = [this.pose.origin[0], this.pose.origin[1], this.pose.origin[2] + 22];
        this.input.setAngles(this.pose.vAngle[0], this.pose.vAngle[1]);
      }
    }
    if (!this.specFree && !live.includes(this.specTarget)) this.specFree = true;
    this.specPrev.attack = attack; this.specPrev.jump = jump;
  }

  private freeFly(dt: number): void {
    const va = this.input.viewangles;
    angleVectors(va, this.fwd, this.right, this.up);
    const cmd = this.peekMove();
    const speed = 500 / 400;
    for (let c = 0; c < 3; c++) this.specOrigin[c] += (this.fwd[c] * cmd.forward + this.right[c] * cmd.side + (c === 2 ? cmd.up : 0)) * speed * dt;
  }

  /** The movement keys right now, without consuming the beat's latches. */
  private peekMove(): { forward: number; side: number; up: number } {
    const i = this.input;
    const c = this.opts.cvars;
    return {
      forward: (i.down('forward') ? c.num('cl_forwardspeed') : 0) - (i.down('back') ? c.num('cl_backspeed') : 0),
      side: (i.down('moveright') ? c.num('cl_sidespeed') : 0) - (i.down('moveleft') ? c.num('cl_sidespeed') : 0),
      up: (i.down('moveup') || i.down('jump') ? c.num('cl_upspeed') : 0) - (i.down('movedown') ? c.num('cl_upspeed') : 0),
    };
  }

  private chaseCamera(cam: RenderFrame['camera'], pose: SelfPose): void {
    angleVectors(pose.vAngle, this.fwd, this.right, this.up);
    for (let c = 0; c < 3; c++) (cam.origin as unknown as number[])[c] = pose.origin[c] - this.fwd[c] * 96 + (c === 2 ? 40 : 0);
    cam.angles[0] = pose.vAngle[0] + 10; cam.angles[1] = pose.vAngle[1]; cam.angles[2] = 0;
  }

  // ------------------------------------------------------------------ HUD

  private hudFrame(now: number, snap: Snap | null, cv: Int32Array | null, others: number): void {
    const net = this.net?.stats();
    const st = this.app.stats;
    let notice = this.notice;
    if (!snap) notice = this.demo ? 'Loading demo' : net && !net.connected ? this.net!.statusText : 'Joining';
    else if (net && this.net!.statusText !== 'Connected' && this.net!.statusText !== 'Offline') notice = this.net!.statusText;
    const rows = snap ? this.scoreRows(now, snap) : { rows: [], teams: [] };
    let match = this.match;
    if (match && cv) {
      // ClientView word 49 is the sim's own time (f32); the derived clock is the fallback
      const simTime = f32(cv)[CV.time];
      const tnow = simTime > 0 ? simTime : this.simTimeAt(others);
      const fcv = f32(cv);
      const phase = cv[CV.phase];
      const end = fcv[CV.phaseEnd] || this.matchEnd;
      match = { ...match, phase, left: end > 0 ? end - tnow : -1 };
      if (phase === 1 && this.matchCountdown > 0) match.left = this.matchCountdown - tnow;
    } else if (cv && cv[CV.phase] !== undefined && !match) {
      match = { phase: cv[CV.phase], left: -1, score1: 0, score2: 0, round: 0, mode: this.mode };
    }
    const intermission = !!cv && (cv[CV.intermission] !== 0 || cv[CV.phase] === PHASE_INTERMISSION);
    let specLine = '';
    if (this.mySlot < 0 && !this.demo) specLine = this.specFree ? 'SPECTATOR - [ATTACK] follow a player, type join to play' : `Tracking ${this.slotName(this.specTarget)} - [ATTACK] next, [JUMP] fly`;
    if (this.demo) specLine = `DEMO ${this.fmtTime(this.demo.pos * TICK_SECONDS)} / ${this.fmtTime(this.demo.length * TICK_SECONDS)}${this.demoPaused ? '  paused' : ''}  x${this.opts.cvars.num('cl_demospeed') || 1}`;
    const state: HudState = {
      now, time: this.selfTime, cv, spectator: this.mySlot < 0, specLine,
      rows: rows.rows, teams: rows.teams, teamplay: this.teamplay,
      showScores: this.input.showScores, intermission,
      match, notice,
      net: {
        fps: this.fps, ping: this.net?.lockstep.roundTripMs ?? null, delayMs: net?.delayMs ?? 0, lead: net?.lead ?? 0,
        rollbacks: net?.rollbacks ?? 0, mispredictions: net?.mispredictions ?? 0, desyncs: net?.desyncs ?? 0, starvations: net?.starvations ?? 0,
        stepUs: st.steps ? (st.stepMs / st.steps) * 1000 : 0, status: this.net?.statusText ?? null,
      },
      consoleFrac: 0,
      paused: false,
    };
    const free = !this.input.locked && this.keyDest() === 'game' && !this.demo;
    if (this.pause) this.pause.show(free && !!snap);
    else state.paused = free;
    this.hud.frame(state, (d) => { this.opts.console.draw(d, now, !!snap); });
  }

  private fmtTime(s: number): string { const t = Math.floor(s); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; }

  // ------------------------------------------------------------------ ambient sounds

  private ambientsFor = '';
  /** Wall-clock arrival of each live confirmed tick (tick stability measurement). */
  private readonly arrivals = new Float64Array(4096);
  private arrivalAt = 0;

  /** Intervals between confirmed ticks as this page received them, over the last `n` ticks. */
  tickStats(n = 2000): { ticks: number; hz: number; meanMs: number; p50: number; p90: number; p99: number; max: number; sd: number; late3: number } | null {
    const count = Math.min(n, this.arrivalAt, this.arrivals.length) - 1;
    if (count < 10) return null;
    const iv: number[] = [];
    for (let k = this.arrivalAt - count; k < this.arrivalAt; k++) iv.push(this.arrivals[k % this.arrivals.length] - this.arrivals[(k - 1) % this.arrivals.length]);
    const span = this.arrivals[(this.arrivalAt - 1) % this.arrivals.length] - this.arrivals[(this.arrivalAt - 1 - count) % this.arrivals.length];
    const sorted = [...iv].sort((a, b) => a - b);
    const q = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    const mean = iv.reduce((a, b) => a + b, 0) / iv.length;
    const sd = Math.sqrt(iv.reduce((a, b) => a + (b - mean) * (b - mean), 0) / iv.length);
    const period = 1000 / TICRATE;
    return { ticks: count, hz: (count * 1000) / span, meanMs: mean, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: sorted[sorted.length - 1], sd, late3: iv.filter((x) => x > 3 * period).length };
  }

  /** QW static sounds (ambientsound): from the engine's list, else the map's ambient_* entities. */
  private startAmbients(map: string): void {
    this.ambientsFor = map;
    this.audio.stopStatics();
    const level = this.opts.cvars.has('ambient_level') ? this.opts.cvars.num('ambient_level') : 0.3;
    if (level <= 0) return;
    const vol = Math.min(1, level / 0.3);
    const h = this.worldH();
    const ex = this.app.sim.ex;
    if (h && ex.world_ambients) {
      const ptr = ex.world_ambients(h);
      if (ptr) {
        const n = new Uint32Array(ex.memory.buffer, ptr, 1)[0];
        const w = new Int32Array(ex.memory.buffer, ptr + 4, n * 6).slice();
        const fw = new Float32Array(w.buffer);
        for (let i = 0; i < n; i++) {
          const o = i * 6;
          this.audio.startStatic(this.soundName(w[o]), [fw[o + 3], fw[o + 4], fw[o + 5]], (w[o + 1] / 255) * vol, w[o + 2] / 64);
        }
        return;
      }
    }
    if (!this.opts.vfs) return;
    const bsp = this.opts.vfs.get(`maps/${map}.bsp`);
    if (!bsp) return;
    for (const m of bspEntities(bsp).matchAll(/\{([^}]*)\}/g)) {
      const cls = /"classname"\s+"([^"]+)"/.exec(m[1])?.[1] ?? '';
      const amb = AMBIENT_SOUNDS[cls];
      if (!amb) continue;
      const o = (/"origin"\s+"([^"]+)"/.exec(m[1])?.[1] ?? '0 0 0').split(/\s+/).map(Number);
      this.audio.startStatic(amb[0], o, amb[1] * vol, 3);       // ATTN_STATIC
    }
  }

  // ------------------------------------------------------------------ demos

  startRecording(): string {
    if (this.recorder && !this.recorder.stopped) return 'already recording';
    const ls = this.net?.lockstep;
    const s = ls?.world.state;
    if (!ls || !s) return 'not connected';
    const name = this.slotName(this.mySlot);
    this.recorder = new DemoRecorder(this.app, s, ls.frame, {
      serverinfo: this.opts.serverinfo, packs: this.opts.packs, maps: [...this.opts.maps.keys()],
      player: this.opts.playerId, playerName: name,
    }, () => this.net?.lockstep.world.state ?? null);
    return 'recording';
  }

  async stopRecording(name: string): Promise<string> {
    if (!this.recorder || this.recorder.stopped) return 'not recording';
    const d = this.recorder.stop();
    const bytes = encodeDemo(d);
    try { await saveDemo(name, bytes); } catch (e) { return `could not store the demo: ${e}`; }
    downloadDemo(name, bytes);
    return `${name}: ${d.ticks.length} ticks, ${(bytes.length / 1024).toFixed(1)} KB`;
  }

  get recording(): boolean { return !!this.recorder && !this.recorder.stopped; }

  demoControl(cmd: string, arg?: string): void {
    if (!this.demo) return;
    if (cmd === 'pause') this.demoPaused = !this.demoPaused;
    else if (cmd === 'seek' && arg) {
      const target = Math.round(Number(arg) * TICRATE);
      this.confirmed.clear();
      this.cq.length = 0;
      this.demo.seek(target);
      this.demoClock = this.demo.frame - this.opts.demo!.startFrame - 1;
    }
  }

  // ------------------------------------------------------------------ lifecycle

  private readonly resize = (): void => {
    this.renderer?.resize(this.opts.host.clientWidth || innerWidth, this.opts.host.clientHeight || innerHeight, Math.min(2, devicePixelRatio || 1));
    this.hud.resize();
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    removeEventListener('resize', this.resize);
    for (const u of this.unsub) u();
    if (this.recorder && !this.recorder.stopped) void this.stopRecording(`autosave-${Date.now()}`);
    this.input.dispose();
    try { this.net?.leave(); } catch { /* gone */ }
    this.demo?.dispose();
    this.opts.console.onChat = null;
    this.opts.console.onToggle = null;
    this.hud.dispose();
    this.pause?.dispose();
    this.audio.dispose();
    this.renderer?.dispose?.();
    this.canvas.remove();
    this.confirmed.clear();
    this.selfRing.clear();
  }

  // ------------------------------------------------------------------ tests / probe

  debug(): Record<string, unknown> {
    const s = this.net?.stats();
    const snap = this.confirmed.latest();
    const cv = snap?.cv ?? null;
    const fc = cv ? f32(cv) : null;
    const st = this.app.stats;
    return {
      ...(s ?? {}), slot: this.mySlot, frame: this.net?.lockstep.frame ?? this.demo?.frame ?? 0,
      pos: fc ? [Math.round(fc[CV.origin]), Math.round(fc[CV.origin + 1]), Math.round(fc[CV.origin + 2])] : null,
      health: cv?.[CV.health] ?? null,
      frags: cv?.[CV.frags] ?? null,
      fps: this.drawn / Math.max(0.001, (performance.now() - this.drawnSince) / 1000),
      fpsNow: this.fps,
      stepUs: st.steps ? (st.stepMs / st.steps) * 1000 : 0,
      steps: st.steps, clones: st.clones, decodes: st.decodes,
      renderMs: this.renderMs,
      entities: this.frame.entityCount,
      liveWorlds: this.app.sim.liveCount,
      map: this.mapName,
      nodeFps: this.net?.nodeFps ?? 0,
      times: this.lastTimes,
    };
  }

  testHold(cmd: string, down: boolean): void { this.opts.cmds.exec(`${down ? '+' : '-'}${cmd} test`); }
  testLook(pitch: number, yaw: number): void { this.input.setAngles(pitch, yaw); }
  testImpulse(n: number): void { this.opts.cmds.exec(`impulse ${n}`); }

  /** Confirmed world summary for agreement checks across pages. */
  totals(): { frame: number; hash: number | undefined; frags: number } {
    const ls = this.net?.lockstep;
    const snap = this.confirmed.latest();
    let frags = 0;
    if (snap) for (let s = 0; s < snap.rows.length / ROW_WORDS; s++) frags += snap.rows[s * ROW_WORDS + R_FRAGS];
    const frame = ls?.frame ?? 0;
    return { frame, hash: ls?.world.hashAt((frame - 8) & ~3), frags };
  }

  /** For the arena probe: the confirmed sim's remote bodies (metres) at the newest frame. */
  simBodies(): Map<string, { x: number; y: number; z: number; vx: number; vy: number; vz: number }> {
    const out = new Map<string, { x: number; y: number; z: number; vx: number; vy: number; vz: number }>();
    const snap = this.confirmed.latest();
    if (!snap) return out;
    const fe = f32(snap.ents);
    for (let i = 0; i < snap.ents.length; i += ENT_WORDS) {
      const num = snap.ents[i + E_NUM];
      if (num < 1 || num > this.app.maxclients || num === this.myEnt) continue;
      const id = snap.slots[num - 1] || `bot${num - 1}`;
      const k = 0.0254;
      out.set(id, { x: fe[i + E_ORIGIN] * k, y: fe[i + E_ORIGIN + 1] * k, z: fe[i + E_ORIGIN + 2] * k, vx: fe[i + E_VELOCITY] * k, vy: fe[i + E_VELOCITY + 1] * k, vz: fe[i + E_VELOCITY + 2] * k });
    }
    return out;
  }

  /** The confirmed ring's entry at a frame, for the probe's own reconstruction. */
  bodyAt(frame: number, id: string): { x: number; y: number; z: number } | null {
    const snap = this.confirmed.get(frame);
    if (!snap) return null;
    const slot = id.startsWith('bot') ? Number(id.slice(3)) : snap.slots.indexOf(id);
    if (slot < 0) return null;
    const idx = indexOf(snap).get(slot + 1);
    if (idx === undefined) return null;
    const fe = f32(snap.ents);
    const o = idx * ENT_WORDS + E_ORIGIN;
    return { x: fe[o] * 0.0254, y: fe[o + 1] * 0.0254, z: fe[o + 2] * 0.0254 };
  }

  get slot(): number { return this.mySlot; }
  get session(): NetSession | null { return this.net; }
  get confirmedRing(): TicRing<Snap> { return this.confirmed; }
}

/** The entity lump of a BSP29/BSP2 as text (lump 0 in both). */
export function bspEntities(bsp: Uint8Array): string {
  if (bsp.length < 12) return '';
  const dv = new DataView(bsp.buffer, bsp.byteOffset, bsp.byteLength);
  const ofs = dv.getInt32(4, true), len = dv.getInt32(8, true);
  if (ofs < 0 || len <= 0 || ofs + len > bsp.length) return '';
  let s = '';
  for (let i = ofs; i < ofs + len && bsp[i]; i++) s += String.fromCharCode(bsp[i]);
  return s;
}

void CLIENT_WORDS; void CLIENT_HUMAN;
