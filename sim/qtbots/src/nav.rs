// Quake Town - qtbots: navigation graph built from the BSP with hull-1 traces
// Copyright (C) 2026 Quake Town contributors
// SPDX-License-Identifier: GPL-2.0-or-later

//! Walkable samples on a grid, flood-filled from spawn points and items with the same
//! step/slide rules as pmove (step 18), plus jump, drop, teleporter and plat links, and a
//! distance field per goal (item, weapon, spawn point, flag) for O(1) path following.
//! Everything is a pure function of the map + spawned entities (BTreeMap/Vec only).

use crate::math::*;
use crate::{contents, it, BotWorld, Vec3, PLAYER_MAXS, PLAYER_MINS};
use std::cmp::Reverse;
use std::collections::{BTreeMap, BinaryHeap, VecDeque};

/// Grid spacing of walkable samples.
pub const GRID: f32 = 32.0;
const STEP: f32 = 18.0;
const SUBSTEP: f32 = 16.0;
const DROP_MAX: f32 = 600.0;
const MAX_NODES: usize = 24000;
/// Distance field quantum (units per field step).
pub const FIELD_Q: f32 = 2.0;
pub const FIELD_INF: u16 = u16::MAX;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u8)]
pub enum LinkKind {
    Walk = 0,
    Jump = 1,
    Drop = 2,
    Teleport = 3,
    Plat = 4,
    /// trigger_push (jump pad / wind tunnel)
    Push = 5,
}

#[derive(Clone, Copy, Debug)]
pub struct Node {
    /// Player origin standing here.
    pub pos: Vec3,
    pub first_link: u32,
    pub num_links: u32,
    /// NODE_* flags.
    pub flags: u32,
}

pub const NODE_WATER: u32 = 1;
pub const NODE_EDGE: u32 = 2;
/// Next to a fall with no floor (void) or into a death volume.
pub const NODE_VOID: u32 = 4;
/// Head under water (drowning risk on long stretches).
pub const NODE_DEEP: u32 = 8;

#[derive(Clone, Copy, Debug)]
pub struct Link {
    pub from: u32,
    pub to: u32,
    pub kind: LinkKind,
    pub cost: f32,
    /// Teleport: trigger center; Plat: plat center (top surface z when lowered); Jump: takeoff point.
    pub via: Vec3,
}

/// What a goal is.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum GoalKind {
    Weapon(u32),
    /// armor type 1 green, 2 yellow, 3 red
    Armor(u8),
    Health { amount: u16, mega: bool },
    /// 0 shells, 1 nails, 2 rockets, 3 cells; big box
    Ammo(u8, bool),
    Powerup(u32),
    Flag(u8),
    Spawn,
}

#[derive(Clone, Copy, Debug)]
pub struct Goal {
    pub ent: u32,
    pub kind: GoalKind,
    pub node: u32,
    pub pos: Vec3,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NavStats {
    pub nodes: u32,
    pub links: u32,
    pub walk: u32,
    pub jump: u32,
    pub drop: u32,
    pub teleport: u32,
    pub plat: u32,
    pub push: u32,
    pub goals: u32,
    pub build_traces: u32,
}

/// The navigation graph of one map. Immutable after `build`; share it with `Arc`.
pub struct NavGraph {
    pub nodes: Vec<Node>,
    pub links: Vec<Link>,
    /// Incoming link indices grouped by target node (CSR).
    rev_first: Vec<u32>,
    rev: Vec<u32>,
    grid_org: [f32; 2],
    grid_dim: [u32; 2],
    cell_first: Vec<u32>,
    cell_nodes: Vec<u32>,
    pub goals: Vec<Goal>,
    /// goals.len() × nodes.len() distances (FIELD_Q units), FIELD_INF unreachable.
    fields: Vec<u16>,
    /// Goal indices used as ALT landmarks for A* (spread over the map).
    landmarks: Vec<usize>,
    stats: NavStats,
}

const CELL: f32 = 64.0;

struct Builder<'a, W: BotWorld> {
    w: &'a mut W,
    traces: u32,
    nodes: Vec<Vec3>,
    flags: Vec<u32>,
    columns: BTreeMap<(i32, i32), Vec<u32>>,
    links: Vec<Link>,
    linked: BTreeMap<(u32, u32), ()>,
    queue: VecDeque<u32>,
    /// trigger_hurt boxes (grown): no node inside, falls into them are void
    hurts: Vec<(Vec3, Vec3)>,
    void_hit: bool,
}

fn kind_cost(kind: LinkKind, d: f32) -> f32 {
    match kind {
        LinkKind::Walk => d,
        LinkKind::Jump => d * 1.3 + 16.0,
        LinkKind::Drop => d * 1.1 + 8.0,
        LinkKind::Teleport => 32.0,
        LinkKind::Plat => d + 160.0,
        LinkKind::Push => d * 0.5 + 32.0,
    }
}

enum Step {
    Walk(Vec3),
    Drop(Vec3),
    Blocked,
    Fail,
}

impl<'a, W: BotWorld> Builder<'a, W> {
    fn tr(&mut self, a: Vec3, b: Vec3) -> crate::Trace {
        self.traces += 1;
        self.w.trace_world(a, PLAYER_MINS, PLAYER_MAXS, b)
    }

    fn bad_contents(&self, p: Vec3) -> (bool, bool) {
        let feet = self.w.point_contents([p[0], p[1], p[2] - 23.0]);
        let waist = self.w.point_contents([p[0], p[1], p[2] + 4.0]);
        let hurt = self.hurts.iter().any(|(mn, mx)| (0..3).all(|k| p[k] + PLAYER_MAXS[k] > mn[k] && p[k] + PLAYER_MINS[k] < mx[k]));
        let bad = hurt || feet == contents::LAVA || feet == contents::SLIME || feet == contents::SKY;
        let water = waist <= contents::WATER && waist >= contents::LAVA;
        (bad, water)
    }

