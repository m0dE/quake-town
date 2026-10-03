// Quake Town - qtbots test kit: a small QW-like world (BSP collision, pmove, items,
// teleporters, plats, hitscan combat) implementing BotWorld, for tests and measurements.
// Copyright (C) 2026 Quake Town contributors
// SPDX-License-Identifier: GPL-2.0-or-later
#![allow(dead_code)]

pub mod bsp;
pub mod pmove;

use bsp::{trace_model, Bsp};
use pmove::{player_move, PState, PhysEnt, PMAXS, PMINS};
use qtbots::{BotWorld, ClientInfo, EntInfo, Trace, UserCmd, Vec3};

pub const MAPS: &str = "/app/data/home/quake-ref/full/id1/maps";

pub fn map_path(i: u32) -> String {
    format!("{}/lqdm{}.bsp", MAPS, i)
}

/// CPU time of this thread in seconds (the box is shared: wall time lies).
pub fn cpu_time() -> f64 {
    std::fs::read_to_string("/proc/thread-self/schedstat")
        .ok()
        .and_then(|s| s.split_whitespace().next().and_then(|x| x.parse::<f64>().ok()))
        .map(|ns| ns / 1e9)
        .unwrap_or(0.0)
}

#[derive(Clone, Default)]
pub struct TEnt {
    pub classname: Vec<u8>,
    pub model: Vec<u8>,
    pub target: Vec<u8>,
    pub targetname: Vec<u8>,
    pub origin: Vec3,
    pub angle: f32,
    pub mins: Vec3,
    pub maxs: Vec3,
    pub spawnflags: u32,
    pub solid: i32,
    pub free: bool,
    pub respawn_at: f64,
    /// brush model index (for plats / triggers)
    pub bmodel: Option<usize>,
    // plat state
    pub plat_state: u8,
    pub plat_low: f32,
    pub plat_high: f32,
    pub plat_wait: f64,
    pub movedir: Vec3,
    pub speed: f32,
    pub angles: Option<Vec3>,
}

#[derive(Clone, Default)]
pub struct TPlayer {
    pub used: bool,
    pub pm: PState,
    pub alive: bool,
    pub health: f32,
    pub armor: f32,
    pub armortype: f32,
    pub items: u32,
    pub weapon: u32,
    pub ammo: [f32; 4],
    pub team: i32,
    pub frags: i32,
    pub deaths: i32,
    pub attack_finished: f64,
    pub dead_time: f64,
    pub cmd: UserCmd,
    pub max_speed: f32,
    pub pickups: u32,
    pub shots: u32,
    pub hits: u32,
}

pub struct TestWorld {
    pub bsp: Bsp,
    pub ents: Vec<TEnt>,
    pub players: Vec<TPlayer>,
    pub maxclients: u32,
    pub time: f64,
    pub rng: u64,
    pub teamplay: i32,
    pub spawns: Vec<usize>,
    pub combat: bool,
    pub walls: Vec<(usize, Vec3)>,
}

fn parse_entities(text: &[u8]) -> Vec<Vec<(Vec<u8>, Vec<u8>)>> {
    let mut out = Vec::new();
    let mut d = text;
    let mut cur: Option<Vec<(Vec<u8>, Vec<u8>)>> = None;
    let mut key: Option<Vec<u8>> = None;
    loop {
        let Some((tok, rest)) = qcvm_like_parse(d) else { break };
        d = rest;
        if tok == b"{" {
            cur = Some(Vec::new());
        } else if tok == b"}" {
            if let Some(c) = cur.take() {
                out.push(c);
            }
        } else if let Some(k) = key.take() {
            if let Some(c) = cur.as_mut() {
                c.push((k, tok));
            }
        } else {
            key = Some(tok);
        }
    }
    out
}

