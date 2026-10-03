// Quake Town - qtbots: the bot brain (perception, goals, navigation, aim, movement)
// Copyright (C) 2026 Quake Town contributors
// SPDX-License-Identifier: GPL-2.0-or-later

use crate::astar::{astar, Scratch, NONE};
use crate::math::*;
use crate::nav::{GoalKind, LinkKind, NavGraph};
use crate::ser::{hash_bytes, R, W};
use crate::skill::{skill, Skill};
use crate::{angle2short, it, short2angle, BotWorld, ClientInfo, UserCmd, Vec3, BUTTON_ATTACK, BUTTON_JUMP};

const TICK: f32 = 0.013;
/// Shared A* expansions per tick across all bots.
const TICK_BUDGET: u32 = 3000;
/// Max A* expansions of one search.
const SEARCH_BUDGET: u32 = 1200;
const STATE_VERSION: u32 = 1;

/// Weapon table: (IT bit, impulse, ammo index (4 = none), ammo per shot, projectile speed (0 hitscan)).
const WEAPONS: [(u32, u32, usize, f32, f32); 8] = [
    (it::AXE, 1, 4, 0.0, 0.0),
    (it::SHOTGUN, 2, 0, 1.0, 0.0),
    (it::SUPER_SHOTGUN, 3, 0, 2.0, 0.0),
    (it::NAILGUN, 4, 1, 1.0, 1000.0),
    (it::SUPER_NAILGUN, 5, 1, 2.0, 1000.0),
    (it::GRENADE_LAUNCHER, 6, 2, 1.0, 600.0),
    (it::ROCKET_LAUNCHER, 7, 2, 1.0, 1000.0),
    (it::LIGHTNING, 8, 3, 1.0, 0.0),
];

fn weapon_info(bit: u32) -> Option<(u32, u32, usize, f32, f32)> {
    WEAPONS.iter().copied().find(|w| w.0 == bit)
}

/// Debug view of a bot (tests / tools).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BotDebug {
    pub node: u32,
    pub goal: u32,
    pub enemy: u32,
    pub hopping: bool,
    pub chase: bool,
    pub yaw: f32,
}

#[derive(Clone, Debug, Default, PartialEq)]
struct Bot {
    level: u8,
    pitch: f32,
    yaw: f32,
    sent_pitch16: i32,
    sent_yaw16: i32,
    cur: u32,
    goal: u32,
    chase: bool,
    path: Vec<u32>,
    chase_target: Vec3,
    next_eval: f64,
    relocalize_at: f64,
    last_pos: Vec3,
    progress_at: f64,
    stuck_count: u32,
    unstuck_until: f64,
    unstuck_yaw: f32,
    jump_prev: bool,
    hop: bool,
    hop_check_at: f64,
    strafe: f32,
    next_flip: f64,
    wall_check_tick: u32,
    enemy: u32,
    enemy_seen: f64,
    enemy_pos: Vec3,
    enemy_vel: Vec3,
    react_until: f64,
    err: [f32; 2],
    next_err: f64,
    scan: u32,
    weapon_at: f64,
    avoid: u32,
    avoid_until: f64,
    dead_ticks: u32,
    ticks: u32,
    now: f64,
    forced_goal: Vec3,
    forced: bool,
    hop_target: Vec3,
    air_target: Vec3,
    air_until: f64,
    astar_at: f64,
}

/// What navigation wants this tick.
#[derive(Default)]
struct NavOut {
    target: Option<Vec3>,
    jump: bool,
    wait: bool,
}

fn rand01<W: BotWorld>(w: &mut W) -> f32 {
    (w.random() >> 8) as f32 * (1.0 / 16777216.0)
}

fn ammo_max(i: usize) -> f32 {
    [100.0, 200.0, 100.0, 100.0][i.min(3)]
}

/// Does a player holding `items` use ammo type `i`?
fn uses_ammo(items: u32, i: usize) -> bool {
    match i {
        0 => items & (it::SHOTGUN | it::SUPER_SHOTGUN) != 0,
        1 => items & (it::NAILGUN | it::SUPER_NAILGUN) != 0,
        2 => items & (it::GRENADE_LAUNCHER | it::ROCKET_LAUNCHER) != 0,
        3 => items & it::LIGHTNING != 0,
        _ => false,
    }
}

impl Bot {
    fn new(level: u8) -> Bot {
        Bot {
            level: level.clamp(1, 5),
            cur: NONE,
            goal: NONE,
            enemy: NONE,
            avoid: NONE,
            strafe: 1.0,
            ..Default::default()
        }
    }

    fn reset_nav(&mut self) {
        self.cur = NONE;
        self.goal = NONE;
        self.chase = false;
        self.path.clear();
        self.hop = false;
        self.next_eval = 0.0;
        self.relocalize_at = 0.0;
        self.stuck_count = 0;
    }

    fn is_enemy<W: BotWorld>(&self, w: &W, me: &ClientInfo, c: &ClientInfo) -> bool {
        !(w.teamplay() != 0 && me.team != 0 && c.team == me.team)
    }

