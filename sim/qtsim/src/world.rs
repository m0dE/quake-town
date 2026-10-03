/*
Copyright (C) 1996-1997 Id Software, Inc.
Copyright (C) 2026 Quake Town authors.

This program is free software; you can redistribute it and/or
modify it under the terms of the GNU General Public License
as published by the Free Software Foundation; either version 2
of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

See the GNU General Public License for more details.
*/
//! The world: server state (`Server`, QW's `sv` + `svs`) next to the QuakeC VM, and a
//! port of QW/server/world.c (area nodes, edict linking, SV_Move, touch links).

use std::sync::Arc;

use qcvm::defs::{fld, glob};
use qcvm::{Ent, Func, Progs, Vm, VmError};

use crate::bsp::*;
use crate::events::*;
use crate::info::Info;
use crate::mathlib::*;
use crate::pmove::{MoveVars, PhysEnt, UserCmd};
use crate::trace::*;

pub const SOLID_NOT: i32 = 0;
pub const SOLID_TRIGGER: i32 = 1;
pub const SOLID_BBOX: i32 = 2;
pub const SOLID_SLIDEBOX: i32 = 3;
pub const SOLID_BSP: i32 = 4;

pub const MOVETYPE_NONE: i32 = 0;
pub const MOVETYPE_ANGLENOCLIP: i32 = 1;
pub const MOVETYPE_ANGLECLIP: i32 = 2;
pub const MOVETYPE_WALK: i32 = 3;
pub const MOVETYPE_STEP: i32 = 4;
pub const MOVETYPE_FLY: i32 = 5;
pub const MOVETYPE_TOSS: i32 = 6;
pub const MOVETYPE_PUSH: i32 = 7;
pub const MOVETYPE_NOCLIP: i32 = 8;
pub const MOVETYPE_FLYMISSILE: i32 = 9;
pub const MOVETYPE_BOUNCE: i32 = 10;

pub const FL_FLY: i32 = 1;
pub const FL_SWIM: i32 = 2;
pub const FL_CLIENT: i32 = 8;
pub const FL_INWATER: i32 = 16;
pub const FL_MONSTER: i32 = 32;
pub const FL_GODMODE: i32 = 64;
pub const FL_NOTARGET: i32 = 128;
pub const FL_ITEM: i32 = 256;
pub const FL_ONGROUND: i32 = 512;
pub const FL_PARTIALGROUND: i32 = 1024;
pub const FL_WATERJUMP: i32 = 2048;

pub const MOVE_NORMAL: i32 = 0;
pub const MOVE_NOMONSTERS: i32 = 1;
pub const MOVE_MISSILE: i32 = 2;

pub const MAX_LIGHTSTYLES: usize = 64;
pub const MAX_MODELS: usize = 256;
pub const MAX_SOUNDS: usize = 256;
pub const NUM_SPAWN_PARMS: usize = 16;
pub const NUM_QT_STATS: usize = 24;

/// The sim tick: msec 13 (DESIGN.md "Tick rate and time").
pub const TICK_MSEC: u8 = 13;

const AREA_DEPTH: i32 = 4;
const NIL: u32 = u32::MAX;

/// Client slot state as the ABI reports it.
pub const CS_EMPTY: u8 = 0;
pub const CS_HUMAN: u8 = 1;
pub const CS_BOT: u8 = 2;
pub const CS_IDLE: u8 = 3;

#[derive(Clone, Copy, Debug)]
pub struct AreaNode {
    pub axis: i32,
    pub dist: f32,
    pub children: [u32; 2],
}

#[derive(Clone, Copy, Debug)]
pub struct Link {
    pub prev: u32,
    pub next: u32,
}

/// One client slot (QW client_t, the parts the sim needs).
#[derive(Clone, Debug)]
pub struct Client {
    pub state: u8,
    /// cs_spawned: has a body in the game
    pub spawned: bool,
    pub userinfo: Info,
    pub name: Vec<u8>,
    /// the held usercmd (last command wins)
    pub cmd: UserCmd,
    pub oldbuttons: i32,
    pub spawn_parms: [f32; NUM_SPAWN_PARMS],
    pub entgravity: f32,
    pub maxspeed: f32,
    pub stats: [i32; NUM_QT_STATS],
    // outputs of the last tick (not hashed)
    pub out_fixangle: Option<Vec3>,
    pub out_dmg: Option<(f32, f32, Vec3)>,
}

