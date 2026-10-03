// Bot glue: which slots are bot-driven, their userinfo, and the usercmd they produce.
// With the `bots` feature the bots are `qtbots` (BSP navigation, human-like play) reading
// the world through `BotWorld`; without it a placeholder bot roams and shoots.
// Copyright (C) 2026 Quake Town authors. GPL-2.0-or-later.

use qcvm::defs::fld;
use qcvm::{Ent, Vm};

use crate::info::Info;
use crate::mathlib::*;
use crate::pmove::UserCmd;
use crate::world::*;

pub const BOT_NAMES: [&str; 32] = [
    "Ranger", "Grunt", "Shambler", "Vore", "Ogre", "Fiend", "Knight", "Zombie", "Scrag", "Enforcer", "Rotfish", "Spawn",
    "Chthon", "Shub", "Hellknight", "Death Knight", "Wizard", "Tarbaby", "Dog", "Soldier", "Gaunt", "Lavaman", "Ithaqua",
    "Dagon", "Hastur", "Nyarlat", "Azathoth", "Yog", "Tsath", "Byakhee", "Mi-Go", "Ghast",
];

pub fn bot_userinfo(slot: usize) -> Info {
    let mut i = Info::default();
    i.set(b"name", BOT_NAMES[slot % 32].as_bytes());
    let top = (slot * 3 % 13).to_string();
    let bottom = (slot * 7 % 13).to_string();
    i.set(b"topcolor", top.as_bytes());
    i.set(b"bottomcolor", bottom.as_bytes());
    i.set(b"skin", b"base");
    i.set(b"*bot", b"1");
    i
}

/// bot skill for a slot: serverinfo `botskill` (1..5, default 3), spread ±1 by slot
pub fn bot_skill(sv: &Server, slot: usize) -> u8 {
    let b = sv.serverinfo.get(b"botskill");
    let base = if b.is_empty() { 3 } else { qcvm::atoi(b).clamp(1, 5) };
    (base + (slot as i32 % 3) - 1).clamp(1, 5) as u8
}

impl Server {
    /// slot is driven by a bot this tick (a bot, or an idle human's body)
    pub fn bot_driven(&self, slot: usize) -> bool {
        let c = &self.clients[slot];
        c.spawned && (c.state == CS_BOT || c.state == CS_IDLE)
    }

    /// step 1 of the tick: every bot-driven slot gets its usercmd
    pub fn bots_think(&mut self, vm: &mut Vm) {
        if !(0..self.maxclients).any(|s| self.bot_driven(s)) {
            return;
        }
        let mut sys = std::mem::take(&mut self.botsys);
        sys.think_all(self, vm);
        self.botsys = sys;
    }
}

// ====================================================================== qtbots

#[cfg(feature = "bots")]
mod imp {
    use super::*;
    use std::cell::RefCell;
    use std::collections::BTreeMap;
    use std::sync::Arc;

    use qtbots::{BotWorld, Bots, ClientInfo, EntInfo, NavGraph};

    #[derive(Clone)]
    pub struct BotSys {
        pub bots: Bots,
        /// built from a canonical fresh spawn of the map (see `nav_for`), never serialized
        pub nav: Option<Arc<NavGraph>>,
    }

    impl Default for BotSys {
        fn default() -> Self {
            BotSys { bots: Bots::new(0), nav: None }
        }
    }

    type NavKey = (u64, u64, Vec<u8>);
    thread_local! {
        static NAV_CACHE: RefCell<BTreeMap<NavKey, Arc<NavGraph>>> = RefCell::new(BTreeMap::new());
        static BUILDING: RefCell<bool> = const { RefCell::new(false) };
    }

