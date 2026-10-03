# Quake Town — design

QuakeWorld reborn in the browser: open a link, pick a server, play. Every client runs
the same deterministic simulation in lockstep over arrr-network; there is no game
server. This file is the contract between the parts (sim, QuakeC VM, mod, content,
renderer, shell). **Change it first, then the code.** Only the integrator edits this
file; a part that needs a contract change writes it into `docs/proposals/<part>.md`
and says so in its report.

## Licensing (settled before any code)

- **Engine code is GPL-2.0-or-later.** id's Quake / QuakeWorld source
  (github.com/id-Software/Quake, `QW/` and `qw-qc/`) carries, in every file header,
  "either version 2 of the License, or (at your option) any later version". So this
  repository is **GPL-2.0-or-later** (`LICENSE` = id's `gnu.txt`, GPL v2 text). Keep
  id's copyright notice in the header of every file ported from id code
  (`Copyright (C) 1996-1997 Id Software, Inc.`) plus our own line.
- **Source ports and mods** checked 2026-10-03 from their file headers: ezQuake
  (`src/pmove.c`), FTEQW (`engine/common/pmove.c`) and KTX (`src/g_main.c`) are all
  "version 2 … or (at your option) any later version". Porting from them is allowed;
  keep their notices in the ported file. Because everything is "or later", GPL-3
  material *could* be combined (the result would then be GPL-3); **don't** — keep the
  tree GPL-2.0-or-later so nothing upstream is shut out. No GPL-3-only code.
- **Tools** used at build time, never shipped in the bundle: ericw-tools (GPL-2.0,
  map compiler), a QuakeC compiler (gmqcc, MIT, or fteqcc, GPL-2.0-or-later). Their
  output (BSP files, progs.dat) is ours.
- **Game data is LibreQuake** (github.com/lavenderdotpet/LibreQuake, v0.09-beta):
  models, textures, sounds, gfx are **BSD-3-Clause** (`docs/COPYING`, `docs/CREDITS`);
  its QuakeC/progs.dat is GPL-2 (we do not ship their progs; our mod is ported from
  id's qw-qc). The LibreQuake DM maps lqdm1–lqdm13 are BSD-3. Their notices ship in
  `assets-licenses/` and in the bundle.
- **id's data is never shipped.** pak0.pak/pak1.pak and id's maps (dm2, dm4, dm6,
  e1m2, …) are not redistributable. A player may load their **own** id paks from
  disk; they are stored in that browser only (IndexedDB) and override the art (same
  file names). They are never uploaded and never advertised to a room.
- **Name:** "QUAKE" is id/ZeniMax's trademark. Player-facing title **Quake Town**.
  Code identifiers may say `quake`/`qw`.
- The published bundle carries `LICENSE.txt`, `ASSET-LICENSES.txt` (LibreQuake BSD-3 +
  credits + per-map credits) and `source.zip` (full corresponding source, GPL §3(a)),
  linked from the menu footer.

## Layout and ownership

```
quake-town/
  DESIGN.md  LICENSE  README.md
  assets-licenses/          LibreQuake COPYING/CREDITS, per-map credits      (content)
  sim/                      Cargo workspace → one wasm                       
    qtsim/                  engine: bsp, trace, world, pmove, phys, builtins, abi, tests (engine)
    qcvm/                   QuakeC VM: progs loader, interpreter, strings, pure builtins (qcvm)
    qtbots/                 bots: navigation from the BSP, usercmd generation     (qcvm, phase 2)
  mod/qtdm/                 the default QuakeC mod (port of id qw-qc + modes)      (mod)
  content/                  map sources (.map), map generators, pack manifests     (content)
  tools/sim/  tools/qc/  tools/content/  tools/test/  tools/export.mjs            (owner = dir)
  public/                   built runtime files (qtsim.wasm, packs/*.pk3), committed
  src/
    render/                 three.js renderer, BSP/MDL/SPR loaders for drawing     (renderer)
    content/                VFS: pak/pk3, packs, sha256, IndexedDB cache, id paks  (content)
    main.ts net/ sim/ menu/ hud/ input/ audio/ console/ demo/ game/ settings/      (shell)
```

Tool owners: `tools/sim` engine, `tools/qc` mod, `tools/content` content,
`tools/test` + `tools/export.mjs` shell. Nobody edits another part's directory; ask the
integrator. Nobody commits; the integrator commits.

Build: `npm run build:sim` (cargo → `public/qtsim.wasm`, committed so the client builds
without Rust), `npm run build:mod` (QuakeC → `public/packs/qtdm-*.pk3`),
`npm run build:content` (maps + base assets → `public/packs/*.pk3` +
`public/packs/index.json`), `npm run dev`, `npm run export`.

The box is small (2 cores, ~2–3 GB free RAM): `CARGO_BUILD_JOBS=1`, `nice` long
compiles, kill every process you start, no `lsof` (use `ss -tlnpH 'sport = :PORT'`).

## Tick rate and time

- **The network rate and the physics rate are separate.** The app's `fps` is the network
  frame rate: how often the node orders and broadcasts inputs. Quake Town runs at
  **20 Hz** like the other ARRR games (`applications.fps = 20`); the client follows
  whatever rate the node states at connect.
- **Physics stays QuakeWorld's.** Each network frame is cut into QuakeWorld frames of at
  most **13 ms** (`frameSteps` in `src/sim/qtsim.ts`): at 20 Hz a 50 ms frame runs
  13 + 13 + 12 + 12 ms. QW's physics is integer-msec and slightly frame-length dependent;
  13 ms is what a QW client at the competitive 77 fps sent, so movement (bunny hops,
  strafe jumps, 43.8-unit jumps) is QW's, and game time is exact (the steps sum to the
  frame). Each step runs `world_tick_ms(h, msec)`: pmove with that msec, `SV_Physics`
  with that frametime, time advanced by it. The split is a pure function of the frame
  number and the rate, so every client cuts identically.
- **Input:** one cmd per network frame. Its view angles are reached across the frame's
  steps, interpolated from the body's current view angles (read from the world, so a
  client restored from a snapshot agrees), so turning while strafe jumping stays smooth;
  an impulse fires on the first step only.
