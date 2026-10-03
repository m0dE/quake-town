/*
 * Quake Town — boot: prefetch the sim and the packs while the menu is up, then
 * a match (or a demo), then back to the menu.
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 *
 * URL parameters (tests and links; players normally come through the menu):
 *   #room=<roomId>            the menu's join flow for that room
 *   ?room=<roomId>            straight into that room (skips the menu)
 *   ?offline=1                practice against bots, no network (with ?mode= ?map= ?bots= ?maxclients=)
 *   ?spectate=1               join as a spectator
 *   ?central=<url> ?nodeUrl=<ws url> (or ?via=)   where to connect (the arrr harness passes these)
 *   ?app=<id>                 the arrr-network app id (default VITE_ARRR_APP_ID)
 *   ?name=<name>              player name for this tab
 *   ?fake=1                   the TS stand-in sim instead of public/qtsim.wasm
 *   ?probe=1                  install the arrr harness probe (arena judge)
 *   ?exec=<commands>          console text run at boot (tests: "r_preset classic")
 */
import { APP_ID as LISTED_APP_ID, API_KEY as LISTED_API_KEY } from './rooms/listing.js';
import './main.css';
import { lockstep } from 'arrr-network';
import { cvars as settingsCvars, binds, configs, settings, userinfo as settingsUserinfo, account } from './settings/index.js';
import { useCvars } from './console/cvars.js';
import { CommandSystem } from './console/commands.js';
import { Console } from './console/console.js';
import { Gfx, Draw2D } from './hud/gfx.js';
import { createContent } from './content/index.js';
import type { PackRef, Vfs } from './content/types.js';
import { QtSim } from './sim/qtsim.js';
import { createFakeSim } from './sim/fake.js';
import { decodeRoomId, defaultConfig, encodeRoomId, toServerinfo, isMode, type RoomConfig } from './rooms/index.js';
import type { PlayRequest } from './menu/index.js';
import type { Game } from './game/game.js';
import type { RendererLike } from './game/topdown.js';
import { decodeDemo, loadDemo, listDemos, type DemoFile } from './demo/demo.js';
import { infoGet } from './sim/wire.js';

declare const __BUILD_REV__: string;

const params = new URLSearchParams(location.search);
const central = params.get('central') ?? undefined;
const APP_ID = params.get('app') ?? LISTED_APP_ID;
const API_KEY = params.get('app') ? undefined : LISTED_API_KEY;
const FAKE = params.get('fake') === '1';

const root = document.getElementById('app')!;
const gameHost = document.getElementById('game')!;
const menuRoot = document.getElementById('menu')!;
const loading = document.getElementById('loading')!;
const loadingText = document.getElementById('loading-text')!;

// ------------------------------------------------------------------ console + settings

settings.start();
const cvars = useCvars();
const cmds = new CommandSystem(cvars, binds, configs, () => settings.exportText());
const con = new Console(cmds, cvars);
cmds.print(`Quake Town ${typeof __BUILD_REV__ === 'string' ? __BUILD_REV__ : 'dev'}\n`);
if (params.get('name')) cvars.set('name', params.get('name')!);
// ?exec=<console text>: settings for a test run ("r_preset classic; show_fps 1")
if (params.get('exec')) cmds.exec(params.get('exec')!);

// ------------------------------------------------------------------ prefetch

/** One content set for the page: base + the player's id paks (art only), then each room's packs. */
const content = createContent();
const loader = content.loader;
const BUILTIN_ROOM_PACKS = ['maps-lq', 'maps-qt', 'qtdm'];
/** Everything a match needs starts downloading now (the loader caches by sha256). */
const prefetchPacks = (async () => {
  try {
    await loader.index();
    // one at a time: the loader caches each verified pack by sha256 for the mounts that follow
    for (const n of ['base', ...BUILTIN_ROOM_PACKS]) await loader.resolve({ id: n }).catch((e) => console.warn(`[boot] prefetch ${n}:`, e));
  } catch (err) { console.warn('[boot] pack prefetch:', err); }
})();
const wasmBytes: Promise<Uint8Array | null> = FAKE ? Promise.resolve(null) : fetch('qtsim.wasm').then(async (r) => (r.ok ? new Uint8Array(await r.arrayBuffer()) : null)).catch(() => null);
const gameModule = import('./game/game.js');
gameModule.catch(() => { /* reported at play */ });

