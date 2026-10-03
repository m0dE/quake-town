/**
 * The server list's data (adapted from doom-arrr's rooms.ts, minus its fake population).
 *
 * Central lists an app's rooms with four facts: id, connected client count, authority
 * node id and creation time. The id carries the config (config.ts), so a row's name,
 * mode, maps, limits and packs come from decoding it. Players are shown honestly:
 * `humans` = the connected client count (spectators connect too, so it is "people
 * here"), and when the room runs bots, `bots` = max − humans is the estimate of the
 * bot-filled slots. Nothing else is invented.
 *
 * Standing servers (regions.ts) are merged in even when central has never heard of them.
 *
 * Licence: GPL-2.0-or-later.
 */
import { listRooms, type RoomInfo } from 'arrr-network';
import { decodeRoomId, encodeRoomId, type RoomConfig } from './config.js';
import { MODES, MODE_ORDER, officialRotation, type Mode, type PackIndexEntry } from './modes.js';
import { REGIONS, overFull, planRooms, regionOf, type RegionId } from './regions.js';

/**
 * The app on the ARRR network: the rooms it lists and joins, and the app a player signs
 * in to — ONE id, because a session token is scoped to its app. `quake-town` on
 * cloud.arrr.fun; `VITE_ARRR_APP_ID` at build time overrides it (a local cluster).
 */
export const DEFAULT_APP_ID = 'app_1791016487876_fc841221364b';

