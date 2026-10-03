/**
 * Regions, standing servers, and when to open another one
 * (adapted from doom-arrr's and vibe-strike's regions.ts).
 *
 * Every region keeps one standing server per mode, listed at all times whether or not
 * anyone is in it: a standing room nobody has joined yet is still a real server — the
 * mesh creates a room the moment its first player dials it.
 *
 * Scaling is decided on REAL humans only: the connected client count central reports.
 * Bots fill empty slots inside the sim and are not clients. When every room a
 * region × mode is showing is more than SCALE_UP_FILL full of humans, the next numbered
 * room (`EU FFA 2`) is listed so there is always somewhere to play that is not about to
 * fill. An overflow room stays listed while humans are in it and drops off once it
 * empties (the mesh reaps an empty room on its own). Every client computes the same
 * plan from the same listing, so two players are sent to the same new room.
 *
 * Where a room physically runs is central's choice: the SDK has no region field, only a
 * preferred node. `VITE_ARRR_NODE_NA`, `…_EU`, `…_ASIA` name a node per location at build
 * time and a regional room asks for it (`regionNodeUrl`). Unset, central places the room.
 *
 * Licence: GPL-2.0-or-later.
 */

export type RegionId = 'na' | 'eu' | 'asia';

export interface Region {
  id: RegionId;
  label: string;
  short: string;
}

/** In the order the browser lists them. Index + 1 = the region's code in a room id (append only). */
export const REGIONS: readonly Region[] = [
  { id: 'na', label: 'North America', short: 'NA' },
  { id: 'eu', label: 'Europe', short: 'EU' },
  { id: 'asia', label: 'Asia / Oceania', short: 'AS' },
];

/** A room over this share of its slots taken by humans counts as full for scaling. */
export const SCALE_UP_FILL = 0.8;

export function isRegion(v: unknown): v is RegionId {
  return typeof v === 'string' && REGIONS.some((r) => r.id === v);
}

export function regionOf(id: RegionId): Region {
  return REGIONS.find((r) => r.id === id)!;
}

/** True when more than SCALE_UP_FILL of the room's slots are held by humans. */
export function overFull(humans: number, capacity: number): boolean {
  return capacity > 0 && humans / capacity > SCALE_UP_FILL;
}

/**
 * The room numbers a region × mode shows, given the humans in each of its live rooms
 * (index → connected clients; missing = empty): room 1 always, every overflow room with
 * a human in it, and — when all of those are over the scale-up line — the lowest unused
 * number as a spare.
 */
export function planRooms(humans: ReadonlyMap<number, number>, capacity: number, standing = 1): number[] {
  const shown = new Set<number>();
  for (let i = 1; i <= standing; i++) shown.add(i);
  for (const [i, n] of humans) if (n > 0) shown.add(i);
  if ([...shown].every((i) => overFull(humans.get(i) ?? 0, capacity))) {
    let next = 1;
    while (shown.has(next)) next++;
    shown.add(next);
  }
  return [...shown].sort((a, b) => a - b);
}

/** Coarse on purpose: it only orders the list and aims Quick Play; the player can pick any row. */
export function regionForTimeZone(tz: string | undefined): RegionId {
  const zone = tz ?? '';
  if (/^(Europe|Africa|Atlantic\/(Reykjavik|Canary|Faroe|Madeira|Azores))\//.test(zone)) return 'eu';
  if (/^(Asia|Australia|Pacific|Indian)\//.test(zone)) return 'asia';
  return 'na';
}

export function homeRegion(): RegionId {
  try {
    return regionForTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return 'na';
  }
}

const env = (k: string): string | undefined => {
  try {
    const v = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[k];
    return (v ?? '').trim() || undefined;
  } catch {
    return undefined;
  }
};

const NODE_URLS: Record<RegionId, string | undefined> = {
  na: env('VITE_ARRR_NODE_NA'),
  eu: env('VITE_ARRR_NODE_EU'),
  asia: env('VITE_ARRR_NODE_ASIA'),
};

/** The node a regional room asks central for, when the build names one for its region. */
export function regionNodeUrl(region: RegionId | null): string | undefined {
  return region ? NODE_URLS[region] : undefined;
}