    /// Floor below (x, y, z) within `down` units, if walkable.
    fn floor(&mut self, x: f32, y: f32, z: f32, down: f32) -> Option<Vec3> {
        let t = self.tr([x, y, z], [x, y, z - down]);
        if t.startsolid || t.allsolid || t.fraction >= 1.0 || t.normal[2] < 0.7 {
            return None;
        }
        Some(t.endpos)
    }

    fn col(x: f32, y: f32) -> (i32, i32) {
        (libm::roundf(x / GRID) as i32, libm::roundf(y / GRID) as i32)
    }

    /// Node at a standing position (dedup per column within 20 units of height).
    fn node_at(&mut self, p: Vec3) -> Option<u32> {
        let c = Self::col(p[0], p[1]);
        if let Some(list) = self.columns.get(&c) {
            for &n in list {
                if (self.nodes[n as usize][2] - p[2]).abs() < 20.0 {
                    return Some(n);
                }
            }
        }
        if self.nodes.len() >= MAX_NODES {
            return None;
        }
        let (bad, water) = self.bad_contents(p);
        if bad {
            return None;
        }
        let n = self.nodes.len() as u32;
        let head = self.w.point_contents([p[0], p[1], p[2] + 22.0]);
        let deep = head <= contents::WATER && head >= contents::LAVA;
        self.nodes.push(p);
        self.flags.push(if water { NODE_WATER } else { 0 } | if deep { NODE_DEEP } else { 0 });
        self.columns.entry(c).or_default().push(n);
        self.queue.push_back(n);
        Some(n)
    }

    /// Seed a node near an arbitrary point (entity origin).
    fn seed(&mut self, p: Vec3) -> Option<u32> {
        let (cx, cy) = Self::col(p[0], p[1]);
        let cands = [
            (cx as f32 * GRID, cy as f32 * GRID),
            (p[0], p[1]),
            ((cx + 1) as f32 * GRID, cy as f32 * GRID),
            ((cx - 1) as f32 * GRID, cy as f32 * GRID),
            (cx as f32 * GRID, (cy + 1) as f32 * GRID),
            (cx as f32 * GRID, (cy - 1) as f32 * GRID),
        ];
        for (x, y) in cands {
            for up in [24.0, 40.0, 8.0] {
                if let Some(f) = self.floor(x, y, p[2] + up, 160.0) {
                    let f = [x, y, f[2]];
                    if let Some(n) = self.node_at(f) {
                        return Some(n);
                    }
                }
            }
        }
        None
    }

    fn add_link(&mut self, from: u32, to: u32, kind: LinkKind, via: Vec3) {
        if from == to || self.linked.contains_key(&(from, to)) {
            return;
        }
        self.linked.insert((from, to), ());
        let d = dist(self.nodes[from as usize], self.nodes[to as usize]);
        self.links.push(Link { from, to, kind, cost: kind_cost(kind, d), via });
    }

    /// pmove-like walk from p to column (tx, ty): substeps of <= 16 with step-up 18.
    fn walk(&mut self, p: Vec3, tx: f32, ty: f32) -> Step {
        let total = dist2d(p, [tx, ty, 0.0]);
        let n = libm::ceilf(total / SUBSTEP).max(1.0) as i32;
        let mut pos = p;
        for i in 1..=n {
            let f = i as f32 / n as f32;
            let x = p[0] + (tx - p[0]) * f;
            let y = p[1] + (ty - p[1]) * f;
            let up = self.tr(pos, [pos[0], pos[1], pos[2] + STEP]);
            if up.startsolid || up.allsolid {
                return Step::Fail;
            }
            let u = up.endpos;
            let fw = self.tr(u, [x, y, u[2]]);
            if fw.fraction < 1.0 {
                // steep stairs (e.g. 12 high, 8 deep): pmove climbs them a few units per
                // frame; retry this substep in 4-unit micro steps
                match self.micro_steps(pos, x, y) {
                    Some(q) => {
                        pos = q;
                        continue;
                    }
                    None => return Step::Blocked,
                }
            }
            let fe = fw.endpos;
            let dn = self.tr(fe, [fe[0], fe[1], fe[2] - (STEP + SUBSTEP + 4.0)]);
            if dn.fraction < 1.0 {
                if dn.normal[2] < 0.7 {
                    return Step::Blocked;
                }
                pos = dn.endpos;
                continue;
            }
            // edge: fall
            let fall = self.tr(dn.endpos, [fe[0], fe[1], fe[2] - DROP_MAX]);
            if fall.fraction >= 1.0 || fall.normal[2] < 0.7 || fall.startsolid {
                if fall.fraction >= 1.0 {
                    self.void_hit = true;
                }
                return Step::Fail;
            }
            // land in the target column (not into a death volume)
            let lz = fall.endpos[2];
            let (bad, _) = self.bad_contents(fall.endpos);
            if bad {
                self.void_hit = true;
                return Step::Fail;
            }
            return match self.floor(tx, ty, lz + STEP, STEP + 48.0) {
                Some(l) => Step::Drop([tx, ty, l[2]]),
                None => Step::Fail,
            };
        }
        Step::Walk([tx, ty, pos[2]])
    }