/** The app's API key: it ships in every client, so it is attribution, not a secret. */
export const DEFAULT_API_KEY = 'arrr_583bec3540214916dff373439c8c07c2d210ef94423b4d0530a5424759184b63';
export const API_KEY: string | undefined = (() => {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string> }).env;
    if (env?.VITE_ARRR_APP_ID && !env.VITE_ARRR_API_KEY) return undefined; // another app: its own key or none
    return (env?.VITE_ARRR_API_KEY ?? '').trim() || DEFAULT_API_KEY;
  } catch {
    return DEFAULT_API_KEY;
  }
})();
export const APP_ID: string = (() => {
  try {
    return ((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_ARRR_APP_ID ?? '').trim() || DEFAULT_APP_ID;
  } catch {
    return DEFAULT_APP_ID;
  }
})();

export interface ServerRow {
  roomId: string;
  config: RoomConfig;
  /** Connected clients (humans, players and spectators) — what central reports. */
  humans: number;
  /** Estimated bot-driven slots: max − humans when the room runs bots, else 0. */
  bots: number;
  /** Central has this room right now (someone is in it or was just now). */
  live: boolean;
  /** Central's authority node for a live room; null when not live. */
  node: string | null;
  ageSeconds: number | null;
  /** Position of a standing / overflow room in its region × mode plan, or 0. */
  standingIndex: number;
}

export type ServersResult = { ok: true; rows: ServerRow[] } | { ok: false; error: string; rows: ServerRow[] };

export function botsEstimate(c: RoomConfig, humans: number): number {
  return c.bots ? Math.max(0, c.maxclients - humans) : 0;
}

/** Central's rooms → rows; ids that do not decode are not ours (or are broken) and are dropped. */
export function toRows(infos: readonly RoomInfo[], now = Date.now()): ServerRow[] {
  const rows: ServerRow[] = [];
  const seen = new Set<string>();
  for (const info of infos) {
    const id = String(info?.id ?? '');
    if (seen.has(id)) continue;
    const config = decodeRoomId(id);
    if (!config) continue;
    seen.add(id);
    const raw = Number(info.clientCount);
    const humans = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
    const created = Date.parse(String(info.createdAt ?? ''));
    rows.push({
      roomId: id, config, humans, bots: botsEstimate(config, humans), live: true,
      node: info.authorityNodeId ? String(info.authorityNodeId) : null,
      ageSeconds: Number.isFinite(created) ? Math.max(0, (now - created) / 1000) : null,
      standingIndex: 0,
    });
  }
  return rows;
}

/** The name of a region × mode's n-th standing room: "EU FFA 1". */
export function standingName(region: RegionId, mode: Mode, n: number): string {
  return `${regionOf(region).short} ${MODES[mode].short} ${n}`;
}

/** The config of a standing room. Pure: the same build derives the same id everywhere. */
export function standingConfig(region: RegionId, mode: Mode, n: number, index: readonly PackIndexEntry[] = []): RoomConfig | null {
  const m = MODES[mode];
  const rotation = officialRotation(mode, index);
  if (!rotation.length) return null;                      // no maps for this mode in this build
  return {
    name: standingName(region, mode, n), region, mode, timelimit: m.timelimit, fraglimit: m.fraglimit,
    maxclients: m.maxclients, bots: m.bots, rotation, mod: null, packs: [], password: null, standing: true,
  };
}

/**
 * Standing servers first (each region × mode's plan, live or not yet created), then
 * every other decodable room. Standing rows of a live room take its real counts.
 */
export function withStanding(rows: readonly ServerRow[], index: readonly PackIndexEntry[] = []): ServerRow[] {
  const byId = new Map(rows.map((r) => [r.roomId, r]));
  const used = new Set<string>();
  const standing: ServerRow[] = [];
  for (const region of REGIONS) {
    for (const mode of MODE_ORDER) {
      const first = standingConfig(region.id, mode, 1, index);
      if (!first) continue;
      // Live rooms of this region × mode's numbered series, by number.
      // A live room is part of the series only if it is exactly the standing config for its
      // number (same rotation, limits, …): a hand-made room named "EU FFA 2" is not.
      const humans = new Map<number, number>();
      const prefix = standingName(region.id, mode, 0).slice(0, -1);
      for (const r of rows) {
        if (!r.config.standing || r.config.region !== region.id || r.config.mode !== mode || !r.config.name.startsWith(prefix)) continue;
        const n = Number(r.config.name.slice(prefix.length));
        if (!Number.isInteger(n) || n < 1 || n > 99) continue;
        const c = standingConfig(region.id, mode, n, index);
        if (c && encodeRoomId(c) === r.roomId) humans.set(n, r.humans);
      }
      for (const n of planRooms(humans, first.maxclients)) {
        const config = n === 1 ? first : standingConfig(region.id, mode, n, index)!;
        const id = encodeRoomId(config);
        const live = byId.get(id);
        used.add(id);
        standing.push(live
          ? { ...live, standingIndex: n }
          : { roomId: id, config, humans: 0, bots: botsEstimate(config, 0), live: false, node: null, ageSeconds: null, standingIndex: n });
      }
    }
  }
  return [...standing, ...rows.filter((r) => !used.has(r.roomId))];
}

/** Never throws: Play must keep working when the room service does not. */
export async function fetchServers(opts: { central?: string; index?: readonly PackIndexEntry[]; limit?: number } = {}): Promise<ServersResult> {
  try {
    const all: RoomInfo[] = [];
    const limit = opts.limit ?? 100;
    for (let offset = 0; offset < 1000; offset += limit) {
      const page = await listRooms(APP_ID, { limit, offset, ...(opts.central ? { centralServiceUrl: opts.central } : {}) });
      all.push(...(page?.rooms ?? []));
      if (!page || all.length >= (page.total ?? 0) || (page.rooms ?? []).length < limit) break;
    }
    return { ok: true, rows: withStanding(toRows(all), opts.index) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), rows: withStanding([], opts.index) };
  }
}

/**
 * Quick Play: the best public room of `mode` in `region` — the busiest one that still has
 * a free slot and is under the scale-up line, preferring standing servers, never one with
 * a password or third-party packs. Falls back to the region's standing server 1.
 */
export function quickPlay(rows: readonly ServerRow[], region: RegionId, mode: Mode, index: readonly PackIndexEntry[] = []): ServerRow | null {
  const ok = rows.filter((r) => r.config.mode === mode && r.config.region === region && !r.config.password
    && !r.config.mod && !r.config.packs.length && r.humans < r.config.maxclients && !overFull(r.humans, r.config.maxclients));
  ok.sort((a, b) => b.humans - a.humans || Number(b.config.standing) - Number(a.config.standing) || a.standingIndex - b.standingIndex);
  if (ok[0]) return ok[0];
  const c = standingConfig(region, mode, 1, index);
  if (!c) return null;
  return rows.find((r) => r.roomId === encodeRoomId(c)) ?? { roomId: encodeRoomId(c), config: c, humans: 0, bots: botsEstimate(c, 0), live: false, node: null, ageSeconds: null, standingIndex: 1 };
}

/** "just now", "4m", "2h 10m"; "—" for a room nobody has opened. */
export function formatAge(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 90) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
