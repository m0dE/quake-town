/**
 * The room config, carried in the room id (DESIGN.md "Room config, server list and hosting").
 *
 * Central knows only a room's id and client count, so the id IS the config:
 *
 *     qt1.<b64url(bytes)>-quaketown          ≤ 240 chars (nodes refuse > 256)
 *
 * `qt1` is the encoding version; a future `qt2` decoder can live beside this one. The bytes:
 *
 *     u8   mode code (low 4 bits, MODE_ORDER index) | region code << 4 (0 none, REGIONS index + 1)
 *     u8   flags: 1 bots, 2 standing, 4 password, 8 mod pack, 16 extra packs
 *     u8   timelimit (minutes, 0..255)
 *     var  fraglimit (LEB128, 0..65535)
 *     u8   maxclients (2..32)
 *     str  name (u8 byte length + UTF-8, ≤ 48 bytes, printable, no backslash/quote)
 *     u8   rotation length (1..16), then per map: u8 code 1..127 = MAP_DICT[code - 1],
 *          or 0 + str (a-z 0-9 _ -, ≤ 32)
 *     [mod]    packref
 *     [packs]  u8 count (1..8) + packref × count
 *     [pw]     4 bytes salt + 4 bytes check (check = first 4 bytes of sha256(salt hex + password))
 *
 *     packref = 6 bytes (the 12-hex short sha256) + str url ("" = none; "https://" is
 *               stripped on encode and put back on decode; other schemes kept verbatim)
 *
 * Decoding is strict: any out-of-range field or trailing byte → null (the room is not listed).
 * encode(decode(id)) === id for every id this file produces.
 *
 * Licence: GPL-2.0-or-later.
 */
import { MODES, MODE_ORDER, MAX_CLIENTS, MIN_CLIENTS, type Mode, isMode } from './modes.js';
import { REGIONS, type RegionId, isRegion } from './regions.js';

export interface PackRef {
  /** First 12 hex chars of the pack's sha256. */
  id: string;
  /** Where to fetch it (any HTTPS URL serving it with CORS); absent = the joiner must already have it. */
  url?: string;
}

export interface PasswordCheck {
  /** 8 hex. */
  salt: string;
  /** 8 hex: sha256(salt + password), first 4 bytes. */
  check: string;
}

export interface RoomConfig {
  name: string;
  region: RegionId | null;
  mode: Mode;
  timelimit: number;
  fraglimit: number;
  maxclients: number;
  bots: boolean;
  rotation: string[];
  /** The mod pack; null = the built-in qtdm. */
  mod: PackRef | null;
  packs: PackRef[];
  password: PasswordCheck | null;
  standing: boolean;
}

export const ROOM_PREFIX = 'qt1.';
export const ROOM_SUFFIX = '-quaketown';
export const MAX_ROOM_ID = 240;
export const MAX_NAME_BYTES = 48;
export const MAX_ROTATION = 16;
export const MAX_PACKS = 8;

/**
 * Map names with a one-byte code. APPEND ONLY: a code, once shipped, means that map
 * forever (room ids in links and favourites depend on it).
 */
export const MAP_DICT: readonly string[] = [
  'lqdm1', 'lqdm2', 'lqdm3', 'lqdm4', 'lqdm5', 'lqdm6', 'lqdm7', 'lqdm8', 'lqdm9', 'lqdm10',
  'lqdm11', 'lqdm12', 'lqdm13',
  'qt_aero', 'qt_dm1', 'qt_dm2', 'qt_dm3', 'qt_dm4', 'qt_dm5', 'qt_dm6', 'qt_ctf1', 'qt_ctf2',
  'qt_tower', 'qt_fort',
];

const MAP_NAME = /^[a-z0-9_-]{1,32}$/;
const HEX12 = /^[0-9a-f]{12}$/;
const HEX8 = /^[0-9a-f]{8}$/;

export class RoomConfigError extends Error {}

