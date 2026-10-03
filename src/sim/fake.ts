/*
 * Quake Town — a tiny TS world behind the qtsim ABI, for building and testing the
 * shell before (or without) the real engine wasm. Not QuakeWorld: a flat walled
 * arena, QW-like movement (friction 4, accelerate 10, airaccelerate 0.7,
 * gravity 800, jump 270), a rocket launcher, bots that strafe and shoot.
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 *
 * It implements `QtSimExports` over a real WebAssembly.Memory with the exact
 * buffer layouts of DESIGN.md, so the wrapper (qtsim.ts), the rings, the HUD and
 * the netcode run the same code against it as against the engine. Deterministic
 * within one JS engine (it uses Math.sin/cos, which is fine for a stand-in).
 */
import {
  type QtSimExports, CLIENT_WORDS, CV, ENT_WORDS, EVENT_WORDS, ROW_WORDS, R_STATS, ST,
  EV_SOUND, EV_TEMP, EV_PRINT, EV_CENTER, EV_MUZZLE, EV_DAMAGE, EV_OBITUARY, EV_MATCH, EV_PICKUP,
  TE_EXPLOSION, TE_TELEPORT, IT, MOVETYPE_WALK, MOVETYPE_FLYMISSILE, MOVETYPE_NONE, EF_DIMLIGHT,
  PRINT_MEDIUM, PHASE_PLAYING,
} from './abi.js';
import { parseInfo } from './wire.js';

const FAKE_VERSION = 0xfa4e0001;
const HALF = 1024;          // the arena is ±HALF in x and y
const PLAYER_Z = 24;        // origin height when standing on the floor (QW hull mins z = -24)
const FT = 0.013;
const MODELS = ['', 'maps/fake.bsp', 'progs/player.mdl', 'progs/missile.mdl', 'progs/v_rock2.mdl', 'progs/g_rock2.mdl', 'progs/armor.mdl'];
const SOUNDS = ['', 'weapons/sgun1.wav', 'weapons/r_exp3.wav', 'player/plyrjmp8.wav', 'player/pain1.wav', 'player/death1.wav', 'items/armor1.wav', 'misc/r_tele1.wav', 'player/land.wav'];
const M_PLAYER = 2, M_MISSILE = 3, M_VROCK = 4, M_ARMOR = 6;
const S_ROCKET = 1, S_EXPLODE = 2, S_JUMP = 3, S_PAIN = 4, S_DEATH = 5, S_ARMOR = 6, S_TELE = 7;
const BOT_NAMES = ['Ranger', 'Grunt', 'Phantom', 'Sarge', 'Visor', 'Bitterman', 'Doom', 'Slash', 'Major', 'Keel', 'Hunter', 'Klesk', 'Anarki', 'Xaero', 'Uriel', 'Orbb'];

interface Client {
  state: number;          // 0 empty 1 human 2 bot 3 idle
  ui: string;
  ent: number;            // entnum (slot + 1)
  serial: number;
  o: number[]; v: number[]; a: number[];
  cmd: number[];          // pitch16 yaw16 fwd side up buttons impulse
  oldButtons: number;
  onground: number;
  health: number; armor: number; rockets: number;
  frags: number; deadflag: number; respawnAt: number; attackAt: number;
  frame: number; weaponframe: number;
  punch: number; dmgTake: number; dmgSave: number; dmgFrom: number[];
  stats: number[];
  botTurn: number;
}

interface Missile { num: number; serial: number; o: number[]; v: number[]; owner: number; dieAt: number }

interface World {
  map: number; progs: number; info: string; tick: number; time: number; rng: number[];
  maxclients: number; bots: boolean; clients: Client[]; missiles: Missile[]; freeNums: number[]; nextNum: number;
  serials: Record<number, number>;
  armor: { o: number[]; at: number; serial: number };
  ev: number[]; strs: string[];
}

const f = Math.fround;