- Sim time: `world.time` is 1.0 + milliseconds simulated on this map / 1000 (f64);
  QuakeC sees the f32 global `time`. A map change restarts time at 1.0 (QW's server did
  the same; keeps f32 precision).
- Cost: ~0.45 ms of wasm per 20 Hz network frame (four QW steps, 16 players with bots),
  ~9 ms of CPU per second per world stepped.

## Simulation architecture

The sim is a port of the QuakeWorld **server** (QW/server: sv_phys.c, sv_user.c,
world.c, pr_cmds.c, pr_exec.c, pr_edict.c, sv_init.c) plus QW/client/pmove.c and
pmovetst.c, in Rust, compiled to one `wasm32-unknown-unknown` binary with a plain C
ABI (no wasm-bindgen). Every client runs it in lockstep. arrr-network's prediction
(whole-world clone + replay) replaces QW's client-side prediction.

Per tick, in this order (QW's SV_Frame order, with all cmds of a tick sequenced):
1. bots compute their usercmds (`qtbots`, reading the world through a trait);
2. for each client slot in ascending order with a live player: `SV_RunCmd` with the
   slot's held cmd — `PlayerPreThink`, pmove (the step's msec, ≤ 13), touch triggers via
   `SV_TouchLinks`/pmove touch list, `SV_RunNewmis`, `PlayerPostThink`;
3. `SV_Physics`: `StartFrame`, then every non-client edict in edict order by movetype
   (push, none, noclip, toss/bounce/fly, step), think functions at `nextthink`;
4. pending `changelevel` is applied (see Maps); events of this tick are final.

