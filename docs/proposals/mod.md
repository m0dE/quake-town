# Proposals from the mod part (mod/qtdm, tools/qc)

## Contract clarifications (DESIGN.md text to add)

1. **qt_pickup item ids for weapons**: `20 + weapon impulse` — SSG 23, NG 24, SNG 25,
   GL 26, RL 27, LG 28 (impulse numbers as QW binds them).
2. **qt_matchstate scores**: 2on2/4on4 = team frag totals; CTF = captures; CA = rounds won;
   duel = frags of the two players (lower slot first); FFA = 0, 0.
   `countdownend` also carries: the time the next map loads (phase 4, intermission) and
   the start of the next round (phase 5, CA round break). `round` = CA round number.
3. **Mode is authoritative for deathmatch / teamplay** (DESIGN's mode rules). The example
   serverinfo in "Room config" (`\mode\duel\deathmatch\1…`) contradicts "duel =
   deathmatch 3"; the mod ignores serverinfo `deathmatch`/`teamplay` and sets the cvars
   itself. `timelimit` (minutes) and `fraglimit` from serverinfo override the mode's
   defaults when present.
4. **Extra serverinfo keys the mod reads**: `overtime` (minutes, `sd` = sudden death,
   `0` = none; default 3), `capturelimit` (CTF, default 0 = none), `rounds` (CA, default 7),
   `roundtime` (CA seconds, default 300, then the round is a draw), `rj` (id's rocket-jump
   multiplier), `dq`/`dr` (id's drop quad / ring), `rotation`.
5. **teamplay 2 semantics** (decided): full team damage, health and armor, as id's QW /
   KTX; a teamkill costs the killer a frag. DESIGN's "no team damage to health" text
   should be changed.
6. **teamplay 1 (CTF, CA)** is id's: no damage to teammates **or yourself** (knockback
   still applies, so rocket jumps are free).

## Engine (sim/qtsim) — bugs found running qtdm in qtrun (engine not edited)

A. **Events from `world_client_command` are lost.** `World::tick` starts with
   `sv.sink.clear()`, so prints/centerprints a mod emits while handling a console
   command (between ticks) never reach `world_events`. The command itself works.
   Repro (`P` = mod/qtdm/build/qwprogs.dat, `M` = quake-ref/full/id1/maps):
   `qtrun --progs $P --map $M/lqdm1.bsp --ticks 8 --info '\mode\duel\maxclients\2\bots\1'
   --human 1 --cmd 5:0:ready --cmd 6:0:bogus` → the countdown starts at tick 5, but
   "human0 is ready" and "Unknown command: bogus" are never printed. Fix: clear the
   sink after the events are handed out (or append command events to the next tick).
B. **`infokey(world, key)` falls back to cvars.** QW reads serverinfo (then localinfo),
   never cvars; the fallback returns the cvar default "0" for a missing `timelimit` /
   `fraglimit`, so the mod cannot tell "not set" from "0" and a room without those keys
   gets no limits instead of the mode's (ffa 15 min / 30 frags). Repro:
   `qtrun --progs $P --map $M/lqdm1.bsp --ticks 2 --info '\mode\ffa\maxclients\4\bots\1'`
   → `matchstate phase 2 … end 0.0` (expected `end 901.0`). Either drop the fallback or
   have the shell always put timelimit/fraglimit in the serverinfo (DESIGN's example does).
C. **Placeholder bots shoot teammates** (`bots.rs` picks the nearest visible player). In
   2on2/4on4 (teammate hits cost armor only) they lock onto each other and stop scoring
   after ~30 s, so team matches stall at a tie; bots should skip players whose userinfo
   `team` equals theirs when `teamplay` != 0 (qtbots, phase 2).

D. **Picked-up items stay in EntView.** id's items hide with `self.model = string_null`
   and keep their `modelindex`; QW's `SV_WriteEntitiesToClient` skips `!*model`.
   `views.rs` (`world_view_ents`) only skips `modelindex == 0`, so every taken
   armor/weapon/ammo box is still drawn. Repro: `qtrun … --ents` after a `pickup` event:
   the item is still listed at its spot. Fix: also skip edicts whose `model` string is
   empty (non-client edicts).

## Engine (sim/qtsim) — requests

1. On changelevel, reset the progs globals (QW reloads the progs; qcvm has
   `vm.restart()`). qtdm resets its own match globals in worldspawn anyway.
2. `qt_setinfo` may or may not call `UserInfo_Changed`; qtdm guards against re-entry.

## Shell / HUD

1. No ready-state per player is exported. A future qt stat (e.g. 24 = ready) would let
   the scoreboard show who is ready; for now the mod prints "X is ready".
2. In CA a dead player waits at his corpse (health <= 0, phase 2) until the round ends:
   a chase camera on a teammate would be nicer (client-side only).

## Renderer / content

1. A CTF carrier has `EF_FLAG1` (carrying the red flag) or `EF_FLAG2` (blue) — draw
   `progs/flag.mdl` (skin 0 red, 1 blue) on his back, as QW clients do.
2. The base pack now has `progs/flag.mdl`, so `build:mod` uses it (skin = team - 1).
   Without it the flags would be `progs/backpack.mdl` with an `EF_RED` / `EF_BLUE`
   glow. Build content before the mod (the choice changes the pack sha).
3. CTF works on maps without flags: the two deathmatch spawns farthest apart get the red
   and blue flags and become the teams' spawns. A real CTF map (item_flag_team1/2,
   info_player_team1/2) is still wanted for the CTF standing server.
