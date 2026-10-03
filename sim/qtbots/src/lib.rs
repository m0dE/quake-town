// Quake Town - qtbots: mod-agnostic bots that drive a slot through QW usercmds
// Copyright (C) 2026 Quake Town contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// This program is free software; you can redistribute it and/or modify it under the terms
// of the GNU General Public License as published by the Free Software Foundation; either
// version 2 of the License, or (at your option) any later version.

//! Bots that play like humans: they read the world through [`BotWorld`] and output one
//! QuakeWorld usercmd per tick. See `API.md` and DESIGN.md (`sim/qtbots`).

mod astar;
mod bot;
pub mod math;
mod nav;
mod ser;
mod skill;

pub use bot::{Bots, BotDebug};
pub use nav::{Link, LinkKind, NavGraph, NavStats, Node, GoalKind};
pub use skill::Skill;

pub type Vec3 = [f32; 3];

/// Result of a box trace (SV_Move / SV_RecursiveHullCheck).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Trace {
    pub fraction: f32,
    pub endpos: Vec3,
    pub normal: Vec3,
    pub allsolid: bool,
    pub startsolid: bool,
    /// Edict hit: -1 none, 0 world, n.
    pub ent: i32,
}

/// A player slot with a body.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct ClientInfo {
    pub entnum: u32,
    pub alive: bool,
    pub origin: Vec3,
    pub velocity: Vec3,
    pub v_angle: Vec3,
    pub view_ofs_z: f32,
    pub health: f32,
    pub armorvalue: f32,
    pub armortype: f32,
    pub items: u32,
    pub weapon: u32,
    /// shells, nails, rockets, cells
    pub ammo: [f32; 4],
    pub team: i32,
    pub onground: bool,
    pub waterlevel: i32,
    pub frags: i32,
    pub effects: u32,
}

/// A live edict.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EntInfo<'a> {
    pub num: u32,
    pub classname: &'a [u8],
    pub model: &'a [u8],
    pub target: &'a [u8],
    pub targetname: &'a [u8],
    pub origin: Vec3,
    pub mins: Vec3,
    pub maxs: Vec3,
    pub absmin: Vec3,
    pub absmax: Vec3,
    pub velocity: Vec3,
    pub solid: i32,
    pub movetype: i32,
    pub flags: u32,
    pub spawnflags: u32,
    pub modelindex: i32,
    pub effects: u32,
    pub health: f32,
    pub team: i32,
    pub owner: u32,
}

/// What the engine exposes to bots. See API.md.
pub trait BotWorld {
    fn time(&self) -> f64;
    fn maxclients(&self) -> u32;
    fn teamplay(&self) -> i32;
    fn client(&self, slot: u32) -> Option<ClientInfo>;
    fn num_edicts(&self) -> u32;
    fn entity(&self, e: u32) -> Option<EntInfo<'_>>;
    fn trace(&self, start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3, nomonsters: bool, passent: u32) -> Trace;
    fn trace_world(&self, start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3) -> Trace;
    fn point_contents(&self, p: Vec3) -> i32;
    fn world_bounds(&self) -> (Vec3, Vec3);
    fn random(&mut self) -> u32;
}

/// One QuakeWorld usercmd (msec is always the tick).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct UserCmd {
    pub pitch16: i32,
    pub yaw16: i32,
    pub forward: i32,
    pub side: i32,
    pub up: i32,
    pub buttons: u32,
    pub impulse: u32,
}

pub const BUTTON_ATTACK: u32 = 1;
pub const BUTTON_JUMP: u32 = 2;

/// QW `ANGLE2SHORT` (wrapped to i16 range).
pub fn angle2short(deg: f32) -> i32 {
    ((deg * 65536.0 / 360.0) as i32 & 65535) as i16 as i32
}
/// QW `SHORT2ANGLE`.
pub fn short2angle(s: i32) -> f32 {
    s as f32 * (360.0 / 65536.0)
}

/// QW items bits.
pub mod it {
    pub const SHOTGUN: u32 = 1;
    pub const SUPER_SHOTGUN: u32 = 2;
    pub const NAILGUN: u32 = 4;
    pub const SUPER_NAILGUN: u32 = 8;
    pub const GRENADE_LAUNCHER: u32 = 16;
    pub const ROCKET_LAUNCHER: u32 = 32;
    pub const LIGHTNING: u32 = 64;
    pub const AXE: u32 = 4096;
    pub const ARMOR1: u32 = 8192;
    pub const ARMOR2: u32 = 16384;
    pub const ARMOR3: u32 = 32768;
    pub const SUPERHEALTH: u32 = 65536;
    pub const KEY1: u32 = 131072;
    pub const KEY2: u32 = 262144;
    pub const INVISIBILITY: u32 = 524288;
    pub const INVULNERABILITY: u32 = 1048576;
    pub const SUIT: u32 = 2097152;
    pub const QUAD: u32 = 4194304;
}

/// QW contents.
pub mod contents {
    pub const EMPTY: i32 = -1;
    pub const SOLID: i32 = -2;
    pub const WATER: i32 = -3;
    pub const SLIME: i32 = -4;
    pub const LAVA: i32 = -5;
    pub const SKY: i32 = -6;
}

pub const PLAYER_MINS: Vec3 = [-16.0, -16.0, -24.0];
pub const PLAYER_MAXS: Vec3 = [16.0, 16.0, 32.0];
pub const ZERO: Vec3 = [0.0; 3];