impl Client {
    pub fn new() -> Client {
        Client {
            state: CS_EMPTY,
            spawned: false,
            userinfo: Info::default(),
            name: Vec::new(),
            cmd: UserCmd { msec: TICK_MSEC, ..Default::default() },
            oldbuttons: 0,
            spawn_parms: [0.0; NUM_SPAWN_PARMS],
            entgravity: 1.0,
            maxspeed: 320.0,
            stats: [0; NUM_QT_STATS],
            out_fixangle: None,
            out_dmg: None,
        }
    }
}

impl Default for Client {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct StaticEnt {
    pub modelindex: i32,
    pub frame: i32,
    pub colormap: i32,
    pub skin: i32,
    pub origin: Vec3,
    pub angles: Vec3,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Ambient {
    pub sound: i32,
    pub volume: i32,
    pub atten: i32,
    pub origin: Vec3,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MatchState {
    pub phase: f32,
    pub endtime: f32,
    pub countdown: f32,
    pub score1: f32,
    pub score2: f32,
    pub round: f32,
}

/// Optional QC fields some mods define (found by name at load).
#[derive(Clone, Copy, Debug, Default)]
pub struct ExtFields {
    pub gravity: Option<u32>,
    pub maxspeed: Option<u32>,
    pub alpha: Option<u32>,
}

/// Engine-called QC functions that are not in progdefs (found by name).
#[derive(Clone, Copy, Debug, Default)]
pub struct ExtFuncs {
    pub parse_client_command: Option<Func>,
    pub userinfo_changed: Option<Func>,
}

/// Everything but the VM. Implements `qcvm::Host`.
#[derive(Clone)]
pub struct Server {
    pub progs: Arc<Progs>,
    pub maps: Vec<Arc<Map>>,
    pub map_id: u32,
    pub map: Arc<Map>,
    pub ext: ExtFields,
    pub extf: ExtFuncs,

    pub seed: u64,
    pub tick_count: u32,
    /// ticks since this map was spawned (time = 1.0 + map_ticks * 0.013)
    pub map_ticks: u32,
    pub time: f64,
    /// QW host_frametime
    pub frametime: f64,
    pub maxclients: usize,
    pub bots_enabled: bool,
    pub serverinfo: Info,
    pub cvars: std::collections::BTreeMap<Vec<u8>, Vec<u8>>,
    pub movevars: MoveVars,

    pub model_precache: Vec<Vec<u8>>,
    pub sound_precache: Vec<Vec<u8>>,
    /// modelindex -> brush submodel (-1 = not a brush model)
    pub model_sub: Vec<i32>,
    pub lightstyles: Vec<Vec<u8>>,
    pub loading: bool,
    pub serverflags: f32,

    pub clients: Vec<Client>,
    pub botsys: crate::bots::BotSys,
    /// serverinfo when this map was spawned (keys the bots' nav graph)
    pub spawn_info: Vec<u8>,
    /// derived cache for the bots' static-world traces (not state)
    pub static_brushes: Option<Vec<Ent>>,

    pub areanodes: Vec<AreaNode>,
    pub links: Vec<Link>,
    pub max_edicts: u32,

    pub lastcheck: i32,
    pub lastchecktime: f64,
    pub checkpvs: Vec<u8>,

    pub statics: Vec<StaticEnt>,
    pub ambients: Vec<Ambient>,
    pub changelevel: Option<Vec<u8>>,
    pub matchstate: MatchState,
    /// svc_intermission seen on this map (origin)
    pub intermission: Option<Vec3>,

    /// set when the world stopped on a fatal QuakeC error
    pub error: Option<String>,

    // ---- per tick, not part of the state
    pub sink: EventSink,
    /// events made between ticks (join, commands, userinfo): delivered with the next tick
    pub pending: EventSink,
    pub buf_all: MsgBuf,
    pub buf_multicast: MsgBuf,
    pub buf_one: Vec<MsgBuf>,
    pub boxhull: Box<BoxHull>,
    pub physents: Vec<PhysEnt>,
    pub playertouch: Vec<u8>,
    /// dprint / error output (qtrun prints it); not part of the state
    pub log: Vec<u8>,
    pub log_enabled: bool,
}

/// A world: the VM plus the server.
#[derive(Clone)]
pub struct World {
    pub vm: Vm,
    pub sv: Server,
}

/// moveclip_t
struct MoveClip {
    boxmins: Vec3,
    boxmaxs: Vec3,
    mins: Vec3,
    maxs: Vec3,
    mins2: Vec3,
    maxs2: Vec3,
    start: Vec3,
    end: Vec3,
    trace: Trace,
    ty: i32,
    passedict: Option<Ent>,
}

impl Server {
    // ------------------------------------------------------------------ field helpers
    #[inline]
    pub fn solid(vm: &Vm, e: Ent) -> i32 {
        vm.e_f(e, fld::SOLID) as i32
    }
    #[inline]
    pub fn flags(vm: &Vm, e: Ent) -> i32 {
        vm.e_f(e, fld::FLAGS) as i32
    }
    #[inline]
    pub fn set_flags(vm: &mut Vm, e: Ent, f: i32) {
        vm.set_e_f(e, fld::FLAGS, f as f32);
    }

    pub fn is_client(&self, e: Ent) -> bool {
        e >= 1 && (e as usize) <= self.maxclients
    }

    pub fn log(&mut self, s: &str) {
        if self.log_enabled {
            self.log.extend_from_slice(s.as_bytes());
        }
    }

    /// QC call with self/other/time set as QW does around PR_ExecuteProgram.
    pub fn call(&mut self, vm: &mut Vm, f: Func) -> Result<(), VmError> {
        vm.call(self, f)
    }

    // ------------------------------------------------------------------ area nodes

    /// SV_ClearWorld
    pub fn clear_world(&mut self) {
        self.areanodes.clear();
        let m = &self.map.models[0];
        let (mins, maxs) = (m.mins, m.maxs);
        self.create_area_node(0, mins, maxs);
        self.links = vec![Link { prev: NIL, next: NIL }; self.max_edicts as usize + self.areanodes.len() * 2];
        for n in 0..self.areanodes.len() {
            for k in 0..2 {
                let h = self.head(n as u32, k == 0);
                self.links[h as usize] = Link { prev: h, next: h };
            }
        }
    }

    fn create_area_node(&mut self, depth: i32, mins: Vec3, maxs: Vec3) -> u32 {
        let idx = self.areanodes.len() as u32;
        self.areanodes.push(AreaNode { axis: -1, dist: 0.0, children: [0, 0] });
        if depth == AREA_DEPTH {
            return idx;
        }
        let size = sub(&maxs, &mins);
        let axis = if size[0] > size[1] { 0 } else { 1 };
        let dist = (0.5 * (maxs[axis] + mins[axis]) as f64) as f32;
        let mut mins1 = mins;
        let mut maxs1 = maxs;
        let mut mins2 = mins;
        let maxs2 = maxs;
        maxs1[axis] = dist;
        mins2[axis] = dist;
        let _ = &mut mins1;
        let c0 = self.create_area_node(depth + 1, mins2, maxs2);
        let c1 = self.create_area_node(depth + 1, mins1, maxs1);
        let n = &mut self.areanodes[idx as usize];
        n.axis = axis as i32;
        n.dist = dist;
        n.children = [c0, c1];
        idx
    }

    /// list head index of area node n (trigger or solid list)
    #[inline]
    fn head(&self, n: u32, trigger: bool) -> u32 {
        self.max_edicts + n * 2 + if trigger { 0 } else { 1 }
    }

    #[inline]
    pub fn is_linked(&self, e: Ent) -> bool {
        self.links[e as usize].prev != NIL
    }

    /// SV_UnlinkEdict
    pub fn unlink_edict(&mut self, e: Ent) {
        let l = self.links[e as usize];
        if l.prev == NIL {
            return; // not linked in anywhere
        }
        self.links[l.prev as usize].next = l.next;
        self.links[l.next as usize].prev = l.prev;
        self.links[e as usize] = Link { prev: NIL, next: NIL };
    }

    /// InsertLinkBefore(&ent->area, head)
    fn insert_before(&mut self, e: Ent, head: u32) {
        let prev = self.links[head as usize].prev;
        self.links[e as usize] = Link { prev, next: head };
        self.links[prev as usize].next = e;
        self.links[head as usize].prev = e;
    }

    /// SV_LinkEdict
    pub fn link_edict(&mut self, vm: &mut Vm, e: Ent, touch_triggers: bool) -> Result<(), VmError> {
        if self.is_linked(e) {
            self.unlink_edict(e); // unlink from old position
        }
        if e == 0 {
            return Ok(()); // don't add the world
        }
        if vm.is_free(e) {
            return Ok(());
        }

        // set the abs box
        let origin = vm.e_v(e, fld::ORIGIN);
        let mut absmin = add(&origin, &vm.e_v(e, fld::MINS));
        let mut absmax = add(&origin, &vm.e_v(e, fld::MAXS));

        // to make items easier to pick up and allow them to be grabbed off of shelves,
        // the abs sizes are expanded
        if Self::flags(vm, e) & FL_ITEM != 0 {
            absmin[0] -= 15.0;
            absmin[1] -= 15.0;
            absmax[0] += 15.0;
            absmax[1] += 15.0;
        } else {
            // because movement is clipped an epsilon away from an actual edge,
            // we must fully check even when bounding boxes don't quite touch
            for i in 0..3 {
                absmin[i] -= 1.0;
                absmax[i] += 1.0;
            }
        }
        vm.set_e_v(e, fld::ABSMIN, absmin);
        vm.set_e_v(e, fld::ABSMAX, absmax);

        // (link to PVS leafs: only needed for network culling, which the sim does not do)

        let solid = Self::solid(vm, e);
        if solid == SOLID_NOT {
            return Ok(());
        }

        // find the first node that the ent's box crosses
        let mut node = 0u32;
        loop {
            let n = self.areanodes[node as usize];
            if n.axis == -1 {
                break;
            }
            let a = n.axis as usize;
            if absmin[a] > n.dist {
                node = n.children[0];
            } else if absmax[a] < n.dist {
                node = n.children[1];
            } else {
                break; // crosses the node
            }
        }

        // link it in
        let head = self.head(node, solid == SOLID_TRIGGER);
        self.insert_before(e, head);

        // if touch_triggers, touch all entities at this node and decend for more
        if touch_triggers {
            self.touch_links(vm, e, 0)?;
        }
        Ok(())
    }

    /// SV_TouchLinks. The candidates of a node are collected first and re-checked
    /// right before each call (a touch function may remove or move entities).
    fn touch_links(&mut self, vm: &mut Vm, ent: Ent, node: u32) -> Result<(), VmError> {
        // collect the node's candidates first (a touch function may relink anything);
        // on the stack for the common case
        let head = self.head(node, true);
        let mut small = [0 as Ent; 32];
        let mut n_small = 0;
        let mut big: Vec<Ent> = Vec::new();
        let mut l = self.links[head as usize].next;
        while l != head {
            if n_small < small.len() {
                small[n_small] = l;
                n_small += 1;
            } else {
                big.push(l);
            }
            l = self.links[l as usize].next;
        }
        for touch in small[..n_small].iter().copied().chain(big.into_iter()) {
            if touch == ent || vm.is_free(touch) || vm.is_free(ent) {
                continue;
            }
            let tf = vm.e_fn(touch, fld::TOUCH);
            if tf == 0 || Self::solid(vm, touch) != SOLID_TRIGGER {
                continue;
            }
            let (eamin, eamax) = (vm.e_v(ent, fld::ABSMIN), vm.e_v(ent, fld::ABSMAX));
            let (tamin, tamax) = (vm.e_v(touch, fld::ABSMIN), vm.e_v(touch, fld::ABSMAX));
            if eamin[0] > tamax[0]
                || eamin[1] > tamax[1]
                || eamin[2] > tamax[2]
                || eamax[0] < tamin[0]
                || eamax[1] < tamin[1]
                || eamax[2] < tamin[2]
            {
                continue;
            }
            let old_self = vm.g_e(glob::SELF);
            let old_other = vm.g_e(glob::OTHER);
            vm.set_g_e(glob::SELF, touch);
            vm.set_g_e(glob::OTHER, ent);
            vm.set_g_f(glob::TIME, self.time as f32);
            vm.call(self, tf)?;
            vm.set_g_e(glob::SELF, old_self);
            vm.set_g_e(glob::OTHER, old_other);
        }

        // recurse down both sides
        let n = self.areanodes[node as usize];
        if n.axis == -1 || vm.is_free(ent) {
            return Ok(());
        }
        let a = n.axis as usize;
        if vm.e_v(ent, fld::ABSMAX)[a] > n.dist {
            self.touch_links(vm, ent, n.children[0])?;
        }
        if vm.e_v(ent, fld::ABSMIN)[a] < n.dist {
            self.touch_links(vm, ent, n.children[1])?;
        }
        Ok(())
    }

    // ------------------------------------------------------------------ point tests

    /// SV_PointContents
    pub fn point_contents(&self, p: &Vec3) -> i32 {
        let hull = self.map.hull(0, 0);
        hull_point_contents(&hull, 0, p)
    }

    /// submodel of a SOLID_BSP entity, -1 if its model is not a brush model
    #[inline]
    pub fn brush_model(&self, vm: &Vm, e: Ent) -> i32 {
        let mi = vm.e_f(e, fld::MODELINDEX) as i32;
        if mi >= 0 && (mi as usize) < self.model_sub.len() {
            self.model_sub[mi as usize]
        } else {
            -1
        }
    }

    /// SV_HullForEntity + the hull walk: returns (contents or trace) helpers below.
    /// Picks the hull and offset; `f` runs with the hull.
    fn with_entity_hull<R>(&mut self, vm: &Vm, e: Ent, mins: &Vec3, maxs: &Vec3, f: impl FnOnce(&Hull, &Vec3) -> R) -> R {
        let solid = Self::solid(vm, e);
        let sm = if solid == SOLID_BSP { self.brush_model(vm, e) } else { -1 };
        if sm >= 0 {
            // explicit hulls in the BSP model
            let size = sub(maxs, mins);
            let hn = if size[0] < 3.0 {
                0
            } else if size[0] <= 32.0 {
                1
            } else {
                2
            };
            let hull = self.map.hull(sm as usize, hn);
            // calculate an offset value to center the origin
            let offset = add(&sub(&hull.clip_mins, mins), &vm.e_v(e, fld::ORIGIN));
            f(&hull, &offset)
        } else {
            // create a temp hull from bounding box sizes
            let hullmins = sub(&vm.e_v(e, fld::MINS), maxs);
            let hullmaxs = sub(&vm.e_v(e, fld::MAXS), mins);
            self.boxhull.set(&hullmins, &hullmaxs);
            let offset = vm.e_v(e, fld::ORIGIN);
            let hull = self.boxhull.hull();
            f(&hull, &offset)
        }
    }

    /// SV_ClipMoveToEntity
    fn clip_move_to_entity(&mut self, vm: &Vm, ent: Ent, start: &Vec3, mins: &Vec3, maxs: &Vec3, end: &Vec3) -> Trace {
        let mut trace = Trace::start(end);
        self.with_entity_hull(vm, ent, mins, maxs, |hull, offset| {
            let start_l = sub(start, offset);
            let end_l = sub(end, offset);
            recursive_hull_check(hull, hull.firstclipnode, 0.0, 1.0, &start_l, &end_l, &mut trace);
            if trace.fraction != 1.0 {
                trace.endpos = add(&trace.endpos, offset);
            }
        });
        if trace.fraction < 1.0 || trace.startsolid {
            trace.ent = ent as i32;
        }
        trace
    }

    /// one entity's hull only (bots' static-world traces)
    pub fn clip_world_only(&mut self, vm: &Vm, ent: Ent, start: &Vec3, mins: &Vec3, maxs: &Vec3, end: &Vec3) -> Trace {
        self.clip_move_to_entity(vm, ent, start, mins, maxs, end)
    }

    /// SV_ClipToLinks
    fn clip_to_links(&mut self, vm: &Vm, node: u32, clip: &mut MoveClip, scratch: &mut Vec<Ent>) {
        let head = self.head(node, false);
        let mut l = self.links[head as usize].next;
        while l != head {
            let touch = l;
            l = self.links[l as usize].next;
            let tsolid = Self::solid(vm, touch);
            if tsolid == SOLID_NOT {
                continue;
            }
            if Some(touch) == clip.passedict {
                continue;
            }
            if tsolid == SOLID_TRIGGER {
                continue; // QW: SV_Error ("Trigger in clipping list")
            }
            if clip.ty == MOVE_NOMONSTERS && tsolid != SOLID_BSP {
                continue;
            }
            let tamin = vm.e_v(touch, fld::ABSMIN);
            let tamax = vm.e_v(touch, fld::ABSMAX);
            if clip.boxmins[0] > tamax[0]
                || clip.boxmins[1] > tamax[1]
                || clip.boxmins[2] > tamax[2]
                || clip.boxmaxs[0] < tamin[0]
                || clip.boxmaxs[1] < tamin[1]
                || clip.boxmaxs[2] < tamin[2]
            {
                continue;
            }
            if let Some(p) = clip.passedict {
                if vm.e_v(p, fld::SIZE)[0] != 0.0 && vm.e_v(touch, fld::SIZE)[0] == 0.0 {
                    continue; // points never interact
                }
            }

            // might intersect, so do an exact clip
            if clip.trace.allsolid {
                return;
            }
            if let Some(p) = clip.passedict {
                if vm.e_e(touch, fld::OWNER) == p {
                    continue; // don't clip against own missiles
                }
                if vm.e_e(p, fld::OWNER) == touch {
                    continue; // don't clip against owner
                }
            }

            let (start, end) = (clip.start, clip.end);
            let trace = if Self::flags(vm, touch) & FL_MONSTER != 0 {
                let (a, b) = (clip.mins2, clip.maxs2);
                self.clip_move_to_entity(vm, touch, &start, &a, &b, &end)
            } else {
                let (a, b) = (clip.mins, clip.maxs);
                self.clip_move_to_entity(vm, touch, &start, &a, &b, &end)
            };
            if trace.allsolid || trace.startsolid || trace.fraction < clip.trace.fraction {
                let mut t = trace;
                t.ent = touch as i32;
                if clip.trace.startsolid {
                    clip.trace = t;
                    clip.trace.startsolid = true;
                } else {
                    clip.trace = t;
                }
            } else if trace.startsolid {
                clip.trace.startsolid = true;
            }
        }

        // recurse down both sides
        let n = self.areanodes[node as usize];
        if n.axis == -1 {
            return;
        }
        let a = n.axis as usize;
        if clip.boxmaxs[a] > n.dist {
            self.clip_to_links(vm, n.children[0], clip, scratch);
        }
        if clip.boxmins[a] < n.dist {
            self.clip_to_links(vm, n.children[1], clip, scratch);
        }
    }

    /// SV_Move. `passedict` None = NULL (QC traceline always passes an entity, maybe
    /// world, which QW treats as an entity too).
    pub fn sv_move(&mut self, vm: &Vm, start: &Vec3, mins: &Vec3, maxs: &Vec3, end: &Vec3, ty: i32, passedict: Option<Ent>) -> Trace {
        // clip to world
        let trace = self.clip_move_to_entity(vm, 0, start, mins, maxs, end);
        let (mins2, maxs2) = if ty == MOVE_MISSILE { ([-15.0; 3], [15.0; 3]) } else { (*mins, *maxs) };
        let mut clip = MoveClip {
            boxmins: [0.0; 3],
            boxmaxs: [0.0; 3],
            mins: *mins,
            maxs: *maxs,
            mins2,
            maxs2,
            start: *start,
            end: *end,
            trace,
            ty,
            passedict,
        };
        // create the bounding box of the entire move (SV_MoveBounds)
        for i in 0..3 {
            if end[i] > start[i] {
                clip.boxmins[i] = start[i] + clip.mins2[i] - 1.0;
                clip.boxmaxs[i] = end[i] + clip.maxs2[i] + 1.0;
            } else {
                clip.boxmins[i] = end[i] + clip.mins2[i] - 1.0;
                clip.boxmaxs[i] = start[i] + clip.maxs2[i] + 1.0;
            }
        }
        // clip to entities
        let mut scratch = Vec::new();
        self.clip_to_links(vm, 0, &mut clip, &mut scratch);
        clip.trace
    }

    /// SV_TestEntityPosition: Some(0) if the entity is stuck
    pub fn test_entity_position(&mut self, vm: &Vm, e: Ent) -> Option<Ent> {
        let o = vm.e_v(e, fld::ORIGIN);
        let (mins, maxs) = (vm.e_v(e, fld::MINS), vm.e_v(e, fld::MAXS));
        let trace = self.sv_move(vm, &o, &mins, &maxs, &o, MOVE_NORMAL, Some(e));
        if trace.startsolid {
            Some(0)
        } else {
            None
        }
    }

    /// AddLinksToPmove: the physents near the player (world first).
    pub fn add_links_to_pmove(&mut self, vm: &Vm, player: Ent, pmove_mins: &Vec3, pmove_maxs: &Vec3) {
        let mut pe = std::mem::take(&mut self.physents);
        pe.clear();
        pe.push(PhysEnt { origin: [0.0; 3], model: 0, mins: [0.0; 3], maxs: [0.0; 3], info: 0 });
        self.add_links_rec(vm, 0, player, pmove_mins, pmove_maxs, &mut pe);
        self.physents = pe;
    }

    fn add_links_rec(&self, vm: &Vm, node: u32, player: Ent, pmins: &Vec3, pmaxs: &Vec3, pe: &mut Vec<PhysEnt>) {
        let head = self.head(node, false);
        let mut l = self.links[head as usize].next;
        while l != head {
            let check = l;
            l = self.links[l as usize].next;
            if vm.e_e(check, fld::OWNER) == player {
                continue; // player's own missile
            }
            let s = Self::solid(vm, check);
            if s == SOLID_BSP || s == SOLID_BBOX || s == SOLID_SLIDEBOX {
                if check == player {
                    continue;
                }
                let amin = vm.e_v(check, fld::ABSMIN);
                let amax = vm.e_v(check, fld::ABSMAX);
                if (0..3).any(|i| amin[i] > pmaxs[i] || amax[i] < pmins[i]) {
                    continue;
                }
                if pe.len() == crate::pmove::MAX_PHYSENTS {
                    return;
                }
                let model = if s == SOLID_BSP { self.brush_model(vm, check) } else { -1 };
                pe.push(PhysEnt {
                    origin: vm.e_v(check, fld::ORIGIN),
                    model,
                    mins: vm.e_v(check, fld::MINS),
                    maxs: vm.e_v(check, fld::MAXS),
                    info: check as i32,
                });
            }
        }
        // recurse down both sides
        let n = self.areanodes[node as usize];
        if n.axis == -1 {
            return;
        }
        let a = n.axis as usize;
        if pmaxs[a] > n.dist {
            self.add_links_rec(vm, n.children[0], player, pmins, pmaxs, pe);
        }
        if pmins[a] < n.dist {
            self.add_links_rec(vm, n.children[1], player, pmins, pmaxs, pe);
        }
    }

    /// modelindex of a precached model name (SV_ModelIndex), 0 for ""
    pub fn model_index(&self, name: &[u8]) -> Option<usize> {
        if name.is_empty() {
            return Some(0);
        }
        self.model_precache.iter().position(|m| m == name)
    }

    pub fn sound_index(&self, name: &[u8]) -> Option<usize> {
        // index 0 is the empty name and never matches a real sample
        self.sound_precache.iter().skip(1).position(|m| m == name).map(|i| i + 1)
    }

    /// recompute model_sub from the precache list
    pub fn update_model_sub(&mut self) {
        let nsub = self.map.models.len();
        self.model_sub = self
            .model_precache
            .iter()
            .enumerate()
            .map(|(i, name)| {
                if i == 1 {
                    0
                } else if name.first() == Some(&b'*') {
                    let n: usize = std::str::from_utf8(&name[1..]).ok().and_then(|s| s.parse().ok()).unwrap_or(0);
                    if n > 0 && n < nsub {
                        n as i32
                    } else {
                        -1
                    }
                } else {
                    -1
                }
            })
            .collect();
    }

    pub fn cvar(&self, name: &[u8]) -> f32 {
        self.cvars.get(name).map(|v| qcvm::atof(v) as f32).unwrap_or(0.0)
    }

    pub fn cvar_str(&self, name: &[u8]) -> &[u8] {
        self.cvars.get(name).map(|v| v.as_slice()).unwrap_or(b"")
    }

    /// Cvar_Set; serverinfo keys follow their cvar (QW CVAR_SERVERINFO)
    pub fn cvar_set(&mut self, name: &[u8], value: &[u8]) {
        self.cvars.insert(name.to_vec(), value.to_vec());
        if !self.serverinfo.get(name).is_empty() || SERVERINFO_CVARS.contains(&name) {
            self.serverinfo.set(name, value);
        }
    }
}

/// cvars that QW mirrors into the serverinfo
pub const SERVERINFO_CVARS: &[&[u8]] = &[b"deathmatch", b"teamplay", b"timelimit", b"fraglimit", b"samelevel", b"maxclients", b"hostname"];