/** The renderer, if this build has one (src/render/renderer.ts). */
const rendererModules = import.meta.glob('./render/renderer.ts');
const previewModules = import.meta.glob('./render/preview.ts');

let gfx: Gfx | null = null;
let basePromise: Promise<{ vfs: Vfs; gfx: Gfx }> | null = null;
/**
 * The base pack (HUD pics, fonts, sounds) and the player's id paks, mounted once. After the
 * prefetch: two concurrent downloads of one URL make Chromium fail one (ERR_CACHE_WRITE_FAILURE).
 */
function base(): Promise<{ vfs: Vfs; gfx: Gfx }> {
  basePromise ??= (async () => {
    await prefetchPacks;
    try { await content.loadBase(); } catch (err) { console.warn('[boot] no base pack:', err); }
    gfx = new Gfx(content.vfs);
    return { vfs: content.vfs, gfx };
  })();
  return basePromise;
}

// ------------------------------------------------------------------ the console when no match is up

let consoleRaf = 0;
const idleCanvas = document.createElement('canvas');
idleCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:50;image-rendering:pixelated';
root.append(idleCanvas);
const idleDraw = { d: null as Draw2D | null, dirty: false };
function idleConsole(now: number): void {
  consoleRaf = requestAnimationFrame(idleConsole);
  const ctx = idleCanvas.getContext('2d')!;
  if (current) { if (idleDraw.dirty) { ctx.clearRect(0, 0, idleCanvas.width, idleCanvas.height); idleDraw.dirty = false; } return; }
  idleDraw.dirty = true;
  const w = Math.round(innerWidth * Math.min(2, devicePixelRatio)), h = Math.round(innerHeight * Math.min(2, devicePixelRatio));
  if (idleCanvas.width !== w || idleCanvas.height !== h) { idleCanvas.width = w; idleCanvas.height = h; }
  ctx.clearRect(0, 0, w, h);
  if (!gfx) return;
  const d = idleDraw.d ?? (idleDraw.d = new Draw2D(gfx));
  d.begin(ctx, Math.max(1, Math.round(w / 640)), w, h);
  con.draw(d, now, true);
}
consoleRaf = requestAnimationFrame(idleConsole);
addEventListener('keydown', (e) => {
  if (current) return;                       // the game's Input routes keys while a match is up
  if (e.code === 'Backquote' || e.key === '`' || e.key === '~') { e.preventDefault(); con.toggle(); return; }
  if (con.open) con.key(e);
});

// ------------------------------------------------------------------ playing

let current: Game | null = null;
let starting = false;
const simCache: { sim: QtSim | null; progs: Map<string, number>; maps: Map<string, number> } = { sim: null, progs: new Map(), maps: new Map() };

function playerId(): string {
  const s = account.session();
  if (s) return s.userId;
  try {
    const have = sessionStorage.getItem('qt.pid');
    if (have) return have;
    const id = (crypto.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/-/g, '').slice(0, 16);
    sessionStorage.setItem('qt.pid', id);
    return id;
  } catch { return `p${Math.random().toString(36).slice(2, 12)}`; }
}

function status(text: string): void { loading.classList.remove('hidden'); loadingText.textContent = text; console.info('[status]', text); }

// Nothing may fail silently: an uncaught error is shown on the page, not only in the console.
function showFatal(what: string): void {
  let el = document.getElementById('qt-fatal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'qt-fatal';
    el.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483647;padding:10px 14px;background:#3a1208;color:#ffd9c2;border:1px solid #c4502a;font:13px/1.4 system-ui,sans-serif;white-space:pre-wrap;cursor:pointer';
    el.title = 'Click to dismiss';
    el.onclick = () => el!.remove();
    document.body.append(el);
  }
  el.textContent = `Something went wrong: ${what}`;
}
window.addEventListener('error', (e) => { if (!/ResizeObserver/.test(e.message)) showFatal(e.message || String(e.error)); });
window.addEventListener('unhandledrejection', (e) => showFatal(e.reason instanceof Error ? e.reason.message : String(e.reason)));