    fn eye(c: &ClientInfo) -> Vec3 {
        let z = if c.view_ofs_z != 0.0 { c.view_ofs_z } else { 22.0 };
        [c.origin[0], c.origin[1], c.origin[2] + z]
    }

    fn can_see<W: BotWorld>(&self, w: &mut W, me: &ClientInfo, c: &ClientInfo, sk: &Skill) -> bool {
        let d = sub(c.origin, me.origin);
        let dl = len(d);
        if dl > 3000.0 {
            return false;
        }
        if c.items & it::INVISIBILITY != 0 && dl > 300.0 {
            return false;
        }
        let view = angles_dir(self.pitch, self.yaw);
        let in_fov = dot(view, norm(d)) >= libm::cosf(sk.fov * RAD);
        let speed = len2d(c.velocity);
        let heard = dl < sk.hear * if speed > 150.0 { 1.0 } else { 0.4 };
        if !(in_fov || heard || dl < 100.0) {
            return false;
        }
        let a = Self::eye(me);
        let b = [c.origin[0], c.origin[1], c.origin[2] + 16.0];
        let t = w.trace(a, [0.0; 3], [0.0; 3], b, true, me.entnum);
        t.fraction >= 1.0 && !t.startsolid
    }

    fn perceive<W: BotWorld>(&mut self, w: &mut W, me: &ClientInfo, slot: u32, now: f64, sk: &Skill) -> bool {
        let mut visible = false;
        if self.enemy != NONE {
            match w.client(self.enemy) {
                Some(c) if c.alive && self.is_enemy(w, me, &c) => {
                    if self.can_see(w, me, &c, sk) {
                        visible = true;
                        self.enemy_seen = now;
                        self.enemy_pos = c.origin;
                        self.enemy_vel = c.velocity;
                    } else if now - self.enemy_seen > 2.5 {
                        self.enemy = NONE;
                    }
                }
                _ => self.enemy = NONE,
            }
        }
        let maxc = w.maxclients().max(1);
        for _ in 0..2 {
            self.scan = (self.scan + 1) % maxc;
            let s = self.scan;
            if s == slot || s == self.enemy {
                continue;
            }
            let Some(c) = w.client(s) else { continue };
            if !c.alive || !self.is_enemy(w, me, &c) {
                continue;
            }
            if !self.can_see(w, me, &c, sk) {
                continue;
            }
            let dnew = dist(me.origin, c.origin);
            let dcur = if visible { dist(me.origin, self.enemy_pos) } else { f32::MAX };
            if dnew < dcur * 0.7 {
                self.enemy = s;
                self.enemy_seen = now;
                self.enemy_pos = c.origin;
                self.enemy_vel = c.velocity;
                let jitter = 0.8 + 0.4 * rand01(w);
                self.react_until = now + (sk.reaction * jitter) as f64;
                visible = true;
            }
        }
        visible
    }

    fn goal_value<W: BotWorld>(&self, w: &W, me: &ClientInfo, kind: GoalKind, ent: u32, goal_pos: Vec3, carrying: bool) -> f32 {
        match kind {
            GoalKind::Weapon(bit) => {
                if me.items & bit == 0 {
                    match bit {
                        it::ROCKET_LAUNCHER => 100.0,
                        it::LIGHTNING => 90.0,
                        it::GRENADE_LAUNCHER => 55.0,
                        it::SUPER_NAILGUN => 50.0,
                        it::SUPER_SHOTGUN => 45.0,
                        _ => 30.0,
                    }
                } else {
                    let (_, _, ai, _, _) = weapon_info(bit).unwrap_or((0, 0, 4, 0.0, 0.0));
                    if ai < 4 {
                        (1.0 - me.ammo[ai] / ammo_max(ai)).max(0.0) * 12.0
                    } else {
                        0.0
                    }
                }
            }
            GoalKind::Armor(t) => {
                let cur = me.armortype * me.armorvalue;
                let new = [30.0, 90.0, 160.0][(t.clamp(1, 3) - 1) as usize];
                if new <= cur + 5.0 {
                    0.0
                } else {
                    (new - cur) * 0.5 + if t == 3 { 25.0 } else { 0.0 }
                }
            }
            GoalKind::Health { amount, mega } => {
                if mega {
                    if me.health < 250.0 {
                        80.0 - me.health * 0.2
                    } else {
                        0.0
                    }
                } else if me.health < 100.0 {
                    amount as f32 * (100.0 - me.health) / 40.0
                } else {
                    0.0
                }
            }
            GoalKind::Ammo(i, big) => {
                let i = i as usize;
                if uses_ammo(me.items, i) {
                    (1.0 - me.ammo[i.min(3)] / ammo_max(i)).max(0.0) * if big { 35.0 } else { 22.0 }
                } else {
                    1.0
                }
            }
            GoalKind::Powerup(bit) => match bit {
                it::QUAD => 120.0,
                it::INVULNERABILITY => 110.0,
                it::INVISIBILITY => 45.0,
                _ => 5.0,
            },
            GoalKind::Flag(_) => {
                let Some(e) = w.entity(ent) else { return 0.0 };
                let own = me.team != 0 && e.team == me.team;
                let center = scale(add(e.absmin, e.absmax), 0.5);
                let at_base = dist(center, goal_pos) < 48.0;
                if carrying {
                    if own {
                        400.0
                    } else {
                        0.0
                    }
                } else if own {
                    if !at_base && e.solid == 1 {
                        150.0
                    } else {
                        0.0
                    }
                } else if e.solid == 1 {
                    160.0
                } else {
                    0.0
                }
            }
            GoalKind::Spawn => 3.0,
        }
    }

