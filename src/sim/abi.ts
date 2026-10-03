/*
 * Quake Town — the qtsim wasm ABI (DESIGN.md "The wasm ABI"), typed, and nothing else.
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 *
 * Every pointer the sim hands back is into its linear memory and valid only
 * until the next call on that world, so every reader here COPIES what it
 * returns. `memory.buffer` is re-read after each call: a call may grow the
 * memory, which detaches every view made before it.
 */

export interface QtSimExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  sim_version(): number;
  last_error_ptr(): number;

  progs_load(ptr: number, len: number): number;
  map_load(namePtr: number, nameLen: number, ptr: number, len: number): number;
  map_name(mapId: number): number;
  map_count(): number;

  world_new(progsId: number, mapId: number, seed: number, infoPtr: number, infoLen: number): number;
  world_free(h: number): void;
  world_clone(h: number): number;
  world_serialize(h: number): number;
  world_buf_ptr(): number;
  world_deserialize(ptr: number, len: number): number;
  world_hash(h: number): number;
  world_tick_count(h: number): number;
  world_map(h: number): number;

  world_free_slot(h: number): number;
  world_client_join(h: number, slot: number, uiPtr: number, uiLen: number): void;
  world_client_leave(h: number, slot: number): void;
  world_client_idle(h: number, slot: number): void;
  world_set_userinfo(h: number, slot: number, uiPtr: number, uiLen: number): void;
  world_client_command(h: number, slot: number, ptr: number, len: number): void;

  world_set_cmd(h: number, slot: number, pitch16: number, yaw16: number, forward: number, side: number, up: number, buttons: number, impulse: number): void;
  world_tick(h: number): void;
  world_tick_ms(h: number, msec: number): void;

  world_view_ents(h: number): number;
  world_view_client(h: number, slot: number): number;
  world_view_clients(h: number): number;
  world_client_info(h: number, slot: number): number;
  world_events(h: number): number;
  world_strings(h: number): number;
  world_model_names(h: number): number;
  world_sound_names(h: number): number;
  world_lightstyles(h: number): number;
  world_serverinfo(h: number): number;

  world_set_cvar?(h: number, namePtr: number, nameLen: number, valuePtr: number, valueLen: number): void;
  /** (engine extension) 1 if the world stopped on a fatal QuakeC error (text in last_error_ptr) */
  world_stopped?(h: number): number;
  /** (engine extension) u32 count, then count × (sound, volume, atten×64, x, y, z f32): ambientsound() calls */
  world_ambients?(h: number): number;
}

// ---------------------------------------------------------------- EntView (20 words)
export const ENT_WORDS = 20;
export const E_NUM = 0, E_SERIAL = 1, E_MODEL = 2, E_FRAME = 3, E_SKIN = 4, E_COLORMAP = 5, E_EFFECTS = 6,
  E_MOVE = 7, E_ORIGIN = 8, E_ANGLES = 11, E_VELOCITY = 14, E_OWNER = 17, E_ALPHA = 18;

// movetypes (QW)
export const MOVETYPE_NONE = 0, MOVETYPE_WALK = 3, MOVETYPE_STEP = 4, MOVETYPE_FLY = 5, MOVETYPE_TOSS = 6,
  MOVETYPE_PUSH = 7, MOVETYPE_NOCLIP = 8, MOVETYPE_FLYMISSILE = 9, MOVETYPE_BOUNCE = 10;

// effects
export const EF_BRIGHTFIELD = 1, EF_MUZZLEFLASH = 2, EF_BRIGHTLIGHT = 4, EF_DIMLIGHT = 8,
  EF_FLAG1 = 16, EF_FLAG2 = 32, EF_BLUE = 64, EF_RED = 128;

// ---------------------------------------------------------------- ClientView (64 words)
export const CLIENT_WORDS = 64;
export const CV = {
  slot: 0, entnum: 1, state: 2, origin: 3, velocity: 6, vAngle: 9, viewOfsZ: 12, punch: 13,
  onground: 16, waterlevel: 17, watertype: 18, health: 19, armor: 20, armortype: 21, currentammo: 22,
  shells: 23, nails: 24, rockets: 25, cells: 26, items: 27, weapon: 28, weaponmodel: 29, weaponframe: 30,
  frags: 31, deadflag: 32, effects: 33, fixangle: 34, fixAngles: 35, dmgTake: 38, dmgSave: 39,
  dmgFrom: 40, intermission: 43, spectator: 44, jumpHeld: 45, teleportTime: 46, phase: 47, phaseEnd: 48, time: 49,
} as const;
/** Words of ClientView that are f32 bit patterns. */
export const CV_FLOATS: readonly number[] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 35, 36, 37, 40, 41, 42, 46, 48, 49];