async function makeRenderer(canvas: HTMLCanvasElement, vfs: Vfs): Promise<RendererLike | null> {
  const load = rendererModules['./render/renderer.ts'];
  if (!load || FAKE || params.get('renderer') === 'topdown') return null;
  const mod = await load() as { Renderer: new (c: HTMLCanvasElement, v: Vfs, s?: Record<string, unknown>) => RendererLike };
  const { renderSettingsFromCvars, watchRenderCvars } = await import('./game/render-settings.js');
  const r = new mod.Renderer(canvas, vfs, renderSettingsFromCvars(cvars) as unknown as Record<string, unknown>);
  const stop = watchRenderCvars(cvars, (s) => r.setSettings?.(s as unknown as Record<string, unknown>));
  const dispose = r.dispose?.bind(r);
  r.dispose = () => { stop(); dispose?.(); };
  return r;
}

/** Mount the room's packs and load progs + every map of the rotation into the (one) sim module. */
async function prepare(config: RoomConfig, serverinfo: string): Promise<{ vfs: Vfs; sim: QtSim; progsId: number; maps: Map<string, number>; packs: string[] }> {
  status('Loading packs');
  await base();
  const refs: PackRef[] = [];
  if (!FAKE) {
    for (const n of ['maps-lq', 'maps-qt']) refs.push({ id: n });
    refs.push(config.mod ? { id: config.mod.id, ...(config.mod.url ? { url: config.mod.url } : {}) } : { id: 'qtdm' });
    for (const p of config.packs) refs.push({ id: p.id, ...(p.url ? { url: p.url } : {}) });
  }
  await content.loadRoom(refs, (d, t) => status(`Loading packs ${t ? Math.round((d / t) * 100) : 0}%`));
  const vfs = content.vfs;
  const packs = vfs.mounts().filter((m) => m.role !== 'idpak').map((m) => m.id);

  status('Starting the simulation');
  if (!simCache.sim) {
    const bytes = await wasmBytes;
    simCache.sim = await QtSim.create(bytes ?? createFakeSim());
    if (!bytes) cmds.print('qtsim.wasm is not built: running the stand-in sim (flat arena)\n');
  }
  const sim = simCache.sim;
  const fake = sim.version === 0xfa4e0001;
  const simView: Vfs = vfs.sim;          // never the id paks: the sim reads only the room's packs
  const progs = fake ? new Uint8Array(4) : simView.get('qwprogs.dat');
  if (!progs) throw new Error('the room\'s mod has no qwprogs.dat');
  const progsKey = `${packs.join('.')}`;
  let progsId = simCache.progs.get(progsKey);
  if (progsId === undefined) { progsId = sim.loadProgs(progs); simCache.progs.set(progsKey, progsId); }
  const maps = new Map<string, number>();
  const rotation = (infoGet(serverinfo, 'rotation') || config.rotation.join(' ')).split(/\s+/).filter(Boolean);
  for (const name of rotation) {
    const key = `${name}@${packs.join('.')}`;
    let id = simCache.maps.get(key);
    if (id === undefined) {
      const bsp = fake ? new Uint8Array(4) : simView.get(`maps/${name}.bsp`);
      if (!bsp) { cmds.print(`map ${name} is not in the room's packs\n`); continue; }
      id = sim.loadMap(name, bsp);
      simCache.maps.set(key, id);
    }
    maps.set(name, id);
  }
  if (!maps.size) throw new Error('none of the rotation\'s maps could be loaded');
  return { vfs, sim, progsId, maps, packs };
}

