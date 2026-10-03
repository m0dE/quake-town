# qtbots — public API (for the engine, `sim/qtsim`)

Status: **published**. Later changes are listed here first.

Changes:
- 2026-10-03: `trace` and `trace_world` take `&mut self` (the engine's SV_Move needs it);
  `NavGraph::build(&mut world)`. `ClientInfo.team` / `EntInfo.team` are the QC `.team`
  values (CTF: a flag whose `.team` equals the player's is his own flag).
  `EntInfo` gained `movedir`, `speed` (jump pads); `trace_world` includes static brush
  entities (func_wall); new link kind `Push` (trigger_push).

Mod-agnostic bots. A bot reads the world through the `BotWorld` trait (implemented by
the engine) and returns a QuakeWorld usercmd per tick, exactly what a human client
sends, so any mod works. No dependency on `qtsim` (or `qcvm`). Deterministic: no
`std::time`, no HashMap, floats via `libm`, randomness only from `BotWorld::random`
(the world PRNG).

```rust
use qtbots::{BotWorld, Bots, NavGraph, UserCmd, Trace, ClientInfo, EntInfo, Vec3};
```

## What the engine implements

```rust
pub type Vec3 = [f32; 3];

pub struct Trace {
    pub fraction: f32, pub endpos: Vec3, pub normal: Vec3,
    pub allsolid: bool, pub startsolid: bool,
    pub ent: i32,             // edict hit: -1 none, 0 world, n
}

pub struct ClientInfo {       // one player slot with a body
    pub entnum: u32,
    pub alive: bool,          // health > 0 && deadflag == 0 && solid != SOLID_NOT (spectating CA players: false)
    pub origin: Vec3, pub velocity: Vec3, pub v_angle: Vec3,   // degrees
    pub view_ofs_z: f32,      // 22 normally
    pub health: f32, pub armorvalue: f32, pub armortype: f32,
    pub items: u32,           // QC .items (QW IT_* bits)
    pub weapon: u32,          // QC .weapon (IT_* bit of the active weapon)
    pub ammo: [f32; 4],       // shells, nails, rockets, cells
    pub team: i32,            // 0 = no team; same non-zero value = same team (e.g. team string crc)
    pub onground: bool,       // FL_ONGROUND after the last pmove
    pub waterlevel: i32,
    pub frags: i32,
    pub effects: u32,
}

pub struct EntInfo<'a> {      // a live (non-free) edict
    pub num: u32,
    pub classname: &'a [u8], pub model: &'a [u8],
    pub target: &'a [u8], pub targetname: &'a [u8],
    pub origin: Vec3, pub mins: Vec3, pub maxs: Vec3,
    pub absmin: Vec3, pub absmax: Vec3, pub velocity: Vec3,
    pub solid: i32, pub movetype: i32, pub flags: u32, pub spawnflags: u32,
    pub modelindex: i32, pub effects: u32,
    pub health: f32, pub team: i32, pub owner: u32,
    pub movedir: Vec3, pub speed: f32,  // QC .movedir / .speed (trigger_push)
}

pub trait BotWorld {
    fn time(&self) -> f64;                       // world time, seconds
    fn maxclients(&self) -> u32;
    fn teamplay(&self) -> i32;                   // cvar teamplay (0 = everyone is an enemy)
    fn client(&self, slot: u32) -> Option<ClientInfo>;   // None: slot empty / no body
    fn num_edicts(&self) -> u32;
    fn entity(&self, e: u32) -> Option<EntInfo<'_>>;     // None: free edict
    /// SV_Move: box trace; the hull is chosen from mins/maxs like SV_HullForEntity
    /// (point → hull 0, player size → hull 1, bigger → hull 2). nomonsters = MOVE_NOMONSTERS.
    fn trace(&mut self, start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3, nomonsters: bool, passent: u32) -> Trace;
    /// Same but against the world BSP model plus static brush entities that never move
    /// (func_wall, func_episodegate, func_bossgate: SOLID_BSP and MOVETYPE_PUSH with no
    /// think) — no doors, plats, trains, buttons, players. Used to build the graph.
    fn trace_world(&mut self, start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3) -> Trace;
    fn point_contents(&self, p: Vec3) -> i32;    // CONTENTS_* of the world (-1 empty, -2 solid, -3 water, -4 slime, -5 lava)
    fn world_bounds(&self) -> (Vec3, Vec3);      // world model mins/maxs
    fn random(&mut self) -> u32;                 // the world PRNG (qcvm: vm.rng_u32())
}
```

## Navigation graph (once per map, shared)

```rust
let nav: Arc<NavGraph> = Arc::new(NavGraph::build(&mut world));   // after the map's entities spawned
nav.stats() -> NavStats { nodes, links, walk, jump, drop, teleport, plat, goals, build_traces }
```
Built from the BSP at map load: walkable samples with hull-1 traces (flood fill from
spawn points and items on a 32-unit grid), links by walk / step 18 / jump / drop /
teleporter / plat, and a distance field per item goal. Pure function of the map and
its spawned entities → identical on every client. Not serialized: rebuild it from the
map (cache it per map id; every world on that map shares the `Arc`).

## Bots (per world, part of the world state)

```rust
let mut bots = Bots::new(maxclients);
bots.add(slot, skill /* 1..=5 */);           // a bot takes over the slot (fresh brain)
bots.remove(slot);                           // human joined / slot emptied
bots.is_bot(slot) -> bool ; bots.skill(slot) -> u8

// every tick, before the clients run (DESIGN.md step 1):
bots.begin_tick();                           // resets the shared path-search budget
for slot in 0..maxclients { if bots.is_bot(slot) {
    let cmd: UserCmd = bots.think(&mut world, &nav, slot);
    // → world_set_cmd(slot, cmd.pitch16, cmd.yaw16, cmd.forward, cmd.side, cmd.up, cmd.buttons, cmd.impulse)
}}

bots.serialize(&mut out); Bots::deserialize(&bytes) -> Result<(Bots, usize), String>
bots.hash() -> u64        // mix into world_hash
bots.clone()              // cheap (no big buffers)
```

`UserCmd { pitch16: i32, yaw16: i32, forward: i32, side: i32, up: i32, buttons: u32, impulse: u32 }`
— pitch16/yaw16 are QW `ANGLE2SHORT` values (-32768..32767), forward/side/up in
-500..500 (400 typical), buttons bit0 attack, bit1 jump, impulse 0..255 (weapon
switches 1..8). `qtbots::angle2short(deg)` / `short2angle(s)` are provided.

A dead bot presses attack/jump to respawn like a player. Bots never read hidden
state: only what `BotWorld` exposes (positions of everyone, as QW bots did), filtered
through line-of-sight, FOV and hearing.

Budget: a bot think is < 30 µs native at 77 Hz (measured in tests, see report). Path
searches are A* with an expansion budget per bot per tick plus a shared budget per tick
(`begin_tick`), so a tick never spikes.

Skill 1..5: reaction 350 → 150 ms, aim error 8° → 1°, turn rate 220 → 900 °/s, FOV,
dodging, circle strafing (≥ 2), bunny hop / strafe jump on long straight paths (≥ 3),
item timing and weapon choice quality.