    /// The nav graph of a map: built once per (map, progs, spawn serverinfo) from a
    /// fresh spawn with no clients and seed 0, so every peer — also one that joins
    /// from a snapshot later — has the identical graph.
    fn nav_for(sv: &Server) -> Arc<NavGraph> {
        let key = (sv.map.fingerprint, sv.progs.fingerprint(), sv.spawn_info.clone());
        if let Some(n) = NAV_CACHE.with(|c| c.borrow().get(&key).cloned()) {
            return n;
        }
        let mut info = Info::parse(&sv.spawn_info);
        info.set(b"bots", b"0");
        BUILDING.with(|b| *b.borrow_mut() = true);
        let fresh = crate::World::new(sv.progs.clone(), sv.maps.clone(), sv.map_id, 0, &info.encode());
        BUILDING.with(|b| *b.borrow_mut() = false);
        let nav = match fresh {
            Ok(mut w) => {
                let mut view = View { vm: &mut w.vm, sv: &mut w.sv };
                Arc::new(NavGraph::build(&mut view))
            }
            Err(_) => {
                // the map does not spawn: a graph of the bare BSP (still deterministic)
                let mut s2 = sv.clone();
                s2.clear_world();
                let cfg = qcvm::VmConfig { client_edicts: sv.maxclients as u32, ..qcvm::VmConfig::default() };
                let mut vm = qcvm::Vm::new(sv.progs.clone(), cfg, 0);
                let mut view = View { vm: &mut vm, sv: &mut s2 };
                Arc::new(NavGraph::build(&mut view))
            }
        };
        NAV_CACHE.with(|c| c.borrow_mut().insert(key, nav.clone()));
        nav
    }

    impl BotSys {
        pub fn new(maxclients: usize) -> BotSys {
            BotSys { bots: Bots::new(maxclients as u32), nav: None }
        }
        pub fn add(&mut self, slot: usize, skill: u8) {
            self.bots.add(slot as u32, skill);
        }
        pub fn remove(&mut self, slot: usize) {
            self.bots.remove(slot as u32);
        }
        /// a new map: the graph is rebuilt lazily and every bot gets a fresh brain
        pub fn new_map(&mut self, maxclients: usize) {
            self.nav = None;
            for slot in 0..maxclients as u32 {
                if self.bots.is_bot(slot) {
                    let sk = self.bots.skill(slot);
                    self.bots.add(slot, sk);
                }
            }
        }
        pub fn serialize(&self, out: &mut Vec<u8>) {
            self.bots.serialize(out);
        }
        pub fn hash(&self) -> u64 {
            self.bots.hash()
        }
        pub fn deserialize(b: &[u8]) -> Result<(BotSys, usize), String> {
            let (bots, used) = Bots::deserialize(b)?;
            Ok((BotSys { bots, nav: None }, used))
        }

        pub fn think_all(&mut self, sv: &mut Server, vm: &mut Vm) {
            if BUILDING.with(|b| *b.borrow()) {
                return;
            }
            if self.nav.is_none() {
                self.nav = Some(nav_for(sv));
            }
            let nav = self.nav.clone().unwrap();
            self.bots.begin_tick();
            for slot in 0..sv.maxclients {
                if !sv.bot_driven(slot) {
                    continue;
                }
                if !self.bots.is_bot(slot as u32) {
                    self.bots.add(slot as u32, bot_skill(sv, slot));
                }
                let cmd = {
                    let mut view = View { vm: &mut *vm, sv: &mut *sv };
                    self.bots.think(&mut view, &nav, slot as u32)
                };
                let a = |s: i32| ((s as i16) as f64 * (360.0 / 65536.0)) as f32;
                sv.clients[slot].cmd = UserCmd {
                    msec: sv.tick_msec,
                    angles: [a(cmd.pitch16), a(cmd.yaw16), 0.0],
                    forwardmove: cmd.forward.clamp(-500, 500) as i16,
                    sidemove: cmd.side.clamp(-500, 500) as i16,
                    upmove: cmd.up.clamp(-500, 500) as i16,
                    buttons: (cmd.buttons & 0xff) as u8,
                    impulse: (cmd.impulse & 0xff) as u8,
                };
            }
        }
    }