    /// Walk from `pos` to (x, y) in 4-unit steps with step-up 18; the landing position.
    fn micro_steps(&mut self, pos: Vec3, x: f32, y: f32) -> Option<Vec3> {
        let total = dist2d(pos, [x, y, 0.0]);
        let n = libm::ceilf(total / 4.0).max(1.0) as i32;
        let mut q = pos;
        for i in 1..=n {
            let f = i as f32 / n as f32;
            let (mx, my) = (pos[0] + (x - pos[0]) * f, pos[1] + (y - pos[1]) * f);
            let up = self.tr(q, [q[0], q[1], q[2] + STEP]);
            if up.startsolid {
                return None;
            }
            let u = up.endpos;
            let fw = self.tr(u, [mx, my, u[2]]);
            if fw.fraction < 1.0 {
                return None;
            }
            let dn = self.tr(fw.endpos, [mx, my, u[2] - STEP - 8.0]);
            if dn.fraction >= 1.0 || dn.normal[2] < 0.7 {
                return None;
            }
            q = dn.endpos;
        }
        Some(q)
    }

    /// Walking from `p` straight towards `center` (at p's height) touches the box mn..mx.
    fn reaches_box(&mut self, p: Vec3, center: Vec3, mn: &Vec3, mx: &Vec3) -> bool {
        let touch = |q: Vec3| (0..3).all(|k| q[k] + PLAYER_MAXS[k] + 1.0 >= mn[k] && q[k] + PLAYER_MINS[k] - 1.0 <= mx[k]);
        if touch(p) {
            return true;
        }
        let t = self.tr(p, [center[0], center[1], p[2]]);
        touch(t.endpos)
    }

    /// A jump pad: velocity `v` is applied every frame while the box touches the trigger;
    /// in the air the player may steer (QW air control: up to 30 u/s along the wish
    /// direction). Tries no steering and 8 steering directions, keeps the landing that
    /// gains the most height, then distance. Returns the landing node.
    fn push_sim(&mut self, starts: &[Vec3], mn: Vec3, mx: Vec3, v: Vec3) -> Option<u32> {
        let mut best: Option<(f32, Vec3)> = None;
        for &start in starts.iter().take(3) {
            for k in 0..9 {
                let steer = if k == 0 { None } else { Some(yaw_dir((k - 1) as f32 * 45.0)) };
                let Some(pos) = self.push_fly(start, mn, mx, v, steer) else { continue };
                let gain = pos[2] - start[2];
                let d = dist2d(pos, start);
                if d < 48.0 && gain < STEP {
                    continue;
                }
                let score = gain * 2.0 + d;
                if best.map_or(true, |(bs, _)| score > bs) {
                    best = Some((score, pos));
                }
            }
            if best.is_some() {
                break;
            }
        }
        let (_, pos) = best?;
        let (cx, cy) = Self::col(pos[0], pos[1]);
        for (x, y) in [(cx as f32 * GRID, cy as f32 * GRID), (pos[0], pos[1])] {
            if let Some(l) = self.floor(x, y, pos[2] + STEP, STEP + 40.0) {
                if let Some(n) = self.node_at([x, y, l[2]]) {
                    return Some(n);
                }
            }
        }
        None
    }

    fn push_fly(&mut self, start: Vec3, mn: Vec3, mx: Vec3, v: Vec3, steer: Option<Vec3>) -> Option<Vec3> {
        let mut pos = start;
        let mut vel = v;
        let dt = 1.0 / 40.0;
        let mut left = false;
        for _ in 0..200 {
            let inside = (0..3).all(|k| pos[k] + PLAYER_MAXS[k] >= mn[k] && pos[k] + PLAYER_MINS[k] <= mx[k]);
            if inside {
                vel = v;
            } else {
                left = true;
                if let Some(d) = steer {
                    let along = dot(vel, d);
                    if along < 30.0 {
                        vel = ma(vel, (30.0 - along).min(10.0 * 320.0 * dt), d);
                    }
                }
            }
            let mut time_left = dt;
            for _ in 0..4 {
                let t = self.tr(pos, ma(pos, time_left, vel));
                if t.startsolid || t.allsolid {
                    return None;
                }
                pos = t.endpos;
                if t.fraction >= 1.0 {
                    break;
                }
                if t.normal[2] >= 0.7 && vel[2] <= 0.0 && left {
                    return Some(pos);
                }
                let back = dot(vel, t.normal);
                vel = sub(vel, scale(t.normal, back));
                time_left *= 1.0 - t.fraction;
            }
            vel[2] -= 800.0 * dt;
            if pos[2] < start[2] - DROP_MAX {
                return None;
            }
        }
        None
    }

    /// Simulated running jump from p along unit direction d. Returns the landing node.
    fn jump(&mut self, from: u32, d: Vec3) -> Option<(u32, Vec3)> {
        let p = self.nodes[from as usize];
        let mut pos = p;
        let mut vel = [d[0] * 280.0, d[1] * 280.0, 270.0];
        let dt = 1.0 / 30.0;
        let mut landed = false;
        for _ in 0..40 {
            // one FlyMove-like step: up to 4 bumps, sliding along what we hit
            let mut time_left = dt;
            for _ in 0..4 {
                let end = ma(pos, time_left, vel);
                let t = self.tr(pos, end);
                if t.startsolid || t.allsolid {
                    return None;
                }
                pos = t.endpos;
                if t.fraction >= 1.0 {
                    break;
                }
                if t.normal[2] >= 0.7 && vel[2] <= 0.0 {
                    landed = true;
                    break;
                }
                let back = dot(vel, t.normal);
                vel = sub(vel, scale(t.normal, back));
                time_left *= 1.0 - t.fraction;
            }
            if landed {
                break;
            }
            // air control: holding forward keeps ~30 u/s along the jump direction (pmove
            // PM_AirAccelerate caps wishspeed at 30), which is how one climbs a ledge
            let along = dot(vel, d);
            if along < 30.0 {
                vel = ma(vel, 30.0 - along, d);
            }
            vel[2] -= 800.0 * dt;
            if pos[2] < p[2] - DROP_MAX {
                return None;
            }
        }
        let ground = self.tr(pos, [pos[0], pos[1], pos[2] - 2.0]);
        if ground.fraction >= 1.0 || ground.normal[2] < 0.7 {
            return None;
        }
        let along = dot(sub(pos, p), d);
        let climbed = pos[2] > p[2] + STEP;
        if along < if climbed { 4.0 } else { GRID * 0.9 } {
            return None;
        }
        let (cx, cy) = Self::col(pos[0], pos[1]);
        let (x, y) = (cx as f32 * GRID, cy as f32 * GRID);
        let l = self.floor(x, y, pos[2] + STEP, STEP + 40.0)?;
        // the column center must be reachable from the landing point
        let t = self.tr([pos[0], pos[1], pos[2] + 1.0], [x, y, pos[2] + 1.0]);
        if t.fraction < 1.0 && (l[2] - pos[2]).abs() < 18.0 {
            return None;
        }
        let n = self.node_at([x, y, l[2]])?;
        Some((n, p))
    }

