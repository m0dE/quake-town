// Renderer test page: mounts LibreQuake test data, flies a camera, spawns animated players,
// items, torches, rockets with trails/dlights/explosions, lightning, and shows FPS/draw calls.
// URL: render.html?map=lqdm1&preset=modern|classic&manual=1 (manual = no rAF loop; driven by
// window.__qt for screenshots and measurements).
// Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
import { Renderer } from '../renderer';
import { renderCharacterPreview } from '../preview';
import {
  CLASSIC_SETTINGS, EF_BLUE, EF_RED, EV_MUZZLEFLASH, EV_TEMP_ENTITY, MODERN_SETTINGS, TE_EXPLOSION, TE_GUNSHOT, TE_LIGHTNING2,
  TE_TELEPORT, createRenderFrame, type RenderEntity, type RenderFrame,
} from '../types';
import { PakVfs, fetchBytes } from './pakvfs';

const params = new URLSearchParams(location.search);
const MAPS = Array.from({ length: 13 }, (_, i) => `lqdm${i + 1}`);
let mapName = params.get('map') ?? 'lqdm1';
const manual = params.get('manual') === '1';
const canvas = document.getElementById('c') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;

const LIGHTSTYLES: string[] = new Array(64).fill('');
Object.assign(LIGHTSTYLES, {
  0: 'm', 1: 'mmnmmommommnonmmonqnmmo', 2: 'abcdefghijklmnopqrstuvwxyzyxwvutsrqponmlkjihgfedcba',
  3: 'mmmmmaaaaammmmmaaaaaabcdefgabcdefg', 4: 'mamamamamama', 5: 'jklmnopqrstuvwxyzyxwvutsrqponmlkj',
  6: 'nmonqnmomnmomomno', 7: 'mmmaaaabcdefgmmmmaaaammmaamm', 8: 'mmmaaammmaaammmabcdefaaaammmmabcdefmmmaaaa',
  9: 'aaaaaaaazzzzzzzz', 10: 'mmamammmmammamamaaamammma', 11: 'abcdefghijklmnopqrrqponmlkjihgfedcba', 63: 'a',
});

interface Thing { model: string; x: number; y: number; z: number; yaw: number; frame: number; skin: number; effects: number; kind: 'static' | 'player'; top?: number; bottom?: number; run?: number }
interface Rocket { sx: number; sy: number; sz: number; ex: number; ey: number; ez: number; t0: number; dur: number; serial: number }

const vfs = new PakVfs();
let renderer: Renderer;
const frame: RenderFrame = createRenderFrame(512, 256);
frame.lightstyles = LIGHTSTYLES;
const cam = { x: 0, y: 0, z: 0, pitch: 0, yaw: 0 };
let things: Thing[] = [];
let rockets: Rocket[] = [];
let spawns: { x: number; y: number; z: number; yaw: number }[] = [];
let serial = 1;
let pendingEvents: { kind: number; a: number; b: number; c: number; x: number; y: number; z: number; ex: number; ey: number; ez: number }[] = [];
let fireUntil = 0;
let lightningUntil = 0;
let manualTime = 0;
let showHud = !manual;

const ITEM_MODELS: Record<string, (sf: number) => [string, number]> = {
  item_health: (sf) => [sf & 1 ? 'maps/b_bh10.bsp' : sf & 2 ? 'maps/b_bh100.bsp' : 'maps/b_bh25.bsp', 0],
  item_shells: (sf) => [sf & 1 ? 'maps/b_shell1.bsp' : 'maps/b_shell0.bsp', 0],
  item_spikes: (sf) => [sf & 1 ? 'maps/b_nail1.bsp' : 'maps/b_nail0.bsp', 0],
  item_rockets: (sf) => [sf & 1 ? 'maps/b_rock1.bsp' : 'maps/b_rock0.bsp', 0],
  item_cells: (sf) => [sf & 1 ? 'maps/b_batt1.bsp' : 'maps/b_batt0.bsp', 0],
  item_armor1: () => ['progs/armor.mdl', 0],
  item_armor2: () => ['progs/armor.mdl', 1],
  item_armorInv: () => ['progs/armor.mdl', 2],
  weapon_supershotgun: () => ['progs/g_shot.mdl', 0],
  weapon_nailgun: () => ['progs/g_nail.mdl', 0],
  weapon_supernailgun: () => ['progs/g_nail2.mdl', 0],
  weapon_grenadelauncher: () => ['progs/g_rock.mdl', 0],
  weapon_rocketlauncher: () => ['progs/g_rock2.mdl', 0],
  weapon_lightning: () => ['progs/g_light.mdl', 0],
  item_artifact_super_damage: () => ['progs/quaddama.mdl', 0],
  item_artifact_invulnerability: () => ['progs/invulner.mdl', 0],
  item_artifact_invisibility: () => ['progs/invisibl.mdl', 0],
  item_artifact_envirosuit: () => ['progs/suit.mdl', 0],
  light_torch_small_walltorch: () => ['progs/flame.mdl', 0],
  light_flame_large_yellow: () => ['progs/flame2.mdl', 1],
  light_flame_small_yellow: () => ['progs/flame2.mdl', 0],
  light_flame_small_white: () => ['progs/flame2.mdl', 0],
};