fn qcvm_like_parse(data: &[u8]) -> Option<(Vec<u8>, &[u8])> {
    let mut d = data;
    while let Some(&c) = d.first() {
        if c > b' ' {
            break;
        }
        d = &d[1..];
    }
    if d.is_empty() {
        return None;
    }
    if d[0] == b'"' {
        let end = d[1..].iter().position(|&c| c == b'"').map_or(d.len(), |p| p + 1);
        let tok = d[1..end.min(d.len())].to_vec();
        return Some((tok, &d[(end + 1).min(d.len())..]));
    }
    let end = d.iter().position(|&c| c <= b' ').unwrap_or(d.len());
    Some((d[..end].to_vec(), &d[end..]))
}

fn vec3(s: &[u8]) -> Vec3 {
    let t = String::from_utf8_lossy(s);
    let mut v = [0.0; 3];
    for (i, p) in t.split_whitespace().take(3).enumerate() {
        v[i] = p.parse().unwrap_or(0.0);
    }
    v
}

fn item_bounds(cls: &[u8]) -> Option<(Vec3, Vec3)> {
    if cls.starts_with(b"item_armor") {
        Some(([-16.0, -16.0, 0.0], [16.0, 16.0, 56.0]))
    } else if cls.starts_with(b"item_artifact") {
        Some(([-16.0, -16.0, -24.0], [16.0, 16.0, 32.0]))
    } else if cls.starts_with(b"weapon_") || cls.starts_with(b"item_") {
        Some(([0.0, 0.0, 0.0], [32.0, 32.0, 56.0]))
    } else {
        None
    }
}

const WEAPONS: [(u32, u32, usize, f32, f64, f32); 8] = [
    // (it bit, impulse, ammo idx, damage, interval, ammo use)
    (4096, 1, 9, 20.0, 0.5, 0.0),
    (1, 2, 0, 24.0, 0.5, 1.0),
    (2, 3, 0, 50.0, 0.7, 2.0),
    (4, 4, 1, 9.0, 0.1, 1.0),
    (8, 5, 1, 18.0, 0.1, 2.0),
    (16, 6, 2, 90.0, 0.6, 1.0),
    (32, 7, 2, 100.0, 0.8, 1.0),
    (64, 8, 3, 30.0, 0.1, 1.0),
];

