# src/settings — cvars, binds, stored configs, persistence

Owner: menu part. The game part's console, input, HUD, renderer glue and audio read and
write settings only through this module.

```ts
import { cvars, binds, configs, settings, userinfo, playerLook } from './settings/index.js';
```

## cvars (`cvars.ts`)

QuakeWorld names and semantics. Values are strings (like QW); typed getters convert.

| call | what |
|---|---|
| `cvars.get(name): string` | current value; `''` for an unknown name |
| `cvars.num(name): number` / `cvars.bool(name): boolean` | typed read (`bool` = non-zero number or non-empty non-"0" string) |
| `cvars.set(name, value, opts?): boolean` | parse + clamp per its definition; false if unknown or read-only. `opts.silent` skips listeners. Changing a `userinfo` cvar fires `onUserinfo` |
| `cvars.reset(name)` / `cvars.resetAll(group?)` | back to default |
| `cvars.has(name)`, `cvars.def(name): CvarDef \| undefined`, `cvars.list(prefix?)`, `cvars.group(g)` | registry queries (console completion, `cvarlist`) |
| `cvars.register(def)` | a cvar the game defines at runtime (e.g. `cl_maxfps`); `archive: false` unless you say so |
| `cvars.onChange(name \| '*', cb)` → unsubscribe | `cb(name, value, old)` after every effective change |
| `cvars.applyPreset('classic' \| 'modern')`, `cvars.currentPreset()` | the `r_preset` bundle; `currentPreset()` is `'custom'` once any preset cvar differs |

Groups: `input`, `video`, `hud`, `audio`, `player`, `menu`. A `CvarDef` is
`{ name, def, kind: 'float'|'int'|'bool'|'string'|'enum'|'color'|'palette', min?, max?, options?, group, label, help, archive?, userinfo?, look?, preset? }`.

Selected cvars (full list: `DEFS` in `cvars.ts`):

- input: `sensitivity 3`, `m_pitch 0.022` (negative = inverted), `m_yaw 0.022`, `m_filter 0`, `m_accel 0`,
  `freelook 1`, `lookspring 0`, `cl_forwardspeed 400`, `cl_backspeed 400`, `cl_sidespeed 400`,
  `cl_upspeed 400`, `cl_movespeedkey 2`, `m_rawinput 1`
- video: `fov 90` (10–170; menu 90–130), `viewsize 100`, `gamma 1`, `contrast 1`, `r_preset modern`,
  `r_bloom 1`, `r_ssao 0`, `r_tonemap 1`, `r_dynamic 1`, `gl_flashblend 0`, `r_drawflat 0`,
  `r_fullbrightskins 0`, `gl_texturemode`, `gl_picmip 0`, `r_scale 1`, `r_particles 1`,
  `r_waterwarp 1`, `r_drawviewmodel 1`, `r_lerpmodels 1`, `cl_bob 0.02`, `cl_bobcycle 0.6`,
  `cl_bobup 0.5`, `cl_rollangle 2`, `cl_rollspeed 200`, `v_kicktime 0.5`, `v_kickroll 0.6`,
  `v_kickpitch 0.6`, `gl_polyblend 1`, `show_fps 0`
- hud: `hud_layout classic|modern`, `crosshair 2` (0 off, 1 `+` char, 2–7 shapes),
  `crosshaircolor 79` (Quake palette index), `crosshairsize 1`, `crosshairalpha 1`, `cl_crossx 0`,
  `cl_crossy 0`, `scr_centertime 2`, `con_notifytime 3`, `show_speed 0`, `scr_clock 0`, `hud_scale 1`
- audio: `volume 0.7`, `ambient_level 0.3`, `cl_chatsound 1`
- player (userinfo): `name`, `team`, `topcolor 0..13`, `bottomcolor 0..13`, `skin base`; cosmetic: `model player`
- menu: `qt_region auto|na|eu|asia`, `qt_quickmode ffa|…`

## userinfo and look

- `userinfo(): string` — `\name\…\team\…\topcolor\…\bottomcolor\…\skin\…` for `{ u }` inputs and
  `world_client_join`.
- `onUserinfo(cb)` → unsubscribe; fires (debounced to one per task) when any userinfo cvar changes,
  so the game sends one `{ u }`.
- `playerLook(): PlayerLook` — `{ model, skin, topcolor, bottomcolor }`, the menu preview's and
  the `{ look }` profile's shape (`src/render/types.ts` `PlayerLook` should match it).
- `PALETTE_ROWS` / `paletteRgb(i)` (`palette.ts`) — the 14 QW colour rows and the 256 colours
  (crosshaircolor, swatches).

## binds (`binds.ts`)

QW key names (`w`, `space`, `mouse1`, `mwheelup`, `tab`, `escape`, `uparrow`, `f1`, `kp_enter`, …).

`binds.get(key)`, `binds.set(key, command)`, `binds.unbind(key)`, `binds.unbindAll()`,
`binds.all(): [key, command][]`, `binds.keysFor(command): string[]`, `binds.resetDefaults()`,
`binds.onChange(cb)`. `keyName(e: KeyboardEvent)` / `mouseKeyName(button)` / `wheelKeyName(deltaY)`
turn DOM events into QW key names. Defaults (`DEFAULT_BINDS`): WASD, mouse1 `+attack`,
space/mouse2 `+jump`, 1–8 `impulse n`, mwheel `impulse 12`/`impulse 10`, tab `+showscores`,
t `messagemode`, y `messagemode2`, `` ` ``/`~` `toggleconsole`, f1 `ready`, f2 `break`, escape `togglemenu`.

## stored configs (`configs.ts`)

`configs.list()`, `configs.get(name)`, `configs.save(name, text)`, `configs.remove(name)` —
for the console's `exec`/`writeconfig`. `autoexec.cfg`, if present, is the console's to run at
start-up. Names are `[a-z0-9_.-]{1,40}`; a config is ≤ 64 KB.

## persistence (`persist.ts`)

Everything above that is archived (cvars that differ from default, all binds, configs) is one
JSON document. It is saved:

- always to **localStorage** (`qt.settings`), debounced 300 ms after a change;
- and when signed in with ARRR, to the **account's vault record** (`arrr-network`
  `vault.open(session)`, key `settings`), debounced 1.5 s, the way vibe-strike keeps its wardrobe
  there. On sign-in the account's copy wins; an account that never saved is seeded from this
  browser. A save that fails stays dirty and is retried on the next change; `settings.flush()`
  is called when the page hides.

`settings.status(): 'browser' | 'account' | 'loading'` and `settings.onStatus(cb)` for the menu.
`settings.exportText()` / `settings.importText(text)` — the whole document as a QW-style cfg
(`bind`, `seta`), for `writeconfig`.

Sign-in: `account` (`account.ts`, adapted from doom-arrr/vibe-strike): `account.start()`,
`account.signIn()`, `account.signOut()`, `account.session()`, `account.onChange(cb)`.