const COLORS: [number, number][] = [[4, 4], [13, 13], [12, 11], [3, 3], [9, 9], [2, 10], [6, 6], [0, 0]];

async function loadMap(name: string): Promise<void> {
  mapName = name;
  for (const ext of ['bsp', 'lit']) {
    if (vfs.has(`maps/${name}.${ext}`)) continue;
    const d = await fetchBytes(`/render-test/maps/${name}.${ext}`);
    if (d) vfs.add(`maps/${name}.${ext}`, d);
  }
  await renderer.loadMap(name);
  const ents = renderer.mapEntities();
  spawns = [];
  things = [];
  for (const e of ents) {
    const o = (e.origin ?? '0 0 0').split(/\s+/).map(Number);
    const yaw = Number(e.angle ?? 0);
    if (e.classname === 'info_player_deathmatch' || e.classname === 'info_player_start') spawns.push({ x: o[0], y: o[1], z: o[2], yaw });
    const im = ITEM_MODELS[e.classname];
    if (im) {
      const [model, skin] = im(Number(e.spawnflags ?? 0));
      const isFlame2 = model === 'progs/flame2.mdl';
      things.push({ model, x: o[0], y: o[1], z: o[2] + (isFlame2 ? -12 : 0), yaw, frame: isFlame2 ? skin : 0, skin: isFlame2 ? 0 : skin, effects: 0, kind: 'static' });
    }
  }
  if (!spawns.length) spawns.push({ x: 0, y: 0, z: 64, yaw: 0 });
  // players on the first spawns (one stands where the camera starts, so skip it)
  for (let i = 1; i < Math.min(spawns.length, 7); i++) {
    const s = spawns[i];
    const [top, bottom] = COLORS[i % COLORS.length];
    things.push({
      model: 'progs/player.mdl', x: s.x, y: s.y, z: s.z, yaw: s.yaw, frame: 6, skin: 0, effects: i === 1 ? EF_BLUE : i === 2 ? EF_RED : 0,
      kind: 'player', top, bottom, run: i % 3,
    });
  }
  const s0 = spawns[0];
  cam.x = s0.x; cam.y = s0.y; cam.z = s0.z + 22; cam.yaw = s0.yaw; cam.pitch = 0;
  rockets = [];
}

function addEvent(kind: number, a: number, b: number, c: number, x: number, y: number, z: number, ex = 0, ey = 0, ez = 0): void {
  pendingEvents.push({ kind, a, b, c, x, y, z, ex, ey, ez });
}

function fireRocket(t: number): void {
  const d2r = Math.PI / 180;
  const fx = Math.cos(cam.pitch * d2r) * Math.cos(cam.yaw * d2r), fy = Math.cos(cam.pitch * d2r) * Math.sin(cam.yaw * d2r), fz = -Math.sin(cam.pitch * d2r);
  const dist = 700;
  rockets.push({ sx: cam.x + fx * 16, sy: cam.y + fy * 16, sz: cam.z - 8, ex: cam.x + fx * dist, ey: cam.y + fy * dist, ez: cam.z + fz * dist, t0: t, dur: dist / 1000, serial: serial++ });
  addEvent(EV_MUZZLEFLASH, 1, 0, 0, 0, 0, 0);
  fireUntil = t + 0.8;
}

function forward(dist: number): [number, number, number] {
  const d2r = Math.PI / 180;
  return [
    cam.x + Math.cos(cam.pitch * d2r) * Math.cos(cam.yaw * d2r) * dist,
    cam.y + Math.cos(cam.pitch * d2r) * Math.sin(cam.yaw * d2r) * dist,
    cam.z - Math.sin(cam.pitch * d2r) * dist,
  ];
}

function setEnt(e: RenderEntity, num: number, ser: number, model: string, x: number, y: number, z: number, yaw: number, fr: number, skin: number, effects: number): void {
  e.num = num; e.serial = ser; e.model = model; e.frame = fr; e.prevFrame = -1; e.frameLerp = 0; e.skin = skin; e.colors = null;
  e.effects = effects; e.origin[0] = x; e.origin[1] = y; e.origin[2] = z; e.angles[0] = 0; e.angles[1] = yaw; e.angles[2] = 0;
  e.alpha = 1; e.isLocalPlayer = false;
}

