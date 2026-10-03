# Proposals from the engine part (sim/qtsim, tools/sim)

Everything below is implemented as described; DESIGN.md should be updated to match.

## 1. ABI additions and precisions

- `world_stopped(h) -> u32` (extension): 1 if the world stopped on a fatal QuakeC error
  (QW SV_Error: NULL function, runaway, `error()`, bad entity …); the text is then in
  `last_error_ptr()`. A stopped world ignores `world_tick` (events stay empty) and every
  membership call. Signature: `extern "C" fn world_stopped(h: u32) -> u32`.
- `world_ambients(h) -> ptr` (extension): `u32 count`, then count × 6 words
  `(sound index, volume 0..255, attenuation×64, x f32, y f32, z f32)` — the
  `ambientsound()` calls of the map (QW sends them in the signon as
  svc_spawnstaticsound). Signature: `extern "C" fn world_ambients(h: u32) -> *const u32`.
- **Static entities** (`makestatic`, torches/flames on most lqdm maps) are freed edicts in
  QW and travel in the signon. They are appended to `world_view_ents` after the edicts,
  with `num = 0x10000 + i`, `serial 0`, `movetype|solid|flags 0`, velocity 0, owner 0,
  alpha 1.0. The renderer keys on `num` as for edicts.
- `world_view_ents` skips non-client edicts with `modelindex == 0` **or an empty `model`
  string** (QW sv_ents.c — items hide with `model = string_null`). Clients are listed
  while their slot is spawned, whatever their model.
- **Name lists**: index 0 of `world_model_names` / `world_sound_names` is the empty name,
  so the blob starts with a NUL; read names until an empty name *after the first*.
  `world_lightstyles` is exactly 64 NUL-terminated strings (empty ones included) plus a
  final NUL.
- `world_serialize` bytes are opaque; they end with the progs id (4 bytes), so
  `world_deserialize(ptr, len)` needs no progs argument. Maps are found by map id.