    fn choose_goal<W: BotWorld>(&mut self, w: &mut W, nav: &NavGraph, me: &ClientInfo, now: f64, fighting: bool) {
        self.goal = NONE;
        if self.cur == NONE {
            return;
        }
        // carrying an enemy flag? (a non-solid enemy flag right on top of us)
        let mut carrying = false;
        for g in &nav.goals {
            if let GoalKind::Flag(_) = g.kind {
                if let Some(e) = w.entity(g.ent) {
                    if e.team != me.team && e.solid != 1 && (e.owner == me.entnum || dist(e.origin, me.origin) < 64.0) {
                        carrying = true;
                    }
                }
            }
        }
        let jitter = (w.random() & 0xffff) as usize;
        let mut best: Option<(f32, u32)> = None;
        for (gi, g) in nav.goals.iter().enumerate() {
            if gi as u32 == self.avoid && now < self.avoid_until {
                continue;
            }
            let Some(d) = nav.goal_dist(gi, self.cur) else { continue };
            let mut v = match g.kind {
                GoalKind::Spawn => 2.0 + ((jitter.wrapping_mul(gi * 2654435761 + 1) >> 7) % 8) as f32 * 0.5,
                GoalKind::Flag(_) => self.goal_value(w, me, g.kind, g.ent, g.pos, carrying),
                kind => {
                    let Some(e) = w.entity(g.ent) else { continue };
                    if e.solid != 1 || e.model.is_empty() || e.modelindex == 0 {
                        continue;
                    }
                    self.goal_value(w, me, kind, g.ent, g.pos, carrying)
                }
            };
            if fighting && me.health < 50.0 {
                if let GoalKind::Health { .. } = g.kind {
                    v *= 2.0;
                }
            }
            if v <= 0.0 {
                continue;
            }
            let score = v / (1.0 + d / 700.0);
            if best.map_or(true, |(bs, _)| score > bs) {
                best = Some((score, gi as u32));
            }
        }
        if let Some((_, gi)) = best {
            self.goal = gi;
        }
    }

    /// Follow the current goal; returns the steering target.
    fn navigate<W: BotWorld>(
        &mut self,
        w: &mut W,
        nav: &NavGraph,
        me: &ClientInfo,
        now: f64,
        scratch: &mut Scratch,
        budget: &mut u32,
    ) -> NavOut {
        let mut out = NavOut::default();
        if self.cur == NONE {
            return out;
        }
        // forced point goal (tests/tools) or chase: A* path
        if self.forced || self.chase {
            let tgt = if self.forced { self.forced_goal } else { self.chase_target };
            if dist(me.origin, tgt) < 40.0 {
                if self.chase {
                    self.chase = false;
                    self.path.clear();
                }
                out.target = Some(tgt);
                return out;
            }
            if self.path.is_empty() {
                let Some(gn) = nav.nearest(tgt, 160.0) else { return out };
                if gn == self.cur {
                    out.target = Some(tgt);
                    return out;
                }
                if *budget == 0 {
                    return out; // wait for budget next tick
                }
                if now < self.astar_at {
                    out.target = Some(tgt);
                    return out;
                }
                let (p, used) = astar(nav, scratch, self.cur, gn, SEARCH_BUDGET.min(*budget));
                *budget = budget.saturating_sub(used.max(1));
                self.path = p;
                if self.path.is_empty() {
                    // no progress possible from here: head straight for it, retry later
                    self.astar_at = now + 0.5;
                    if self.chase {
                        self.chase = false;
                    }
                    out.target = Some(tgt);
                    return out;
                }
            }
            while let Some(&first) = self.path.first() {
                if first == self.cur {
                    self.path.remove(0);
                } else {
                    break;
                }
            }
            let Some(&next) = self.path.first() else {
                out.target = Some(tgt);
                return out;
            };
            let link = nav.links_of(self.cur).iter().find(|l| l.to == next).copied();
            match link {
                Some(l) => return self.follow_link(nav, me, &l, out),
                None => {
                    // off the path: replan
                    self.path.clear();
                    return out;
                }
            }
        }
        if self.goal == NONE {
            return out;
        }
        let Some(g) = nav.goals.get(self.goal as usize).copied() else {
            self.goal = NONE;
            return out;
        };
        if self.cur == g.node || (dist2d(me.origin, g.pos) < 96.0 && (me.origin[2] - g.pos[2]).abs() < 48.0) {
            let available = match g.kind {
                GoalKind::Spawn => true,
                _ => w.entity(g.ent).map_or(false, |e| e.solid == 1 && !e.model.is_empty()),
            };
            if dist2d(me.origin, g.pos) < 20.0 || !available || self.cur == g.node && dist2d(me.origin, g.pos) < 36.0 {
                self.avoid = self.goal;
                self.avoid_until = now + 4.0;
                self.goal = NONE;
                self.next_eval = 0.0;
            }
            out.target = Some([g.pos[0], g.pos[1], me.origin[2]]);
            return out;
        }
        match nav.goal_next(self.goal as usize, self.cur) {
            Some(l) => {
                let l = *l;
                self.follow_link(nav, me, &l, out)
            }
            None => {
                self.goal = NONE;
                self.next_eval = 0.0;
                out
            }
        }
    }