impl TestWorld {
    pub fn load(path: &str, maxclients: u32, seed: u64) -> TestWorld {
        let data = std::fs::read(path).expect("bsp");
        let bsp = Bsp::load(&data);
        let mut ents = vec![TEnt { classname: b"worldspawn".to_vec(), solid: 4, ..Default::default() }];
        for _ in 0..maxclients {
            ents.push(TEnt { classname: b"player".to_vec(), free: true, ..Default::default() });
        }
        let mut spawns = Vec::new();
        for kv in parse_entities(&bsp.entities) {
            let mut e = TEnt::default();
            for (k, v) in &kv {
                match &k[..] {
                    b"classname" => e.classname = v.clone(),
                    b"model" => e.model = v.clone(),
                    b"target" => e.target = v.clone(),
                    b"targetname" => e.targetname = v.clone(),
                    b"origin" => e.origin = vec3(v),
                    b"angle" => e.angle = String::from_utf8_lossy(v).parse().unwrap_or(0.0),
                    b"spawnflags" => e.spawnflags = String::from_utf8_lossy(v).parse().unwrap_or(0),
                    b"speed" => e.speed = String::from_utf8_lossy(v).parse().unwrap_or(0.0),
                    b"angles" => e.angles = Some(vec3(v)),
                    b"height" => e.plat_low = -String::from_utf8_lossy(v).parse::<f32>().unwrap_or(0.0),
                    _ => {}
                }
            }
            if e.classname == b"worldspawn" {
                continue;
            }
            if e.spawnflags & 2048 != 0 {
                continue;
            }
            if let Some(rest) = e.model.strip_prefix(b"*") {
                let m: usize = String::from_utf8_lossy(rest).parse().unwrap_or(0);
                if m < bsp.models.len() {
                    e.bmodel = Some(m);
                    e.mins = bsp.models[m].mins;
                    e.maxs = bsp.models[m].maxs;
                }
            }
            if let Some((mn, mx)) = item_bounds(&e.classname) {
                e.mins = mn;
                e.maxs = mx;
                e.solid = 1;
                e.model = b"progs/item.mdl".to_vec();
            }
            if e.classname.starts_with(b"trigger_") {
                e.solid = 1;
            }
            if e.classname == b"func_wall" {
                e.solid = 4;
            }
            // SetMovedir
            e.movedir = if let Some(a) = e.angles {
                qtbots::math::angles_dir(a[0], a[1])
            } else if e.angle == -1.0 {
                [0.0, 0.0, 1.0]
            } else if e.angle == -2.0 {
                [0.0, 0.0, -1.0]
            } else {
                qtbots::math::yaw_dir(e.angle)
            };
            if e.classname == b"trigger_push" && e.speed == 0.0 {
                e.speed = 1000.0;
            }
            if e.classname == b"info_teleport_destination" {
                e.origin[2] += 27.0;
            }
            if e.classname == b"func_plat" {
                let h = e.maxs[2] - e.mins[2] - 8.0;
                e.plat_high = 0.0;
                if e.plat_low == 0.0 {
                    e.plat_low = -h;
                }
                e.solid = 4;
                if e.targetname.is_empty() {
                    e.origin[2] = e.plat_low;
                }
            }
            if e.classname == b"info_player_deathmatch" {
                spawns.push(ents.len());
            }
            ents.push(e);
        }
        if spawns.is_empty() {
            for (i, e) in ents.iter().enumerate() {
                if e.classname == b"info_player_start" {
                    spawns.push(i);
                }
            }
        }
        let players = vec![TPlayer::default(); maxclients as usize];
        let walls = ents.iter().filter(|e| e.classname == b"func_wall").filter_map(|e| e.bmodel.map(|m| (m, e.origin))).collect();
        TestWorld { bsp, ents, players, maxclients, time: 1.0, rng: seed | 1, teamplay: 0, spawns, combat: true, walls }
    }

    pub fn rand(&mut self) -> u32 {
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 7;
        self.rng ^= self.rng << 17;
        (self.rng >> 32) as u32
    }

    fn physents(&self) -> Vec<PhysEnt> {
        let mut v = vec![PhysEnt { model: 0, origin: [0.0; 3], ent: 0 }];
        for (i, e) in self.ents.iter().enumerate() {
            if e.classname == b"func_plat" || e.classname == b"func_wall" {
                if let Some(m) = e.bmodel {
                    v.push(PhysEnt { model: m, origin: e.origin, ent: i as i32 });
                }
            }
        }
        v
    }

    pub fn spawn_player(&mut self, slot: usize) {
        let n = self.spawns.len().max(1) as u32;
        let pick = self.rand() % n;
        let sp = self.spawns.get(pick as usize).copied().unwrap_or(0);
        let (o, yaw) = (self.ents[sp].origin, self.ents[sp].angle);
        let p = &mut self.players[slot];
        p.used = true;
        p.alive = true;
        p.health = 100.0;
        p.armor = 0.0;
        p.armortype = 0.0;
        p.items = 4096 | 1 | 256;
        p.weapon = 1;
        p.ammo = [25.0, 0.0, 0.0, 0.0];
        p.pm = PState { origin: [o[0], o[1], o[2] + 1.0], angles: [0.0, yaw, 0.0], onground: -1, ..Default::default() };
        self.ents[slot + 1].free = false;
    }

    pub fn set_spawn_point(&mut self, slot: usize, o: Vec3) {
        self.players[slot].pm.origin = o;
        self.players[slot].pm.velocity = [0.0; 3];
    }