    /// The engine side of `qtbots::BotWorld`.
    pub struct View<'a> {
        pub vm: &'a mut Vm,
        pub sv: &'a mut Server,
    }

    fn team_of(vm: &Vm, sv: &Server, e: Ent) -> i32 {
        let t = vm.e_f(e, fld::TEAM) as i32;
        if t != 0 {
            return t;
        }
        if sv.is_client(e) {
            let s = sv.clients[e as usize - 1].userinfo.get(b"team");
            if !s.is_empty() {
                return crate::views::crc_block(s) as i32 | 0x10000;
            }
        }
        0
    }

    fn is_static_brush(vm: &Vm, e: Ent) -> bool {
        e < vm.num_edicts()
            && !vm.is_free(e)
            && vm.e_f(e, fld::SOLID) as i32 == SOLID_BSP
            && vm.e_f(e, fld::MOVETYPE) as i32 == MOVETYPE_PUSH
            && vm.e_fn(e, fld::THINK) == 0
    }

    fn to_bt(t: crate::trace::Trace) -> qtbots::Trace {
        qtbots::Trace { fraction: t.fraction, endpos: t.endpos, normal: t.normal, allsolid: t.allsolid, startsolid: t.startsolid, ent: t.ent }
    }

    impl BotWorld for View<'_> {
        fn time(&self) -> f64 {
            self.sv.time
        }
        fn maxclients(&self) -> u32 {
            self.sv.maxclients as u32
        }
        fn teamplay(&self) -> i32 {
            self.sv.cvar(b"teamplay") as i32
        }
        fn client(&self, slot: u32) -> Option<ClientInfo> {
            let (vm, sv) = (&*self.vm, &*self.sv);
            let c = sv.clients.get(slot as usize)?;
            if !c.spawned {
                return None;
            }
            let e = slot + 1;
            let health = vm.e_f(e, fld::HEALTH);
            Some(ClientInfo {
                entnum: e,
                alive: health > 0.0 && vm.e_f(e, fld::DEADFLAG) == 0.0 && vm.e_f(e, fld::SOLID) as i32 != SOLID_NOT,
                origin: vm.e_v(e, fld::ORIGIN),
                velocity: vm.e_v(e, fld::VELOCITY),
                v_angle: vm.e_v(e, fld::V_ANGLE),
                view_ofs_z: vm.e_v(e, fld::VIEW_OFS)[2],
                health,
                armorvalue: vm.e_f(e, fld::ARMORVALUE),
                armortype: vm.e_f(e, fld::ARMORTYPE),
                items: vm.e_f(e, fld::ITEMS) as i32 as u32,
                weapon: vm.e_f(e, fld::WEAPON) as i32 as u32,
                ammo: [vm.e_f(e, fld::AMMO_SHELLS), vm.e_f(e, fld::AMMO_NAILS), vm.e_f(e, fld::AMMO_ROCKETS), vm.e_f(e, fld::AMMO_CELLS)],
                team: team_of(vm, sv, e),
                onground: vm.e_f(e, fld::FLAGS) as i32 & FL_ONGROUND != 0,
                waterlevel: vm.e_f(e, fld::WATERLEVEL) as i32,
                frags: vm.e_f(e, fld::FRAGS) as i32,
                effects: vm.e_f(e, fld::EFFECTS) as i32 as u32,
            })
        }
        fn num_edicts(&self) -> u32 {
            self.vm.num_edicts()
        }
        fn entity(&self, e: u32) -> Option<EntInfo<'_>> {
            let vm = &*self.vm;
            if e >= vm.num_edicts() || vm.is_free(e) {
                return None;
            }
            Some(EntInfo {
                num: e,
                classname: vm.e_str(e, fld::CLASSNAME),
                model: vm.e_str(e, fld::MODEL),
                target: vm.e_str(e, fld::TARGET),
                targetname: vm.e_str(e, fld::TARGETNAME),
                origin: vm.e_v(e, fld::ORIGIN),
                mins: vm.e_v(e, fld::MINS),
                maxs: vm.e_v(e, fld::MAXS),
                absmin: vm.e_v(e, fld::ABSMIN),
                absmax: vm.e_v(e, fld::ABSMAX),
                velocity: vm.e_v(e, fld::VELOCITY),
                solid: vm.e_f(e, fld::SOLID) as i32,
                movetype: vm.e_f(e, fld::MOVETYPE) as i32,
                flags: vm.e_f(e, fld::FLAGS) as i32 as u32,
                spawnflags: vm.e_f(e, fld::SPAWNFLAGS) as i32 as u32,
                modelindex: vm.e_f(e, fld::MODELINDEX) as i32,
                effects: vm.e_f(e, fld::EFFECTS) as i32 as u32,
                health: vm.e_f(e, fld::HEALTH),
                team: team_of(vm, self.sv, e),
                owner: vm.e_e(e, fld::OWNER),
                movedir: vm.e_v(e, fld::MOVEDIR),
                speed: self.sv.progs.find_field("speed").map(|d| vm.e_f(e, d.ofs)).unwrap_or(0.0),
            })
        }
        fn trace(&mut self, start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3, nomonsters: bool, passent: u32) -> qtbots::Trace {
            let ty = if nomonsters { MOVE_NOMONSTERS } else { MOVE_NORMAL };
            let t = self.sv.sv_move(&*self.vm, &start, &mins, &maxs, &end, ty, Some(passent));
            to_bt(t)
        }
        fn trace_world(&mut self, start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3) -> qtbots::Trace {
            let vm = &*self.vm;
            // static brush entities (func_wall …) are collected once per map and
            // re-checked on every trace, so a trace costs O(statics), not O(edicts)
            if self.sv.static_brushes.is_none() {
                let list: Vec<Ent> = (1..vm.num_edicts()).filter(|&e| is_static_brush(vm, e)).collect();
                self.sv.static_brushes = Some(list);
            }
            let list = self.sv.static_brushes.take().unwrap_or_default();
            let mut best = self.sv.clip_world_only(vm, 0, &start, &mins, &maxs, &end);
            for &e in &list {
                if !is_static_brush(vm, e) {
                    continue;
                }
                let t = self.sv.clip_world_only(vm, e, &start, &mins, &maxs, &end);
                if t.allsolid || t.startsolid || t.fraction < best.fraction {
                    let started = best.startsolid;
                    best = t;
                    best.startsolid |= started;
                }
            }
            self.sv.static_brushes = Some(list);
            to_bt(best)
        }
        fn point_contents(&self, p: Vec3) -> i32 {
            self.sv.point_contents(&p)
        }
        fn world_bounds(&self) -> (Vec3, Vec3) {
            let m = &self.sv.map.models[0];
            (m.mins, m.maxs)
        }
        fn random(&mut self) -> u32 {
            self.vm.rng_u32()
        }
    }
}