export const CLIENT_EMPTY = 0, CLIENT_HUMAN = 1, CLIENT_BOT = 2, CLIENT_IDLE = 3;

// ---------------------------------------------------------------- ClientRow (32 words)
export const ROW_WORDS = 32;
export const R_SLOT = 0, R_STATE = 1, R_ENTNUM = 2, R_FRAGS = 3, R_TEAM = 4, R_TOP = 5, R_BOTTOM = 6, R_PING = 7, R_STATS = 8;
export const ST = {
  kills: 0, deaths: 1, suicides: 2, teamkills: 3, dmgGiven: 4, dmgTaken: 5,
  ra: 6, ya: 7, ga: 8, mh: 9, quad: 10, pent: 11, ring: 12,
  rlShots: 13, rlHits: 14, lgShots: 15, lgHits: 16, sgShots: 17, sgHits: 18,
  ssgShots: 19, ssgHits: 20, glShots: 21, glHits: 22, eff: 23,
} as const;

// ---------------------------------------------------------------- Events (10 words)
export const EVENT_WORDS = 10;
export const EV_SOUND = 1, EV_TEMP = 2, EV_PRINT = 3, EV_CENTER = 4, EV_MUZZLE = 5, EV_DAMAGE = 6, EV_KICK = 7,
  EV_STUFF = 8, EV_LIGHTSTYLE = 9, EV_INTERMISSION = 10, EV_OBITUARY = 11, EV_MATCH = 12, EV_CHANGELEVEL = 13, EV_PICKUP = 14;

export const TE_SPIKE = 0, TE_SUPERSPIKE = 1, TE_GUNSHOT = 2, TE_EXPLOSION = 3, TE_TAREXPLOSION = 4,
  TE_LIGHTNING1 = 5, TE_LIGHTNING2 = 6, TE_WIZSPIKE = 7, TE_KNIGHTSPIKE = 8, TE_LIGHTNING3 = 9,
  TE_LAVASPLASH = 10, TE_TELEPORT = 11, TE_BLOOD = 12, TE_LIGHTNINGBLOOD = 13;

export const PRINT_LOW = 0, PRINT_MEDIUM = 1, PRINT_HIGH = 2, PRINT_CHAT = 3;

// match phases
export const PHASE_WARMUP = 0, PHASE_COUNTDOWN = 1, PHASE_PLAYING = 2, PHASE_OVERTIME = 3, PHASE_INTERMISSION = 4, PHASE_ROUNDBREAK = 5;

// QW items
export const IT = {
  SHOTGUN: 1, SUPER_SHOTGUN: 2, NAILGUN: 4, SUPER_NAILGUN: 8, GRENADE_LAUNCHER: 16, ROCKET_LAUNCHER: 32,
  LIGHTNING: 64, SUPER_LIGHTNING: 128, SHELLS: 256, NAILS: 512, ROCKETS: 1024, CELLS: 2048, AXE: 4096,
  ARMOR1: 8192, ARMOR2: 16384, ARMOR3: 32768, SUPERHEALTH: 65536, KEY1: 131072, KEY2: 262144,
  INVISIBILITY: 524288, INVULNERABILITY: 1048576, SUIT: 2097152, QUAD: 4194304,
  SIGIL1: 1 << 28, SIGIL2: 1 << 29, SIGIL3: 1 << 30, SIGIL4: 1 << 31,
} as const;

export const BUTTON_ATTACK = 1, BUTTON_JUMP = 2;

// ---------------------------------------------------------------- loading

/**
 * Instantiate the module. The DESIGN says the wasm imports nothing; whatever a
 * debug build imports anyway is satisfied with a reporting stub.
 */