    fn ray_hits_player(&self, a: Vec3, b: Vec3, skip: usize) -> Option<(usize, f32)> {
        let mut best: Option<(usize, f32)> = None;
        for (i, p) in self.players.iter().enumerate() {
            if !p.used || !p.alive || i == skip {
                continue;
            }
            let mn = [p.pm.origin[0] - 16.0, p.pm.origin[1] - 16.0, p.pm.origin[2] - 24.0];
            let mx = [p.pm.origin[0] + 16.0, p.pm.origin[1] + 16.0, p.pm.origin[2] + 32.0];
            let (mut t0, mut t1) = (0.0f32, 1.0f32);
            let mut ok = true;
            for k in 0..3 {
                let d = b[k] - a[k];
                if d.abs() < 1e-6 {
                    if a[k] < mn[k] || a[k] > mx[k] {
                        ok = false;
                    }
                } else {
                    let (mut u0, mut u1) = ((mn[k] - a[k]) / d, (mx[k] - a[k]) / d);
                    if u0 > u1 {
                        std::mem::swap(&mut u0, &mut u1);
                    }
                    t0 = t0.max(u0);
                    t1 = t1.min(u1);
                }
            }
            if ok && t0 <= t1 && best.map_or(true, |(_, bt)| t0 < bt) {
                best = Some((i, t0));
            }
        }
        best
    }

    fn fire(&mut self, slot: usize) {
        let p = self.players[slot].clone();
        if p.attack_finished > self.time {
            return;
        }
        let Some(w) = WEAPONS.iter().find(|w| w.0 == p.weapon) else { return };
        if w.2 < 4 && p.ammo[w.2] < w.5 {
            return;
        }
        let pl = &mut self.players[slot];
        if w.2 < 4 {
            pl.ammo[w.2] -= w.5;
        }
        pl.attack_finished = self.time + w.4;
        pl.shots += 1;
        let eye = [p.pm.origin[0], p.pm.origin[1], p.pm.origin[2] + 22.0];
        let dir = qtbots::math::angles_dir(p.pm.angles[0], p.pm.angles[1]);
        let range = if w.0 == 4096 { 64.0 } else { 4096.0 };
        let end = qtbots::math::ma(eye, range, dir);
        let wt = trace_model(&self.bsp, 0, [0.0; 3], eye, [0.0; 3], [0.0; 3], end);
        if let Some((v, t)) = self.ray_hits_player(eye, end, slot) {
            if t <= wt.fraction {
                self.players[slot].hits += 1;
                let mut dmg = w.3;
                if self.teamplay != 0 && self.players[v].team != 0 && self.players[v].team == p.team {
                    dmg = 0.0;
                }
                let save = (dmg * self.players[v].armortype).min(self.players[v].armor).ceil();
                self.players[v].armor -= save;
                self.players[v].health -= dmg - save;
                if self.players[v].health <= 0.0 {
                    self.players[v].alive = false;
                    self.players[v].dead_time = self.time;
                    self.players[v].deaths += 1;
                    self.players[slot].frags += 1;
                }
            }
        }
    }