- **Events produced between ticks** (`world_client_join/leave`, `world_set_userinfo`,
  `world_client_command`, and the spawn of `world_new`) are delivered with the events of
  the **next** `world_tick` (they are part of that tick's `world_events`). Events are not
  part of the state: a world deserialized between a command and the next tick does not
  carry them.
- `ClientView` word 49 = sim time (f32, seconds; the QC `time`).
- `ClientView` words 13–15 (punchangle) are 0: QW has no server punchangle; the kick
  comes as event 7.
- Event 10 (intermission): `x,y,z` = origin, `e`/`f` = the f32 bits of the pitch / yaw
  the QC wrote (svc_intermission carries angles).
- Event 2 (temp entity): `b` = count for TE_GUNSHOT/TE_BLOOD, 1 otherwise; lightning
  (5/6/9): `c` = owner entnum, `xyz` = start, `e`,`f` = end x,y f32 bits, `d` = end z f32
  bits.
- Event 1 (sound): `b` = channel & 7 (QW's bit 8 "no PHS" is meaningless here).

## 2. Serverinfo keys the engine reads

- `maxclients` 2..32, default 8 when absent. Client edicts are 1..maxclients (QW always
  reserved 32; the QC sees the same layout for every maxclients ≤ 32 except the first
  non-client edict number).
- `bots`: bots fill empty slots iff the value is non-empty and not 0 (**absent = off**).
- `botskill` 1..5 (default 3), spread ±1 over the slots.
- Every serverinfo key also seeds the cvar of the same name; defaults for the QW cvars
  (`deathmatch 1, teamplay 0, timelimit 0, fraglimit 0, samelevel 0, sv_gravity 800,
  sv_maxspeed 320, sv_friction 4, sv_accelerate 10, sv_maxvelocity 2000, sv_aim 2, …`).
  `cvar_set` of `deathmatch/teamplay/timelimit/fraglimit/samelevel/maxclients/hostname`
  (or of an existing serverinfo key) updates the serverinfo, as QW's CVAR_SERVERINFO.
- `infokey(world, key)` reads the serverinfo only (QW: serverinfo then localinfo; there
  is no localinfo) — an absent key is "".

## 3. pmove numbers (DESIGN.md "pmove" text should say these)

Measured from the port, pinned in `sim/qtsim/tests/pmove.rs`:
- ground max speed 320.0000 (asserted), stop from 320 in 42 ticks;
- **jump apex at msec 13 is 43.81 units**, not 45.56: 45.56 = 270²/1600 is the
  continuous limit; QW integrates per frame (gravity applied before the move), so the
  apex is Σ(270 − 10.4k)·0.013 for k = 1..25 = 43.81. That is QW at 77 fps exactly
  (higher fps jumps higher). DESIGN's "jump apex 45 units" should read "43.8 at msec 13".
- bunny hop, optimal air strafe (wishdir ⟂ velocity: QW caps the air wish speed at 30
  while accelspeed is 41.6), 10 hops from a 320 run: takeoff speeds 320.0, 383.9, 438.6,
  487.2, 531.4, 572.2, 610.2, 646.1, 680.0, **712.3**;
- circle jump (ground strafing with the optimal lead angle acos(278.4/v) for 25 ticks
  from rest): takeoff **456.1** vs 320 straight;
- strafe jump: straight jump covers 212.2 units at 320, strafed 233.6 (lands at 383.9);
  a 254.9-unit gap is crossed strafing and not straight;
- rocket jump (id's qwprogs, RL fired at the floor one tick after the jump):
  **261.7 units** (tests/world.rs).

## 4. Deviations from QW (all deliberate, all deterministic)

- `SV_RunNewmis` restores the tick's frametime after moving the new missile 0.05 s (QW
  left host_frametime at 0.05 for the rest of the SV_Physics loop).
- SV_TouchLinks collects a node's triggers before calling them and re-checks each one
  before its call (QW iterated the live list and could crash when a touch removed the
  next trigger).
- A NULL `think`/`touch`/`blocked` with a due `nextthink` is skipped (QW: fatal
  "NULL function").
- `remove(world)` and `remove(client)` are ignored (logged); `precache_*` after spawn is
  accepted (the name lists are read per world); `PF_checkclient` only targets spawned
  slots; `MSG_INIT` writes are dropped (statics come from `makestatic`); entities with
  SOLID_BSP but a non-brush model clip as boxes instead of SV_Error.
- No PVS/PHS culling of events (DESIGN), no `msg` message level filtering of prints.
- On `changelevel` the VM is restarted (`vm.restart()`), SetChangeParms → spawn →
  ClientConnect + PutClientInServer for every occupied slot (bots too, with a fresh bot
  brain); the 2 settle frames run with frametime 0.1 as `SV_SpawnServer` wrote it.
- `qt_setinfo` does not call `UserInfo_Changed` (the QC that calls it knows);
  `world_set_userinfo` does.
- `stuffcmd(client, "disconnect\n")` is just a stufftext event (no forced drop in
  lockstep).

## 5. Lockstep note for the shell (fixangle)

QW sets the view angles on teleports with svc_setangle. Here `ClientView[34..37]` holds
them for the tick the sim set them; while `fixangle` is set the sim ignores the
command's angles for that player (QW). The shell must read it from the **predicted**
world right after stepping the local input and continue its local mouse angles from
there, so the following commands carry the new angles.

## 6. For qcvm (performance)

`world_hash` costs 45–51 µs (8 players) / ~80 µs (16) in wasm; the engine's part is
now ~5 µs (4-lane mixing, bots via `Bots::hash`). The rest is `Vm::hash_into`: about
2 ns per edict word (21 µs for 92 edicts, 47 µs for 247 edicts native) — the per-word
`is_float` lookup in `words_typed`. Since VM memory is NaN-canonical by construction
(setters and float ops canonicalise; loads copy bits), hashing raw words with the 4 lanes
(or canonicalising branchlessly with a precomputed per-word mask) would roughly halve it.

## 7. Build note

`cargo test --release` on this workspace hits cargo issue #6313 (qtsim is cdylib+rlib,
the release-bin and release-test builds overwrite each other's lib → "multiple versions
of qcvm" / panic-strategy errors). Run tests with the test profile (`cargo test -p
qtsim`, opt-level 2) — that is what the numbers in the report use.
