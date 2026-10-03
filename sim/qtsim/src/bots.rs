// Bot glue: which slots are bot-driven, their userinfo, and the usercmd they produce.
// Until `qtbots` lands this is a placeholder bot that roams: runs forward, turns away
// from walls, jumps now and then, shoots at visible enemies, respawns when dead.
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

#[derive(Clone, Debug, Default, PartialEq)]
pub struct BotState {
    pub yaw: f32,
    pub pitch: f32,
    pub stuck: u32,
    pub last_origin: Vec3,
    pub turn: f32,
    pub jump_hold: u32,
    pub enemy: u32,
}

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

fn ang16(deg: f32) -> f32 {
    let s = ((deg as f64 * 65536.0 / 360.0) as i64 & 0xffff) as u16 as i16;
    (s as f64 * (360.0 / 65536.0)) as f32
}

impl Server {
    /// slot is driven by a bot this tick (a bot, or an idle human's body)
    pub fn bot_driven(&self, slot: usize) -> bool {
        let c = &self.clients[slot];
        c.spawned && (c.state == CS_BOT || c.state == CS_IDLE)
    }

    /// Placeholder bot think: sets clients[slot].cmd.
    pub fn bot_think(&mut self, vm: &mut Vm, slot: usize) {
        let e = Self::slot_edict(slot);
        let mut b = std::mem::take(&mut self.clients[slot].bot);
        let origin = vm.e_v(e, fld::ORIGIN);
        let mut cmd = UserCmd { msec: TICK_MSEC, ..Default::default() };

        if vm.e_f(e, fld::HEALTH) <= 0.0 {
            // dead: press fire every other half second to respawn
            cmd.buttons = if (self.tick_count / 20) % 2 == 0 { 1 } else { 0 };
            self.clients[slot].cmd = cmd;
            self.clients[slot].bot = b;
            return;
        }

        // pick the nearest visible enemy
        let eye = add(&origin, &vm.e_v(e, fld::VIEW_OFS));
        let mut best: Option<(f32, Ent)> = None;
        for other in 1..=self.maxclients as Ent {
            if other == e || !self.clients[other as usize - 1].spawned || vm.e_f(other, fld::HEALTH) <= 0.0 {
                continue;
            }
            let oo = vm.e_v(other, fld::ORIGIN);
            let d = sub(&oo, &eye);
            let dist = length(&d);
            if dist > 1500.0 || best.map_or(false, |(bd, _)| bd < dist) {
                continue;
            }
            let tr = self.sv_move(vm, &eye, &VEC3_ORIGIN, &VEC3_ORIGIN, &oo, MOVE_NOMONSTERS, Some(e));
            if tr.fraction == 1.0 {
                best = Some((dist, other));
            }
        }

        let speed = length(&[vm.e_v(e, fld::VELOCITY)[0], vm.e_v(e, fld::VELOCITY)[1], 0.0]);
        if let Some((_, target)) = best {
            let d = sub(&vm.e_v(target, fld::ORIGIN), &eye);
            let a = qcvm::math::vectoangles(d);
            b.yaw = a[1] + (vm.rng_f01() - 0.5) * 6.0;
            b.pitch = -(if a[0] > 180.0 { a[0] - 360.0 } else { a[0] });
            cmd.buttons |= if vm.rng_u32() % 4 != 0 { 1 } else { 0 };
            cmd.sidemove = if (self.tick_count / 40 + slot as u32) % 2 == 0 { 350 } else { -350 };
            b.enemy = target;
        } else {
            b.enemy = 0;
            b.pitch = 0.0;
            // wander: turn when stuck
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
        // weapon switch now and then
        if vm.rng_u32() % 400 == 0 {
            cmd.impulse = (2 + vm.rng_u32() % 7) as u8;
        }
        cmd.angles = [ang16(b.pitch), ang16(b.yaw), 0.0];
        b.last_origin = origin;
        self.clients[slot].cmd = cmd;
        self.clients[slot].bot = b;
    }
}
