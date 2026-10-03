/**
 * The cvar registry: QuakeWorld names, QuakeWorld semantics (values are strings,
 * typed getters convert, `set` clamps to the cvar's range like ezQuake's cvar limits).
 *
 * Defaults are QW's (id's QW 2.33 client, cl_main.c / view.c / gl_rmain.c / screen.c),
 * except where noted:
 *   - cl_forwardspeed / backspeed / sidespeed / upspeed 400: "always run", what QW's
 *     menu option and every competitive config set (pmove caps the wish speed at 320).
 *   - gl_flashblend 0 in the modern preset (QW GL default 1 = the classic preset).
 * Quake Town additions are prefixed `r_` (renderer: bloom, ssao, tonemap, preset, scale),
 * `hud_`, `qt_` (menu), or are ezQuake names (m_accel, show_speed, crosshairalpha …).
 *
 * Licence: GPL-2.0-or-later.
 */

export type CvarKind = 'float' | 'int' | 'bool' | 'string' | 'enum' | 'color' | 'palette';
export type CvarGroup = 'input' | 'video' | 'hud' | 'audio' | 'player' | 'menu' | 'game';

export interface CvarDef {
  name: string;
  /** Default, as a string. */
  def: string;
  kind: CvarKind;
  min?: number;
  max?: number;
  /** Menu slider step. */
  step?: number;
  /** For `enum`. */
  options?: readonly string[];
  /** Menu labels for `options`, same order. */
  optionLabels?: readonly string[];
  group: CvarGroup;
  /** Menu label. */
  label: string;
  /** One sentence for the console's `help` and the menu tooltip. */
  help: string;
  /** Saved (QW `seta`). Default true. */
  archive?: boolean;
  /** This cvar is a userinfo key (sent to the room as `{ u }`). */
  userinfo?: boolean;
  /** Part of the cosmetic player look. */
  look?: boolean;
  /** Part of the `r_preset` bundle. */
  preset?: boolean;
  /** Max string length (string kind). */
  maxLength?: number;
}

const f = (name: string, def: number, min: number, max: number, group: CvarGroup, label: string, help: string, extra: Partial<CvarDef> = {}): CvarDef =>
  ({ name, def: String(def), kind: 'float', min, max, group, label, help, ...extra });
const i = (name: string, def: number, min: number, max: number, group: CvarGroup, label: string, help: string, extra: Partial<CvarDef> = {}): CvarDef =>
  ({ name, def: String(def), kind: 'int', min, max, step: 1, group, label, help, ...extra });
const b = (name: string, def: 0 | 1, group: CvarGroup, label: string, help: string, extra: Partial<CvarDef> = {}): CvarDef =>
  ({ name, def: String(def), kind: 'bool', min: 0, max: 1, group, label, help, ...extra });
const e = (name: string, def: string, options: readonly string[], optionLabels: readonly string[], group: CvarGroup, label: string, help: string, extra: Partial<CvarDef> = {}): CvarDef =>
  ({ name, def, kind: 'enum', options, optionLabels, group, label, help, ...extra });