const colorObjs = COLORS.map(([top, bottom]) => ({ top, bottom }));

function buildFrame(t: number): void {
  frame.time = t;
  const c = frame.camera;
  c.origin[0] = cam.x; c.origin[1] = cam.y; c.origin[2] = cam.z;
  c.angles[0] = cam.pitch; c.angles[1] = cam.yaw; c.angles[2] = 0;
  c.fov = Number(params.get('fov') ?? 100);
  c.blend[3] = 0;
  frame.viewEntity = 1;
  let n = 0;
  const ents = frame.entities;
  // the local player (not drawn, but its effects are)
  setEnt(ents[n++], 1, 1, 'progs/player.mdl', cam.x, cam.y, cam.z - 22, cam.yaw, 12, 0, 0);
  ents[n - 1].isLocalPlayer = true;
  let num = 2;
  for (const th of things) {
    const e = ents[n++];
    let fr = th.frame, x = th.x, y = th.y, yaw = th.yaw;
    if (th.kind === 'player') {
      // run in a small circle, rockrun frames at 10 Hz (QC frames), or stand
      const ph = t * 0.6 + num;
      if (th.run === 0) { fr = 12 + (Math.floor(t * 10) % 5); yaw = th.yaw + Math.sin(t * 0.5 + num) * 40; }
      else {
        x = th.x + Math.cos(ph) * 40; y = th.y + Math.sin(ph) * 40;
        yaw = (ph * 180 / Math.PI + 90) % 360;
        fr = (th.run === 1 ? 6 : 0) + (Math.floor(t * 10) % 6);
      }
    }
    setEnt(e, num, 1, th.model, x, y, th.z, yaw, fr, th.skin, th.effects);
    if (th.kind === 'player') e.colors = colorObjs[(num + 3) % colorObjs.length];
    num++;
    if (n >= ents.length - 64) break;
  }
  // rockets
  rockets = rockets.filter((r) => {
    const k = (t - r.t0) / r.dur;
    if (k >= 1) { addEvent(EV_TEMP_ENTITY, TE_EXPLOSION, 0, 0, r.ex, r.ey, r.ez); return false; }
    return true;
  });
  for (const r of rockets) {
    const k = (t - r.t0) / r.dur;
    const e = ents[n++];
    const yaw = Math.atan2(r.ey - r.sy, r.ex - r.sx) * 180 / Math.PI;
    setEnt(e, 400 + (r.serial % 100), r.serial, 'progs/missile.mdl', r.sx + (r.ex - r.sx) * k, r.sy + (r.ey - r.sy) * k, r.sz + (r.ez - r.sz) * k, yaw, 0, 0, 0);
    e.angles[0] = -Math.atan2(r.ez - r.sz, Math.hypot(r.ex - r.sx, r.ey - r.sy)) * 180 / Math.PI;
  }
  frame.entityCount = n;
  if (t < lightningUntil) {
    const [ex, ey, ez] = forward(600);
    addEvent(EV_TEMP_ENTITY, TE_LIGHTNING2, 0, 1, cam.x, cam.y, cam.z - 16, ex, ey, ez);
  }
  // events
  frame.eventCount = 0;
  for (const ev of pendingEvents) {
    if (frame.eventCount >= frame.events.length) break;
    Object.assign(frame.events[frame.eventCount++], ev, { d: 0 });
  }
  pendingEvents = [];
  // gun
  frame.viewmodel = frame.viewmodel ?? { model: '', frame: 0, prevFrame: -1, frameLerp: 0, effects: 0, bob: 0 };
  const vm = frame.viewmodel;
  if (t < lightningUntil) { vm.model = 'progs/v_light.mdl'; vm.frame = 1 + (Math.floor(t * 10) % 4); }
  else { vm.model = 'progs/v_rock2.mdl'; vm.frame = t < fireUntil ? Math.min(6, 1 + Math.floor((fireUntil - 0.8 < t ? t - (fireUntil - 0.8) : 0) * 10)) : 0; }
  vm.bob = Math.sin(t * 8) * (moving ? 2 : 0.3);
}