    fn expand(&mut self, n: u32) {
        self.void_hit = false;
        let p = self.nodes[n as usize];
        let (cx, cy) = Self::col(p[0], p[1]);
        let mut edge = false;
        const DIRS: [(i32, i32); 8] = [(1, 0), (0, 1), (-1, 0), (0, -1), (1, 1), (-1, 1), (-1, -1), (1, -1)];
        for (dx, dy) in DIRS {
            let (tx, ty) = ((cx + dx) as f32 * GRID, (cy + dy) as f32 * GRID);
            match self.walk(p, tx, ty) {
                Step::Walk(q) => {
                    if let Some(m) = self.node_at(q) {
                        self.add_link(n, m, LinkKind::Walk, p);
                        // walking is symmetric when the height difference is a few steps
                        if (q[2] - p[2]).abs() <= STEP * 2.0 + 0.5 {
                            self.add_link(m, n, LinkKind::Walk, q);
                        }
                    }
                }
                Step::Drop(q) => {
                    edge = true;
                    if let Some(m) = self.node_at(q) {
                        let kind = if q[2] < p[2] - 64.0 { LinkKind::Drop } else { LinkKind::Walk };
                        self.add_link(n, m, kind, p);
                    }
                    if dx != 0 && dy != 0 {
                        continue;
                    }
                    let d = norm([dx as f32, dy as f32, 0.0]);
                    if let Some((m, via)) = self.jump(n, d) {
                        if !self.linked.contains_key(&(n, m)) {
                            self.add_link(n, m, LinkKind::Jump, via);
                        }
                    }
                }
                Step::Blocked | Step::Fail => {
                    edge = true;
                    // jump across gaps / onto ledges up to ~45 units (cardinal directions)
                    if dx != 0 && dy != 0 {
                        continue;
                    }
                    let d = norm([dx as f32, dy as f32, 0.0]);
                    let ledge = self.tr(p, [p[0], p[1], p[2] + 46.0]);
                    let lz = ledge.endpos[2];
                    let over = self.tr([p[0], p[1], lz], [tx, ty, lz]);
                    if over.fraction < 1.0 {
                        continue; // a wall: no jump
                    }
                    if let Some((m, via)) = self.jump(n, d) {
                        self.add_link(n, m, LinkKind::Jump, via);
                    }
                }
            }
        }
        if edge {
            self.flags[n as usize] |= NODE_EDGE;
        }
        if self.void_hit {
            self.flags[n as usize] |= NODE_VOID;
            self.void_hit = false;
        }
    }
}

fn classify(classname: &[u8], spawnflags: u32) -> Option<GoalKind> {
    Some(match classname {
        b"weapon_supershotgun" => GoalKind::Weapon(it::SUPER_SHOTGUN),
        b"weapon_nailgun" => GoalKind::Weapon(it::NAILGUN),
        b"weapon_supernailgun" => GoalKind::Weapon(it::SUPER_NAILGUN),
        b"weapon_grenadelauncher" => GoalKind::Weapon(it::GRENADE_LAUNCHER),
        b"weapon_rocketlauncher" => GoalKind::Weapon(it::ROCKET_LAUNCHER),
        b"weapon_lightning" => GoalKind::Weapon(it::LIGHTNING),
        b"item_armor1" => GoalKind::Armor(1),
        b"item_armor2" => GoalKind::Armor(2),
        b"item_armorInv" => GoalKind::Armor(3),
        b"item_health" => {
            if spawnflags & 2 != 0 {
                GoalKind::Health { amount: 100, mega: true }
            } else if spawnflags & 1 != 0 {
                GoalKind::Health { amount: 15, mega: false }
            } else {
                GoalKind::Health { amount: 25, mega: false }
            }
        }
        b"item_shells" => GoalKind::Ammo(0, spawnflags & 1 != 0),
        b"item_spikes" => GoalKind::Ammo(1, spawnflags & 1 != 0),
        b"item_rockets" => GoalKind::Ammo(2, spawnflags & 1 != 0),
        b"item_cells" => GoalKind::Ammo(3, spawnflags & 1 != 0),
        b"item_artifact_super_damage" => GoalKind::Powerup(it::QUAD),
        b"item_artifact_invulnerability" => GoalKind::Powerup(it::INVULNERABILITY),
        b"item_artifact_invisibility" => GoalKind::Powerup(it::INVISIBILITY),
        b"item_artifact_envirosuit" => GoalKind::Powerup(it::SUIT),
        b"item_flag_team1" => GoalKind::Flag(1),
        b"item_flag_team2" => GoalKind::Flag(2),
        b"info_player_deathmatch" | b"info_player_start" | b"info_player_team1" | b"info_player_team2" => {
            GoalKind::Spawn
        }
        _ => return None,
    })
}

