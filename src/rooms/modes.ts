/**
 * Game modes and their defaults (DESIGN.md "The default mod: mod/qtdm").
 *
 * The `deathmatch`/`teamplay` pair per mode is what id's qw-qc reads; the mod reads the
 * `mode` key on top of it. Defaults are what a Host screen starts from and what the
 * standing servers run. Rotations name maps by their BSP name (no "maps/", no ".bsp").
 *
 * Licence: GPL-2.0-or-later (this repository).
 */

export type Mode = 'ffa' | 'duel' | '2on2' | '4on4' | 'ctf' | 'ca';

export interface ModeInfo {
  id: Mode;
  /** Player-facing name. */
  label: string;
  /** Column-width name for the server list. */
  short: string;
  /** One line for the Host screen. */
  blurb: string;
  deathmatch: number;
  teamplay: number;
  /** Minutes, 0 = none. */
  timelimit: number;
  /** Frags (ffa/duel/team modes), captures (ctf) or rounds to win (ca); 0 = none. */
  fraglimit: number;
  /** What `fraglimit` counts in this mode, for labels. */
  limitLabel: string;
  maxclients: number;
  bots: boolean;
  /** Team mode: players are put on red/blue. */
  teams: boolean;
  /** Ready-up and countdown before the match (vs. a running server you drop into). */
  readyUp: boolean;
  /**
   * The official rotation. Empty = take every map from the content index whose `modes`
   * lists this mode (CTF until the content part ships flag maps). See `officialRotation`.
   */
  rotation: readonly string[];
}

/**
 * LibreQuake lqdm1–13 (BSD-3). Sizes and spawn counts measured 2026-10-03:
 * small = lqdm11, lqdm12, lqdm2, lqdm1, lqdm13, lqdm8; large = lqdm3, lqdm7, lqdm5, lqdm9.
 * qt_aero is the content part's original map (modes duel, 2on2, ffa, ca in its index entry).
 */
export const MODES: Readonly<Record<Mode, ModeInfo>> = {
  ffa: {
    id: 'ffa', label: 'Free For All', short: 'FFA', blurb: 'Everyone for themselves. Drop in any time.',
    deathmatch: 3, teamplay: 0, timelimit: 15, fraglimit: 30, limitLabel: 'Frag limit', maxclients: 16, bots: true,
    teams: false, readyUp: false, rotation: ['lqdm3', 'lqdm7', 'qt_aero', 'lqdm10', 'lqdm6', 'lqdm4', 'lqdm9', 'lqdm5'],
  },
  duel: {
    id: 'duel', label: 'Duel', short: 'Duel', blurb: 'One on one. Ready up, ten minutes, sudden overtime.',
    deathmatch: 3, teamplay: 0, timelimit: 10, fraglimit: 0, limitLabel: 'Frag limit', maxclients: 2, bots: false,
    teams: false, readyUp: true, rotation: ['qt_aero', 'lqdm11', 'lqdm12', 'lqdm2', 'lqdm13', 'lqdm1', 'lqdm8'],
  },
  '2on2': {
    id: '2on2', label: '2 on 2', short: '2on2', blurb: 'Two teams of two. No team damage to health.',
    deathmatch: 3, teamplay: 2, timelimit: 10, fraglimit: 0, limitLabel: 'Frag limit', maxclients: 4, bots: true,
    teams: true, readyUp: true, rotation: ['lqdm2', 'qt_aero', 'lqdm1', 'lqdm8', 'lqdm13', 'lqdm4'],
  },
  '4on4': {
    id: '4on4', label: '4 on 4', short: '4on4', blurb: 'Team deathmatch. Weapons are taken and respawn.',
    deathmatch: 1, teamplay: 2, timelimit: 20, fraglimit: 0, limitLabel: 'Frag limit', maxclients: 8, bots: true,
    teams: true, readyUp: true, rotation: ['lqdm3', 'lqdm7', 'lqdm6', 'lqdm10', 'lqdm4'],
  },
  ctf: {
    id: 'ctf', label: 'Capture the Flag', short: 'CTF', blurb: 'Take their flag home. 15 points a capture.',
    deathmatch: 3, teamplay: 1, timelimit: 20, fraglimit: 0, limitLabel: 'Capture limit', maxclients: 16, bots: true,
    teams: true, readyUp: true, rotation: [],
  },
  ca: {
    id: 'ca', label: 'Clan Arena', short: 'CA', blurb: 'Rounds. Full stack, no items, last team standing.',
    deathmatch: 3, teamplay: 1, timelimit: 0, fraglimit: 7, limitLabel: 'Rounds to win', maxclients: 8, bots: true,
    teams: true, readyUp: true, rotation: ['lqdm12', 'lqdm2', 'qt_aero', 'lqdm11', 'lqdm8', 'lqdm13'],
  },
};

/** In the order the menu lists them. Index = the mode's code in a room id (append only). */
export const MODE_ORDER: readonly Mode[] = ['ffa', 'duel', '2on2', '4on4', 'ctf', 'ca'];

export const MAX_CLIENTS = 32;
export const MIN_CLIENTS = 2;

export function isMode(v: unknown): v is Mode {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(MODES, v);
}

/** A map entry of `public/packs/index.json` (DESIGN.md "Content packs"). */
export interface IndexMap {
  name: string;
  title?: string;
  author?: string;
  modes?: string[];
  players?: string | number[] | number;
}

/** An entry of `public/packs/index.json`. */
export interface PackIndexEntry {
  id: string;
  name: string;
  kind: 'base' | 'maps' | 'mod' | string;
  bytes: number;
  files?: string[];
  maps?: IndexMap[];
  /** Optional URL (relative to packs/) the content part serves it from. */
  file?: string;
}

/**
 * The official rotation of a mode: the table above, or — for a mode the table leaves
 * empty — every map in the index that says it supports the mode, sorted by name. The
 * result is a pure function of the build (the index ships with it), so every client of
 * one build derives the same standing room ids.
 */
export function officialRotation(mode: Mode, index: readonly PackIndexEntry[] = []): string[] {
  const fixed = MODES[mode].rotation;
  if (fixed.length) return [...fixed];
  const names = new Set<string>();
  for (const pack of index) for (const m of pack.maps ?? []) if (m.modes?.includes(mode)) names.add(m.name);
  return [...names].sort().slice(0, 8);
}

/** Every map the index knows, with its title, by name. */
export function mapTitles(index: readonly PackIndexEntry[]): Map<string, IndexMap> {
  const out = new Map<string, IndexMap>();
  for (const pack of index) for (const m of pack.maps ?? []) if (!out.has(m.name)) out.set(m.name, m);
  for (const [name, title] of Object.entries(LQ_TITLES)) if (!out.has(name)) out.set(name, { name, title, author: 'LibreQuake' });
  return out;
}

/** LibreQuake map titles (worldspawn "message"), so the list reads well before the index loads. */
export const LQ_TITLES: Readonly<Record<string, string>> = {
  lqdm1: 'Solstice', lqdm2: 'Torture Pit', lqdm3: 'Hyperborea', lqdm4: 'Psychofuge',
  lqdm5: 'Transport Tubes', lqdm6: 'Ghost Quarter', lqdm7: 'Boomstick Basement',
  lqdm8: 'Alichar Sector', lqdm9: 'The Outlands', lqdm10: "Lucifer's Gambit",
  lqdm11: 'The Wicked Night', lqdm12: 'Javelin', lqdm13: 'Death Provides No Return',
};