async function play(req: PlayRequest, demo?: DemoFile): Promise<void> {
  console.info('[play]', req.roomId, { starting, inGame: !!current });
  if (starting) { status('Still starting the last game…'); return; }
  if (current) leaveQuietly();
  starting = true;
  status('Loading');
  menuRoot.classList.add('hidden');
  try {
    const { hideMenu } = await import('./menu/index.js');
    hideMenu();
  } catch { /* no menu */ }
  try {
    const { gfx: g } = await base();
    const p = await prepare(req.config, req.serverinfo);
    const { Game } = await gameModule;
    status(demo ? 'Starting the demo' : req.offline ? 'Starting practice' : 'Connecting');
    const fake = p.sim.version === 0xfa4e0001;
    const game = await Game.start({
      sim: p.sim, progsId: p.progsId, maps: p.maps, serverinfo: req.serverinfo, packs: p.packs,
      roomId: req.roomId, offline: !!req.offline, spectate: !!req.spectate,
      appId: APP_ID, apiKey: API_KEY, central, nodeUrl: params.get('nodeUrl') ?? params.get('via') ?? req.nodeUrl,
      identity: req.identity, playerId: playerId(),
      vfs: p.vfs, host: gameHost,
      makeRenderer: (canvas) => (fake ? Promise.resolve(null) : makeRenderer(canvas, p.vfs)),
      cvars, cmds, console: con, gfx: g,
      userinfo: settingsUserinfo,
      pausePanel: !params.has('test'),
      ...(demo ? { demo } : {}),
    }, (label) => status(label));
    current = game;
    (window as unknown as { __game?: Game }).__game = game;
    loading.classList.add('hidden');
    document.title = demo ? 'Demo — Quake Town' : req.offline ? 'Practice — Quake Town' : `${req.config.name || 'Room'} — Quake Town`;
    game.onLeave = (reason) => leave(reason);
    if (params.get('probe') === '1') void installProbe(game);
  } catch (err) {
    console.error('[play] could not start', err);
    loading.classList.add('hidden');
    const msg = `Could not start: ${err instanceof Error ? err.message : String(err)}`;
    showFatal(msg);
    // the room link would reopen the join dialog over the notice: drop it
    try { history.replaceState(null, '', location.pathname + location.search); } catch { /* sandboxed */ }
    void showMenu(msg);
  } finally {
    starting = false;
  }
}

/** End the running game without going back to the menu (a new game is about to start). */
function leaveQuietly(): void {
  const g = current;
  if (!g) return;
  current = null;
  (window as unknown as { __game?: Game }).__game = undefined;
  g.dispose();
}

function leave(reason = ''): void {
  const g = current;
  if (!g) return;
  current = null;
  (window as unknown as { __game?: Game }).__game = undefined;
  g.dispose();
  try { history.replaceState(null, '', location.pathname); } catch { /* sandboxed */ }
  void showMenu(reason);
}

let previewModule: { renderCharacterPreview: (c: HTMLCanvasElement, v: Vfs, look: { model?: string; skin: number; top: number; bottom: number }, t: number) => void } | null = null;

async function showMenu(notice = ''): Promise<void> {
  menuRoot.classList.remove('hidden');
  // the 3D player preview, drawn from the base pack (and the player's id paks)
  if (!previewModule && !FAKE) {
    try { await base(); const load = previewModules['./render/preview.ts']; if (load) previewModule = await load() as typeof previewModule; } catch (e) { console.warn('[menu] no 3D preview:', e); }
  }
  document.title = 'Quake Town';
  try {
    const m = await import('./menu/index.js');
    const req = await m.showMenu(menuRoot, {
      central, ...(notice ? { notice } : {}),
      packIndex: () => loader.index() as never,
      cacheLocalPack: (file) => content.cacheLocalPack(file),
      idPaks: content.idPaks,
      ...(previewModule ? {
        renderPreview: (canvas: HTMLCanvasElement, look: { model: string; skin: string; topcolor: number; bottomcolor: number }, t: number) => previewModule!.renderCharacterPreview(canvas, content.vfs, {
          model: `progs/${look.model || 'player'}.mdl`, skin: Number.parseInt(look.skin, 10) || 0, top: look.topcolor, bottom: look.bottomcolor,
        }, t),
      } : {}),
      models: () => content.vfs.list('progs/').filter((p) => /^progs\/player\w*\.mdl$/.test(p)).map((p) => p.slice(6, -4)),
    });
    await play(req);
  } catch (err) {
    console.error('[menu]', err);
    menuRoot.innerHTML = `<div style="color:#e8d8b0;font:16px monospace;padding:40px">The menu did not load: ${String(err)}<br><br>Press ~ for the console: <b>connect &lt;room&gt;</b> or <b>practice</b>.</div>`;
  }
}

// ------------------------------------------------------------------ commands