// --------------------------------------------------------------------------------- helpers

const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });

/** Printable, single-line, no infostring metacharacters, trimmed, ≤ MAX_NAME_BYTES of UTF-8. */
export function cleanRoomName(raw: string): string {
  let s = raw.replace(/[\u0000-\u001f\u007f\\"]/g, '').replace(/\s+/g, ' ').trim();
  while (te.encode(s).length > MAX_NAME_BYTES) s = [...s].slice(0, -1).join('');
  return s;
}

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

class Writer {
  private buf: number[] = [];
  u8(n: number): void { this.buf.push(n & 0xff); }
  varint(n: number): void {
    do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; this.buf.push(b); } while (n);
  }
  bytes(b: Uint8Array | number[]): void { for (const x of b) this.buf.push(x); }
  str(s: string, max: number): void {
    const b = te.encode(s);
    if (b.length > max) throw new RoomConfigError(`"${s.slice(0, 20)}…" is too long`);
    this.u8(b.length);
    this.bytes(b);
  }
  hex(h: string): void { for (let i = 0; i < h.length; i += 2) this.u8(parseInt(h.slice(i, i + 2), 16)); }
  done(): Uint8Array { return Uint8Array.from(this.buf); }
}

class Reader {
  private p = 0;
  constructor(private readonly b: Uint8Array) {}
  get end(): boolean { return this.p >= this.b.length; }
  u8(): number {
    if (this.p >= this.b.length) throw new RoomConfigError('short');
    return this.b[this.p++];
  }
  varint(): number {
    let n = 0;
    for (let shift = 0; shift < 21; shift += 7) {
      const b = this.u8();
      n |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return n;
    }
    throw new RoomConfigError('varint');
  }
  bytes(n: number): Uint8Array {
    if (this.p + n > this.b.length) throw new RoomConfigError('short');
    const out = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return out;
  }
  str(max: number): string {
    const n = this.u8();
    if (n > max) throw new RoomConfigError('string too long');
    return td.decode(this.bytes(n));
  }
  hex(n: number): string { return [...this.bytes(n)].map((x) => x.toString(16).padStart(2, '0')).join(''); }
}

function writePack(w: Writer, ref: PackRef): void {
  if (!HEX12.test(ref.id)) throw new RoomConfigError(`pack id "${ref.id}" must be 12 hex characters`);
  w.hex(ref.id);
  const url = ref.url ?? '';
  w.str(url.startsWith('https://') ? url.slice(8) : url, 255);
}

function readPack(r: Reader): PackRef {
  const id = r.hex(6);
  const raw = r.str(255);
  if (!raw) return { id };
  const url = raw.includes('://') ? raw : `https://${raw}`;
  if (!/^https?:\/\/[^\s]+$/.test(url)) throw new RoomConfigError('bad url');
  return { id, url };
}

// --------------------------------------------------------------------------------- validate

/** Throws RoomConfigError with a sentence a host can act on. */
export function validateConfig(c: RoomConfig): void {
  if (!isMode(c.mode)) throw new RoomConfigError('Unknown mode.');
  if (c.region !== null && !isRegion(c.region)) throw new RoomConfigError('Unknown region.');
  if (cleanRoomName(c.name) !== c.name || !c.name) throw new RoomConfigError('Give the server a name (no backslashes or quotes).');
  if (!Number.isInteger(c.timelimit) || c.timelimit < 0 || c.timelimit > 255) throw new RoomConfigError('Time limit is 0–255 minutes.');
  if (!Number.isInteger(c.fraglimit) || c.fraglimit < 0 || c.fraglimit > 65535) throw new RoomConfigError('Limit is 0–65535.');
  if (!Number.isInteger(c.maxclients) || c.maxclients < MIN_CLIENTS || c.maxclients > MAX_CLIENTS) {
    throw new RoomConfigError(`Max players is ${MIN_CLIENTS}–${MAX_CLIENTS}.`);
  }
  if (!c.rotation.length || c.rotation.length > MAX_ROTATION) throw new RoomConfigError(`Pick 1–${MAX_ROTATION} maps.`);
  for (const m of c.rotation) if (!MAP_NAME.test(m)) throw new RoomConfigError(`"${m}" is not a map name.`);
  if (c.packs.length > MAX_PACKS) throw new RoomConfigError(`At most ${MAX_PACKS} extra packs.`);
  if (c.password && !(HEX8.test(c.password.salt) && HEX8.test(c.password.check))) throw new RoomConfigError('Bad password check.');
}

// --------------------------------------------------------------------------------- codec

export function encodeConfig(c: RoomConfig): Uint8Array {
  validateConfig(c);
  const w = new Writer();
  const regionCode = c.region ? REGIONS.findIndex((r) => r.id === c.region) + 1 : 0;
  w.u8(MODE_ORDER.indexOf(c.mode) | (regionCode << 4));
  w.u8((c.bots ? 1 : 0) | (c.standing ? 2 : 0) | (c.password ? 4 : 0) | (c.mod ? 8 : 0) | (c.packs.length ? 16 : 0));
  w.u8(c.timelimit);
  w.varint(c.fraglimit);
  w.u8(c.maxclients);
  w.str(c.name, MAX_NAME_BYTES);
  w.u8(c.rotation.length);
  for (const m of c.rotation) {
    const code = MAP_DICT.indexOf(m);
    if (code >= 0 && code < 127) w.u8(code + 1);
    else { w.u8(0); w.str(m, 32); }
  }
  if (c.mod) writePack(w, c.mod);
  if (c.packs.length) { w.u8(c.packs.length); for (const p of c.packs) writePack(w, p); }
  if (c.password) { w.hex(c.password.salt); w.hex(c.password.check); }
  return w.done();
}

export function decodeConfig(bytes: Uint8Array): RoomConfig | null {
  try {
    const r = new Reader(bytes);
    const mr = r.u8();
    const mode = MODE_ORDER[mr & 15];
    const rc = mr >> 4;
    if (!mode || rc > REGIONS.length) return null;
    const flags = r.u8();
    if (flags & ~31) return null;
    const timelimit = r.u8();
    const fraglimit = r.varint();
    const maxclients = r.u8();
    const name = r.str(MAX_NAME_BYTES);
    const n = r.u8();
    const rotation: string[] = [];
    for (let i = 0; i < n; i++) {
      const code = r.u8();
      if (code === 0) rotation.push(r.str(32));
      else if (code <= MAP_DICT.length) rotation.push(MAP_DICT[code - 1]);
      else return null;
    }
    const mod = flags & 8 ? readPack(r) : null;
    const packs: PackRef[] = [];
    if (flags & 16) {
      const k = r.u8();
      if (k < 1 || k > MAX_PACKS) return null;
      for (let i = 0; i < k; i++) packs.push(readPack(r));
    }
    const password = flags & 4 ? { salt: r.hex(4), check: r.hex(4) } : null;
    if (!r.end) return null;
    const c: RoomConfig = {
      name, region: rc ? REGIONS[rc - 1].id : null, mode, timelimit, fraglimit, maxclients,
      bots: !!(flags & 1), rotation, mod, packs, password, standing: !!(flags & 2),
    };
    validateConfig(c);
    return c;
  } catch {
    return null;
  }
}

/** The room id for a config. Throws RoomConfigError if it does not fit (shorten names or URLs). */
export function encodeRoomId(c: RoomConfig): string {
  const id = `${ROOM_PREFIX}${b64urlEncode(encodeConfig(c))}${ROOM_SUFFIX}`;
  if (id.length > MAX_ROOM_ID) {
    throw new RoomConfigError(`The room code is ${id.length} characters; the network takes ${MAX_ROOM_ID}. Use shorter pack links or fewer maps.`);
  }
  return id;
}

/** The config a room id carries, or null for anything that is not a Quake Town room. */
export function decodeRoomId(id: string): RoomConfig | null {
  if (typeof id !== 'string' || id.length > MAX_ROOM_ID || !id.startsWith(ROOM_PREFIX) || !id.endsWith(ROOM_SUFFIX)) return null;
  const bytes = b64urlDecode(id.slice(ROOM_PREFIX.length, -ROOM_SUFFIX.length));
  if (!bytes || !bytes.length) return null;
  const c = decodeConfig(bytes);
  // Canonical form only: one config, one id (so a listing never shows the same room twice).
  try {
    return c && encodeRoomId(c) === id ? c : null;
  } catch {
    return null;
  }
}

/** A config with the mode's defaults; the Host screen starts from it. */
export function defaultConfig(mode: Mode, patch: Partial<RoomConfig> = {}): RoomConfig {
  const m = MODES[mode];
  return {
    name: 'My server', region: null, mode, timelimit: m.timelimit, fraglimit: m.fraglimit,
    maxclients: m.maxclients, bots: m.bots, rotation: [...m.rotation], mod: null, packs: [],
    password: null, standing: false, ...patch,
  };
}

// --------------------------------------------------------------------------------- password

const hex = (b: ArrayBuffer | Uint8Array): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', te.encode(text)));
}