    fn follow_link(&mut self, nav: &NavGraph, me: &ClientInfo, l: &crate::nav::Link, mut out: NavOut) -> NavOut {
        let Some(nn) = nav.node(l.to) else { return out };
        let npos = nn.pos;
        let cpos = nav.node(self.cur).map_or(me.origin, |n| n.pos);
        let close = dist2d(me.origin, npos) < 20.0 && (me.origin[2] - npos[2]).abs() < 40.0;
        if close {
            self.cur = l.to;
        }
        match l.kind {
            LinkKind::Walk | LinkKind::Drop => out.target = Some(npos),
            LinkKind::Jump => {
                out.target = Some(npos);
                let d = sub(npos, cpos);
                let dir = norm([d[0], d[1], 0.0]);
                let along = dot(dir, [me.velocity[0], me.velocity[1], 0.0]);
                let past = dot(sub(me.origin, cpos), dir);
                if past >= -2.0 && dist2d(me.origin, cpos) < 40.0 && me.onground && along > 200.0 {
                    out.jump = true;
                    self.air_target = npos;
                    self.air_until = self.now + 1.5;
                }
            }
            LinkKind::Teleport => out.target = Some(l.via),
            LinkKind::Push => {
                out.target = Some(l.via);
                self.air_target = npos;
                self.air_until = self.now + 4.0;
            }
            LinkKind::Plat => {
                if dist2d(me.origin, l.via) > 32.0 && me.origin[2] < npos[2] - 40.0 {
                    out.target = Some(l.via);
                } else if me.origin[2] < npos[2] - 40.0 {
                    out.wait = true;
                } else {
                    out.target = Some(npos);
                }
            }
        }
        out
    }

    /// Straight distance ahead along the goal path from the current node.
    fn straight_ahead(&self, nav: &NavGraph, me: &ClientInfo) -> (f32, Vec3) {
        if self.goal == NONE || self.cur == NONE {
            return (0.0, me.origin);
        }
        let mut n = self.cur;
        let mut dir0: Option<Vec3> = None;
        let mut length = 0.0;
        let mut last = me.origin;
        for _ in 0..14 {
            let Some(l) = nav.goal_next(self.goal as usize, n) else { break };
            if l.kind != LinkKind::Walk {
                break;
            }
            let Some(p) = nav.node(l.to).map(|x| x.pos) else { break };
            if (p[2] - last[2]).abs() > 20.0 {
                break;
            }
            let d = sub(p, me.origin);
            let d2 = norm([d[0], d[1], 0.0]);
            match dir0 {
                None => dir0 = Some(d2),
                Some(d0) => {
                    if dot(d0, d2) < 0.985 {
                        break;
                    }
                }
            }
            length = dist2d(me.origin, p);
            last = p;
            n = l.to;
        }
        (length, last)
    }

    fn pick_weapon(&self, me: &ClientInfo, enemy_dist: Option<f32>, enemy_below: bool) -> u32 {
        let has = |bit: u32, ai: usize, need: f32| me.items & bit != 0 && (ai >= 4 || me.ammo[ai] >= need);
        let d = enemy_dist.unwrap_or(400.0);
        let mut best = (0.0f32, 0u32);
        for &(bit, imp, ai, need, _) in WEAPONS.iter() {
            if !has(bit, ai, need) {
                continue;
            }
            let s = match bit {
                it::ROCKET_LAUNCHER => {
                    if d < 110.0 {
                        if me.health + me.armorvalue > 140.0 {
                            55.0
                        } else {
                            25.0
                        }
                    } else if d < 800.0 {
                        100.0
                    } else {
                        60.0
                    }
                }
                it::LIGHTNING => {
                    if me.waterlevel <= 1 && d < 600.0 {
                        95.0
                    } else {
                        15.0
                    }
                }
                it::SUPER_SHOTGUN => {
                    if d < 250.0 {
                        75.0
                    } else {
                        32.0
                    }
                }
                it::SUPER_NAILGUN => {
                    if d < 600.0 {
                        65.0
                    } else {
                        40.0
                    }
                }
                it::GRENADE_LAUNCHER => {
                    if enemy_below && d < 500.0 {
                        80.0
                    } else if d > 150.0 && d < 450.0 {
                        48.0
                    } else {
                        18.0
                    }
                }
                it::NAILGUN => 38.0,
                it::SHOTGUN => {
                    if d > 500.0 {
                        36.0
                    } else {
                        30.0
                    }
                }
                _ => 5.0,
            };
            if s > best.0 {
                best = (s, imp);
            }
        }
        best.1
    }

