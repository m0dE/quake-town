# Proposals from the qcvm part (sim/qcvm, sim/qtbots)

## Mod (mod/qtdm)
1. **Set the QW `.team` field** on players (= `qteam`) and on CTF flags (= `flagteam`).
   The engine's `team_of` reads `.team` (falls back to a crc of userinfo `team`), so
   today flags have team 0 and qtbots must *learn* which flag is theirs. With `.team`
   set, bots know at once. (Also lets `teamplay` logic in id code keep working.)
2. CTF respawns after the first life seem to use deathmatch spawns on either half (a
   red bot respawned at x=1489 on qt_fort, blue side). If that is not intended, use
   `info_player_team1/2`.

## Engine (sim/qtsim)
1. `BotWorld::trace_world` loops over every edict per trace to find static SOLID_BSP
   brushes; graph build does ~100-250k traces per map. Collect the static brush
   entities once per call of `NavGraph::build` (or cache the list per map) to keep the
   build in the 30-80 ms range measured natively with world-only traces.
2. qcvm hash/serialize now use raw words (see sim/qcvm/API.md changes): hash values
   changed, bump `sim_version`. qtbots state bytes changed too.

## Content
- qt_fort: the flooded tunnels are now 3x more expensive and bots surface after 4 s;
  a short air pocket every ~600 units would make the route playable for humans too.