/**
 * A password check for a room. Client-side only: lockstep has no gatekeeper, so this
 * keeps honest people out of a private room and nothing more (the Host screen says so).
 */
export async function makePasswordCheck(password: string, salt?: string): Promise<PasswordCheck> {
  const s = salt ?? hex(crypto.getRandomValues(new Uint8Array(4)));
  return { salt: s, check: (await sha256Hex(s + password)).slice(0, 8) };
}

export async function passwordMatches(check: PasswordCheck, password: string): Promise<boolean> {
  return (await sha256Hex(check.salt + password)).slice(0, 8) === check.check;
}

// --------------------------------------------------------------------------------- serverinfo

/** An infostring value: no backslashes, quotes or control characters (QW Info_SetValueForKey refuses them). */
const iv = (v: string | number): string => String(v).replace(/[\\"\u0000-\u001f\u007f]/g, '').slice(0, 127);

/**
 * The QW serverinfo every client hands `world_new` (DESIGN.md: config → serverinfo →
 * world_new). A pure function of the config; key order is fixed.
 *
 * `mode`, `deathmatch`, `teamplay`, `timelimit`, `fraglimit`, `maxclients`, `bots`,
 * `rotation` (space-separated map names; the first is the starting map), `hostname`,
 * `region`, `samelevel 0`, `watervis 0`; duel adds `overtime 3`; ca adds `rounds`
 * (= fraglimit, the rounds to win). `*qt` is the config encoding version.
 */
export function toServerinfo(c: RoomConfig): string {
  const m = MODES[c.mode];
  const kv: [string, string | number][] = [
    ['*qt', 1],
    ['hostname', c.name],
    ['mode', c.mode],
    ['deathmatch', m.deathmatch],
    ['teamplay', m.teamplay],
    ['timelimit', c.timelimit],
    ['fraglimit', c.fraglimit],
    ['maxclients', c.maxclients],
    ['bots', c.bots ? 1 : 0],
    ['rotation', c.rotation.join(' ')],
    ['samelevel', 0],
    ['watervis', 0],
  ];
  if (c.region) kv.push(['region', c.region]);
  if (c.mode === 'duel') kv.push(['overtime', 3]);
  if (c.mode === 'ca') kv.push(['rounds', c.fraglimit]);
  return kv.map(([k, v]) => `\\${k}\\${iv(v)}`).join('');
}

/** "\\a\\1\\b\\2" → Map — the inverse of the infostring format (for tests and the console). */
export function parseInfo(info: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = info.split('\\');
  for (let i = 1; i + 1 < parts.length; i += 2) out.set(parts[i], parts[i + 1]);
  return out;
}
