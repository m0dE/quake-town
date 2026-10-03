/*
 * Quake Town — the console's view of the cvar registry.
 * Copyright (C) 2026 Quake Town contributors. GPL-2.0-or-later.
 *
 * The registry itself is the settings part's (`src/settings/cvars.ts`, QW names
 * and semantics, persisted by settings). The shell registers the few cvars that
 * only the game loop reads (game group) and talks to the registry through the
 * narrow interface below, so tests can hand it a bare registry.
 */
import { cvars as settingsCvars, CvarRegistry, DEFS, type CvarDef } from '../settings/cvars.js';

export type { CvarDef };

export interface Cvars {
  has(name: string): boolean;
  get(name: string): string;
  num(name: string): number;
  set(name: string, value: string): boolean;
  reset(name: string): void;
  /** Sorted names (optionally with a prefix). */
  list(prefix?: string): string[];
  def(name: string): CvarDef | undefined;
  onChange(name: string, cb: (name: string, value: string, old: string) => void): () => void;
  register(def: CvarDef): void;
}

const g = (name: string, def: string, help: string, extra: Partial<CvarDef> = {}): CvarDef =>
  ({ name, def, kind: 'float', group: 'game', label: name, help, archive: true, ...extra });

/** Cvars only the shell reads (the rest are in settings' DEFS). */
export const SHELL_CVARS: CvarDef[] = [
  g('cl_yawspeed', '140', 'Turn speed of +left/+right, degrees per second.', { min: 0, max: 1000 }),
  g('cl_pitchspeed', '150', 'Look speed of +lookup/+lookdown.', { min: 0, max: 1000 }),
  g('con_notifylines', '4', 'Console lines shown at the top while playing.', { kind: 'int', min: 0, max: 16 }),
  g('show_net', '0', 'Net numbers: 1 text, 2 text and graph.', { kind: 'int', min: 0, max: 2 }),
  g('hud_killfeed', '1', 'Kill feed in the top right corner.', { kind: 'bool', min: 0, max: 1 }),
  g('cl_chasecam', '0', 'Spectator follow camera: 0 through the eyes, 1 chase.', { kind: 'bool', min: 0, max: 1 }),
  g('cl_predict_projectiles', '1', 'Draw your own rockets and nails from the prediction (no latency).', { kind: 'bool', min: 0, max: 1 }),
  g('cl_demospeed', '1', 'Demo playback speed.', { min: 0, max: 20, archive: false }),
  g('gl_cshiftpercent', '100', 'Strength of screen tints, percent.', { min: 0, max: 100 }),
  g('scr_conspeed', '3000', 'Console scroll speed, pixels per second.', { min: 100, max: 100000 }),
  g('cl_hudswap', '0', 'Classic HUD: ammo counts on the left.', { kind: 'bool', min: 0, max: 1 }),
];

let shared: Cvars | null = null;

/** The registry the shell uses, with the shell's cvars registered. */
export function useCvars(registry?: CvarRegistry): Cvars {
  const reg = registry ?? settingsCvars;
  if (!shared || registry) {
    for (const d of SHELL_CVARS) if (!reg.has(d.name)) reg.register(d);
    shared = {
      has: (n) => reg.has(n),
      get: (n) => reg.get(n),
      num: (n) => reg.num(n),
      set: (n, v) => reg.set(n, v),
      reset: (n) => reg.reset(n),
      list: (p) => reg.list(p),
      def: (n) => reg.def(n),
      onChange: (n, cb) => reg.onChange(n, cb),
      register: (d) => reg.register(d),
    };
  }
  return shared;
}

/** A private registry with every default, for tests and tools. */
export function testCvars(): Cvars {
  return useCvars(new CvarRegistry(DEFS));
}