Crates:
- `sim/qcvm` — no dependency on the engine. Progs loader for **QW progs**
  (`qwprogs.dat`, PROG_VERSION 6, QW `progdefs.h` CRC 54730; NQ progs.dat with CRC 5927
  is refused with a clear error code), the interpreter (all opcodes incl. the
  common FTE extension opcodes are NOT required — vanilla v6 opcode set), a runaway
  guard (instruction budget per call → error, never a hang), string table with
  `strzone` handles that are deterministic and serializable, edict memory
  (`Vec<f32/i32 words>`), field lookup by name, global lookup by name, and builtin
  dispatch through a `Host` trait the engine implements. Pure builtins (math, string,
  vector ops, ftos/vtos/stof, random via the host's PRNG) live here.
- `sim/qtsim` — the engine: BSP29 + BSP2 loading (planes, nodes, clipnodes, leafs,
  models, hulls 0/1/2, entities lump, visdata for `checkclient`/PVS), traces
  (`SV_RecursiveHullCheck`, `SV_Move` with area nodes), edict linking (world.c),
  `pmove` (pmove.c + pmovetst.c, a faithful port), sv_phys, sv_user, the engine
  builtins, events, bots glue, serialization, hashing, the ABI.
- `sim/qtbots` — bots that play like humans, mod-agnostic: they produce a usercmd per
  tick exactly like a human's, so any mod works with them. Navigation graph derived
  from the BSP at map load (walkable samples with hull 1, step 18, jumps, drops,
  teleporters, plats/lifts as edges), goals from entity classnames (weapons, armor,
  health, powerups, flags), enemy visibility via traces and the PVS, per-bot skill
  (reaction 150–350 ms, aim error, turn rate), circle strafe, bunny hop and strafe jump
  on long straight paths, rocket jumps on known gaps at high skill. Depends on a
  `BotWorld` trait defined in `qtbots` and implemented by `qtsim` — no crate cycle.

### Determinism rules (the sim is floats; these keep it lockstep-safe)

- f32/f64 arithmetic in wasm is IEEE-754 and deterministic across browsers. **No host
  math imports** (`Math.sin` etc.): transcendental functions come from the pure-Rust
  `libm` crate (sin, cos, atan2, sqrt is `f32::sqrt` = IEEE exact). Never call
  `f32::sin` / `f64::powf` etc. from std (they lower to host/LLVM intrinsics). Rust
  never contracts into FMA; do not enable `+relaxed-simd` or any target feature
  that changes float results.
- **NaN canonicalisation:** wasm leaves NaN payload/sign bits nondeterministic. Any
  float that is hashed or serialized is canonicalised (`if x.is_nan() { f32::NAN }`)
  and float→int conversions use Rust's saturating `as` (NaN → 0).
- Iterate in a stable order (edict index, slot index, creation order). No HashMap
  iteration in sim code (BTreeMap or Vec only).
- One PRNG per world (xorshift128+ or PCG32), seeded from `world_new`'s seed, part
  of the serialized state. QC `random()` draws from it.
- No `std::time`, no host imports at all except none: the wasm imports nothing.
- `world_hash` covers the whole state (edicts, globals, strings, PRNG, bots, slots,
  time, pending events excluded). `deserialize(serialize(w))` steps bit-identically
  to `w`; `clone(w)` likewise.
- Tests (all must pass before a part says done): twin worlds stepped with the same
  inputs for 20,000 ticks agree on every tick's hash; a clone taken at tick 5,000
  agrees for the next 5,000; serialize→deserialize at random ticks agrees; the
  native build and the wasm build (run from Node) produce the same hash sequence for
  a scripted 5,000-tick match with bots — this proves no host-dependent math.

### pmove

A line-by-line port of `QW/client/pmove.c` and `pmovetst.c` (QW 2.33 behaviour), with
`movevars`: gravity 800, stopspeed 100, maxspeed 320, spectatormaxspeed 500,
accelerate 10, airaccelerate 0.7, wateraccelerate 10, friction 4, waterfriction 4,
entgravity 1. Jump: `PM_CategorizePosition`/`JumpButton` exactly as QW (jump held
does not re-jump until released: `oldbuttons`), `PM_Friction` with the edge-friction
trace, `PM_AirAccelerate` capping wishspd at 30. **Regression tests** (in
`sim/qtsim/tests/pmove.rs`, against a flat test BSP built in code or a tiny compiled
BSP): ground max speed 320; bunny hopping with optimal strafe gains speed every hop
(record the speed after 10 hops with the optimal-angle bot input and pin it); strafe
jump crosses a gap a straight jump cannot; jump apex 43.81 units at msec 13 (QW integrates per frame; 45.56 is
the continuous limit); rocket jump height (RL self-damage knockback, velocity +=
dir × damage × 8 for self-damage in QW combat.qc → pin the height); circle jump
start speed gain. Pin numbers measured from the port; where public numbers exist
(e.g. 320 ground, 45.5 apex) assert them.

## The wasm ABI (`sim/qtsim/src/abi.rs`) — the only interface between Rust and TS

All exports `extern "C"`, `#[no_mangle]`. i32/u32 unless noted. Pointers are offsets
into wasm memory. Little-endian. "f32" words are f32 bit patterns in a u32 slot (read
through a Float32Array over the same buffer). Returned buffers are valid until the
next call on the same world (or the next content call for content buffers).

```
// memory
alloc(len) -> ptr ; dealloc(ptr, len)
sim_version() -> u32                bump on any change to behaviour or layout
last_error_ptr() -> ptr             NUL-terminated text of the last error (any call)

// content — once per page, before worlds. Bytes are copied in.
progs_load(ptr, len) -> progs_id    qwprogs.dat; >= 0, or < 0 error code
map_load(name_ptr, name_len, ptr, len) -> map_id     BSP29 or BSP2 bytes; name = "qt_aero"
map_name(map_id) -> ptr             NUL-terminated
map_count() -> u32

// worlds (several coexist: confirmed, predicted, demo, test peers)
world_new(progs_id, map_id, seed, info_ptr, info_len) -> h      h > 0, 0 = error
     info = QW serverinfo infostring "\key\value\key\value" (see Room config → serverinfo)
     maxclients comes from info "maxclients" (2..32). Empty slots are bot-driven when
     info "bots" != "0", else empty. Spawns the map (worldspawn, ED_LoadFromFile).
world_free(h)
world_clone(h) -> h2
world_serialize(h) -> len           bytes at world_buf_ptr()
world_buf_ptr() -> ptr
world_deserialize(ptr, len) -> h    0 on bad data (progs/maps must already be loaded, same ids)
world_hash(h) -> u32
world_tick_count(h) -> u32          ticks since world_new
world_map(h) -> map_id              current map (changes on changelevel)

// membership — pure functions of the ordered stream
world_free_slot(h) -> i32           lowest slot that is empty or bot-driven, -1 if none
world_client_join(h, slot, ui_ptr, ui_len)   slot becomes human: a bot there is
                                    disconnected (ClientDisconnect), the human connects
                                    (SetNewParms, ClientConnect, PutClientInServer),
                                    frags reset. ui = userinfo infostring. Idempotent.
world_client_leave(h, slot)         human leaves: ClientDisconnect; a bot takes the slot
                                    if bots are on. Idempotent.
world_client_idle(h, slot)          connection lost, membership kept: a bot drives
                                    the same body (frags kept) until join/leave.
world_set_userinfo(h, slot, ui_ptr, ui_len)  name/team/topcolor/bottomcolor/skin; the
                                    engine updates netname/team/colormap and calls the
                                    mod's UserInfo_Changed if the progs define it.
world_client_command(h, slot, ptr, len)      a console command string from that client
                                    ("ready", "break", "team red", "kill", "vote …"):
                                    passed to the mod's SV_ParseClientCommand(string) if
                                    defined (self = player), else the engine handles
                                    "kill" (ClientKill) and ignores the rest.

// input — last command wins, held until replaced
world_set_cmd(h, slot, pitch16, yaw16, forward, side, up, buttons, impulse)
     pitch16/yaw16: i32 in -32768..32767, QW ANGLE2SHORT (angle*65536/360), as the QW
                    usercmd carries them; roll is 0.
     forward/side/up: i32 -500..500 (QW cl_forwardspeed etc. 400 typical, 800 with +speed
                    capped by maxspeed in pmove); buttons: bit0 attack, bit1 jump;
     impulse: 0..255, applied once (the sim clears it after the tick that used it).
     msec is always 13 (the tick).
world_tick(h)

// reading a world (buffers valid until the next call on h)
world_view_ents(h) -> ptr           u32 count, then count × EntView (20 words)
world_view_client(h, slot) -> ptr   ClientView (64 words)
world_view_clients(h) -> ptr        u32 count (= maxclients), then count × ClientRow (32 words)
world_client_info(h, slot) -> ptr   userinfo infostring, NUL-terminated (bots have one too)
world_events(h) -> ptr              events of the LAST world_tick: u32 count, then
                                    count × Event (10 words)
world_strings(h) -> ptr             NUL-separated strings the events reference (index i
                                    = the i-th string), rebuilt each tick
world_model_names(h) -> ptr         precache_model list, index = modelindex
                                    (index 0 = "", 1 = the map "maps/x.bsp", "*1".. brush models)
world_sound_names(h) -> ptr         precache_sound list, index = sound index
world_lightstyles(h) -> ptr         64 NUL-separated lightstyle strings ("m", "mmnmmommo…")
world_serverinfo(h) -> ptr          serverinfo infostring (the mod may change keys)

// tests / tools
world_set_cvar(h, name_ptr, name_len, value_ptr, value_len)   only before the first tick
```

Every name list is NUL-terminated names followed by one extra NUL.

`EntView` (20 words) — every edict with a modelindex != 0 that is not the world,
plus every client with a body. Order: edict index.

| # | field | notes |
|---|---|---|
| 0 | num | edict index (1..maxclients are clients) |
| 1 | serial | bumps every time this edict index is reused (spawn); renderer keys on (num, serial) |
| 2 | modelindex | |
| 3 | frame | |
| 4 | skin | skinnum |
| 5 | colormap | 0, or client slot+1 for player-coloured models |
| 6 | effects | QW EF_* bits (EF_BRIGHTFIELD 1, EF_MUZZLEFLASH 2, EF_BRIGHTLIGHT 4, EF_DIMLIGHT 8, EF_FLAG1 16, EF_FLAG2 32, EF_BLUE 64, EF_RED 128) |
| 7 | movetype \| solid<<8 \| flags<<16 | low 16 bits of QC `flags` (FL_ONGROUND etc.) |
| 8–10 | origin f32 | |
| 11–13 | angles f32 | degrees, QC `angles` |
| 14–16 | velocity f32 | renderer extrapolates projectiles (MOVETYPE_FLY/FLYMISSILE/BOUNCE) along it |
| 17 | owner num | for own-projectile prediction decisions |
| 18 | alpha f32 | 1.0 unless the mod sets `.alpha` (0 → 1) |
| 19 | reserved | 0 |

`ClientView` (64 words, i32 unless f32):

```
0 slot  1 entnum  2 state (0 empty, 1 human, 2 bot, 3 idle-human driven by bot)
3-5 origin f32  6-8 velocity f32  9-11 v_angle f32 (sim's view angles, degrees)
12 view_ofs_z f32  13-15 punchangle f32  16 onground (0/1)  17 waterlevel  18 watertype
19 health  20 armorvalue  21 armortype*100  22 currentammo  23 shells  24 nails
25 rockets  26 cells  27 items (QW IT_* bits)  28 weapon (IT_ bit of active weapon)
29 weaponmodel (modelindex, 0 none)  30 weaponframe  31 frags  32 deadflag
33 effects  34 fixangle (1 if the sim set angles this tick; 35-37 then hold them)
35-37 fixangle angles f32  38 dmg_take  39 dmg_save  40-42 dmg_inflictor origin f32
43 intermission (0/1)  44 spectator 0  45 jump_held  46 teleport_time f32
47 qt stat: match phase  48 qt stat: phase end time f32 (sim seconds)
49-63 reserved 0
```

`ClientRow` (32 words): `slot, state, entnum, frags, team_hash (crc of team string),
topcolor, bottomcolor, ping_reserved(0), then 24 qt stats (index = stat id below)`.

`Event` (10 words): `kind, a, b, c, d, x f32, y f32, z f32, e, f`

| kind | meaning | a | b | c | d | x,y,z | e | f |
|---|---|---|---|---|---|---|---|---|
| 1 | sound | entnum (0 = at xyz) | channel | sound index | volume 0..255 | origin | attenuation×64 | — |
| 2 | temp entity | QW TE_* id | count | entnum (lightning owner) | — | start | end x f32 bits | end y; end z in d |
| 3 | print (sprint/bprint) | target slot (-1 all) | level (PRINT_LOW 0, MEDIUM 1, HIGH 2, CHAT 3) | string index | — | — | — | — |
| 4 | centerprint | target slot (-1 all) | string index | — | — | — | — | — |
| 5 | muzzleflash | entnum | — | — | — | — | — | — |
| 6 | damage | victim slot | dmg_save | dmg_take | — | from origin | — | — |
| 7 | kick | slot | 0 small, 1 big | — | — | — | — | — |
| 8 | stufftext | target slot (-1 all) | string index | — | — | — | — | — |
| 9 | lightstyle | style | string index | — | — | — | — | — |
| 10 | intermission | — | — | — | — | origin | — | — |
| 11 | obituary (qt_obituary) | victim slot | killer slot (-1 world, = victim suicide) | weapon/deathtype id | flags (1 teamkill, 2 telefrag) | victim origin | — | — |
| 12 | match state (qt_matchstate) | phase | team1 score | team2 score | round | end time f32 bits | countdown end f32 bits | — |
| 13 | changelevel done | new map_id | — | — | — | — | — | — |
| 14 | pickup (qt_pickup) | slot | item id (stat ids 6..12, weapons 20+w) | — | — | origin | — | — |

TE ids are QW's (TE_SPIKE 0, TE_SUPERSPIKE 1, TE_GUNSHOT 2, TE_EXPLOSION 3,
TE_TAREXPLOSION 4, TE_LIGHTNING1 5, TE_LIGHTNING2 6, TE_WIZSPIKE 7, TE_KNIGHTSPIKE 8,
TE_LIGHTNING3 9, TE_LAVASPLASH 10, TE_TELEPORT 11, TE_BLOOD 12, TE_LIGHTNINGBLOOD 13).
The engine turns the QC `WriteByte(MSG_MULTICAST/MSG_ALL/MSG_ONE, …)` +
`multicast()` byte streams into events (svc_temp_entity, svc_muzzleflash,
svc_smallkick, svc_bigkick, svc_damage, svc_intermission, svc_centerprint,
svc_stufftext); unknown svc bytes are dropped. Visibility filtering (PHS/PVS) is NOT
applied: every client sees every event; the client culls by distance.