impl NavGraph {
    /// Build the graph of the current map (call after the map's entities spawned).
    pub fn build<W: BotWorld>(w: &mut W) -> NavGraph {
        // collect entities of interest
        let mut goal_ents: Vec<(u32, GoalKind, Vec3)> = Vec::new();
        let mut teleports: Vec<(Vec3, Vec3, Vec<u8>)> = Vec::new();
        let mut dests: Vec<(Vec<u8>, Vec3)> = Vec::new();
        let mut plats: Vec<(Vec3, Vec3)> = Vec::new();
        let mut pushes: Vec<(Vec3, Vec3, Vec3)> = Vec::new(); // absmin, absmax, push velocity
        let mut hurts: Vec<(Vec3, Vec3)> = Vec::new();
        let mut seeds: Vec<Vec3> = Vec::new();
        for e in 1..w.num_edicts() {
            let Some(ent) = w.entity(e) else { continue };
            let center = scale(add(ent.absmin, ent.absmax), 0.5);
            let center = if ent.absmax == ent.absmin { ent.origin } else { center };
            if let Some(k) = classify(ent.classname, ent.spawnflags) {
                let pos = if k == GoalKind::Spawn { ent.origin } else { center };
                goal_ents.push((e, k, pos));
                seeds.push(if k == GoalKind::Spawn { ent.origin } else { [center[0], center[1], ent.absmin[2] + 24.0] });
            } else if ent.classname == b"trigger_teleport" {
                teleports.push((ent.absmin, ent.absmax, ent.target.to_vec()));
            } else if ent.classname == b"func_plat" {
                plats.push((ent.absmin, ent.absmax));
            } else if ent.classname == b"trigger_hurt" {
                hurts.push((sub(ent.absmin, [8.0; 3]), add(ent.absmax, [8.0; 3])));
            } else if ent.classname == b"trigger_push" {
                let sp = if ent.speed > 0.0 { ent.speed } else { 1000.0 };
                let v = scale(ent.movedir, sp * 10.0);
                let v = [v[0].clamp(-2000.0, 2000.0), v[1].clamp(-2000.0, 2000.0), v[2].clamp(-2000.0, 2000.0)];
                pushes.push((ent.absmin, ent.absmax, v));
            }
            if !ent.targetname.is_empty() && ent.classname != b"trigger_teleport" {
                dests.push((ent.targetname.to_vec(), ent.origin));
            }
        }
        let mut b = Builder {
            w,
            traces: 0,
            nodes: Vec::new(),
            flags: Vec::new(),
            columns: BTreeMap::new(),
            links: Vec::new(),
            linked: BTreeMap::new(),
            queue: VecDeque::new(),
            hurts,
            void_hit: false,
        };
        for s in &seeds {
            b.seed(*s);
        }
        let mut tele_links: Vec<(Vec3, Vec3, Vec3)> = Vec::new(); // (absmin, absmax, dest)
        for (mn, mx, target) in &teleports {
            if let Some((_, d)) = dests.iter().find(|(n, _)| n == target) {
                b.seed(*d);
                tele_links.push((*mn, *mx, *d));
            }
        }
        // flood fill, then teleporters and jump pads (which seed new areas), a few passes
        for _pass in 0..4 {
            while let Some(n) = b.queue.pop_front() {
                b.expand(n);
            }
            // teleporters: every node whose box touches the trigger (grown by 24) → destination
            for (mn, mx, d) in &tele_links {
                let Some(dest) = b.seed(*d) else { continue };
                let center = scale(add(*mn, *mx), 0.5);
                for n in 0..b.nodes.len() as u32 {
                    let p = b.nodes[n as usize];
                    let inside = (0..3).all(|k| p[k] + PLAYER_MAXS[k] + 24.0 >= mn[k] && p[k] + PLAYER_MINS[k] - 24.0 <= mx[k]);
                    if inside && n != dest && b.reaches_box(p, center, mn, mx) {
                        b.add_link(n, dest, LinkKind::Teleport, center);
                    }
                }
            }
            // jump pads: simulate the push from the nodes touching the trigger
            for (mn, mx, v) in &pushes {
                let center = scale(add(*mn, *mx), 0.5);
                let near: Vec<u32> = (0..b.nodes.len() as u32)
                    .filter(|&n| {
                        let p = b.nodes[n as usize];
                        (0..3).all(|k| p[k] + PLAYER_MAXS[k] + 8.0 >= mn[k] && p[k] + PLAYER_MINS[k] - 8.0 <= mx[k])
                    })
                    .collect();
                let mut touching = Vec::new();
                for n in near {
                    let p = b.nodes[n as usize];
                    if b.reaches_box(p, center, mn, mx) {
                        touching.push(n);
                    }
                }
                let mut starts: Vec<(i32, Vec3)> = Vec::new();
                for &n in &touching {
                    let p = b.nodes[n as usize];
                    let c = [center[0].clamp(p[0] - 32.0, p[0] + 32.0), center[1].clamp(p[1] - 32.0, p[1] + 32.0), p[2]];
                    starts.push((-(p[2] as i32) * 1024 + dist2d(c, center) as i32, c));
                    starts.push((-(p[2] as i32) * 1024 + 512 + dist2d(p, center) as i32, p));
                }
                starts.sort_by(|a, c| a.0.cmp(&c.0));
                let starts: Vec<Vec3> = starts.into_iter().map(|x| x.1).collect();
                if let Some(dest) = b.push_sim(&starts, *mn, *mx, *v) {
                    for &n in &touching {
                        if n != dest {
                            b.add_link(n, dest, LinkKind::Push, center);
                        }
                    }
                }
            }
            if b.queue.is_empty() {
                break;
            }
        }
        // plats: lowest nodes in the footprint → nodes around the top
        for (mn, mx) in &plats {
            let center = [(mn[0] + mx[0]) * 0.5, (mn[1] + mx[1]) * 0.5, mx[2]];
            let height = mx[2] - mn[2] - 8.0;
            let top = mx[2] + height.max(0.0);
            let mut bottom: Vec<u32> = Vec::new();
            let mut tops: Vec<u32> = Vec::new();
            for n in 0..b.nodes.len() as u32 {
                let p = b.nodes[n as usize];
                let feet = p[2] - 24.0;
                let inxy = p[0] >= mn[0] - 8.0 && p[0] <= mx[0] + 8.0 && p[1] >= mn[1] - 8.0 && p[1] <= mx[1] + 8.0;
                let nearxy = p[0] >= mn[0] - 72.0 && p[0] <= mx[0] + 72.0 && p[1] >= mn[1] - 72.0 && p[1] <= mx[1] + 72.0;
                if inxy && feet <= mx[2] + 4.0 && feet >= mn[2] - 64.0 {
                    bottom.push(n);
                } else if nearxy && (feet - top).abs() <= 24.0 {
                    tops.push(n);
                }
            }
            for &bn in &bottom {
                for &tn in &tops {
                    b.add_link(bn, tn, LinkKind::Plat, center);
                }
            }
        }

        // Standing inside a teleporter or a jump pad means being moved: such nodes keep
        // only their Teleport / Push links (walking across a pad launches you).
        let overlaps = |p: Vec3, mn: &Vec3, mx: &Vec3| (0..3).all(|k| p[k] + PLAYER_MAXS[k] > mn[k] && p[k] + PLAYER_MINS[k] < mx[k]);
        let mut forced_kind: Vec<Option<LinkKind>> = vec![None; b.nodes.len()];
        for (i, p) in b.nodes.iter().enumerate() {
            if pushes.iter().any(|(mn, mx, _)| overlaps(*p, mn, mx)) {
                forced_kind[i] = Some(LinkKind::Push);
            } else if tele_links.iter().any(|(mn, mx, _)| overlaps(*p, mn, mx)) {
                forced_kind[i] = Some(LinkKind::Teleport);
            }
        }
        // standing on a lowered plat's trigger (inset 25, QW plat_spawn_inside_trigger)
        // starts it: such nodes keep only their Plat links
        for (i, p) in b.nodes.iter().enumerate() {
            for (mn, mx) in &plats {
                let feet = p[2] - 24.0;
                if p[0] > mn[0] + 25.0 - 16.0 && p[0] < mx[0] - 25.0 + 16.0 && p[1] > mn[1] + 25.0 - 16.0 && p[1] < mx[1] - 25.0 + 16.0
                    && feet <= mx[2] + 8.0 && feet >= mn[2] - 64.0
                {
                    forced_kind[i] = Some(LinkKind::Plat);
                }
            }
        }
        let mut has_kind = vec![false; b.nodes.len()];
        for l in &b.links {
            if forced_kind[l.from as usize] == Some(l.kind) {
                has_kind[l.from as usize] = true;
            }
        }
        b.links.retain(|l| match forced_kind[l.from as usize] {
            Some(k) if has_kind[l.from as usize] => l.kind == k,
            _ => true,
        });

        // brushing past a teleporter / jump pad is risky: walking next to one costs extra
        let near = |p: Vec3, mn: &Vec3, mx: &Vec3| (0..3).all(|k| p[k] + PLAYER_MAXS[k] + 16.0 > mn[k] && p[k] + PLAYER_MINS[k] - 16.0 < mx[k]);
        let risky: Vec<bool> = b
            .nodes
            .iter()
            .map(|p| {
                pushes.iter().any(|(mn, mx, _)| near(*p, mn, mx))
                    || tele_links.iter().any(|(mn, mx, _)| near(*p, mn, mx))
                    || plats.iter().any(|(mn, mx)| near(*p, mn, mx) && p[2] - 24.0 <= mx[2] + 8.0)
            })
            .collect();
        for l in b.links.iter_mut() {
            let tf = b.flags[l.to as usize];
            if tf & NODE_DEEP != 0 {
                l.cost = l.cost * 3.0 + 60.0;
            }
            if tf & NODE_VOID != 0 && l.kind == LinkKind::Walk {
                l.cost += 24.0;
            }
            if l.kind == LinkKind::Jump && b.flags[l.from as usize] & NODE_VOID != 0 {
                l.cost += 150.0;
            }
            if risky[l.to as usize] && l.kind != LinkKind::Teleport && l.kind != LinkKind::Push && l.kind != LinkKind::Plat {
                l.cost += 300.0;
            }
        }

        // CSR adjacency (links sorted by (from, to) for stable order)
        let build_traces = b.traces;
        let nn = b.nodes.len();
        let mut links = std::mem::take(&mut b.links);
        links.sort_by(|a, c| (a.from, a.to).cmp(&(c.from, c.to)));
        let mut nodes: Vec<Node> = b
            .nodes
            .iter()
            .zip(b.flags.iter())
            .map(|(&pos, &flags)| Node { pos, first_link: 0, num_links: 0, flags })
            .collect();
        for (i, l) in links.iter().enumerate().rev() {
            let n = &mut nodes[l.from as usize];
            n.first_link = i as u32;
            n.num_links += 1;
        }
        let mut rev_count = vec![0u32; nn + 1];
        for l in &links {
            rev_count[l.to as usize + 1] += 1;
        }
        for i in 0..nn {
            rev_count[i + 1] += rev_count[i];
        }
        let rev_first = rev_count.clone();
        let mut fill = rev_count;
        let mut rev = vec![0u32; links.len()];
        for (i, l) in links.iter().enumerate() {
            let slot = &mut fill[l.to as usize];
            rev[*slot as usize] = i as u32;
            *slot += 1;
        }

        // spatial grid
        let (mut lo, mut hi) = ([f32::MAX; 2], [f32::MIN; 2]);
        for n in &nodes {
            for k in 0..2 {
                lo[k] = lo[k].min(n.pos[k]);
                hi[k] = hi[k].max(n.pos[k]);
            }
        }
        if nodes.is_empty() {
            lo = [0.0; 2];
            hi = [0.0; 2];
        }
        let dim = [
            (((hi[0] - lo[0]) / CELL) as u32 + 1).min(4096),
            (((hi[1] - lo[1]) / CELL) as u32 + 1).min(4096),
        ];
        let ncell = (dim[0] * dim[1]) as usize;
        let cell_of = |p: Vec3| -> usize {
            let cx = (((p[0] - lo[0]) / CELL) as u32).min(dim[0] - 1);
            let cy = (((p[1] - lo[1]) / CELL) as u32).min(dim[1] - 1);
            (cy * dim[0] + cx) as usize
        };
        let mut cc = vec![0u32; ncell + 1];
        for n in &nodes {
            cc[cell_of(n.pos) + 1] += 1;
        }
        for i in 0..ncell {
            cc[i + 1] += cc[i];
        }
        let cell_first = cc.clone();
        let mut cell_nodes = vec![0u32; nn];
        let mut fill = cc;
        for (i, n) in nodes.iter().enumerate() {
            let c = cell_of(n.pos);
            cell_nodes[fill[c] as usize] = i as u32;
            fill[c] += 1;
        }

        drop(b);
        let mut g = NavGraph {
            nodes,
            links,
            rev_first,
            rev,
            grid_org: lo,
            grid_dim: dim,
            cell_first,
            cell_nodes,
            goals: Vec::new(),
            fields: Vec::new(),
            landmarks: Vec::new(),
            stats: NavStats::default(),
        };

        // goals and their distance fields
        for (ent, kind, pos) in goal_ents {
            let probe = if kind == GoalKind::Spawn { pos } else { [pos[0], pos[1], pos[2]] };
            if let Some(node) = g.nearest_visible(w, probe, 160.0) {
                g.goals.push(Goal { ent, kind, node, pos });
            }
        }
        let mut fields = vec![FIELD_INF; g.goals.len() * nn];
        for (gi, goal) in g.goals.iter().enumerate() {
            g.dijkstra_into(goal.node, &mut fields[gi * nn..(gi + 1) * nn]);
        }
        g.fields = fields;
        // landmarks: farthest-point sampling over goal positions (deterministic)
        if !g.goals.is_empty() {
            let mut lm = vec![0usize];
            while lm.len() < 8.min(g.goals.len()) {
                let mut best = (0.0f32, 0usize);
                for (i, gl) in g.goals.iter().enumerate() {
                    let d = lm.iter().map(|&j| dist(gl.pos, g.goals[j].pos)).fold(f32::MAX, f32::min);
                    if d > best.0 {
                        best = (d, i);
                    }
                }
                if best.0 <= 0.0 {
                    break;
                }
                lm.push(best.1);
            }
            g.landmarks = lm;
        }

        let mut st = NavStats {
            nodes: nn as u32,
            links: g.links.len() as u32,
            goals: g.goals.len() as u32,
            build_traces,
            ..Default::default()
        };
        for l in &g.links {
            match l.kind {
                LinkKind::Walk => st.walk += 1,
                LinkKind::Jump => st.jump += 1,
                LinkKind::Drop => st.drop += 1,
                LinkKind::Teleport => st.teleport += 1,
                LinkKind::Plat => st.plat += 1,
                LinkKind::Push => st.push += 1,
            }
        }
        g.stats = st;
        g
    }