export async function instantiateQtSim(source: Response | Promise<Response> | ArrayBuffer | Uint8Array): Promise<QtSimExports> {
  let module: WebAssembly.Module;
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    module = await WebAssembly.compile(source as BufferSource);
  } else {
    const res = await source;
    if (!res.ok) throw new Error(`qtsim.wasm: HTTP ${res.status}`);
    try { module = await WebAssembly.compileStreaming(res.clone()); } catch { module = await WebAssembly.compile(await res.arrayBuffer()); }
  }
  let memory: WebAssembly.Memory | null = null;
  const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {};
  for (const imp of WebAssembly.Module.imports(module)) {
    const ns = (imports[imp.module] ??= {});
    if (imp.kind !== 'function') continue;
    ns[imp.name] = (...args: number[]) => {
      if (memory && args.length >= 2 && args[1] > 0 && args[1] < 4096) {
        console.warn(`[qtsim] ${imp.name}: ${new TextDecoder().decode(new Uint8Array(memory.buffer, args[0], args[1]))}`);
      } else console.warn(`[qtsim] ${imp.module}.${imp.name}(${args.join(', ')})`);
      return 0;
    };
  }
  const instance = await WebAssembly.instantiate(module, imports);
  const ex = instance.exports as unknown as QtSimExports;
  memory = ex.memory;
  for (const k of ['alloc', 'progs_load', 'map_load', 'world_new', 'world_tick', 'world_hash', 'world_serialize', 'world_deserialize', 'world_view_ents', 'world_view_client', 'world_events'] as const) {
    if (typeof ex[k] !== 'function') throw new Error(`qtsim.wasm does not export ${k}`);
  }
  return ex;
}

// ---------------------------------------------------------------- readers (all copy)

const latin1 = new TextDecoder('latin1');
const utf8 = new TextEncoder();

/** `count` i32s at ptr. */
export function copyI32(ex: QtSimExports, ptr: number, count: number): Int32Array {
  return new Int32Array(ex.memory.buffer, ptr, count).slice();
}

/** `u32 count`, then `count × words` i32s. */
export function copyCounted(ex: QtSimExports, ptr: number, words: number): Int32Array {
  if (!ptr) return new Int32Array(0);
  const n = new Uint32Array(ex.memory.buffer, ptr, 1)[0];
  return new Int32Array(ex.memory.buffer, ptr + 4, n * words).slice();
}

/** A NUL-terminated string. Quake text is bytes: high-bit chars are the coloured conchars half. */
export function readCString(ex: QtSimExports, ptr: number): string {
  if (!ptr) return '';
  const mem = new Uint8Array(ex.memory.buffer);
  let end = ptr;
  while (end < mem.length && mem[end] !== 0) end++;
  return latin1.decode(mem.subarray(ptr, end));
}

/** NUL-terminated names followed by one extra NUL (DESIGN "Every name list"). */
export function readNameList(ex: QtSimExports, ptr: number, max = 1 << 16): string[] {
  if (!ptr) return [];
  const mem = new Uint8Array(ex.memory.buffer);
  const out: string[] = [];
  let at = ptr;
  while (at < mem.length && out.length < max) {
    let end = at;
    while (end < mem.length && mem[end] !== 0) end++;
    if (end === at) break;                  // the extra NUL
    out.push(latin1.decode(mem.subarray(at, end)));
    at = end + 1;
  }
  return out;
}

/**
 * NUL-separated strings where an empty string is a valid entry (event strings,
 * lightstyles): read exactly `count` of them.
 */
export function readStrings(ex: QtSimExports, ptr: number, count: number): string[] {
  const out: string[] = [];
  if (!ptr) return out;
  const mem = new Uint8Array(ex.memory.buffer);
  let at = ptr;
  for (let i = 0; i < count && at < mem.length; i++) {
    let end = at;
    while (end < mem.length && mem[end] !== 0) end++;
    out.push(latin1.decode(mem.subarray(at, end)));
    at = end + 1;
  }
  return out;
}

/**
 * Strings referenced by events: NUL-separated, terminated by an extra NUL, but
 * an event may reference an empty string, so the reader stops at the highest
 * index any event names.
 */
export function readEventStrings(ex: QtSimExports, ptr: number, needed: number): string[] {
  return readStrings(ex, ptr, needed);
}

/** Copy bytes into wasm memory, call `fn(ptr, len)`, free them. */
export function withBytes<T>(ex: QtSimExports, bytes: Uint8Array, fn: (ptr: number, len: number) => T): T {
  const len = bytes.length;
  const ptr = ex.alloc(Math.max(1, len));
  new Uint8Array(ex.memory.buffer, ptr, len).set(bytes);
  try { return fn(ptr, len); } finally { ex.dealloc(ptr, Math.max(1, len)); }
}

/** Quake strings are bytes; anything outside latin1 becomes '?'. */
export function textBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out[i] = c < 256 ? c : 63; }
  return out;
}

export function lastError(ex: QtSimExports): string {
  try { return readCString(ex, ex.last_error_ptr()); } catch { return ''; }
}

export { utf8 as _utf8 };

/** f32 view helpers over an Int32Array copy. */
export function f32of(words: Int32Array): Float32Array {
  return new Float32Array(words.buffer, words.byteOffset, words.length);
}
