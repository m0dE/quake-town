/*
 * Quake Town — what goes on the ordered stream (DESIGN.md "Inputs on the wire"),
 * validated, plus QW infostrings.
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 *
 * The sim only ever looks at `c`, `j`, `u`, `k`; everything else (chat, ping
 * reports, cosmetic looks) is an app message the shell reads off the stream.
 */

/** A usercmd as world_set_cmd takes it. */
export interface UserCmd {
  pitch: number;     // ANGLE2SHORT, -32768..32767
  yaw: number;       // ANGLE2SHORT, -32768..32767
  forward: number;   // -500..500
  side: number;
  up: number;
  buttons: number;   // bit0 attack, bit1 jump
  impulse: number;   // 0..255
}

export type WireCmd = { c: [number, number, number, number, number, number, number] };

const int = (v: unknown, lo: number, hi: number): number | null => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.trunc(v);
  return n < lo ? lo : n > hi ? hi : n;
};

/** QW ANGLE2SHORT, signed (the wire range is -32768..32767). */
export function angleToShort(deg: number): number {
  const s = Math.round((deg * 65536) / 360) & 0xffff;
  return s >= 32768 ? s - 65536 : s;
}
export function shortToAngle(s: number): number { return (s * 360) / 65536; }

export function encodeCmd(c: UserCmd): WireCmd {
  return { c: [c.pitch | 0, c.yaw | 0, c.forward | 0, c.side | 0, c.up | 0, c.buttons & 3, c.impulse & 255] };
}

export function decodeCmd(data: unknown): UserCmd | null {
  const c = (data as { c?: unknown }).c;
  if (!Array.isArray(c) || c.length !== 7) return null;
  const pitch = int(c[0], -32768, 32767), yaw = int(c[1], -32768, 32767);
  const forward = int(c[2], -500, 500), side = int(c[3], -500, 500), up = int(c[4], -500, 500);
  const buttons = int(c[5], 0, 3), impulse = int(c[6], 0, 255);
  if (pitch === null || yaw === null || forward === null || side === null || up === null || buttons === null || impulse === null) return null;
  return { pitch, yaw, forward, side, up, buttons, impulse };
}

/** A console command a client may hand the mod: ≤ 128 printable chars. */
export function cleanCommand(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > 128) return null;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 32 || c > 126) return null; }
  return s;
}

/** Userinfo as it may enter the sim: an infostring ≤ 512 bytes, no quotes/semicolons/control chars. */
export function cleanUserinfo(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 512 || v[0] !== '\\') return null;
  for (let i = 0; i < v.length; i++) { const c = v.charCodeAt(i); if (c < 32 || c === 34 || c === 59 || c > 255) return null; }
  return v;
}

/** Is this payload one the sim acts on? */
export function isSimInput(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return Array.isArray(d.c) || d.j === 0 || d.j === 1 || typeof d.u === 'string' || typeof d.k === 'string';
}

// ---------------------------------------------------------------- infostrings

export function parseInfo(s: string): Map<string, string> {
  const m = new Map<string, string>();
  const parts = s.split('\\');
  // a leading backslash gives an empty first part
  for (let i = parts[0] === '' ? 1 : 0; i + 1 < parts.length; i += 2) m.set(parts[i], parts[i + 1]);
  return m;
}

/** Keys and values may not contain a backslash or a quote (QW Info_SetValueForKey). */
export function cleanInfoValue(v: string): string {
  return String(v).replace(/[\\"\u0000-\u001f]/g, '').slice(0, 63);
}

export function buildInfo(entries: Iterable<readonly [string, string | number]>): string {
  let s = '';
  for (const [k, v] of entries) s += `\\${cleanInfoValue(k)}\\${cleanInfoValue(String(v))}`;
  return s;
}

export function infoGet(s: string, key: string): string {
  return parseInfo(s).get(key) ?? '';
}

export function infoSet(s: string, key: string, value: string): string {
  const m = parseInfo(s);
  m.set(key, value);
  return buildInfo(m);
}