    fn preferred_range(weapon: u32) -> f32 {
        match weapon {
            it::ROCKET_LAUNCHER => 320.0,
            it::LIGHTNING => 260.0,
            it::SUPER_SHOTGUN => 110.0,
            it::AXE => 32.0,
            it::GRENADE_LAUNCHER => 300.0,
            _ => 380.0,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn think<W: BotWorld>(&mut self, w: &mut W, nav: &NavGraph, slot: u32, scratch: &mut Scratch, budget: &mut u32) -> UserCmd {
        let sk = skill(self.level);
        self.ticks = self.ticks.wrapping_add(1);
        let mut cmd = UserCmd { pitch16: self.sent_pitch16, yaw16: self.sent_yaw16, ..Default::default() };
        let Some(me) = w.client(slot) else { return cmd };
        let now = w.time();
        self.now = now;
        if !me.alive {
            self.reset_nav();
            self.enemy = NONE;
            self.dead_ticks += 1;
            if (self.dead_ticks / 8) % 2 == 1 {
                cmd.buttons = BUTTON_ATTACK;
            }
            self.jump_prev = false;
            return cmd;
        }
        self.dead_ticks = 0;
        // the engine forced our angles (spawn, teleport): adopt them
        if wrap180(me.v_angle[1] - short2angle(self.sent_yaw16)).abs() > 1.5
            || wrap180(me.v_angle[0] - short2angle(self.sent_pitch16)).abs() > 1.5
        {
            self.yaw = me.v_angle[1];
            self.pitch = me.v_angle[0];
        }
        // localize on the graph
        let far = match nav.node(self.cur) {
            Some(n) => dist2d(n.pos, me.origin) > 140.0 || (n.pos[2] - me.origin[2]).abs() > 80.0,
            None => true,
        };
        let flying = !me.onground && now < self.air_until && me.waterlevel < 2;
        if !flying && (far || now >= self.relocalize_at) {
            if far {
                self.path.clear();
            }
            self.cur = nav.nearest(me.origin, 160.0).unwrap_or(NONE);
            self.relocalize_at = now + 0.6 + (slot % 8) as f64 * 0.013;
        }

        let visible = self.perceive(w, &me, slot, now, &sk);
        let enemy_info = if self.enemy != NONE { w.client(self.enemy) } else { None };
        let fighting = visible && enemy_info.is_some();

        if !self.forced && !self.chase && (self.goal == NONE || now >= self.next_eval) {
            self.choose_goal(w, nav, &me, now, fighting);
            self.next_eval = now + 0.6 + (slot % 5) as f64 * 0.05;
            // nothing worth taking and an enemy was seen recently: hunt him
            let roaming = self.goal == NONE
                || matches!(nav.goals.get(self.goal as usize).map(|g| g.kind), Some(GoalKind::Spawn));
            if roaming && self.enemy != NONE && !visible && self.level >= 2 && now - self.enemy_seen < 3.0 {
                self.chase = true;
                self.chase_target = self.enemy_pos;
                self.path.clear();
            }
        }
        let mut nv = if flying { NavOut::default() } else { self.navigate(w, nav, &me, now, scratch, budget) };
        if flying {
            nv.target = Some(self.air_target);
        } else if me.onground {
            self.air_until = 0.0;
        }

        // ------------------------------------------------------------ weapon
        let edist = enemy_info.map(|e| dist(e.origin, me.origin));
        let below = enemy_info.map_or(false, |e| e.origin[2] < me.origin[2] - 64.0);
        if now >= self.weapon_at {
            let want = self.pick_weapon(&me, if fighting { edist } else { None }, below);
            if want != 0 && WEAPONS.iter().any(|w| w.1 == want && w.0 != me.weapon) {
                cmd.impulse = want;
                self.weapon_at = now + 0.5;
            } else {
                self.weapon_at = now + 0.2;
            }
        }

        // ------------------------------------------------------------ aim
        let eye = Self::eye(&me);
        let mut desired: Option<(f32, f32)> = None;
        let mut true_aim: Option<Vec3> = None;
        if let (true, Some(e)) = (fighting, enemy_info) {
            if now >= self.react_until {
                let speed = weapon_info(me.weapon).map_or(0.0, |w| w.4);
                let d = dist(eye, e.origin);
                let mut aim = [e.origin[0], e.origin[1], e.origin[2] + 4.0];
                if speed > 0.0 {
                    let tf = d / speed;
                    aim = ma(aim, tf * sk.lead, e.velocity);
                    if me.weapon == it::ROCKET_LAUNCHER && e.onground {
                        aim[2] = e.origin[2] - 18.0;
                    }
                    if me.weapon == it::GRENADE_LAUNCHER {
                        aim[2] += 0.5 * 800.0 * tf * tf * 0.8;
                    }
                }
                true_aim = Some(aim);
                if now >= self.next_err {
                    let a = (rand01(w) * 2.0 - 1.0) * sk.aim_error;
                    let b = (rand01(w) * 2.0 - 1.0) * sk.aim_error * 0.5;
                    self.err = [b, a];
                    self.next_err = now + 0.3 + 0.3 * rand01(w) as f64;
                }
                let v = sub(aim, eye);
                desired = Some((pitch_of(v) + self.err[0], yaw_of(v) + self.err[1]));
            }
        } else if self.enemy != NONE && now - self.enemy_seen < 1.0 && self.level >= 3 {
            let v = sub(self.enemy_pos, eye);
            desired = Some((pitch_of(v) * 0.5, yaw_of(v)));
        }
        let travel_target = nv.target;
        let hop_target;
        // bunny hop decision
        if !fighting && sk.bunny_hop && me.waterlevel < 2 {
            if now >= self.hop_check_at {
                let (len, far_p) = self.straight_ahead(nav, &me);
                self.hop = if self.hop { len > 180.0 } else { len > 380.0 };
                self.hop_target = far_p;
                self.hop_check_at = now + 0.2;
            }
        } else {
            self.hop = false;
        }
        hop_target = if self.hop { Some(self.hop_target) } else { None };
        let steer = hop_target.or(travel_target);
        if desired.is_none() {
            if let Some(t) = steer {
                let v = sub(t, eye);
                if len2d(v) > 8.0 {
                    let p = (pitch_of(v) * 0.5).clamp(-25.0, 25.0);
                    desired = Some((p, yaw_of(v)));
                }
            }
        }
        if let Some((p, y)) = desired {
            let track = if fighting { sk.track } else { sk.track.max(0.35) };
            let max = sk.turn_rate * TICK;
            let dy = wrap180(y - self.yaw);
            let dp = p - self.pitch;
            self.yaw = wrap180(self.yaw + (dy * track).clamp(-max, max));
            if self.yaw < 0.0 {
                self.yaw += 360.0;
            }
            self.pitch = (self.pitch + (dp * track).clamp(-max, max)).clamp(-70.0, 80.0);
        }

        // ------------------------------------------------------------ fire
        if let (Some(aim), Some(e)) = (true_aim, enemy_info) {
            let view = angles_dir(self.pitch, self.yaw);
            let to = sub(aim, eye);
            let d = len(to).max(1.0);
            let cosang = dot(view, scale(to, 1.0 / d));
            let radius = match me.weapon {
                it::ROCKET_LAUNCHER | it::GRENADE_LAUNCHER => 48.0,
                it::SUPER_SHOTGUN | it::SHOTGUN => 30.0,
                _ => 20.0,
            };
            let tol = libm::atan2f(radius, d) + 0.6 * RAD;
            let too_close_rl = me.weapon == it::ROCKET_LAUNCHER && d < 90.0 && me.health + me.armorvalue < 130.0;
            if cosang >= libm::cosf(tol) && !too_close_rl && !(me.weapon == it::AXE && d > 64.0) {
                // line of fire: don't hit teammates
                let end = ma(eye, d.min(2048.0), view);
                let t = w.trace(eye, [0.0; 3], [0.0; 3], end, false, me.entnum);
                let mut ok = true;
                if t.ent > 0 && t.ent as u32 != e.entnum && w.teamplay() != 0 {
                    for s in 0..w.maxclients() {
                        if let Some(c) = w.client(s) {
                            if c.entnum == t.ent as u32 && c.team == me.team && me.team != 0 {
                                ok = false;
                            }
                        }
                    }
                }
                if ok {
                    cmd.buttons |= BUTTON_ATTACK;
                }
            }
        }

        // ------------------------------------------------------------ move
        let mut move_yaw: Option<f32> = None;
        let mut want_jump = nv.jump;
        if now < self.unstuck_until {
            move_yaw = Some(self.unstuck_yaw);
        } else if let (true, Some(e)) = (fighting && sk.circle_strafe && !self.forced, enemy_info) {
            let to = sub(e.origin, me.origin);
            let de = len2d(to);
            let ey = yaw_of(to);
            if now >= self.next_flip {
                self.strafe = -self.strafe;
                self.next_flip = now + ((0.35 + 1.1 * rand01(w)) / sk.dodge) as f64;
            }
            self.wall_check_tick += 1;
            if self.wall_check_tick % 6 == 0 {
                let sd = yaw_dir(ey + 90.0 * self.strafe);
                let t = w.trace(me.origin, crate::PLAYER_MINS, crate::PLAYER_MAXS, ma(me.origin, 56.0, sd), true, me.entnum);
                if t.fraction < 1.0 {
                    self.strafe = -self.strafe;
                }
            }
            let pref = Self::preferred_range(me.weapon);
            let radial = if de > pref + 80.0 {
                1.0
            } else if de < pref - 80.0 {
                -1.0
            } else {
                0.0
            };
            let mut v = add(scale(yaw_dir(ey), radial * 0.7), yaw_dir(ey + 90.0 * self.strafe));
            if let Some(t) = travel_target {
                if self.goal != NONE && dist(t, me.origin) > 8.0 {
                    let dt = sub(t, me.origin);
                    v = add(v, scale(norm([dt[0], dt[1], 0.0]), 0.8));
                }
            }
            move_yaw = Some(yaw_of(v));
            if sk.dodge_jump && me.onground && (w.random() % 1000) < 12 {
                want_jump = true;
            }
        } else if let Some(t) = steer {
            let d = sub(t, me.origin);
            if len2d(d) > 4.0 {
                let ty = yaw_of(d);
                if self.hop && !me.onground && len2d(me.velocity) > 100.0 {
                    let vy = yaw_of(me.velocity);
                    let diff = wrap180(ty - vy);
                    let side = if diff > 2.0 {
                        1.0
                    } else if diff < -2.0 {
                        -1.0
                    } else if (self.ticks / 6) % 2 == 0 {
                        1.0
                    } else {
                        -1.0
                    };
                    move_yaw = Some(vy + side * 88.0);
                } else {
                    move_yaw = Some(ty);
                }
            }
            if self.hop && me.onground {
                want_jump = true;
            }
        }
        let wants_move = move_yaw.is_some() && !nv.wait;
        // stuck detection
        if wants_move {
            if dist2d(me.origin, self.last_pos) > 24.0 {
                self.last_pos = me.origin;
                self.progress_at = now;
                if self.stuck_count > 0 && now - self.progress_at > 3.0 {
                    self.stuck_count = 0;
                }
            } else if now - self.progress_at > 0.9 {
                self.progress_at = now;
                self.stuck_count += 1;
                self.unstuck_until = now + 0.45;
                self.unstuck_yaw = self.yaw + 90.0 + 180.0 * rand01(w);
                want_jump = true;
                self.relocalize_at = now;
                self.path.clear();
                if self.stuck_count >= 3 {
                    self.avoid = self.goal;
                    self.avoid_until = now + 6.0;
                    self.goal = NONE;
                    self.chase = false;
                    self.stuck_count = 0;
                }
            }
        } else {
            self.progress_at = now;
            self.last_pos = me.origin;
        }
        if let (Some(my), false) = (move_yaw, nv.wait) {
            let delta = (my - self.yaw) * RAD;
            cmd.forward = libm::roundf(400.0 * libm::cosf(delta)) as i32;
            cmd.side = libm::roundf(-400.0 * libm::sinf(delta)) as i32;
        }
        if me.waterlevel >= 2 {
            if let Some(t) = steer {
                cmd.up = if t[2] > me.origin[2] + 8.0 {
                    200
                } else if t[2] < me.origin[2] - 24.0 {
                    -200
                } else {
                    0
                };
            }
        }
        if want_jump && !self.jump_prev {
            cmd.buttons |= BUTTON_JUMP;
        }
        self.jump_prev = cmd.buttons & BUTTON_JUMP != 0;

        cmd.pitch16 = angle2short(self.pitch);
        cmd.yaw16 = angle2short(self.yaw);
        self.sent_pitch16 = cmd.pitch16;
        self.sent_yaw16 = cmd.yaw16;
        cmd
    }

    fn write(&self, w: &mut W) {
        w.u8(self.level);
        w.f32(self.pitch);
        w.f32(self.yaw);
        w.i32(self.sent_pitch16);
        w.i32(self.sent_yaw16);
        w.u32(self.cur);
        w.u32(self.goal);
        w.bool(self.chase);
        w.u32(self.path.len() as u32);
        for &p in &self.path {
            w.u32(p);
        }
        w.v3(self.chase_target);
        w.f64(self.next_eval);
        w.f64(self.relocalize_at);
        w.v3(self.last_pos);
        w.f64(self.progress_at);
        w.u32(self.stuck_count);
        w.f64(self.unstuck_until);
        w.f32(self.unstuck_yaw);
        w.bool(self.jump_prev);
        w.bool(self.hop);
        w.f64(self.hop_check_at);
        w.f32(self.strafe);
        w.f64(self.next_flip);
        w.u32(self.wall_check_tick);
        w.u32(self.enemy);
        w.f64(self.enemy_seen);
        w.v3(self.enemy_pos);
        w.v3(self.enemy_vel);
        w.f64(self.react_until);
        w.f32(self.err[0]);
        w.f32(self.err[1]);
        w.f64(self.next_err);
        w.u32(self.scan);
        w.f64(self.weapon_at);
        w.u32(self.avoid);
        w.f64(self.avoid_until);
        w.u32(self.dead_ticks);
        w.u32(self.ticks);
        w.v3(self.forced_goal);
        w.bool(self.forced);
        w.v3(self.hop_target);
        w.v3(self.air_target);
        w.f64(self.air_until);
        w.f64(self.now);
        w.f64(self.astar_at);
    }

    fn read(r: &mut R) -> Result<Bot, String> {
        let mut b = Bot::new(1);
        b.level = r.u8()?.clamp(1, 5);
        b.pitch = r.f32()?;
        b.yaw = r.f32()?;
        b.sent_pitch16 = r.i32()?;
        b.sent_yaw16 = r.i32()?;
        b.cur = r.u32()?;
        b.goal = r.u32()?;
        b.chase = r.bool()?;
        let n = r.u32()? as usize;
        if n > 4096 {
            return Err("bots: path too long".into());
        }
        for _ in 0..n {
            b.path.push(r.u32()?);
        }
        b.chase_target = r.v3()?;
        b.next_eval = r.f64()?;
        b.relocalize_at = r.f64()?;
        b.last_pos = r.v3()?;
        b.progress_at = r.f64()?;
        b.stuck_count = r.u32()?;
        b.unstuck_until = r.f64()?;
        b.unstuck_yaw = r.f32()?;
        b.jump_prev = r.bool()?;
        b.hop = r.bool()?;
        b.hop_check_at = r.f64()?;
        b.strafe = r.f32()?;
        b.next_flip = r.f64()?;
        b.wall_check_tick = r.u32()?;
        b.enemy = r.u32()?;
        b.enemy_seen = r.f64()?;
        b.enemy_pos = r.v3()?;
        b.enemy_vel = r.v3()?;
        b.react_until = r.f64()?;
        b.err = [r.f32()?, r.f32()?];
        b.next_err = r.f64()?;
        b.scan = r.u32()?;
        b.weapon_at = r.f64()?;
        b.avoid = r.u32()?;
        b.avoid_until = r.f64()?;
        b.dead_ticks = r.u32()?;
        b.ticks = r.u32()?;
        b.forced_goal = r.v3()?;
        b.forced = r.bool()?;
        b.hop_target = r.v3()?;
        b.air_target = r.v3()?;
        b.air_until = r.f64()?;
        b.now = r.f64()?;
        b.astar_at = r.f64()?;
        Ok(b)
    }
}

/// All bots of a world (indexed by slot). Part of the world state.
#[derive(Clone)]
pub struct Bots {
    bots: Vec<Option<Bot>>,
    budget: u32,
    scratch: Scratch,
}

impl Bots {
    pub fn new(maxclients: u32) -> Bots {
        Bots { bots: vec![None; maxclients.min(256) as usize], budget: TICK_BUDGET, scratch: Scratch::default() }
    }
    /// A bot of skill 1..=5 takes `slot` (fresh brain).
    pub fn add(&mut self, slot: u32, skill: u8) {
        if let Some(b) = self.bots.get_mut(slot as usize) {
            *b = Some(Bot::new(skill));
        }
    }
    pub fn remove(&mut self, slot: u32) {
        if let Some(b) = self.bots.get_mut(slot as usize) {
            *b = None;
        }
    }
    pub fn is_bot(&self, slot: u32) -> bool {
        matches!(self.bots.get(slot as usize), Some(Some(_)))
    }
    pub fn skill(&self, slot: u32) -> u8 {
        match self.bots.get(slot as usize) {
            Some(Some(b)) => b.level,
            _ => 0,
        }
    }
    /// Call once per tick before the thinks.
    pub fn begin_tick(&mut self) {
        self.budget = TICK_BUDGET;
    }
    /// The bot's usercmd for this tick (default cmd if `slot` is not a bot).
    pub fn think<W: BotWorld>(&mut self, w: &mut W, nav: &NavGraph, slot: u32) -> UserCmd {
        let Some(Some(mut b)) = self.bots.get_mut(slot as usize).map(|b| b.take()) else {
            return UserCmd::default();
        };
        let cmd = b.think(w, nav, slot, &mut self.scratch, &mut self.budget);
        self.bots[slot as usize] = Some(b);
        cmd
    }
    /// Make a bot walk to a point (tests / tools); `None` returns it to normal play.
    pub fn force_goal(&mut self, slot: u32, p: Option<Vec3>) {
        if let Some(Some(b)) = self.bots.get_mut(slot as usize) {
            b.forced = p.is_some();
            b.forced_goal = p.unwrap_or([0.0; 3]);
            b.path.clear();
        }
    }
    pub fn debug(&self, slot: u32) -> Option<BotDebug> {
        match self.bots.get(slot as usize) {
            Some(Some(b)) => Some(BotDebug { node: b.cur, goal: b.goal, enemy: b.enemy, hopping: b.hop, chase: b.chase, yaw: b.yaw }),
            _ => None,
        }
    }

    pub fn serialize(&self, out: &mut Vec<u8>) {
        let mut w = W(out);
        w.u32(0x5442_5451); // "QTBT"
        w.u32(STATE_VERSION);
        w.u32(self.bots.len() as u32);
        for b in &self.bots {
            match b {
                None => w.u8(0),
                Some(b) => {
                    w.u8(1);
                    b.write(&mut w);
                }
            }
        }
    }

    pub fn deserialize(data: &[u8]) -> Result<(Bots, usize), String> {
        let mut r = R { d: data, p: 0 };
        if r.u32()? != 0x5442_5451 || r.u32()? != STATE_VERSION {
            return Err("bots: bad magic/version".into());
        }
        let n = r.u32()? as usize;
        if n > 256 {
            return Err("bots: too many slots".into());
        }
        let mut bots = Vec::with_capacity(n);
        for _ in 0..n {
            bots.push(match r.u8()? {
                0 => None,
                1 => Some(Bot::read(&mut r)?),
                _ => return Err("bots: bad slot flag".into()),
            });
        }
        Ok((Bots { bots, budget: TICK_BUDGET, scratch: Scratch::default() }, r.p))
    }

    pub fn hash(&self) -> u64 {
        let mut v = Vec::with_capacity(256);
        self.serialize(&mut v);
        hash_bytes(&v)
    }
}