function offlineRequest(over: Partial<RoomConfig> = {}): PlayRequest {
  const mode = isMode(params.get('mode')) ? params.get('mode') as RoomConfig['mode'] : 'ffa';
  const map = params.get('map');
  const config = defaultConfig(mode, {
    name: 'Practice', bots: params.get('bots') !== '0',
    ...(map ? { rotation: [map] } : {}),
    ...(params.get('maxclients') ? { maxclients: Number(params.get('maxclients')) } : {}),
    ...over,
  });
  return { roomId: `practice-${Date.now().toString(36)}`, config, serverinfo: toServerinfo(config), offline: true, identity: null };
}

function roomRequest(roomId: string, spectate = false): PlayRequest | null {
  const config = decodeRoomId(roomId);
  if (!config) return null;
  return { roomId, config, serverinfo: toServerinfo(config), spectate, identity: account.session() };
}

const r = (n: string, fn: (a: string[], line: string) => void, d?: string): void => cmds.register(n, fn, d);
r('connect', (a) => {
  const id = a[1] ?? '';
  const req = id === 'practice' ? offlineRequest() : roomRequest(id);
  if (!req) { cmds.print(id ? `"${id}" is not a Quake Town room id\n` : 'connect <room id> | connect practice\n'); return; }
  if (current) leave();
  void play(req);
}, 'join a room by its id (or "practice")');
r('practice', (a) => {
  if (current) leave();
  void play(offlineRequest(a[1] ? { rotation: [a[1]] } : {}));
}, 'play against bots offline, optionally on a map');
r('disconnect', () => { if (current) leave('Disconnected'); }, 'leave the room');
r('quit', () => { if (current) leave(); }, 'back to the menu');
r('togglemenu', () => { if (current && !con.open) current.input.unlock(); });
r('join', () => current?.join(true), 'play (take a slot)');
r('spectate', () => current?.join(false), 'watch (give the slot back)');
r('say', (_a, line) => current?.say(line.replace(/^\s*say\s+/i, '').replace(/^"(.*)"$/, '$1'), false), 'say something to everyone');
r('say_team', (_a, line) => current?.say(line.replace(/^\s*say_team\s+/i, '').replace(/^"(.*)"$/, '$1'), true), 'say something to your team');
for (const k of ['ready', 'break', 'kill', 'notready']) r(k, (_a, line) => { if (!current?.modCommand(line)) cmds.print('not connected\n'); }, 'tell the mod');
r('color', (a) => {
  if (a.length < 2) { cmds.print(`"color" is "${cvars.get('topcolor')} ${cvars.get('bottomcolor')}"\n`); return; }
  cvars.set('topcolor', a[1]); cvars.set('bottomcolor', a[2] ?? a[1]);
}, 'color <top> [bottom]: shirt and pants rows 0-13');
r('weapon', (a) => { const g = current; if (g) g.weaponCommand(a.slice(1).map(Number)); }, 'weapon 7 5 4: the first of these you have with ammo');
r('record', (a) => {
  if (!current) { cmds.print('not playing\n'); return; }
  const res = current.startRecording();
  cmds.print(`${res}${a[1] ? ` ${a[1]}` : ''}\n`);
  pendingDemoName = a[1] || `demo-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}, 'record a demo');
let pendingDemoName = '';
r('stop', () => {
  if (!current) return;
  void current.stopRecording(pendingDemoName || `demo-${Date.now()}`).then((m) => cmds.print(`${m}\n`));
}, 'stop recording and save the demo');
r('demos', () => { void listDemos().then((l) => { for (const n of l) cmds.print(`${n}\n`); cmds.print(`${l.length} demos\n`); }); }, 'list the demos stored in this browser');
r('playdemo', (a) => {
  const name = a[1];
  if (!name) { cmds.print('playdemo <name>\n'); return; }
  void loadDemo(name).then((bytes) => {
    if (!bytes) { cmds.print(`no demo ${name}\n`); return; }
    const d = decodeDemo(bytes);
    const config = decodeRoomId(infoGet(d.serverinfo, 'roomid')) ?? defaultConfig(isMode(infoGet(d.serverinfo, 'mode')) ? infoGet(d.serverinfo, 'mode') as RoomConfig['mode'] : 'ffa', { rotation: d.maps });
    if (current) leave();
    void play({ roomId: 'demo', config, serverinfo: d.serverinfo, offline: true, identity: null }, d);
  }).catch((e) => cmds.print(`${e}\n`));
}, 'play a stored demo');
r('demo_pause', () => current?.demoControl('pause'));
r('demo_seek', (a) => current?.demoControl('seek', a[1]), 'demo_seek <seconds>');
r('pause', () => current?.demoControl('pause'));
r('screenshot', () => {
  const c = gameHost.querySelector('canvas');
  if (!c) return;
  const a = document.createElement('a');
  a.href = (c as HTMLCanvasElement).toDataURL('image/png');
  a.download = `quaketown-${Date.now()}.png`;
  a.click();
}, 'save a picture of the view');
r('version', () => cmds.print(`Quake Town ${typeof __BUILD_REV__ === 'string' ? __BUILD_REV__ : 'dev'}, sim ${simCache.sim?.version ?? 'not loaded'}, app ${APP_ID}\n`));
r('bf', () => current?.bonusFlash());
r('play', (a) => current?.audio.local(a[1] ?? ''));
r('echo_room', () => cmds.print(`${current ? 'in a room' : 'no room'}\n`));
// Anything else typed while connected goes to the mod, like QW's forward to the server.
cmds.forward = (line) => !!current && current.modCommand(line);

// ------------------------------------------------------------------ the arena probe (tests only)

async function installProbe(game: Game): Promise<void> {
  // Dev builds and test builds (VITE_QT_PROBE=1) only: the harness is not part of the game and never ships.
  const probes: Record<string, () => Promise<unknown>> = import.meta.env.DEV || import.meta.env.VITE_QT_PROBE === '1' ? import.meta.glob('../../arrr-mono/harness/arena/probe.ts') : {};
  const load = Object.values(probes)[0];
  if (!load) { console.warn('[probe] harness/arena/probe.ts is not reachable from this build'); return; }
  const mod = await load() as { installProbe: (hooks: Record<string, unknown>) => void };
  const rec = <T,>(m: Map<string, T>): Record<string, T> => Object.fromEntries(m);
  mod.installProbe({
    name: 'quake-town',
    tickHz: 77,
    lockstep: () => game.session?.lockstep,
    clock: () => {
      const t = game.lastTimes, ls = game.session?.lockstep;
      if (!t || !ls) return null;
      const selfFrame = (ls.prediction?.frame ?? ls.frame) - 1;
      return { frame: ls.frame, alpha: t.others - ls.frame, selfFrame, selfAlpha: t.self - selfFrame, at: game.lastDrawAt };
    },
    drawn: () => rec(game.drawnBodies),
    sim: () => rec(game.simBodies()),
    self: () => game.session?.playerId ?? null,
  });
}

// ------------------------------------------------------------------ entry

void (async () => {
  if (params.has('demo')) {
    const bytes = await loadDemo(params.get('demo')!);
    if (bytes) { const d = decodeDemo(bytes); await play({ roomId: 'demo', config: defaultConfig('ffa', { rotation: d.maps }), serverinfo: d.serverinfo, offline: true, identity: null }, d); return; }
  }
  if (params.get('offline') === '1') { void base(); await play(offlineRequest()); return; }
  const roomParam = params.get('room');
  if (roomParam) {
    let req = roomRequest(roomParam, params.get('spectate') === '1');
    if (!req) {
      // a plain room name (tests): an FFA room with that name
      const config = defaultConfig(isMode(params.get('mode')) ? params.get('mode') as RoomConfig['mode'] : 'ffa', {
        name: roomParam.slice(0, 40),
        ...(params.get('map') ? { rotation: [params.get('map')!] } : {}),
        ...(params.get('bots') === '0' ? { bots: false } : {}),
        ...(params.get('maxclients') ? { maxclients: Number(params.get('maxclients')) } : {}),
      });
      const id = encodeRoomId(config);
      req = { roomId: id, config, serverinfo: toServerinfo(config), spectate: params.get('spectate') === '1', identity: account.session() };
    }
    void base();
    await play(req);
    return;
  }
  void base();
  await showMenu();
})();

void lockstep; void consoleRaf;