// ---------------------------------------------------------------------------------- input
const keys = new Set<string>();
let moving = false;
addEventListener('keydown', (e) => {
  keys.add(e.code);
  const t = now();
  if (e.code === 'Digit1') renderer.setSettings(CLASSIC_SETTINGS);
  if (e.code === 'Digit2') renderer.setSettings(MODERN_SETTINGS);
  if (e.code === 'KeyF') renderer.setSettings({ flashblend: !renderer.getSettings().flashblend });
  if (e.code === 'KeyB') renderer.setSettings({ bloom: !renderer.getSettings().bloom });
  if (e.code === 'KeyP') renderer.setSettings({ drawflat: !renderer.getSettings().drawflat });
  if (e.code === 'KeyH') { showHud = !showHud; hud.style.display = showHud ? '' : 'none'; }
  if (e.code === 'KeyR') fireRocket(t);
  if (e.code === 'KeyG') { const [x, y, z] = forward(200); addEvent(EV_TEMP_ENTITY, TE_GUNSHOT, 3, 0, x, y, z); }
  if (e.code === 'KeyL') lightningUntil = t + 1.5;
  if (e.code === 'KeyT') { const [x, y, z] = forward(120); addEvent(EV_TEMP_ENTITY, TE_TELEPORT, 0, 0, x, y, z); }
  if (e.code === 'KeyM') void loadMap(MAPS[(MAPS.indexOf(mapName) + 1) % MAPS.length]);
});
addEventListener('keyup', (e) => keys.delete(e.code));
canvas.addEventListener('click', () => canvas.requestPointerLock?.());
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return;
  cam.yaw -= e.movementX * 0.15;
  cam.pitch = Math.max(-89, Math.min(89, cam.pitch + e.movementY * 0.15));
});

function moveCamera(dt: number): void {
  const sp = (keys.has('ShiftLeft') ? 900 : 320) * dt;
  const d2r = Math.PI / 180;
  const fx = Math.cos(cam.pitch * d2r) * Math.cos(cam.yaw * d2r), fy = Math.cos(cam.pitch * d2r) * Math.sin(cam.yaw * d2r), fz = -Math.sin(cam.pitch * d2r);
  const rx = Math.sin(cam.yaw * d2r), ry = -Math.cos(cam.yaw * d2r);
  let mx = 0, my = 0, mz = 0;
  if (keys.has('KeyW')) { mx += fx; my += fy; mz += fz; }
  if (keys.has('KeyS')) { mx -= fx; my -= fy; mz -= fz; }
  if (keys.has('KeyD')) { mx += rx; my += ry; }
  if (keys.has('KeyA')) { mx -= rx; my -= ry; }
  if (keys.has('KeyE') || keys.has('Space')) mz += 1;
  if (keys.has('KeyQ') || keys.has('KeyC')) mz -= 1;
  moving = mx !== 0 || my !== 0 || mz !== 0;
  cam.x += mx * sp; cam.y += my * sp; cam.z += mz * sp;
}

// ---------------------------------------------------------------------------------- loop
const t0 = performance.now();
function now(): number { return manual ? manualTime : (performance.now() - t0) / 1000; }
let last = 0, frames = 0, fpsT = 0, fps = 0, cpuSum = 0, cpuMax = 0;
function loop(ts: number): void {
  requestAnimationFrame(loop);
  const t = (ts - t0) / 1000;
  const dt = last ? Math.min(0.1, t - last) : 0;
  last = t;
  moveCamera(dt);
  buildFrame(t);
  renderer.draw(frame);
  const st = renderer.stats();
  frames++; cpuSum += st.ms; cpuMax = Math.max(cpuMax, st.ms);
  if (t - fpsT > 0.5) {
    fps = frames / (t - fpsT);
    if (showHud) {
      hud.textContent = `${mapName}  ${fps.toFixed(0)} fps   draw() ${(cpuSum / frames).toFixed(2)} ms avg / ${cpuMax.toFixed(2)} max\n` +
        `calls ${st.drawCalls}  tris ${st.tris}  faces ${st.faces}  leafs ${st.leafs}\n` +
        `ents ${st.entities}  particles ${st.particles}  dlights ${st.dlights}\n` +
        `pos ${cam.x.toFixed(0)} ${cam.y.toFixed(0)} ${cam.z.toFixed(0)}  ang ${cam.pitch.toFixed(0)} ${cam.yaw.toFixed(0)}`;
    }
    frames = 0; fpsT = t; cpuSum = 0; cpuMax = 0;
  }
}

function resize(): void { renderer.resize(innerWidth, innerHeight, devicePixelRatio); }

// ---------------------------------------------------------------------------------- automation API
declare global {
  interface Window { __qt: unknown }
}