    fn touch_items(&mut self, slot: usize) {
        let p = self.players[slot].pm.origin;
        let (pmn, pmx) = ([p[0] - 16.0, p[1] - 16.0, p[2] - 24.0], [p[0] + 16.0, p[1] + 16.0, p[2] + 32.0]);
        for i in 0..self.ents.len() {
            let e = &self.ents[i];
            if e.solid != 1 || e.free {
                continue;
            }
            // SV_LinkEdict grows abs boxes by 1 (and items by 15 in x/y)
            let grow = if e.classname.starts_with(b"item_") || e.classname.starts_with(b"weapon_") { [15.0, 15.0, 1.0] } else { [1.0; 3] };
            let (mn, mx) = (bsp::add(e.origin, e.mins), bsp::add(e.origin, e.maxs));
            if (0..3).any(|k| pmx[k] < mn[k] - grow[k] || pmn[k] > mx[k] + grow[k]) {
                continue;
            }
            let cls = e.classname.clone();
            let sf = e.spawnflags;
            let target = e.target.clone();
            let pl = &mut self.players[slot];
            let mut taken = true;
            let mut respawn = 30.0;
            match &cls[..] {
                b"trigger_push" => {
                    let e = &self.ents[i];
                    let v = qtbots::math::scale(e.movedir, e.speed * 10.0);
                    self.players[slot].pm.velocity = [v[0].clamp(-2000.0, 2000.0), v[1].clamp(-2000.0, 2000.0), v[2].clamp(-2000.0, 2000.0)];
                    continue;
                }
                b"trigger_teleport" => {
                    if let Some(d) = self.ents.iter().find(|d| d.targetname == target && !target.is_empty()) {
                        let pl = &mut self.players[slot];
                        pl.pm.origin = d.origin;
                        let yaw = d.angle;
                        pl.pm.velocity = [300.0 * (yaw * qtbots::math::RAD).cos(), 300.0 * (yaw * qtbots::math::RAD).sin(), 0.0];
                        pl.pm.angles = [0.0, yaw, 0.0];
                    }
                    continue;
                }
                b"weapon_supershotgun" => { pl.items |= 2; pl.ammo[0] += 5.0; respawn = -1.0 }
                b"weapon_nailgun" => { pl.items |= 4; pl.ammo[1] += 30.0; respawn = -1.0 }
                b"weapon_supernailgun" => { pl.items |= 8; pl.ammo[1] += 30.0; respawn = -1.0 }
                b"weapon_grenadelauncher" => { pl.items |= 16; pl.ammo[2] += 5.0; respawn = -1.0 }
                b"weapon_rocketlauncher" => { pl.items |= 32; pl.ammo[2] += 5.0; respawn = -1.0 }
                b"weapon_lightning" => { pl.items |= 64; pl.ammo[3] += 15.0; respawn = -1.0 }
                b"item_shells" => pl.ammo[0] += 20.0,
                b"item_spikes" => pl.ammo[1] += 25.0,
                b"item_rockets" => pl.ammo[2] += 5.0,
                b"item_cells" => pl.ammo[3] += 6.0,
                b"item_health" => {
                    let (amt, max) = if sf & 2 != 0 { (100.0, 250.0) } else if sf & 1 != 0 { (15.0, 100.0) } else { (25.0, 100.0) };
                    if pl.health >= max { taken = false } else { pl.health = (pl.health + amt).min(max) }
                    respawn = 20.0;
                }
                b"item_armor1" | b"item_armor2" | b"item_armorInv" => {
                    let (t, v) = match &cls[..] { b"item_armor1" => (0.3, 100.0), b"item_armor2" => (0.6, 150.0), _ => (0.8, 200.0) };
                    if pl.armortype * pl.armor >= t * v { taken = false } else { pl.armortype = t; pl.armor = v }
                    respawn = 20.0;
                }
                c if c.starts_with(b"item_artifact") => respawn = 60.0,
                _ => taken = false,
            }
            if taken {
                pl.pickups += 1;
                for k in 0..4 {
                    pl.ammo[k] = pl.ammo[k].min([100.0, 200.0, 100.0, 100.0][k]);
                }
                if respawn > 0.0 {
                    self.ents[i].solid = 0;
                    self.ents[i].respawn_at = self.time + respawn;
                }
            }
        }
    }

