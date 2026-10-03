# qtdm — the Quake Town default mod

id's QuakeWorld QuakeC (`qw-qc`, GPL-2.0-or-later) with match modes on top. Gameplay
(weapons, damage, armor, item timings, knockback, rocket jumps) is id's, unchanged.
Build: `npm run build:mod` (see `tools/qc/README.md`); test: `tools/qc/test-modes.mjs`.

## Serverinfo keys the mod reads

| key | default | meaning |
|---|---|---|
| `mode` | `ffa` | `ffa`, `duel` (or `1on1`), `2on2`, `4on4`, `ctf`, `ca`; anything else is ffa |
| `timelimit` | per mode (below) | minutes; `0` = none. Ignored in `ca` |
| `fraglimit` | per mode (below) | `0` = none. Team frags in 2on2/4on4, a player's frags in ffa/duel; not used in ctf/ca |
| `overtime` | `3` | minutes of overtime on a tie at timelimit (duel, 2on2, 4on4, ctf); `sd` = sudden death (next frag/capture wins); `0` = none, the match ends a draw. At most 3 overtimes, then a draw |
| `capturelimit` | `0` | ctf: captures that end the match; `0` = none |
| `rounds` | `7` | ca: rounds a team needs to win the match |
| `roundtime` | `300` | ca: seconds per round, then the round is a draw; `0` = none |
| `rotation` | (none) | space-separated map names; after the intermission the next one after the current map (wraps; the first one when the current map is not listed). Empty: the same map again |
| `bots` | — | read by the engine, not the mod: bot-filled slots. Bots are always ready and count as players in every mode |
| `rj` | `1` | id's rocket-jump multiplier: extra self knockback `dir × damage × rj` when > 1 |
| `dq` / `dr` | `0` | id's: drop the quad / ring on death when non-zero |
| `qt_selftest` | (none) | `ctf` runs the scripted CTF checks of `selftest.qc` (tests only) |

`deathmatch` and `teamplay` are **not** read from serverinfo: the mode sets them (and the
cvars). Note: the engine's `infokey(world)` currently falls back to cvars, so a missing
`timelimit`/`fraglimit` reads as `0` (= no limit) — the shell should always send both.

## Modes

| mode | deathmatch | teamplay | timelimit | fraglimit | ready-up | notes |
|---|---|---|---|---|---|---|
| ffa | 3 | 0 | 15 | 30 | no | plays from map start, join any time |
| duel | 3 | 0 | 10 | 0 | yes | needs 2 players |
| 2on2 | 3 | 2 | 10 | 0 | yes | auto-team red/blue, full team damage |
| 4on4 | 1 | 2 | 20 | 0 | yes | auto-team, weapons taken and respawn |
| ctf | 3 | 1 | 20 | — | yes | ThreeWave rules, no team or self damage |
| ca | 3 | 1 | — | — | yes | rounds, full kit, no items, no self damage |

Ready-up modes: warmup until every human typed `ready` (and duel has 2 players / each
team has one), then a 10 s countdown (no firing, no damage), then everyone respawns with
a fresh kit, items reset, frags and stats reset. Intermission 8 s, then the rotation.

Console commands (`{ k: "…" }`): `ready`, `break` (unready; during a match a vote, more
than half the humans stop it), `team red|blue` (warmup only, may not unbalance), `team`
(show), `kill`.

Teams: red = team 1 (colours 4/4), blue = team 2 (13/13), written into userinfo `team`,
`topcolor`, `bottomcolor`. CTF carrier: `EF_FLAG1` = carries the red flag, `EF_FLAG2` =
the blue flag (draw `progs/flag.mdl` skin 0 / 1), items `IT_KEY1` / `IT_KEY2`.

## Events

**qt_matchstate** `(phase, endtime, countdownend, score1, score2, round)`, sent on every
phase and score change. Phases: 0 warmup, 1 countdown, 2 playing, 3 overtime,
4 intermission, 5 round break (ca). Times are sim seconds (`time`), 0 = none.

| mode | score1 / score2 |
|---|---|
| ffa | 0 / 0 (use the frags in ClientRow) |
| duel | frags of the two players, lower slot first |
| 2on2, 4on4 | red / blue team frags (sum, suicides and teamkills included) |
| ctf | red / blue captures |
| ca | red / blue rounds won |

`endtime`: end of the match (phase 2/3) or of the ca round. `countdownend`: start of the
match (phase 1), start of the next ca round (phase 5), the next map loads (phase 4).
`round`: ca round number (0 elsewhere).

**qt_pickup** `(player, item)`: 6 red armor, 7 yellow armor, 8 green armor, 9 mega
health, 10 quad, 11 pentagram, 12 ring; weapons `20 + weapon impulse`: 23 super shotgun,
24 nailgun, 25 super nailgun, 26 grenade launcher, 27 rocket launcher, 28 lightning gun.

**qt_obituary** `(victim, killer, deathtype, flags)`: deathtype ids as DESIGN.md; killer
world = environment, killer = victim = suicide; flags 1 teamkill, 2 telefrag.

**qt_setstat**: all 24 DESIGN.md stat ids, reset when a match starts and on connect.
Damage given counts hits on enemies only; efficiency = kills / (kills + deaths) × 100;
SG/SSG shots and hits are pellets; LG shots are cells, a hit is a cell that hurt an enemy;
RL hits are direct hits; a GL hit is a grenade that hurt an enemy.