    /// Reverse Dijkstra: distance (in FIELD_Q units) from every node to `target`.
    fn dijkstra_into(&self, target: u32, out: &mut [u16]) {
        let mut dist = vec![f32::INFINITY; self.nodes.len()];
        let mut heap: BinaryHeap<Reverse<(u32, u32)>> = BinaryHeap::new();
        // non-negative f32 bit patterns order like the floats
        dist[target as usize] = 0.0;
        heap.push(Reverse((0f32.to_bits(), target)));
        while let Some(Reverse((dq, v))) = heap.pop() {
            let dv = dist[v as usize];
            if dv.to_bits() != dq {
                continue;
            }
            let (a, b) = (self.rev_first[v as usize] as usize, self.rev_first[v as usize + 1] as usize);
            for &li in &self.rev[a..b] {
                let l = &self.links[li as usize];
                let nd = dv + l.cost;
                if nd < dist[l.from as usize] {
                    dist[l.from as usize] = nd;
                    heap.push(Reverse((nd.to_bits(), l.from)));
                }
            }
        }
        for (o, d) in out.iter_mut().zip(dist.iter()) {
            *o = if d.is_finite() { ((d / FIELD_Q) as u32).min(FIELD_INF as u32 - 1) as u16 } else { FIELD_INF };
        }
    }