export const DEFS: readonly CvarDef[] = [
  // ------------------------------------------------------------------ input
  f('sensitivity', 3, 0.1, 30, 'input', 'Sensitivity', 'Mouse speed. QW default 3.', { step: 0.1 }),
  f('m_pitch', 0.022, -0.1, 0.1, 'input', 'Pitch', 'Vertical mouse scale; negative inverts the mouse.', { step: 0.001 }),
  f('m_yaw', 0.022, -0.1, 0.1, 'input', 'Yaw', 'Horizontal mouse scale.', { step: 0.001 }),
  b('m_filter', 0, 'input', 'Mouse filter', 'Average the last two mouse moves.'),
  f('m_accel', 0, 0, 1, 'input', 'Acceleration', 'Mouse acceleration (ezQuake). 0 = off.', { step: 0.01 }),
  b('m_rawinput', 1, 'input', 'Raw input', 'Unaccelerated mouse movement where the browser supports it.'),
  b('freelook', 1, 'input', 'Mouse look', 'The mouse looks up and down (QW +mlook always on).'),
  b('lookspring', 0, 'input', 'Lookspring', 'Re-centre the view when mouse look is released.'),
  f('cl_forwardspeed', 400, 0, 1000, 'input', 'Forward speed', 'Forward move speed (400 = always run).', { step: 10 }),
  f('cl_backspeed', 400, 0, 1000, 'input', 'Back speed', 'Backward move speed.', { step: 10 }),
  f('cl_sidespeed', 400, 0, 1000, 'input', 'Strafe speed', 'Strafe speed.', { step: 10 }),
  f('cl_upspeed', 400, 0, 1000, 'input', 'Up speed', 'Swim up/down speed.', { step: 10 }),
  f('cl_movespeedkey', 2, 0.1, 4, 'input', '+speed factor', 'Speed multiplier while +speed is held.', { step: 0.1 }),

  // ------------------------------------------------------------------ video
  e('r_preset', 'modern', ['classic', 'modern'], ['Classic', 'Modern'], 'video', 'Look', 'Classic: GL QuakeWorld as it was. Modern: bloom, tone mapping, dynamic lights.'),
  f('fov', 90, 10, 170, 'video', 'Field of view', 'Horizontal field of view at 4:3, degrees (QW). Wider screens see more.', { step: 1 }),
  i('viewsize', 100, 30, 120, 'video', 'View size', '100 = full screen with status bar; 110/120 hide parts of the bar.', { step: 10 }),
  f('gamma', 1, 0.5, 1.5, 'video', 'Gamma', 'Lower is brighter (QW).', { step: 0.05 }),
  f('contrast', 1, 0.8, 2, 'video', 'Contrast', 'Overall brightness multiplier.', { step: 0.05 }),
  f('r_scale', 1, 0.25, 2, 'video', 'Render scale', 'Resolution multiplier; below 1 is faster.', { step: 0.05 }),
  b('r_dynres', 1, 'video', 'Adaptive resolution', 'Lowers the render resolution while the frame rate is under 45 fps, and raises it back when there is headroom.'),
  b('r_bloom', 1, 'video', 'Bloom', 'Glow around bright lights.', { preset: true }),
  b('r_ssao', 0, 'video', 'Ambient occlusion', 'Contact shadows (SSAO). Costs frame time.', { preset: true }),
  b('r_tonemap', 1, 'video', 'Tone mapping', 'ACES filmic tone mapping.', { preset: true }),
  b('r_dynamic', 1, 'video', 'Dynamic lights', 'Rockets, explosions and muzzle flashes light the world.', { preset: true }),
  b('gl_flashblend', 0, 'video', 'Flash blend', 'Draw dynamic lights as glowing spheres instead of lighting the world (QW GL).', { preset: true }),
  e('gl_texturemode', 'GL_LINEAR_MIPMAP_LINEAR', ['GL_NEAREST_MIPMAP_LINEAR', 'GL_LINEAR_MIPMAP_LINEAR', 'GL_NEAREST'],
    ['Pixelated', 'Smooth', 'Pixelated, no mipmaps'], 'video', 'Texture filtering', 'How textures are sampled.', { preset: true }),
  i('gl_picmip', 0, 0, 3, 'video', 'Texture detail', 'Halve texture resolution this many times (QW picmip).'),
  b('r_drawflat', 0, 'video', 'Flat walls', 'Draw the world in flat colours (QW r_drawflat).'),
  b('r_fullbrightskins', 0, 'video', 'Bright players', 'Players are drawn at full brightness.'),
  b('r_particles', 1, 'video', 'Particles', 'Rocket trails, blood, explosions.'),
  b('r_waterwarp', 1, 'video', 'Water warp', 'Warp the view under water.'),
  b('r_drawviewmodel', 1, 'video', 'Show weapon', 'Draw your weapon.'),
  b('r_lerpmodels', 1, 'video', 'Smooth animation', 'Interpolate model animation frames.'),
  f('cl_bob', 0.02, 0, 0.1, 'video', 'View bob', 'How much the view bobs when running (QW 0.02).', { step: 0.005 }),
  f('cl_bobcycle', 0.6, 0.1, 2, 'video', 'Bob cycle', 'Seconds per bob cycle.', { step: 0.05 }),
  f('cl_bobup', 0.5, 0, 1, 'video', 'Bob up', 'Share of the cycle spent going up.', { step: 0.05 }),
  f('cl_rollangle', 2, 0, 10, 'video', 'Strafe roll', 'View roll when strafing, degrees (QW 2).', { step: 0.5 }),
  f('cl_rollspeed', 200, 1, 1000, 'video', 'Roll speed', 'Speed at which the roll is full.', { step: 10 }),
  f('v_kicktime', 0.5, 0, 2, 'video', 'Damage kick time', 'How long the view kicks when hit.', { step: 0.1 }),
  f('v_kickroll', 0.6, 0, 2, 'video', 'Damage kick roll', 'Roll on damage.', { step: 0.1 }),
  f('v_kickpitch', 0.6, 0, 2, 'video', 'Damage kick pitch', 'Pitch on damage.', { step: 0.1 }),
  b('gl_polyblend', 1, 'video', 'Screen tints', 'Damage, pickup, powerup and water colour flashes.'),
  b('show_fps', 0, 'video', 'Show FPS', 'Frames per second in the corner.'),

  // ------------------------------------------------------------------ hud
  e('hud_layout', 'classic', ['classic', 'modern'], ['Classic status bar', 'Modern minimal'], 'hud', 'HUD', 'Classic: the QW status bar. Modern: compact corners.'),
  f('hud_scale', 1, 0.5, 3, 'hud', 'HUD scale', 'Size of the HUD and console text.', { step: 0.25 }),
  i('crosshair', 2, 0, 7, 'hud', 'Crosshair', '0 off, 1 the + character, 2–7 shapes.'),
  { name: 'crosshaircolor', def: '79', kind: 'palette', min: 0, max: 255, group: 'hud', label: 'Crosshair colour', help: 'Quake palette index (QW 79).' },
  f('crosshairsize', 1, 0.25, 3, 'hud', 'Crosshair size', 'Scale.', { step: 0.25 }),
  f('crosshairalpha', 1, 0.1, 1, 'hud', 'Crosshair opacity', 'Opacity.', { step: 0.05 }),
  i('cl_crossx', 0, -100, 100, 'hud', 'Crosshair X', 'Horizontal offset in pixels.'),
  i('cl_crossy', 0, -100, 100, 'hud', 'Crosshair Y', 'Vertical offset in pixels.'),
  f('scr_centertime', 2, 0, 10, 'hud', 'Centre text time', 'Seconds centred messages stay.', { step: 0.5 }),
  f('con_notifytime', 3, 0, 20, 'hud', 'Notify time', 'Seconds console lines stay on screen.', { step: 0.5 }),
  b('show_speed', 0, 'hud', 'Show speed', 'Your horizontal speed (ups).'),
  b('scr_clock', 0, 'hud', 'Show clock', 'The time of day.'),

  // ------------------------------------------------------------------ audio
  f('volume', 0.7, 0, 1, 'audio', 'Volume', 'Master volume.', { step: 0.05 }),
  f('ambient_level', 0.3, 0, 1, 'audio', 'Ambient', 'Ambient sound level (QW).', { step: 0.05 }),
  b('cl_chatsound', 1, 'audio', 'Chat sound', 'Beep on chat messages.'),

  // ------------------------------------------------------------------ player (userinfo)
  { name: 'name', def: 'ranger', kind: 'string', maxLength: 20, group: 'player', label: 'Name', help: 'Your name.', userinfo: true },
  { name: 'team', def: '', kind: 'string', maxLength: 8, group: 'player', label: 'Team', help: 'Team name in team modes (auto when empty).', userinfo: true },
  { name: 'topcolor', def: '0', kind: 'color', min: 0, max: 13, group: 'player', label: 'Shirt', help: 'Shirt colour row 0–13.', userinfo: true, look: true },
  { name: 'bottomcolor', def: '0', kind: 'color', min: 0, max: 13, group: 'player', label: 'Pants', help: 'Pants colour row 0–13.', userinfo: true, look: true },
  { name: 'skin', def: 'base', kind: 'string', maxLength: 32, group: 'player', label: 'Skin', help: 'Player skin (skins/<name>.pcx).', userinfo: true, look: true },
  { name: 'model', def: 'player', kind: 'string', maxLength: 32, group: 'player', label: 'Model', help: 'Player model (progs/<name>.mdl); cosmetic.', look: true },

  // ------------------------------------------------------------------ menu
  e('qt_region', 'auto', ['auto', 'na', 'eu', 'asia'], ['Nearest', 'North America', 'Europe', 'Asia / Oceania'], 'menu', 'Region', 'Region for Quick Play and the top of the list.'),
  e('qt_quickmode', 'ffa', ['ffa', 'duel', '2on2', '4on4', 'ctf', 'ca'], ['Free For All', 'Duel', '2 on 2', '4 on 4', 'CTF', 'Clan Arena'], 'menu', 'Quick Play mode', 'The mode Quick Play finds.'),
];