    fn run_plats(&mut self) {
        let dt = 0.013f32;
        for i in 0..self.ents.len() {
            if self.ents[i].classname != b"func_plat" {
                continue;
            }
            let (mn, mx) = (bsp::add(self.ents[i].origin, self.ents[i].mins), bsp::add(self.ents[i].origin, self.ents[i].maxs));
            // QW plat_spawn_inside_trigger: inset 25 units, on top
            let rider = self.players.iter().any(|p| {
                p.used && p.alive && p.pm.origin[0] + 16.0 > mn[0] + 25.0 && p.pm.origin[0] - 16.0 < mx[0] - 25.0 && p.pm.origin[1] + 16.0 > mn[1] + 25.0
                    && p.pm.origin[1] - 16.0 < mx[1] - 25.0 && (p.pm.origin[2] - 24.0 - mx[2]).abs() < 8.0
            });
            let e = &mut self.ents[i];
            match e.plat_state {
                0 => {
                    if rider {
                        e.plat_state = 1;
                    }
                }
                1 => {
                    e.origin[2] += 150.0 * dt;
                    if e.origin[2] >= e.plat_high {
                        e.origin[2] = e.plat_high;
                        e.plat_state = 2;
                        e.plat_wait = self.time + 3.0;
                    }
                }
                2 => {
                    if self.time > e.plat_wait && !rider {
                        e.plat_state = 3;
                    }
                }
                _ => {
                    e.origin[2] -= 150.0 * dt;
                    if e.origin[2] <= e.plat_low {
                        e.origin[2] = e.plat_low;
                        e.plat_state = 0;
                    }
                }
            }
            // SV_PushMove-like: anyone the plat now overlaps (or stands on it while rising)
            // is pushed on top of it
            let (mn, mx) = (bsp::add(e.origin, e.mins), bsp::add(e.origin, e.maxs));
            let top = mx[2];
            let rising = e.plat_state == 1;
            for p in self.players.iter_mut() {
                if !p.used {
                    continue;
                }
                let o = p.pm.origin;
                // (kit simplification: only players whose center is over the plat ride it)
                let inxy = o[0] > mn[0] && o[0] < mx[0] && o[1] > mn[1] && o[1] < mx[1];
                let feet = o[2] - 24.0;
                let overlap = inxy && feet < mx[2] && o[2] + 32.0 > mn[2];
                let riding = inxy && rising && (feet - top).abs() < 4.0;
                if overlap || riding {
                    let np = [o[0], o[1], top + 24.0 + 0.03125];
                    let head = self.bsp.models[0].headnode[1];
                    if self.bsp.hull_point_contents(1, head, np) == -2 {
                        // blocked (QW plat_crush): the plat goes back down
                        e.plat_state = 3;
                        e.origin[2] -= 150.0 * dt;
                        continue;
                    }
                    p.pm.origin = np;
                    if p.pm.velocity[2] < 0.0 {
                        p.pm.velocity[2] = 0.0;
                    }
                }
            }
        }
    }

    /// One tick: every used slot runs its held cmd through pmove, then items/plats.
    pub fn tick(&mut self) {
        self.time += 0.013;
        let phys = self.physents();
        for s in 0..self.players.len() {
            if !self.players[s].used {
                continue;
            }
            if !self.players[s].alive {
                let p = &self.players[s];
                if self.time - p.dead_time > 1.0 && p.cmd.buttons & 1 != 0 {
                    let deaths = p.deaths;
                    let frags = p.frags;
                    self.spawn_player(s);
                    self.players[s].deaths = deaths;
                    self.players[s].frags = frags;
                }
                continue;
            }
            let cmd = self.players[s].cmd;
            if cmd.impulse >= 1 && cmd.impulse <= 8 {
                let w = WEAPONS[cmd.impulse as usize - 1];
                if self.players[s].items & w.0 != 0 {
                    self.players[s].weapon = w.0;
                }
            }
            let mut pm = self.players[s].pm;
            player_move(&self.bsp, &phys, &mut pm, &cmd);
            self.players[s].pm = pm;
            let sp = (pm.velocity[0] * pm.velocity[0] + pm.velocity[1] * pm.velocity[1]).sqrt();
            if sp > self.players[s].max_speed {
                self.players[s].max_speed = sp;
            }
            if self.combat && cmd.buttons & 1 != 0 {
                self.fire(s);
            }
            self.touch_items(s);
        }
        for e in self.ents.iter_mut() {
            if e.respawn_at > 0.0 && self.time >= e.respawn_at {
                e.respawn_at = 0.0;
                e.solid = 1;
            }
        }
        self.run_plats();
    }
}