async function main(): Promise<void> {
  hud.textContent = 'loading pak0…';
  const pak = await fetchBytes('/render-test/pak0.pak');
  if (!pak) { hud.textContent = 'missing .cache/render-test/pak0.pak'; return; }
  vfs.mountPak(pak);
  if (params.get('preview') === '1') {
    // menu character preview on a 2:3 canvas over a dark gradient
    canvas.remove();
    document.body.style.background = 'radial-gradient(circle at 50% 40%, #3a3127, #0d0b09 70%)';
    const pc = document.createElement('canvas');
    pc.style.cssText = 'position:fixed;left:50%;top:50%;width:360px;height:540px;transform:translate(-50%,-50%);';
    document.body.appendChild(pc);
    hud.style.display = 'none';
    (document.getElementById('help') as HTMLElement).style.display = 'none';
    const look = { skin: Number(params.get('skin') ?? 0), top: Number(params.get('top') ?? 4), bottom: Number(params.get('bottom') ?? 12) };
    const pset = params.get('preset') === 'classic' ? CLASSIC_SETTINGS : MODERN_SETTINGS;
    window.__qt = { preview: (t: number) => { renderCharacterPreview(pc, vfs, look, t, pset); return pc.toDataURL('image/png'); }, look };
    if (manual) { document.title = 'ready'; return; }
    const t0p = performance.now();
    const loopP = (): void => { renderCharacterPreview(pc, vfs, look, (performance.now() - t0p) / 1000, pset); requestAnimationFrame(loopP); };
    requestAnimationFrame(loopP);
    return;
  }
  const preset = params.get('preset') === 'classic' ? CLASSIC_SETTINGS : MODERN_SETTINGS;
  renderer = new Renderer(canvas, vfs, preset);
  resize();
  addEventListener('resize', resize);
  await loadMap(mapName);
  window.__qt = {
    renderer, frame, cam, spawns: () => spawns, things: () => things,
    loadMap: (n: string) => loadMap(n),
    setView: (x: number, y: number, z: number, pitch: number, yaw: number) => Object.assign(cam, { x, y, z, pitch, yaw }),
    setPreset: (p: 'classic' | 'modern', extra = {}) => renderer.setSettings({ ...(p === 'classic' ? CLASSIC_SETTINGS : MODERN_SETTINGS), ...extra }),
    /** draw one frame at sim time t (manual mode) */
    render: (t: number) => { manualTime = t; buildFrame(t); renderer.draw(frame); return renderer.stats(); },
    fireRocket: (t: number) => fireRocket(t),
    /** render at t and return the mean rgb of the canvas (read back in the same task) */
    probe: (t: number) => {
      manualTime = t; buildFrame(t); renderer.draw(frame);
      const g = renderer.gl.getContext();
      const w = g.drawingBufferWidth, h = g.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px);
      let r = 0, gg = 0, b = 0;
      for (let i = 0; i < px.length; i += 4) { r += px[i]; gg += px[i + 1]; b += px[i + 2]; }
      const n = px.length / 4;
      return [Math.round(r / n), Math.round(gg / n), Math.round(b / n)];
    },
    explode: (x: number, y: number, z: number) => addEvent(EV_TEMP_ENTITY, TE_EXPLOSION, 0, 0, x, y, z),
    teleport: (x: number, y: number, z: number) => addEvent(EV_TEMP_ENTITY, TE_TELEPORT, 0, 0, x, y, z),
    lightning: (until: number) => { lightningUntil = until; },
    /** effects showcase starting at t0: rocket, explosion ahead, teleport splash, lightning */
    fxDemo: (t0: number) => {
      fireRocket(t0);
      const [x, y, z] = forward(260);
      const [lx, ly, lz] = forward(140);
      const d2r = Math.PI / 180;
      addEvent(EV_TEMP_ENTITY, TE_EXPLOSION, 0, 0, x + Math.sin(cam.yaw * d2r) * 90, y - Math.cos(cam.yaw * d2r) * 90, z);
      addEvent(EV_TEMP_ENTITY, TE_TELEPORT, 0, 0, lx - Math.sin(cam.yaw * d2r) * 60, ly + Math.cos(cam.yaw * d2r) * 60, lz);
      addEvent(EV_TEMP_ENTITY, TE_GUNSHOT, 3, 0, lx, ly, lz - 20);
      lightningUntil = t0 + 0.6;
    },
    hideHud: () => { showHud = false; hud.style.display = 'none'; (document.getElementById('help') as HTMLElement).style.display = 'none'; },
    EF_BLUE, EF_RED,
  };
  if (manual) { (window.__qt as { hideHud: () => void }).hideHud(); document.title = 'ready'; return; }
  requestAnimationFrame(loop);
}

main().catch((e) => { hud.textContent = String(e?.stack ?? e); console.error(e); });