/** What each preset sets. Every `preset: true` cvar appears in both. */
export const PRESETS: Readonly<Record<'classic' | 'modern', Readonly<Record<string, string>>>> = {
  classic: { r_bloom: '0', r_ssao: '0', r_tonemap: '0', r_dynamic: '1', gl_flashblend: '1', gl_texturemode: 'GL_NEAREST_MIPMAP_LINEAR' },
  modern: { r_bloom: '1', r_ssao: '0', r_tonemap: '1', r_dynamic: '1', gl_flashblend: '0', gl_texturemode: 'GL_LINEAR_MIPMAP_LINEAR' },
};

type Listener = (name: string, value: string, old: string) => void;

/** Printable, no infostring metacharacters (`\` `"`), trimmed. */
export function cleanText(raw: string, max: number): string {
  return raw.replace(/[\u0000-\u001f\u007f\\"]/g, '').trim().slice(0, max);
}

export class CvarRegistry {
  private readonly defs = new Map<string, CvarDef>();
  private readonly values = new Map<string, string>();
  private readonly listeners = new Map<string, Set<Listener>>();
  /** Saved values of cvars not registered yet (a game cvar registered after the settings load). */
  private readonly pending = new Map<string, string>();

  constructor(defs: readonly CvarDef[]) {
    for (const d of defs) this.register(d);
  }

  register(def: CvarDef): void {
    const name = def.name.toLowerCase();
    const d = { archive: true, ...def, name };
    this.defs.set(name, d);
    if (!this.values.has(name)) this.values.set(name, this.normalize(d, d.def) ?? d.def);
    const saved = this.pending.get(name);
    if (saved !== undefined) {
      this.pending.delete(name);
      if (d.archive !== false) this.set(name, saved, { silent: true });
    }
  }

  has(name: string): boolean { return this.defs.has(name.toLowerCase()); }
  def(name: string): CvarDef | undefined { return this.defs.get(name.toLowerCase()); }
  get(name: string): string { return this.values.get(name.toLowerCase()) ?? ''; }

  num(name: string): number {
    const n = Number.parseFloat(this.get(name));
    return Number.isFinite(n) ? n : 0;
  }

  bool(name: string): boolean {
    const v = this.get(name);
    const n = Number(v);
    return Number.isFinite(n) && v.trim() !== '' ? n !== 0 : v !== '' && v !== '0';
  }

  /** Sorted names, optionally those starting with `prefix`. */
  list(prefix = ''): string[] {
    const p = prefix.toLowerCase();
    return [...this.defs.keys()].filter((n) => n.startsWith(p)).sort();
  }

  group(g: CvarGroup): CvarDef[] { return [...this.defs.values()].filter((d) => d.group === g); }

  /** Parse + clamp; returns false if unknown or the value cannot be read. */
  set(name: string, value: string | number | boolean, opts: { silent?: boolean } = {}): boolean {
    const d = this.def(name);
    if (!d) return false;
    const v = this.normalize(d, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
    if (v === null) return false;
    const old = this.values.get(d.name)!;
    if (v === old) return true;
    this.values.set(d.name, v);
    if (!opts.silent) this.emit(d.name, v, old);
    return true;
  }

  reset(name: string): void {
    const d = this.def(name);
    if (d) this.set(d.name, d.def);
  }

  resetAll(group?: CvarGroup): void {
    for (const d of this.defs.values()) if (!group || d.group === group) this.set(d.name, d.def);
  }

  isDefault(name: string): boolean {
    const d = this.def(name);
    return !!d && this.get(d.name) === (this.normalize(d, d.def) ?? d.def);
  }

  /** `cb(name, value, old)` after every effective change of `name` (or of any cvar for '*'). */
  onChange(name: string, cb: Listener): () => void {
    const key = name === '*' ? '*' : name.toLowerCase();
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, (set = new Set()));
    set.add(cb);
    return () => { set!.delete(cb); };
  }

  /** Archived cvars that differ from their default. */
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.pending) out[k] = v;
    for (const d of this.defs.values()) if (d.archive !== false && !this.isDefault(d.name)) out[d.name] = this.get(d.name);
    return out;
  }

  /**
   * Make the archived cvars equal `values` (missing → default). Unknown names are kept
   * aside and applied if a cvar of that name is registered later (a game cvar).
   */
  load(values: Record<string, string>): void {
    for (const d of this.defs.values()) {
      if (d.archive === false) continue;
      const v = Object.prototype.hasOwnProperty.call(values, d.name) ? values[d.name] : d.def;
      this.set(d.name, typeof v === 'string' ? v : d.def);
    }
    for (const [k, v] of Object.entries(values)) if (!this.defs.has(k) && typeof v === 'string') this.pending.set(k, v);
  }

  applyPreset(p: 'classic' | 'modern'): void {
    for (const [k, v] of Object.entries(PRESETS[p])) this.set(k, v);
    this.set('r_preset', p);
  }

  /** The preset whose bundle the current values match, or 'custom'. */
  currentPreset(): 'classic' | 'modern' | 'custom' {
    const p = this.get('r_preset') as 'classic' | 'modern';
    const bundle = PRESETS[p];
    if (!bundle) return 'custom';
    return Object.entries(bundle).every(([k, v]) => this.get(k) === v) ? p : 'custom';
  }

  private normalize(d: CvarDef, raw: string): string | null {
    const s = String(raw).trim();
    switch (d.kind) {
      case 'float': case 'int': case 'color': case 'palette': {
        let n = Number.parseFloat(s);
        if (!Number.isFinite(n)) return null;
        if (d.kind !== 'float') n = Math.round(n);
        if (d.min !== undefined) n = Math.max(d.min, n);
        if (d.max !== undefined) n = Math.min(d.max, n);
        // Short, stable text: 0.022 not 0.022000000000000002.
        return String(Number(n.toFixed(6)));
      }
      case 'bool': {
        const n = Number.parseFloat(s);
        if (Number.isFinite(n)) return n !== 0 ? '1' : '0';
        if (/^(on|true|yes)$/i.test(s)) return '1';
        if (/^(off|false|no)$/i.test(s)) return '0';
        return null;
      }
      case 'enum': {
        const hit = d.options?.find((o) => o.toLowerCase() === s.toLowerCase());
        return hit ?? null;
      }
      default:
        return cleanText(s, d.maxLength ?? 255);
    }
  }

  private emit(name: string, value: string, old: string): void {
    for (const key of [name, '*']) {
      for (const cb of this.listeners.get(key) ?? []) {
        try { cb(name, value, old); } catch (err) { console.error(err); }
      }
    }
  }
}

export const cvars = new CvarRegistry(DEFS);