### Quake Town QuakeC extensions (builtin numbers 9000+, optional for mods)

```
void(entity victim, entity killer, float deathtype, float flags) qt_obituary = #9000;
void(entity player, float stat, float value) qt_setstat = #9001;
void(float phase, float endtime, float countdownend, float score1, float score2, float round) qt_matchstate = #9002;
void(entity player, string key, string value) qt_setinfo = #9003;   // userinfo (e.g. auto-team)
float(entity player) qt_isbot = #9004;
void(entity player, float item) qt_pickup = #9005;
```
Plus the standard FTE/DP string extensions the mod may use: `strlen #114, strcat #115,
substring #116, stov #117, strzone #118, strunzone #119, tokenize #441, argv #442,
cvar_string #448`. `infokey(world, key)` reads serverinfo; `infokey(player, key)`
reads userinfo (QW #80). `cvar(name)` reads the sim cvars, which are seeded from
serverinfo (deathmatch, teamplay, timelimit, fraglimit, samelevel, maxclients, …).

Deathtype ids: 0 world/other, 1 axe, 2 shotgun, 3 super shotgun, 4 nailgun, 5 super
nailgun, 6 grenade, 7 rocket, 8 lightning, 9 discharge, 10 telefrag, 11 squish,
12 lava, 13 slime, 14 water, 15 fall, 16 suicide (kill), 17 teamkill-other.

qt stat ids (ClientRow words 8..31): 0 kills, 1 deaths, 2 suicides, 3 teamkills,
4 damage given, 5 damage taken, 6 red armor, 7 yellow armor, 8 green armor,
9 mega health, 10 quad, 11 pent, 12 ring, 13 RL shots, 14 RL hits(direct),
15 LG shots (cells), 16 LG hits, 17 SG shots(pellets), 18 SG hits, 19 SSG shots,
20 SSG hits, 21 GL shots, 22 GL hits, 23 efficiency×100 (mod-computed).
Match phases: 0 warmup, 1 countdown, 2 playing, 3 overtime, 4 intermission,
5 round break (Clan Arena).

## The default mod: `mod/qtdm`

QuakeC ported from id's `qw-qc` (GPL-2.0-or-later), compiled to `qwprogs.dat`, shipped
as the `qtdm` pack. Modes selected by serverinfo `mode`:
- `ffa` — deathmatch 3 (weapons stay, items respawn), teamplay 0, fraglimit 30 /
  timelimit 15, no ready-up (a running server, join any time).
- `duel` — 1on1, deathmatch 3 (the competitive QW duel rule), teamplay 0,
  timelimit 10, ready-up + countdown, overtime 3 min on a tie (sudden death if
  serverinfo `overtime` = "sd").
- `2on2` — teamplay 2 (full team damage, as id's qw-qc and KTX), deathmatch 3,
  timelimit 10; `4on4` — teamplay 2, **deathmatch 1** (weapons are taken and respawn,
  the 4on4 rule), timelimit 20. Auto-team red/blue, ready-up + countdown.
- `ctf` — ThreeWave-style CTF, teamplay 1, flags at `item_flag_team1/2`, capture 15,
  flag return after 30 s, grappling hook off by default.
- `ca` — Clan Arena: rounds, everyone spawns with 100 health 200 RA, all weapons and
  ammo (no items on the map), no self damage, last team standing wins the round,
  first to 7 rounds (configurable), dead players spectate until the round ends.
Common: warmup with ready-up (`ready`/`break` commands; bots are always ready),
10 s countdown, match stats via `qt_setstat`, `qt_obituary`, `qt_matchstate`,
intermission 8 s, then `changelevel` to the next map in serverinfo `rotation`.
Bots count as players in every mode. In duel, bots only when serverinfo `bots` = "1".

## Maps and changelevel

All maps of a room's rotation are loaded (`map_load`) before the world starts.
`changelevel(name)` in QC sets a pending map; at the end of the tick the engine saves
each client's parms (`SetChangeParms`), rebuilds the world on that map (edicts freed,
strings reset except zoned ones it must keep, time 1.0), respawns clients
(`SetNewParms`/parms, `ClientConnect`, `PutClientInServer`) and emits event 13. A
name that is not loaded restarts the current map. Every client does this at the same
tick because it is a pure function of the state.

Map formats: BSP29 and BSP2 (`BSP2` magic; 2PSB is refused). `.lit` coloured light
files are loaded by the renderer only.

## Content packs

- A **pack** is a `.pk3` (zip; stored or deflate) or `.pak` file. Its id is the
  **sha256 of its bytes** (hex); short id = first 12 hex chars. Packs are immutable;
  every file in them is addressed by its Quake path (`maps/qt_aero.bsp`,
  `progs/player.mdl`, `qwprogs.dat`, `sound/weapons/r_exp3.wav`, `gfx/conchars.lmp`).
- The VFS (`src/content/`) mounts packs in order; later packs override earlier ones;
  the player's own id paks (if loaded) mount between `base` and the room's packs for
  art only — **the sim never reads from an id pak** (progs and BSP collision come from
  the room's packs, so a player with id paks stays in lockstep).
- Built-in packs, built by `npm run build:content` / `build:mod` into
  `public/packs/` with `public/packs/index.json`
  (`[{ id, name, kind: 'base'|'maps'|'mod', bytes, files: [...], maps?: [{name,title,author,modes,players}] }]`):
  `base` (LibreQuake models/sounds/gfx subset needed by qtdm + HUD), `maps-qt`
  (our original maps), `maps-lq` (LibreQuake lqdm1–13), `qtdm` (the mod).
- **Community packs** are referenced by `sha256` plus a source URL (any HTTPS URL
  that serves the bytes with CORS). The joining client downloads, verifies the
  sha256 before anything is mounted, caches in IndexedDB by sha256, and refuses a
  mismatch. Resolver order: built-in index → IndexedDB cache → room-given URL. (ARRR
  Storage — blobs addressed by sha256 — is the natural resolver once it is deployed;
  add it to the list then.) A host can also load a local pack file; it is cached by
  sha256 and the room carries no URL, so only players who have it can join — the
  join screen says so.
- **Sandbox:** packs are data. The only code in a pack is QuakeC bytecode, which runs
  inside the deterministic VM in the sim wasm: no imports, no network, no DOM, an
  instruction budget per call, an edict cap (1024 edicts as QW + 1024 extra, refuse
  more), string memory cap (4 MB). Limits: a pack ≤ 64 MB, all room packs together
  ≤ 128 MB, a BSP ≤ 32 MB, a progs ≤ 4 MB, zip entries ≤ 4096, no paths with `..`
  or absolute paths. Text files (cfg) from packs are never executed by the client
  console automatically.

## Room config, server list and hosting

- The app on arrr-network is `quake-town`; rooms are listed per app by central
  (`listRooms(APP_ID)`), which knows only the room id and client count. So **the room
  id carries the config** (≤ 240 chars; nodes refuse > 256):
  `qt1.<b64url(config)>-quaketown` where config is a compact, versioned encoding
  (owner: shell) of: display name, region, mode, timelimit, fraglimit, maxclients,
  bots on/off, rotation (map names), mod pack ref, extra pack refs (short id +
  optional URL), password check (8 hex of sha256(salt + password), or none),
  standing-server flag. Undecodable ids are not listed.
- Every client derives the world from the decoded config deterministically: config →
  serverinfo infostring (`\mode\duel\timelimit\10\fraglimit\0\maxclients\2\bots\0
  \rotation\qt_aero qt_tower\hostname\…`; always include timelimit and fraglimit;
  the mod derives deathmatch/teamplay from `mode`; every key the mod reads is listed in
  `mod/qtdm/README.md`) → `world_new`.
- The **server list**: name, mode, map (first of rotation; the live map is not
  knowable without joining), players/max (humans from client count; bots shown as
  "+N bots" estimate = max − humans when bots are on), ping (RTT to the room's
  authority node: the shell pings the node it would connect to; best effort), mod
  (pack name or short id). Filters (mode, region, hide full, hide empty, has
  password), favourites (localStorage), sort by any column.
- **Standing servers**: per region (as in vibe-strike/doom `regions.ts`) and per mode
  (ffa, duel, 2on2, 4on4, ctf, ca), public, bots on (except duel), the official map
  rotation per mode. Listed even when empty (joining creates the room).
- **Hosting** = the menu's Host screen: name, mode, maps (rotation), mod, packs,
  timelimit, fraglimit, max players, bots, password. It just builds a room id and
  joins it; the first client to join creates the room. Password is checked client-
  side only (lockstep has no gatekeeper): it keeps honest people out of private rooms
  and the UI says that.

## Membership, slots, bots, spectators

- Every arrr-network member is a **spectator** until it sends `{ j: 1 }` (join game)
  in the stream; the sim then gives it `world_free_slot` (a bot's or an empty slot)
  and calls `world_client_join`. `{ j: 0 }` (spectate) or a leave gives the slot back
  (`world_client_leave`). A disconnect without leave → `world_client_idle`. If no slot
  is free the member stays a spectator (the HUD says "server full, spectating").
- Spectators are client-only: free-fly or follow any player (chase / first person),
  drawn from the confirmed world. They cost the sim nothing.
- The TS state holds `slots: string[]` (slot → member id or '') — part of the hash.
- Bots are named from a fixed list per slot; their userinfo has `*bot\1`.

## Inputs on the wire (ordered stream)

- Gameplay: `{ c: [pitch16, yaw16, forward, side, up, buttons, impulse] }` every beat.
- Membership: `{ j: 1 }` / `{ j: 0 }`.
- Userinfo: `{ u: "\\name\\…\\team\\red\\topcolor\\4\\bottomcolor\\12\\skin\\…" }`.
- Mod console commands: `{ k: "ready" }` (whitelisted shape: ≤ 128 chars printable).
- Everything else is not gameplay and never reaches the sim: chat `{ say: text, team?: 1 }`,
  ping reports `{ ping: ms }`, cosmetic profile `{ look: {...} }` (model/skin/colors
  that only affect drawing). The sim ignores any payload without `c`/`j`/`u`/`k`.

## Client side (shell)

- `src/sim/qtsim.ts` loads the wasm (fetch started while the menu is up), wraps the
  ABI, implements `lockstep.Sim` like doom's `doomsim.ts`: state `{ h, slots, names }`,
  `serialize` = `{ w: base64(world bytes), slots }` lazily (clone fast path),
  `hash` mixes `world_hash` with the slot table, `dispose` frees, `fingerprint` = the
  local player's origin quantised to 1/8 unit + health. `version` = sim_version + pack ids.
- Rendering follows `arrr-mono/harness/INTEGRATION.md`: everything drawn comes off
  `lockstep.view(now)`; others from a ring of confirmed EntViews at the playout time,
  the local player (camera, viewmodel) from the predicted ring at `selfAlpha`; never
  extrapolate characters; projectiles extrapolate along velocity. Own projectiles may
  be drawn from the predicted world (zero-latency rockets) — they carry the owner.
  Prove it with the arena judge.
- Classic conveniences: console (`~`) with cvars, binds, `exec` of configs stored in
  browser storage, aliases, `name`/`team`/`color` commands, QW-style cvar names
  (`sensitivity`, `m_pitch`, `fov`, `viewsize`, `crosshair`, `cl_bob`, `gl_flashblend`,
  `r_drawflat`, `r_fullbrightskins`, `cl_rollangle`, `volume`, …); team say
  (`messagemode2`); scoreboard (Tab) with ping, frags, efficiency, team totals; match
  stats screen at intermission (frags/deaths/accuracy per weapon, item pickups);
  countdown/ready-up HUD; spectator mode; demos (record = initial world snapshot +
  every confirmed tick's ordered inputs; playback steps the sim; `.qtd` files saved
  locally, play speed / seek).
- Customization: player model, skin, top/bottom colors (QW palette rows), crosshair
  (shape/size/colour), HUD layout (classic QW sbar / modern minimal), with a 3D preview
  of the character in the menu. Persisted to the ARRR account when signed in
  (identity), localStorage otherwise.
- Load: wasm + base pack prefetched while the menu shows; report sizes in KB in the
  export README.

## Rendering (renderer)

`src/render/` owns everything drawn in 3D and exposes:

```ts
class Renderer {
  constructor(canvas: HTMLCanvasElement, vfs: Vfs, settings: RenderSettings)
  loadMap(name: string): Promise<void>          // BSP from the VFS, .lit if present
  draw(frame: RenderFrame): void                 // one call per rAF
  setSettings(s: Partial<RenderSettings>): void
  resize(w: number, h: number, dpr: number): void
  stats(): { drawCalls: number; tris: number; ms: number }
}
renderCharacterPreview(canvas, vfs, look: PlayerLook, t: number)   // menu 3D preview
```

`RenderFrame` (defined in `src/render/types.ts`, owned by the renderer; the shell
fills it): sim `time` (seconds, fractional, the playout clock), `camera` (origin,
angles in degrees Quake convention, fov, view blend rgba, underwater contents),
`viewmodel` (model name, frame, previous frame + lerp, effects, bob offsets), `entities`
(key `${num}:${serial}`, model name, frame, previous frame + frame lerp, skin,
colors {top,bottom} or null, effects, origin, angles, alpha, isLocalPlayer),
`lightstyles` (64 strings), `events` (TE / muzzleflash / explosion effects of ticks
newly passed), `dlights` derived by the renderer from effects.

Quake coordinates: z up, units = inches-ish; the renderer converts once.

Look: BSP world with Quake lightmaps (+ .lit colour, + lightstyle animation),
modern lighting: dynamic lights (rockets, muzzle flashes, explosions, quad/pent
glows), bloom, ACES tone mapping, optional SSAO, warped water/lava/slime/teleport
surfaces, scrolling two-layer sky, MDL models with frame-interpolated vertex
animation, particles (rocket trails, blood, explosions, teleport). Classic options:
`gl_flashblend`, `r_drawflat`, `r_fullbrightskins`, `gl_picmip`/texture filtering
nearest, `r_dynamic 0`, fov / viewsize / crosshair. Performance: PVS culling per
leaf, faces batched per texture × lightmap atlas page (one draw per texture), models
instanced, target 60+ fps on an average laptop and smooth at 144 Hz (no allocation
per frame).

## Accepted amendments (part of the contract)

- `docs/proposals/engine.md` §1–§5: `world_stopped`, `world_ambients`, static entities in
  `world_view_ents` (`num = 0x10000 + i`), name lists start with the empty name, events
  produced between ticks arrive with the next tick, ClientView word 49 = sim time,
  punchangle words are 0 (kicks are event 7), event 2/10 word use, serverinfo keys the
  engine reads (`maxclients` default 8, `bots` absent = off, `botskill` 1..5), the
  deliberate QW deviations, and the fixangle rule for the shell. An idle member who
  rejoins (state 3) keeps body, frags and stats.
- pmove numbers pinned in `sim/qtsim/tests/pmove.rs`: ground 320, apex 43.81, bunny hop
  320 → 712.3 over 10 optimal hops, circle-jump takeoff 456.1, strafe jump crosses a
  254.9-unit gap a straight jump cannot, rocket jump 261.7 units.
- `mod/qtdm/README.md` lists every serverinfo key the mod reads; the shell always sends
  `timelimit` and `fraglimit`. qt_pickup weapon ids are 20 + weapon impulse.
- `public/packs/index.json` entries also carry `file` and `title`; `players` is
  `[min, max]` (`docs/proposals/content.md`).
- Earlier measurements at a 77 Hz network rate (one 13 ms step per frame): the dev node
  delivered 72–76 Hz of 77 on this box. Superseded: the network runs at 20 Hz and each
  frame runs several 13 ms QW steps (see "Tick rate and time").

## Process

Parts run in parallel, each owning its directories. Each part reports: what works,
what does not, numbers (sizes in KB, tick cost in µs, fps, draw calls), and the
screenshots it looked at. The integrator wires the parts, runs the multiplayer test
on the local cluster (`cd ../arrr-mono && node e2e/cluster.js`) with two or more
headless Chromium pages, and commits.