function newClient(slot: number): Client {
  return {
    state: 0, ui: '', ent: slot + 1, serial: 0, o: [0, 0, PLAYER_Z], v: [0, 0, 0], a: [0, 0, 0],
    cmd: [0, 0, 0, 0, 0, 0, 0], oldButtons: 0, onground: 1, health: 100, armor: 0, rockets: 50,
    frags: 0, deadflag: 0, respawnAt: 0, attackAt: 0, frame: 12, weaponframe: 0,
    punch: 0, dmgTake: 0, dmgSave: 0, dmgFrom: [0, 0, 0], stats: new Array(24).fill(0), botTurn: 1,
  };
}

/** xorshift128+ in 32-bit halves: deterministic and serializable. */
function rand(w: World): number {
  let [a, b] = w.rng;
  a ^= a << 11; a ^= a >>> 8; b ^= b >>> 19;
  const r = (a ^ b) >>> 0;
  w.rng = [w.rng[1], r];
  return r / 4294967296;
}

function infoValue(ui: string, k: string): string { return parseInfo(ui).get(k) ?? ''; }

export function createFakeSim(): QtSimExports {
  const memory = new WebAssembly.Memory({ initial: 128 });      // 8 MB
  const worlds = new Map<number, World>();
  let nextH = 1;
  const maps: string[] = [];
  let progsCount = 0;
  let allocAt = 0x400000;
  let lastError = '';
  const enc = new TextEncoder();
  const R = { ents: 0x1000, client: 0x60000, clients: 0x61000, info: 0x63000, events: 0x64000, strings: 0x70000, models: 0x80000, sounds: 0x81000, styles: 0x82000, sinfo: 0x83000, err: 0x84000, mapname: 0x85000, buf: 0x100000 };

  const u8 = (): Uint8Array => new Uint8Array(memory.buffer);
  const i32 = (): Int32Array => new Int32Array(memory.buffer);
  const f32 = (): Float32Array => new Float32Array(memory.buffer);
  const readStr = (p: number, n: number): string => { let s = ''; const m = u8(); for (let i = 0; i < n; i++) s += String.fromCharCode(m[p + i]); return s; };
  const writeStr = (p: number, s: string): number => { const m = u8(); for (let i = 0; i < s.length; i++) m[p + i] = s.charCodeAt(i) & 255; m[p + s.length] = 0; return p; };
  const writeList = (p: number, list: string[]): number => {
    let at = p;
    for (const s of list) { writeStr(at, s); at += s.length + 1; }
    u8()[at] = 0;
    return p;
  };
  const W = (h: number): World => { const w = worlds.get(h); if (!w) throw new Error(`fake: no world ${h}`); return w; };

  const event = (w: World, kind: number, a = 0, b = 0, c = 0, d = 0, x = 0, y = 0, z = 0, e = 0, ff = 0): void => {
    w.ev.push(kind, a, b, c, d, x, y, z, e, ff);
  };
  const str = (w: World, s: string): number => { w.strs.push(s); return w.strs.length - 1; };
  const nameOf = (w: World, slot: number): string => {
    const c = w.clients[slot];
    return infoValue(c.ui, 'name') || BOT_NAMES[slot % BOT_NAMES.length];
  };

  const spawnPoint = (w: World, c: Client): void => {
    const ang = rand(w) * Math.PI * 2, r = 200 + rand(w) * 600;
    c.o = [f(Math.cos(ang) * r), f(Math.sin(ang) * r), PLAYER_Z];
    c.v = [0, 0, 0];
    c.a = [0, f((ang * 180) / Math.PI + 180), 0];
    c.health = 100; c.armor = 0; c.rockets = 50; c.deadflag = 0; c.onground = 1; c.frame = 12;
    c.serial = (w.serials[c.ent] = (w.serials[c.ent] ?? 0) + 1);
  };

  const connect = (w: World, slot: number, state: number, ui: string): void => {
    const c = w.clients[slot];
    c.state = state; c.ui = ui; c.frags = 0; c.stats = new Array(24).fill(0);
    c.cmd = [0, 0, 0, 0, 0, 0, 0];
    spawnPoint(w, c);
    event(w, EV_TEMP, TE_TELEPORT, 0, 0, 0, c.o[0], c.o[1], c.o[2]);
    event(w, EV_SOUND, c.ent, 0, S_TELE, 255, c.o[0], c.o[1], c.o[2], 64);
    if (state === 1) event(w, EV_PRINT, -1, 2, str(w, `${nameOf(w, slot)} entered the game\n`));
  };

  const fillBots = (w: World): void => {
    if (!w.bots) return;
    // Half the slots carry bots at most, so a room has someone to shoot and room to join.
    const want = Math.max(2, Math.min(w.maxclients, 4));
    let have = w.clients.filter((c) => c.state !== 0).length;
    for (let s = 0; s < w.maxclients && have < want; s++) {
      if (w.clients[s].state === 0) { connect(w, s, 2, `\\name\\${BOT_NAMES[s % BOT_NAMES.length]}\\*bot\\1\\topcolor\\${s % 14}\\bottomcolor\\${(s * 5) % 14}`); have++; }
    }
  };

  const damage = (w: World, victim: Client, attacker: Client | null, amount: number, from: number[], deathtype: number): void => {
    if (victim.deadflag || victim.state === 0) return;
    let take = amount;
    let save = 0;
    if (victim.armor > 0) { save = Math.min(victim.armor, Math.ceil(amount * 0.6)); victim.armor -= save; take -= save; }
    victim.health -= take;
    victim.dmgTake += take; victim.dmgSave += save; victim.dmgFrom = from.slice();
    if (attacker && attacker !== victim) { attacker.stats[ST.dmgGiven] += take; }
    victim.stats[ST.dmgTaken] += take;
    const vs = victim.ent - 1;
    event(w, EV_DAMAGE, vs, save, take, 0, from[0], from[1], from[2]);
    if (victim.health <= 0) {
      victim.deadflag = 1; victim.respawnAt = w.time + 1.5; victim.frame = 50;
      const ks = attacker ? attacker.ent - 1 : -1;
      if (attacker === victim || !attacker) { victim.frags--; victim.stats[ST.suicides]++; }
      else { attacker.frags++; attacker.stats[ST.kills]++; }
      victim.stats[ST.deaths]++;
      event(w, EV_OBITUARY, vs, ks, deathtype, 0, victim.o[0], victim.o[1], victim.o[2]);
      event(w, EV_SOUND, victim.ent, 2, S_DEATH, 255, victim.o[0], victim.o[1], victim.o[2], 64);
      const text = !attacker || attacker === victim ? `${nameOf(w, vs)} becomes bored with life\n` : `${nameOf(w, vs)} rides ${nameOf(w, ks)}'s rocket\n`;
      event(w, EV_PRINT, -1, PRINT_MEDIUM, str(w, text));
    } else {
      event(w, EV_SOUND, victim.ent, 2, S_PAIN, 255, victim.o[0], victim.o[1], victim.o[2], 64);
    }
  };

  const explode = (w: World, m: Missile): void => {
    event(w, EV_TEMP, TE_EXPLOSION, 0, 0, 0, m.o[0], m.o[1], m.o[2]);
    event(w, EV_SOUND, 0, 0, S_EXPLODE, 255, m.o[0], m.o[1], m.o[2], 64);
    const owner = w.clients[m.owner - 1] ?? null;
    if (owner) owner.stats[ST.rlHits] += 0;
    for (const c of w.clients) {
      if (c.state === 0 || c.deadflag) continue;
      const d = [c.o[0] - m.o[0], c.o[1] - m.o[1], c.o[2] - m.o[2]];
      const dist = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
      if (dist > 160) continue;
      let pts = 120 - 0.5 * dist;
      if (c === owner) pts *= 0.5;
      if (pts <= 0) continue;
      const k = dist > 1 ? 1 / dist : 0;
      const kick = pts * (c === owner ? 8 : 4);
      c.v[0] = f(c.v[0] + d[0] * k * kick); c.v[1] = f(c.v[1] + d[1] * k * kick); c.v[2] = f(c.v[2] + Math.max(0.3, d[2] * k) * kick);
      c.onground = 0;
      if (owner && c !== owner && dist < 40) owner.stats[ST.rlHits]++;
      damage(w, c, owner, Math.round(pts), m.o, 7);
    }
    w.freeNums.push(m.num);
  };

  const pmove = (w: World, c: Client): void => {
    const [, yaw16, fwd, side, , buttons] = c.cmd;
    const yaw = (yaw16 * 2 * Math.PI) / 65536;
    const fx = Math.cos(yaw), fy = Math.sin(yaw);
    const rx = Math.sin(yaw), ry = -Math.cos(yaw);
    let wx = fx * fwd + rx * side, wy = fy * fwd + ry * side;
    let wishspeed = Math.sqrt(wx * wx + wy * wy);
    if (wishspeed > 0) { wx /= wishspeed; wy /= wishspeed; }
    if (wishspeed > 320) wishspeed = 320;
    const jump = (buttons & 2) !== 0;
    if (c.onground) {
      if (jump && !(c.oldButtons & 2)) {
        c.v[2] = 270; c.onground = 0;
        event(w, EV_SOUND, c.ent, 4, S_JUMP, 255, c.o[0], c.o[1], c.o[2], 64);
      } else {
        // PM_Friction
        const speed = Math.sqrt(c.v[0] * c.v[0] + c.v[1] * c.v[1]);
        if (speed >= 1) {
          const control = speed < 100 ? 100 : speed;
          let ns = speed - FT * control * 4;
          if (ns < 0) ns = 0;
          c.v[0] = f(c.v[0] * (ns / speed)); c.v[1] = f(c.v[1] * (ns / speed));
        } else { c.v[0] = 0; c.v[1] = 0; }
      }
    }
    // PM_Accelerate / PM_AirAccelerate
    const air = !c.onground;
    const wishspd = air && wishspeed > 30 ? 30 : wishspeed;
    const cur = c.v[0] * wx + c.v[1] * wy;
    const add = wishspd - cur;
    if (add > 0) {
      let acc = (air ? 0.7 : 10) * wishspeed * FT;
      if (acc > add) acc = add;
      c.v[0] = f(c.v[0] + acc * wx); c.v[1] = f(c.v[1] + acc * wy);
    }
    if (air) c.v[2] = f(c.v[2] - 800 * FT);
    for (let i = 0; i < 3; i++) c.o[i] = f(c.o[i] + c.v[i] * FT);
    for (let i = 0; i < 2; i++) {
      if (c.o[i] > HALF - 16) { c.o[i] = HALF - 16; c.v[i] = 0; }
      if (c.o[i] < -HALF + 16) { c.o[i] = -HALF + 16; c.v[i] = 0; }
    }
    if (c.o[2] <= PLAYER_Z) {
      if (air && c.v[2] < -650) event(w, EV_SOUND, c.ent, 4, 8, 255, c.o[0], c.o[1], c.o[2], 64);
      c.o[2] = PLAYER_Z; if (c.v[2] < 0) c.v[2] = 0; c.onground = 1;
    }
    c.oldButtons = buttons;
  };

  const runClient = (w: World, slot: number): void => {
    const c = w.clients[slot];
    if (c.state === 0) return;
    if (c.state !== 1) bot(w, c);
    c.a = [f((c.cmd[0] * 360) / 65536), f((c.cmd[1] * 360) / 65536), 0];
    if (c.deadflag) {
      if (c.frame < 60) c.frame++;
      c.v = [0, 0, 0];
      if (w.time >= c.respawnAt && ((c.cmd[5] & 1) || c.state !== 1 || w.time > c.respawnAt + 3)) {
        spawnPoint(w, c);
        event(w, EV_TEMP, TE_TELEPORT, 0, 0, 0, c.o[0], c.o[1], c.o[2]);
      }
      return;
    }
    pmove(w, c);
    const moving = Math.abs(c.v[0]) + Math.abs(c.v[1]) > 20;
    c.frame = moving ? 6 + (Math.floor(w.tick / 8) % 6) : 12 + (Math.floor(w.tick / 10) % 5);
    if (c.weaponframe > 0) c.weaponframe = c.weaponframe >= 8 ? 0 : c.weaponframe + 1;
    if (c.punch < 0) c.punch = Math.min(0, c.punch + 10 * FT);
    if ((c.cmd[5] & 1) && w.time >= c.attackAt && c.rockets > 0) {
      c.attackAt = w.time + 0.8;
      c.rockets--;
      c.weaponframe = 1; c.punch = -2;
      c.stats[ST.rlShots]++;
      const pitch = (c.a[0] * Math.PI) / 180, yaw = (c.a[1] * Math.PI) / 180;
      const dir = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), -Math.sin(pitch)];
      const num = w.freeNums.length ? w.freeNums.shift()! : w.nextNum++;
      const serial = (w.serials[num] = (w.serials[num] ?? 0) + 1);
      w.missiles.push({ num, serial, o: [f(c.o[0] + dir[0] * 8), f(c.o[1] + dir[1] * 8), f(c.o[2] + 16)], v: dir.map((d) => f(d * 1000)), owner: c.ent, dieAt: w.time + 5 });
      event(w, EV_SOUND, c.ent, 1, S_ROCKET, 255, c.o[0], c.o[1], c.o[2], 64);
      event(w, 5, c.ent);   // EV_MUZZLE
    }
    // armor pickup
    const ar = w.armor;
    if (ar.at <= w.time && Math.abs(c.o[0] - ar.o[0]) < 32 && Math.abs(c.o[1] - ar.o[1]) < 32 && c.o[2] < 80) {
      c.armor = 200; ar.at = w.time + 20; c.stats[ST.ra]++;
      event(w, EV_SOUND, c.ent, 3, S_ARMOR, 255, c.o[0], c.o[1], c.o[2], 64);
      event(w, EV_PICKUP, slot, 6, 0, 0, ar.o[0], ar.o[1], ar.o[2]);
      event(w, EV_PRINT, slot, 0, str(w, 'You got the Red Armor\n'));
    }
  };

  const bot = (w: World, c: Client): void => {
    let best: Client | null = null, bd = 1e9;
    for (const o of w.clients) {
      if (o === c || o.state === 0 || o.deadflag) continue;
      const d = Math.hypot(o.o[0] - c.o[0], o.o[1] - c.o[1]);
      if (d < bd) { bd = d; best = o; }
    }
    let yaw = (c.cmd[1] * 360) / 65536, pitch = 0;
    if (best) {
      yaw = (Math.atan2(best.o[1] - c.o[1], best.o[0] - c.o[0]) * 180) / Math.PI + (rand(w) - 0.5) * 8;
      pitch = (-Math.atan2(best.o[2] - c.o[2], bd) * 180) / Math.PI;
    }
    if (rand(w) < 0.01) c.botTurn = -c.botTurn;
    const toShort = (deg: number): number => { const s = Math.round((deg * 65536) / 360) & 0xffff; return s >= 32768 ? s - 65536 : s; };
    const near = Math.hypot(c.o[0], c.o[1]) > HALF - 120;
    c.cmd = [toShort(pitch), toShort(yaw), near ? -400 : bd > 300 ? 400 : 0, 400 * c.botTurn, 0, (best && bd < 900 && rand(w) < 0.1 ? 1 : 0) | (rand(w) < 0.02 ? 2 : 0), 0];
    if (c.deadflag) c.cmd[5] = 1;
  };

  const runMissiles = (w: World): void => {
    const keep: Missile[] = [];
    for (const m of w.missiles) {
      for (let i = 0; i < 3; i++) m.o[i] = f(m.o[i] + m.v[i] * FT);
      let hit = m.o[2] <= 0 || Math.abs(m.o[0]) >= HALF || Math.abs(m.o[1]) >= HALF || m.o[2] > 600 || w.time >= m.dieAt;
      if (!hit) for (const c of w.clients) {
        if (c.state === 0 || c.deadflag || c.ent === m.owner) continue;
        if (Math.abs(c.o[0] - m.o[0]) < 20 && Math.abs(c.o[1] - m.o[1]) < 20 && m.o[2] > c.o[2] - 28 && m.o[2] < c.o[2] + 36) { hit = true; break; }
      }
      if (hit) explode(w, m); else keep.push(m);
    }
    w.missiles = keep;
  };

  const tick = (w: World): void => {
    w.ev = []; w.strs = [];
    w.tick++;
    w.time = 1 + w.tick * FT;
    for (const c of w.clients) { c.dmgTake = 0; c.dmgSave = 0; }
    for (let s = 0; s < w.maxclients; s++) runClient(w, s);
    runMissiles(w);
    if (w.tick === 1) event(w, EV_MATCH, PHASE_PLAYING, 0, 0, 0, 0, 0, 0, 0, 0);
    if (w.tick % (77 * 60) === 0) event(w, EV_CENTER, -1, str(w, 'A minute has passed'));
  };

  const hashWorld = (w: World): number => {
    const s = JSON.stringify([w.tick, w.rng, w.clients, w.missiles, w.armor, w.freeNums, w.nextNum, w.serials]);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  };

  const add = (w: World): number => { const h = nextH++; worlds.set(h, w); return h; };

  const ex: QtSimExports = {
    memory,
    alloc(len) {
      if (allocAt + len > memory.buffer.byteLength) allocAt = 0x400000;
      const p = allocAt; allocAt += (len + 7) & ~7;
      if (allocAt > memory.buffer.byteLength) { memory.grow(Math.ceil((allocAt - memory.buffer.byteLength) / 65536)); }
      return p;
    },
    dealloc() { /* the bump region is reused */ },
    sim_version: () => FAKE_VERSION,
    last_error_ptr: () => writeStr(R.err, lastError),
    progs_load: () => progsCount++,
    map_load(np, nn) { maps.push(readStr(np, nn)); return maps.length - 1; },
    map_name: (id) => writeStr(R.mapname, maps[id] ?? ''),
    map_count: () => maps.length,

    world_new(progs, map, seed, ip, il) {
      const info = readStr(ip, il);
      const si = parseInfo(info);
      const maxclients = Math.max(2, Math.min(32, Number(si.get('maxclients')) || 8));
      const w: World = {
        map, progs, info, tick: 0, time: 1, rng: [(seed | 0) || 1, 0x9e3779b9 | 0], maxclients,
        bots: si.get('bots') !== '0', clients: Array.from({ length: maxclients }, (_, i) => newClient(i)),
        missiles: [], freeNums: [], nextNum: maxclients + 1, serials: {},
        armor: { o: [0, 0, 24], at: 0, serial: 1 }, ev: [], strs: [],
      };
      fillBots(w);
      return add(w);
    },
    world_free(h) { worlds.delete(h); },
    world_clone(h) { return add(structuredClone(W(h))); },
    world_serialize(h) {
      const bytes = enc.encode(JSON.stringify(W(h)));
      u8().set(bytes, R.buf);
      return bytes.length;
    },
    world_buf_ptr: () => R.buf,
    world_deserialize(p, n) {
      try { return add(JSON.parse(new TextDecoder().decode(u8().slice(p, p + n))) as World); } catch (e) { lastError = String(e); return 0; }
    },
    world_hash: (h) => hashWorld(W(h)),
    world_tick_count: (h) => W(h).tick,
    world_map: (h) => W(h).map,

    world_free_slot(h) {
      const w = W(h);
      for (let s = 0; s < w.maxclients; s++) if (w.clients[s].state === 0) return s;
      for (let s = 0; s < w.maxclients; s++) if (w.clients[s].state === 2) return s;
      return -1;
    },
    world_client_join(h, slot, up, un) {
      const w = W(h);
      const c = w.clients[slot];
      if (!c) return;
      const ui = readStr(up, un);
      if (c.state === 3) { c.state = 1; c.ui = ui; return; }   // back from idle: same body, frags kept
      if (c.state === 1) { c.ui = ui; return; }
      connect(w, slot, 1, ui);
    },
    world_client_leave(h, slot) {
      const w = W(h);
      const c = w.clients[slot];
      if (!c || (c.state !== 1 && c.state !== 3)) return;
      event(w, EV_PRINT, -1, 2, str(w, `${nameOf(w, slot)} left the game with ${c.frags} frags\n`));
      c.state = 0; c.ui = '';
      fillBots(w);
    },
    world_client_idle(h, slot) { const c = W(h).clients[slot]; if (c && c.state === 1) c.state = 3; },
    world_set_userinfo(h, slot, up, un) { const c = W(h).clients[slot]; if (c && c.state !== 0) c.ui = readStr(up, un); },
    world_client_command(h, slot, p, n) {
      const w = W(h);
      const cmd = readStr(p, n);
      const c = w.clients[slot];
      if (cmd === 'kill' && c && !c.deadflag) damage(w, c, c, 999, c.o, 16);
      else event(w, EV_PRINT, slot, 2, str(w, `fake sim: ignored "${cmd}"\n`));
    },
    world_set_cmd(h, slot, pitch, yaw, fwd, side, up, buttons, impulse) {
      const c = W(h).clients[slot];
      if (c && c.state === 1) c.cmd = [pitch, yaw, fwd, side, up, buttons, impulse];
    },
    world_tick(h) { tick(W(h)); },

    world_view_ents(h) {
      const w = W(h);
      const I = i32(), F = f32();
      let n = 0;
      const base = R.ents >> 2;
      const put = (num: number, serial: number, model: number, frame: number, colormap: number, effects: number, move: number, o: number[], a: number[], v: number[], owner: number): void => {
        const at = base + 1 + n * ENT_WORDS;
        I.fill(0, at, at + ENT_WORDS);
        I[at] = num; I[at + 1] = serial; I[at + 2] = model; I[at + 3] = frame; I[at + 5] = colormap; I[at + 6] = effects; I[at + 7] = move;
        F[at + 8] = o[0]; F[at + 9] = o[1]; F[at + 10] = o[2];
        F[at + 11] = a[0]; F[at + 12] = a[1]; F[at + 13] = a[2];
        F[at + 14] = v[0]; F[at + 15] = v[1]; F[at + 16] = v[2];
        I[at + 17] = owner; F[at + 18] = 1;
        n++;
      };
      for (const c of w.clients) {
        if (c.state === 0) continue;
        put(c.ent, c.serial, M_PLAYER, c.frame, c.ent, 0, MOVETYPE_WALK | (3 << 8) | ((c.onground ? 512 : 0) << 16), c.o, [0, c.a[1], 0], c.v, 0);
      }
      for (const m of w.missiles) {
        const yaw = (Math.atan2(m.v[1], m.v[0]) * 180) / Math.PI;
        put(m.num, m.serial, M_MISSILE, 0, 0, EF_DIMLIGHT, MOVETYPE_FLYMISSILE | (2 << 8), m.o, [0, yaw, 0], m.v, m.owner);
      }
      if (w.armor.at <= w.time) put(w.maxclients + 400, w.armor.serial, M_ARMOR, 0, 0, 0, MOVETYPE_NONE | (1 << 8), w.armor.o, [0, (w.tick * 1.3) % 360, 0], [0, 0, 0], 0);
      I[base] = n;
      return R.ents;
    },
    world_view_client(h, slot) {
      const w = W(h);
      const c = w.clients[slot];
      const I = i32(), F = f32();
      const b = R.client >> 2;
      I.fill(0, b, b + CLIENT_WORDS);
      if (!c) return R.client;
      I[b + CV.slot] = slot; I[b + CV.entnum] = c.ent; I[b + CV.state] = c.state;
      for (let i = 0; i < 3; i++) { F[b + CV.origin + i] = c.o[i]; F[b + CV.velocity + i] = c.v[i]; F[b + CV.vAngle + i] = c.a[i]; F[b + CV.dmgFrom + i] = c.dmgFrom[i]; }
      F[b + CV.viewOfsZ] = c.deadflag ? -8 : 22;
      F[b + CV.punch] = c.punch;
      I[b + CV.onground] = c.onground; I[b + CV.health] = c.health; I[b + CV.armor] = c.armor; I[b + CV.armortype] = c.armor ? 80 : 0;
      I[b + CV.currentammo] = c.rockets; I[b + CV.shells] = 25; I[b + CV.rockets] = c.rockets;
      I[b + CV.items] = IT.SHOTGUN | IT.ROCKET_LAUNCHER | IT.AXE | (c.armor ? IT.ARMOR3 : 0);
      I[b + CV.weapon] = IT.ROCKET_LAUNCHER; I[b + CV.weaponmodel] = c.deadflag ? 0 : M_VROCK; I[b + CV.weaponframe] = c.weaponframe;
      I[b + CV.frags] = c.frags; I[b + CV.deadflag] = c.deadflag; I[b + CV.dmgTake] = c.dmgTake; I[b + CV.dmgSave] = c.dmgSave;
      I[b + CV.jumpHeld] = c.oldButtons & 2 ? 1 : 0; I[b + CV.phase] = PHASE_PLAYING; F[b + CV.phaseEnd] = 1 + 15 * 60;
      return R.client;
    },
    world_view_clients(h) {
      const w = W(h);
      const I = i32();
      const b = R.clients >> 2;
      I[b] = w.maxclients;
      for (let s = 0; s < w.maxclients; s++) {
        const c = w.clients[s];
        const at = b + 1 + s * ROW_WORDS;
        I.fill(0, at, at + ROW_WORDS);
        I[at] = s; I[at + 1] = c.state; I[at + 2] = c.ent; I[at + 3] = c.frags;
        I[at + 5] = Number(infoValue(c.ui, 'topcolor')) || 0; I[at + 6] = Number(infoValue(c.ui, 'bottomcolor')) || 0;
        const k = c.stats[ST.kills], d = c.stats[ST.deaths];
        c.stats[ST.eff] = k + d ? Math.round((k * 100) / (k + d)) : 0;
        for (let i = 0; i < 24; i++) I[at + R_STATS + i] = c.stats[i];
      }
      return R.clients;
    },
    world_client_info(h, slot) {
      const w = W(h);
      const c = w.clients[slot];
      return writeStr(R.info, c ? (c.ui || `\\name\\${BOT_NAMES[slot % BOT_NAMES.length]}\\*bot\\1`) : '');
    },
    world_events(h) {
      const w = W(h);
      const I = i32(), F = f32();
      const b = R.events >> 2;
      const n = w.ev.length / EVENT_WORDS;
      I[b] = n;
      for (let i = 0; i < w.ev.length; i++) {
        const k = i % EVENT_WORDS;
        if (k >= 5 && k <= 7) F[b + 1 + i] = w.ev[i]; else I[b + 1 + i] = w.ev[i];
      }
      return R.events;
    },
    world_strings: (h) => writeList(R.strings, W(h).strs.map((s) => s || ' ')),
    world_model_names: () => { writeList(R.models + 1, MODELS.slice(1)); u8()[R.models] = 0; return R.models; },
    world_sound_names: () => { writeList(R.sounds + 1, SOUNDS.slice(1)); u8()[R.sounds] = 0; return R.sounds; },
    world_lightstyles: () => {
      let at = R.styles;
      for (let i = 0; i < 64; i++) { const s = i === 0 ? 'm' : i === 1 ? 'mmnmmommommnonmmonqnmmo' : ''; writeStr(at, s); at += s.length + 1; }
      return R.styles;
    },
    world_serverinfo: (h) => writeStr(R.sinfo, W(h).info),
    world_set_cvar() { /* none */ },
  };
  void EV_MUZZLE; void TE_TELEPORT; void PRINT_MEDIUM; void IT;
  return ex;
}