impl BotWorld for TestWorld {
    fn time(&self) -> f64 {
        self.time
    }
    fn maxclients(&self) -> u32 {
        self.maxclients
    }
    fn teamplay(&self) -> i32 {
        self.teamplay
    }
    fn client(&self, slot: u32) -> Option<ClientInfo> {
        let p = self.players.get(slot as usize)?;
        if !p.used {
            return None;
        }
        Some(ClientInfo {
            entnum: slot + 1,
            alive: p.alive,
            origin: p.pm.origin,
            velocity: p.pm.velocity,
            v_angle: p.pm.angles,
            view_ofs_z: 22.0,
            health: p.health,
            armorvalue: p.armor,
            armortype: p.armortype,
            items: p.items,
            weapon: p.weapon,
            ammo: p.ammo,
            team: p.team,
            onground: p.pm.onground != -1,
            waterlevel: p.pm.waterlevel,
            frags: p.frags,
            effects: 0,
        })
    }
    fn num_edicts(&self) -> u32 {
        self.ents.len() as u32
    }
    fn entity(&self, e: u32) -> Option<EntInfo<'_>> {
        let t = self.ents.get(e as usize)?;
        if t.free || e == 0 {
            return None;
        }
        let (absmin, absmax) = (bsp::add(t.origin, t.mins), bsp::add(t.origin, t.maxs));
        Some(EntInfo {
            num: e,
            classname: &t.classname,
            model: &t.model,
            target: &t.target,
            targetname: &t.targetname,
            origin: t.origin,
            mins: t.mins,
            maxs: t.maxs,
            absmin,
            absmax,
            velocity: [0.0; 3],
            solid: t.solid,
            movetype: 0,
            flags: 0,
            spawnflags: t.spawnflags,
            modelindex: if t.solid != 0 || t.bmodel.is_some() { 1 } else { 0 },
            effects: 0,
            health: 0.0,
            team: 0,
            owner: 0,
            movedir: t.movedir,
            speed: t.speed,
        })
    }
    fn trace(&mut self, start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3, nomonsters: bool, passent: u32) -> Trace {
        let mut t = trace_model(&self.bsp, 0, [0.0; 3], start, mins, maxs, end);
        if !t.startsolid {
            t.ent = if t.fraction < 1.0 { 0 } else { -1 };
        }
        for pe in self.physents().iter().skip(1) {
            let u = trace_model(&self.bsp, pe.model, pe.origin, start, mins, maxs, end);
            if u.fraction < t.fraction {
                t = u;
                t.ent = pe.ent;
            }
        }
        if !nomonsters && maxs[0] - mins[0] < 3.0 {
            if let Some((v, f)) = self.ray_hits_player(start, end, passent as usize - 1) {
                if f < t.fraction {
                    t.fraction = f;
                    t.endpos = qtbots::math::ma(start, f, qtbots::math::sub(end, start));
                    t.ent = v as i32 + 1;
                }
            }
        }
        t
    }
    fn trace_world(&mut self, start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3) -> Trace {
        let mut t = trace_model(&self.bsp, 0, [0.0; 3], start, mins, maxs, end);
        for &(m, o) in &self.walls {
            let u = trace_model(&self.bsp, m, o, start, mins, maxs, end);
            if u.fraction < t.fraction {
                t = u;
            }
        }
        t
    }
    fn point_contents(&self, p: Vec3) -> i32 {
        self.bsp.point_contents(p)
    }
    fn world_bounds(&self) -> (Vec3, Vec3) {
        (self.bsp.models[0].mins, self.bsp.models[0].maxs)
    }
    fn random(&mut self) -> u32 {
        self.rand()
    }
}

pub const PLAYER_BOX: (Vec3, Vec3) = (PMINS, PMAXS);
