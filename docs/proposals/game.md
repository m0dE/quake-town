# Proposals from the game part (shell: net, game loop, HUD, console, audio, demos)

## 1. Cvar registry shape (to the menu part, `src/settings/`)

The console (`src/console/`) needs one cvar registry shared with the menu's settings
screens. Until `src/settings/` exports one, the console runs its own store with the
same shape (`src/console/cvars.ts`) and switches to the settings one when it appears.
Proposed shape (QW semantics: every cvar is a string; numbers parse with `Number`):

```ts
export interface CvarDef {
  name: string;            // QW name: 'sensitivity', 'm_pitch', 'fov', 'cl_bob', 'crosshair', ...
  default: string;
  archive?: boolean;       // persisted (localStorage, or the ARRR account when signed in)
  desc?: string;           // one line for `cvarlist` and the settings screen
  min?: number; max?: number;
  userinfo?: boolean;      // name/team/topcolor/bottomcolor/skin: a change sends { u } to the room
}
export interface Cvars {
  register(def: CvarDef): void;     // idempotent; the console registers the shell's cvars at boot
  has(name: string): boolean;
  get(name: string): string;        // '' for an unknown cvar
  num(name: string): number;        // Number(get) or 0
  set(name: string, value: string): void;   // clamps to min/max, persists archive cvars, fires onChange
  reset(name: string): void;
  list(): CvarDef[];
  onChange(fn: (name: string, value: string) => void): () => void;
}
export const cvars: Cvars;
```

Shell cvars the game part registers (menu screens may show them): `sensitivity` 6,
`m_pitch` 0.022, `m_yaw` 0.022, `m_filter` 0, `m_rawinput` 1, `cl_forwardspeed` 400,
`cl_backspeed` 400, `cl_sidespeed` 400, `cl_upspeed` 400, `cl_movespeedkey` 2,
`cl_run` 1, `lookspring` 0, `freelook` 1, `invert_mouse` 0 (→ m_pitch sign), `fov` 90,
`viewsize` 100, `cl_bob` 0.02, `cl_bobcycle` 0.6, `cl_bobup` 0.5, `cl_rollangle` 2,
`cl_rollspeed` 200, `v_kicktime` 0.5, `v_kickroll` 0.6, `v_kickpitch` 0.6,
`crosshair` 2, `crosshaircolor` 79, `crosshairsize` 1, `crosshairalpha` 1, `hud_style`
(classic|modern), `scr_centertime` 2, `con_notifytime` 3, `con_notifylines` 4,
`show_fps` 0, `show_net` 0 (net graph), `volume` 0.7, `bgmvolume` 0, `s_ambient` 1,
`cl_chasecam` 0, `name`, `team`, `topcolor`, `bottomcolor`, `skin` (userinfo).

Binds are console data, persisted by the console (`config.cfg` in localStorage:
`bind`, `alias` and `seta` lines, exactly as QW writes it); `exec <name>` runs a config
stored in browser storage. Settings screens that edit binds can call
`console.exec('bind x "+jump"')` / read `console.binds()`.

## 2. Engine (`world_client_join` after `world_client_idle`)

A member whose connection dropped (idle, state 3) and who reconnects is re-joined with
`world_client_join(slot)`; DESIGN says join resets frags. For a reconnect into the same
slot, please keep frags/stats when the slot's state is 3 (idle-human): it is the same
player, the bot only kept the body warm. (The fake sim in `src/sim/fake.ts` does this.)

## 3. Tick rate measurements (for DESIGN.md "Tick rate")

Filled in below by the multiplayer run on the local cluster.