    /// A* heuristic from `n` to `t`: max of the straight distance and the ALT bound
    /// from the landmark distance fields (d(n,t) >= d(n,L) - d(t,L)).
    pub fn heuristic(&self, n: u32, t: u32) -> f32 {
        let nn = self.nodes.len();
        let (Some(a), Some(b)) = (self.nodes.get(n as usize), self.nodes.get(t as usize)) else { return 0.0 };
        let mut h = dist(a.pos, b.pos);
        for &l in &self.landmarks {
            let f = &self.fields[l * nn..(l + 1) * nn];
            let (dn, dt) = (f[n as usize], f[t as usize]);
            if dn != FIELD_INF && dt != FIELD_INF && dn > dt {
                let v = (dn - dt) as f32 * FIELD_Q - FIELD_Q;
                if v > h {
                    h = v;
                }
            }
        }
        h
    }

    pub fn stats(&self) -> NavStats {
        self.stats
    }

    pub fn node(&self, n: u32) -> Option<&Node> {
        self.nodes.get(n as usize)
    }

    /// Outgoing links of node `n` (empty if out of range).
    pub fn links_of(&self, n: u32) -> &[Link] {
        match self.nodes.get(n as usize) {
            Some(nd) => &self.links[nd.first_link as usize..(nd.first_link + nd.num_links) as usize],
            None => &[],
        }
    }