// ====================================================================== placeholder

#[cfg(not(feature = "bots"))]
mod imp {
    use super::*;

    #[derive(Clone, Debug, Default, PartialEq)]
    pub struct BotState {
        pub active: bool,
        pub yaw: f32,
        pub pitch: f32,
        pub stuck: u32,
        pub turn: f32,
        pub jump_hold: u32,
    }

    #[derive(Clone, Default)]
    pub struct BotSys {
        pub states: Vec<BotState>,
    }

    impl BotSys {
        pub fn new(maxclients: usize) -> BotSys {
            BotSys { states: vec![BotState::default(); maxclients] }
        }
        pub fn add(&mut self, slot: usize, _skill: u8) {
            if let Some(s) = self.states.get_mut(slot) {
                *s = BotState { active: true, ..Default::default() };
            }
        }
        pub fn remove(&mut self, slot: usize) {
            if let Some(s) = self.states.get_mut(slot) {
                *s = BotState::default();
            }
        }
        pub fn new_map(&mut self, _maxclients: usize) {}
        pub fn hash(&self) -> u64 {
            let mut b = Vec::new();
            self.serialize(&mut b);
            b.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, &x| (h ^ x as u64).wrapping_mul(0x0100_0000_01b3))
        }
        pub fn serialize(&self, out: &mut Vec<u8>) {
            out.extend_from_slice(&(self.states.len() as u32).to_le_bytes());
            for s in &self.states {
                out.push(s.active as u8);
                for x in [s.yaw, s.pitch, s.turn] {
                    out.extend_from_slice(&canon(x).to_le_bytes());
                }
                out.extend_from_slice(&s.stuck.to_le_bytes());
                out.extend_from_slice(&s.jump_hold.to_le_bytes());
            }
        }
        pub fn deserialize(b: &[u8]) -> Result<(BotSys, usize), String> {
            let rd = |o: usize| -> Result<u32, String> {
                b.get(o..o + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]])).ok_or_else(|| "bots: short".to_string())
            };
            let n = rd(0)? as usize;
            if n > 32 {
                return Err("bots: bad count".into());
            }
            let mut p = 4;
            let mut states = Vec::with_capacity(n);
            for _ in 0..n {
                let active = *b.get(p).ok_or("bots: short")? != 0;
                p += 1;
                let yaw = f32::from_bits(rd(p)?);
                let pitch = f32::from_bits(rd(p + 4)?);
                let turn = f32::from_bits(rd(p + 8)?);
                let stuck = rd(p + 12)?;
                let jump_hold = rd(p + 16)?;
                p += 20;
                states.push(BotState { active, yaw, pitch, stuck, turn, jump_hold });
            }
            Ok((BotSys { states }, p))
        }

        pub fn think_all(&mut self, sv: &mut Server, vm: &mut Vm) {
            for slot in 0..sv.maxclients {
                if sv.bot_driven(slot) {
                    let mut b = std::mem::take(&mut self.states[slot]);
                    sv.clients[slot].cmd = placeholder_think(sv, vm, slot, &mut b);
                    self.states[slot] = b;
                }
            }
        }
    }

    fn ang16(deg: f32) -> f32 {
        let s = ((deg as f64 * 65536.0 / 360.0) as i64 & 0xffff) as u16 as i16;
        (s as f64 * (360.0 / 65536.0)) as f32
    }

    /// runs forward, turns away from walls, jumps now and then, shoots at the nearest
    /// visible enemy (not a teammate), respawns when dead
    fn placeholder_think(sv: &mut Server, vm: &mut Vm, slot: usize, b: &mut BotState) -> UserCmd {
        let e = Server::slot_edict(slot);
        let origin = vm.e_v(e, fld::ORIGIN);
        let mut cmd = UserCmd { msec: TICK_MSEC, ..Default::default() };
        if vm.e_f(e, fld::HEALTH) <= 0.0 {
            cmd.buttons = if (sv.tick_count / 20) % 2 == 0 { 1 } else { 0 };
            return cmd;
        }
        let eye = add(&origin, &vm.e_v(e, fld::VIEW_OFS));
        let mut best: Option<(f32, Ent)> = None;
        let teamplay = sv.cvar(b"teamplay") != 0.0;
        let myteam = sv.clients[slot].userinfo.get(b"team").to_vec();
        for other in 1..=sv.maxclients as Ent {
            if other == e || !sv.clients[other as usize - 1].spawned || vm.e_f(other, fld::HEALTH) <= 0.0 {
                continue;
            }
            if teamplay && !myteam.is_empty() && sv.clients[other as usize - 1].userinfo.get(b"team") == myteam.as_slice() {
                continue;
            }
            let oo = vm.e_v(other, fld::ORIGIN);
            let dist = length(&sub(&oo, &eye));
            if dist > 1500.0 || best.map_or(false, |(bd, _)| bd < dist) {
                continue;
            }
            let tr = sv.sv_move(vm, &eye, &VEC3_ORIGIN, &VEC3_ORIGIN, &oo, MOVE_NOMONSTERS, Some(e));
            if tr.fraction == 1.0 {
                best = Some((dist, other));
            }
        }
        let v = vm.e_v(e, fld::VELOCITY);
        let speed = length(&[v[0], v[1], 0.0]);
        if let Some((_, target)) = best {
            let d = sub(&vm.e_v(target, fld::ORIGIN), &eye);
            let a = qcvm::math::vectoangles(d);
            b.yaw = a[1] + (vm.rng_f01() - 0.5) * 6.0;
            b.pitch = -(if a[0] > 180.0 { a[0] - 360.0 } else { a[0] });
            cmd.buttons |= if vm.rng_u32() % 4 != 0 { 1 } else { 0 };
            cmd.sidemove = if (sv.tick_count / 40 + slot as u32) % 2 == 0 { 350 } else { -350 };
        } else {
            b.pitch = 0.0;
            if speed < 60.0 {
                b.stuck += 1;
            } else {
                b.stuck = 0;
            }
            if b.stuck > 8 {
                b.turn = (vm.rng_f01() - 0.5) * 300.0;
                b.stuck = 0;
                b.jump_hold = 3;
            }
            if b.turn != 0.0 {
                let step = b.turn.clamp(-9.0, 9.0);
                b.yaw += step;
                b.turn -= step;
            }
        }
        b.yaw = anglemod(b.yaw);
        cmd.forwardmove = 400;
        if b.jump_hold > 0 {
            b.jump_hold -= 1;
            cmd.buttons |= 2;
        } else if vm.rng_u32() % 200 == 0 {
            b.jump_hold = 2;
        }
        if vm.rng_u32() % 400 == 0 {
            cmd.impulse = (2 + vm.rng_u32() % 7) as u8;
        }
        cmd.angles = [ang16(b.pitch), ang16(b.yaw), 0.0];
        cmd
    }
}

pub use imp::BotSys;