    /// Distance from node `n` to goal `g` in world units (None if unreachable).
    pub fn goal_dist(&self, g: usize, n: u32) -> Option<f32> {
        let nn = self.nodes.len();
        if g >= self.goals.len() || n as usize >= nn {
            return None;
        }
        let d = self.fields[g * nn + n as usize];
        if d == FIELD_INF {
            None
        } else {
            Some(d as f32 * FIELD_Q)
        }
    }

    /// Best next link from `n` towards goal `g`.
    pub fn goal_next(&self, g: usize, n: u32) -> Option<&Link> {
        let nn = self.nodes.len();
        if g >= self.goals.len() || n as usize >= nn {
            return None;
        }
        let f = &self.fields[g * nn..(g + 1) * nn];
        let mut best: Option<(&Link, f32)> = None;
        for l in self.links_of(n) {
            let d = f[l.to as usize];
            if d == FIELD_INF {
                continue;
            }
            let c = l.cost + d as f32 * FIELD_Q;
            if best.map_or(true, |(_, bc)| c < bc) {
                best = Some((l, c));
            }
        }
        best.map(|(l, _)| l)
    }

    fn cell_range(&self, cx: i32, cy: i32) -> &[u32] {
        if cx < 0 || cy < 0 || cx >= self.grid_dim[0] as i32 || cy >= self.grid_dim[1] as i32 {
            return &[];
        }
        let c = (cy as u32 * self.grid_dim[0] + cx as u32) as usize;
        &self.cell_nodes[self.cell_first[c] as usize..self.cell_first[c + 1] as usize]
    }

    /// Nearest node by a level-aware distance (no traces). Searches `radius` units.
    pub fn nearest(&self, p: Vec3, radius: f32) -> Option<u32> {
        if self.nodes.is_empty() {
            return None;
        }
        let cx = libm::floorf((p[0] - self.grid_org[0]) / CELL) as i32;
        let cy = libm::floorf((p[1] - self.grid_org[1]) / CELL) as i32;
        let r = (radius / CELL) as i32 + 1;
        let mut best: Option<(u32, f32)> = None;
        for y in cy - r..=cy + r {
            for x in cx - r..=cx + r {
                for &n in self.cell_range(x, y) {
                    let q = self.nodes[n as usize].pos;
                    let dz = (q[2] - p[2]).abs();
                    let d = dist2d(p, q) + if dz > 20.0 { dz * 3.0 } else { dz };
                    if d <= radius * 1.5 && best.map_or(true, |(_, bd)| d < bd) {
                        best = Some((n, d));
                    }
                }
            }
        }
        best.map(|(n, _)| n)
    }

    /// Nearest node that a point trace from `p` reaches (up to 8 candidates tried).
    pub fn nearest_visible<W: BotWorld>(&self, w: &mut W, p: Vec3, radius: f32) -> Option<u32> {
        let cx = libm::floorf((p[0] - self.grid_org[0]) / CELL) as i32;
        let cy = libm::floorf((p[1] - self.grid_org[1]) / CELL) as i32;
        let r = (radius / CELL) as i32 + 1;
        let mut cands: Vec<(u32, u32)> = Vec::new();
        for y in cy - r..=cy + r {
            for x in cx - r..=cx + r {
                for &n in self.cell_range(x, y) {
                    let q = self.nodes[n as usize].pos;
                    let dz = (q[2] - p[2]).abs();
                    let d = dist2d(p, q) + if dz > 20.0 { dz * 3.0 } else { dz };
                    if d <= radius * 1.5 {
                        cands.push(((d * 16.0) as u32, n));
                    }
                }
            }
        }
        cands.sort();
        for &(_, n) in cands.iter().take(8) {
            let q = self.nodes[n as usize].pos;
            let t = w.trace_world(p, [0.0; 3], [0.0; 3], q);
            if t.fraction >= 1.0 && !t.startsolid {
                return Some(n);
            }
        }
        cands.first().map(|&(_, n)| n)
    }

    pub fn incoming(&self, n: u32) -> impl Iterator<Item = &Link> {
        let (a, b) = match (self.rev_first.get(n as usize), self.rev_first.get(n as usize + 1)) {
            (Some(&a), Some(&b)) => (a as usize, b as usize),
            _ => (0, 0),
        };
        self.rev[a..b].iter().map(move |&i| &self.links[i as usize])
    }

    /// Number of nodes reachable from `n` (tests / tools).
    pub fn reachable_count(&self, n: u32) -> usize {
        let mut seen = vec![false; self.nodes.len()];
        let mut stack = vec![n];
        let mut c = 0;
        while let Some(x) = stack.pop() {
            if seen.get(x as usize) != Some(&false) {
                continue;
            }
            seen[x as usize] = true;
            c += 1;
            for l in self.links_of(x) {
                stack.push(l.to);
            }
        }
        c
    }
}
