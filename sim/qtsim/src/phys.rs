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
//! Port of QW/server/sv_phys.c.
//!
//! pushmove objects do not obey gravity, and do not interact with each other or trigger
//! fields, but block normal movement and push normal objects when they move.
//! onground is set for toss objects when they come to a complete rest.

use qcvm::defs::{fld, glob};
use qcvm::{Ent, Vm, VmError};

use crate::mathlib::*;
use crate::pmove::clip_velocity;
use crate::trace::Trace;
use crate::world::*;

impl Server {
    /// SV_CheckVelocity: bound velocity
    pub fn check_velocity(&self, vm: &mut Vm, e: Ent) {
        let maxv = self.cvar(b"sv_maxvelocity");
        let mut v = vm.e_v(e, fld::VELOCITY);
        let mut o = vm.e_v(e, fld::ORIGIN);
        let mut changed_o = false;
        for i in 0..3 {
            if v[i].is_nan() {
                v[i] = 0.0;
            }
            if o[i].is_nan() {
                o[i] = 0.0;
                changed_o = true;
            }
            if v[i] > maxv {
                v[i] = maxv;
            } else if v[i] < -maxv {
                v[i] = -maxv;
            }
        }
        vm.set_e_v(e, fld::VELOCITY, v);
        if changed_o {
            vm.set_e_v(e, fld::ORIGIN, o);
        }
    }

    /// SV_RunThink: runs thinking code if time. Returns false if the entity removed
    /// itself.
    pub fn run_think(&mut self, vm: &mut Vm, e: Ent) -> Result<bool, VmError> {
        loop {
            let mut thinktime = vm.e_f(e, fld::NEXTTHINK);
            if thinktime <= 0.0 {
                return Ok(true);
            }
            if thinktime as f64 > self.time + self.frametime {
                return Ok(true);
            }
            if (thinktime as f64) < self.time {
                thinktime = self.time as f32; // don't let things stay in the past
            }
            vm.set_e_f(e, fld::NEXTTHINK, 0.0);
            vm.set_g_f(glob::TIME, thinktime);
            vm.set_g_e(glob::SELF, e);
            vm.set_g_e(glob::OTHER, 0);
            let f = vm.e_fn(e, fld::THINK);
            if f != 0 {
                vm.call(self, f)?;
            }
            if vm.is_free(e) {
                return Ok(false);
            }
        }
    }

    /// SV_Impact: two entities have touched, so run their touch functions
    pub fn impact(&mut self, vm: &mut Vm, e1: Ent, e2: Ent) -> Result<(), VmError> {
        let old_self = vm.g_e(glob::SELF);
        let old_other = vm.g_e(glob::OTHER);

        vm.set_g_f(glob::TIME, self.time as f32);
        let t1 = vm.e_fn(e1, fld::TOUCH);
        if t1 != 0 && Self::solid(vm, e1) != SOLID_NOT {
            vm.set_g_e(glob::SELF, e1);
            vm.set_g_e(glob::OTHER, e2);
            vm.call(self, t1)?;
        }
        let t2 = vm.e_fn(e2, fld::TOUCH);
        if t2 != 0 && Self::solid(vm, e2) != SOLID_NOT {
            vm.set_g_e(glob::SELF, e2);
            vm.set_g_e(glob::OTHER, e1);
            vm.call(self, t2)?;
        }

        vm.set_g_e(glob::SELF, old_self);
        vm.set_g_e(glob::OTHER, old_other);
        Ok(())
    }

    /// SV_FlyMove: the basic solid body movement clip that slides along multiple planes.
    /// Returns the clipflags (1 floor, 2 wall/step, 4 dead stop).
    pub fn fly_move(&mut self, vm: &mut Vm, e: Ent, time: f32, mut steptrace: Option<&mut Trace>) -> Result<i32, VmError> {
        const MAX_CLIP_PLANES: usize = 5;
        let numbumps = 4;
        let mut blocked = 0;
        let mut original_velocity = vm.e_v(e, fld::VELOCITY);
        let primal_velocity = original_velocity;
        let mut numplanes = 0usize;
        let mut planes = [[0.0f32; 3]; MAX_CLIP_PLANES];
        let mut time_left = time;

        for _ in 0..numbumps {
            let origin = vm.e_v(e, fld::ORIGIN);
            let velocity = vm.e_v(e, fld::VELOCITY);
            let mut end = [0.0f32; 3];
            for i in 0..3 {
                end[i] = origin[i] + time_left * velocity[i];
            }
            let (mins, maxs) = (vm.e_v(e, fld::MINS), vm.e_v(e, fld::MAXS));
            let trace = self.sv_move(vm, &origin, &mins, &maxs, &end, MOVE_NORMAL, Some(e));

            if trace.allsolid {
                // entity is trapped in another solid
                vm.set_e_v(e, fld::VELOCITY, VEC3_ORIGIN);
                return Ok(3);
            }

            if trace.fraction > 0.0 {
                // actually covered some distance
                vm.set_e_v(e, fld::ORIGIN, trace.endpos);
                original_velocity = vm.e_v(e, fld::VELOCITY);
                numplanes = 0;
            }

            if trace.fraction == 1.0 {
                break; // moved the entire distance
            }

            let tent = if trace.ent < 0 { 0 } else { trace.ent as Ent };

            if (trace.normal[2] as f64) > 0.7 {
                blocked |= 1; // floor
                if Self::solid(vm, tent) == SOLID_BSP {
                    Self::set_flags(vm, e, Self::flags(vm, e) | FL_ONGROUND);
                    vm.set_e_e(e, fld::GROUNDENTITY, tent);
                }
            }
            if trace.normal[2] == 0.0 {
                blocked |= 2; // step
                if let Some(st) = steptrace.as_deref_mut() {
                    *st = trace; // save for player extrafriction
                }
            }

            // run the impact function
            self.impact(vm, e, tent)?;
            if vm.is_free(e) {
                break; // removed by the impact function
            }

            time_left -= time_left * trace.fraction;

            // cliped to another plane
            if numplanes >= MAX_CLIP_PLANES {
                // this shouldn't really happen
                vm.set_e_v(e, fld::VELOCITY, VEC3_ORIGIN);
                return Ok(3);
            }

            planes[numplanes] = trace.normal;
            numplanes += 1;

            // modify original_velocity so it parallels all of the clip planes
            let mut new_velocity = [0.0f32; 3];
            let mut i = 0;
            while i < numplanes {
                clip_velocity(&original_velocity, &planes[i], &mut new_velocity, 1.0);
                let mut j = 0;
                while j < numplanes {
                    if j != i && dot(&new_velocity, &planes[j]) < 0.0 {
                        break; // not ok
                    }
                    j += 1;
                }
                if j == numplanes {
                    break;
                }
                i += 1;
            }

            if i != numplanes {
                // go along this plane
                vm.set_e_v(e, fld::VELOCITY, new_velocity);
            } else {
                // go along the crease
                if numplanes != 2 {
                    vm.set_e_v(e, fld::VELOCITY, VEC3_ORIGIN);
                    return Ok(7);
                }
                let dir = cross(&planes[0], &planes[1]);
                let v = vm.e_v(e, fld::VELOCITY);
                let d = dot(&dir, &v);
                vm.set_e_v(e, fld::VELOCITY, scale(&dir, d));
            }

            // if original velocity is against the original velocity, stop dead
            // to avoid tiny occilations in sloping corners
            if dot(&vm.e_v(e, fld::VELOCITY), &primal_velocity) <= 0.0 {
                vm.set_e_v(e, fld::VELOCITY, VEC3_ORIGIN);
                return Ok(blocked);
            }
        }
        Ok(blocked)
    }

    /// SV_AddGravity
    pub fn add_gravity(&self, vm: &mut Vm, e: Ent, scale: f32) {
        let mut v = vm.e_v(e, fld::VELOCITY);
        v[2] = (v[2] as f64 - (scale * self.movevars.gravity) as f64 * self.frametime) as f32;
        vm.set_e_v(e, fld::VELOCITY, v);
    }

    /// SV_PushEntity: does not change the entities velocity at all
    pub fn push_entity(&mut self, vm: &mut Vm, e: Ent, push: &Vec3) -> Result<Trace, VmError> {
        let origin = vm.e_v(e, fld::ORIGIN);
        let end = add(&origin, push);
        let (mins, maxs) = (vm.e_v(e, fld::MINS), vm.e_v(e, fld::MAXS));
        let mt = vm.e_f(e, fld::MOVETYPE) as i32;
        let solid = Self::solid(vm, e);
        let ty = if mt == MOVETYPE_FLYMISSILE {
            MOVE_MISSILE
        } else if solid == SOLID_TRIGGER || solid == SOLID_NOT {
            MOVE_NOMONSTERS // only clip against bmodels
        } else {
            MOVE_NORMAL
        };
        let trace = self.sv_move(vm, &origin, &mins, &maxs, &end, ty, Some(e));

        vm.set_e_v(e, fld::ORIGIN, trace.endpos);
        self.link_edict(vm, e, true)?;

        if trace.ent >= 0 {
            self.impact(vm, e, trace.ent as Ent)?;
        }
        Ok(trace)
    }

    /// SV_Push
    pub fn push(&mut self, vm: &mut Vm, pusher: Ent, mv: &Vec3) -> Result<bool, VmError> {
        let mut mins = [0.0f32; 3];
        let mut maxs = [0.0f32; 3];
        let pamin = vm.e_v(pusher, fld::ABSMIN);
        let pamax = vm.e_v(pusher, fld::ABSMAX);
        for i in 0..3 {
            mins[i] = pamin[i] + mv[i];
            maxs[i] = pamax[i] + mv[i];
        }

        let pushorig = vm.e_v(pusher, fld::ORIGIN);

        // move the pusher to it's final position
        vm.set_e_v(pusher, fld::ORIGIN, add(&pushorig, mv));
        self.link_edict(vm, pusher, false)?;

        // see if any solid entities are inside the final position
        let mut moved: Vec<(Ent, Vec3)> = Vec::new();
        let mut e = 1;
        while e < vm.num_edicts() {
            let check = e;
            e += 1;
            if vm.is_free(check) {
                continue;
            }
            let mt = vm.e_f(check, fld::MOVETYPE) as i32;
            if mt == MOVETYPE_PUSH || mt == MOVETYPE_NONE || mt == MOVETYPE_NOCLIP {
                continue;
            }

            vm.set_e_f(pusher, fld::SOLID, SOLID_NOT as f32);
            let block = self.test_entity_position(vm, check);
            vm.set_e_f(pusher, fld::SOLID, SOLID_BSP as f32);
            if block.is_some() {
                continue;
            }

            // if the entity is standing on the pusher, it will definately be moved
            if !(Self::flags(vm, check) & FL_ONGROUND != 0 && vm.e_e(check, fld::GROUNDENTITY) == pusher) {
                let camin = vm.e_v(check, fld::ABSMIN);
                let camax = vm.e_v(check, fld::ABSMAX);
                if camin[0] >= maxs[0]
                    || camin[1] >= maxs[1]
                    || camin[2] >= maxs[2]
                    || camax[0] <= mins[0]
                    || camax[1] <= mins[1]
                    || camax[2] <= mins[2]
                {
                    continue;
                }

                // see if the ent's bbox is inside the pusher's final position
                if self.test_entity_position(vm, check).is_none() {
                    continue;
                }
            }

            let corg = vm.e_v(check, fld::ORIGIN);
            moved.push((check, corg));

            // try moving the contacted entity
            vm.set_e_v(check, fld::ORIGIN, add(&corg, mv));
            if self.test_entity_position(vm, check).is_none() {
                // pushed ok
                self.link_edict(vm, check, false)?;
                continue;
            }

            // if it is ok to leave in the old position, do it
            vm.set_e_v(check, fld::ORIGIN, sub(&vm.e_v(check, fld::ORIGIN), mv));
            if self.test_entity_position(vm, check).is_none() {
                moved.pop();
                continue;
            }

            // if it is still inside the pusher, block
            if vm.e_v(check, fld::MINS)[0] == vm.e_v(check, fld::MAXS)[0] {
                self.link_edict(vm, check, false)?;
                continue;
            }
            let cs = Self::solid(vm, check);
            if cs == SOLID_NOT || cs == SOLID_TRIGGER {
                // corpse
                let mut cmins = vm.e_v(check, fld::MINS);
                cmins[0] = 0.0;
                cmins[1] = 0.0;
                vm.set_e_v(check, fld::MINS, cmins);
                vm.set_e_v(check, fld::MAXS, cmins);
                self.link_edict(vm, check, false)?;
                continue;
            }

            vm.set_e_v(pusher, fld::ORIGIN, pushorig);
            self.link_edict(vm, pusher, false)?;

            // if the pusher has a "blocked" function, call it
            // otherwise, just stay in place until the obstacle is gone
            let bf = vm.e_fn(pusher, fld::BLOCKED);
            if bf != 0 {
                vm.set_g_e(glob::SELF, pusher);
                vm.set_g_e(glob::OTHER, check);
                vm.call(self, bf)?;
            }

            // move back any entities we already moved
            for &(m, from) in &moved {
                vm.set_e_v(m, fld::ORIGIN, from);
                self.link_edict(vm, m, false)?;
            }
            return Ok(false);
        }
        Ok(true)
    }

    /// SV_PushMove
    pub fn push_move(&mut self, vm: &mut Vm, pusher: Ent, movetime: f32) -> Result<(), VmError> {
        let v = vm.e_v(pusher, fld::VELOCITY);
        if v[0] == 0.0 && v[1] == 0.0 && v[2] == 0.0 {
            vm.set_e_f(pusher, fld::LTIME, vm.e_f(pusher, fld::LTIME) + movetime);
            return Ok(());
        }
        let mv = scale(&v, movetime);
        if self.push(vm, pusher, &mv)? {
            vm.set_e_f(pusher, fld::LTIME, vm.e_f(pusher, fld::LTIME) + movetime);
        }
        Ok(())
    }

    /// SV_Physics_Pusher
    fn physics_pusher(&mut self, vm: &mut Vm, e: Ent) -> Result<(), VmError> {
        let oldltime = vm.e_f(e, fld::LTIME);
        let thinktime = vm.e_f(e, fld::NEXTTHINK);
        let ft = self.frametime as f32;
        let movetime = if (thinktime as f64) < oldltime as f64 + self.frametime {
            let m = thinktime - oldltime;
            if m < 0.0 {
                0.0
            } else {
                m
            }
        } else {
            ft
        };

        if movetime != 0.0 {
            self.push_move(vm, e, movetime)?; // advances ltime if not blocked
        }

        if thinktime > oldltime && thinktime <= vm.e_f(e, fld::LTIME) {
            let oldorg = vm.e_v(e, fld::ORIGIN);
            vm.set_e_f(e, fld::NEXTTHINK, 0.0);
            vm.set_g_f(glob::TIME, self.time as f32);
            vm.set_g_e(glob::SELF, e);
            vm.set_g_e(glob::OTHER, 0);
            let f = vm.e_fn(e, fld::THINK);
            if f != 0 {
                vm.call(self, f)?;
            }
            if vm.is_free(e) {
                return Ok(());
            }
            let mv = sub(&vm.e_v(e, fld::ORIGIN), &oldorg);
            let l = length(&mv);
            if (l as f64) > 1.0 / 64.0 {
                vm.set_e_v(e, fld::ORIGIN, oldorg);
                self.push(vm, e, &mv)?;
            }
        }
        Ok(())
    }

    /// SV_Physics_Noclip: a moving object that doesn't obey physics
    fn physics_noclip(&mut self, vm: &mut Vm, e: Ent) -> Result<(), VmError> {
        if !self.run_think(vm, e)? {
            return Ok(());
        }
        let ft = self.frametime as f32;
        vm.set_e_v(e, fld::ANGLES, ma(&vm.e_v(e, fld::ANGLES), ft, &vm.e_v(e, fld::AVELOCITY)));
        vm.set_e_v(e, fld::ORIGIN, ma(&vm.e_v(e, fld::ORIGIN), ft, &vm.e_v(e, fld::VELOCITY)));
        self.link_edict(vm, e, false)
    }

    /// SV_CheckWaterTransition
    fn check_water_transition(&mut self, vm: &mut Vm, e: Ent) -> Result<(), VmError> {
        let cont = self.point_contents(&vm.e_v(e, fld::ORIGIN));
        let wt = vm.e_f(e, fld::WATERTYPE);
        if wt == 0.0 {
            // just spawned here
            vm.set_e_f(e, fld::WATERTYPE, cont as f32);
            vm.set_e_f(e, fld::WATERLEVEL, 1.0);
            return Ok(());
        }
        if cont <= crate::bsp::CONTENTS_WATER {
            if wt as i32 == crate::bsp::CONTENTS_EMPTY {
                // just crossed into water
                self.start_sound(vm, e, 0, b"misc/h2ohit1.wav", 255, 1.0);
            }
            vm.set_e_f(e, fld::WATERTYPE, cont as f32);
            vm.set_e_f(e, fld::WATERLEVEL, 1.0);
        } else {
            if wt as i32 != crate::bsp::CONTENTS_EMPTY {
                // just crossed into water
                self.start_sound(vm, e, 0, b"misc/h2ohit1.wav", 255, 1.0);
            }
            vm.set_e_f(e, fld::WATERTYPE, crate::bsp::CONTENTS_EMPTY as f32);
            vm.set_e_f(e, fld::WATERLEVEL, cont as f32);
        }
        Ok(())
    }

    /// SV_Physics_Toss: toss, bounce, and fly movement. When onground, do nothing.
    fn physics_toss(&mut self, vm: &mut Vm, e: Ent) -> Result<(), VmError> {
        // regular thinking
        if !self.run_think(vm, e)? {
            return Ok(());
        }

        if vm.e_v(e, fld::VELOCITY)[2] > 0.0 {
            Self::set_flags(vm, e, Self::flags(vm, e) & !FL_ONGROUND);
        }

        // if onground, return without moving
        if Self::flags(vm, e) & FL_ONGROUND != 0 {
            return Ok(());
        }

        self.check_velocity(vm, e);

        // add gravity
        let mt = vm.e_f(e, fld::MOVETYPE) as i32;
        if mt != MOVETYPE_FLY && mt != MOVETYPE_FLYMISSILE {
            self.add_gravity(vm, e, 1.0);
        }

        // move angles
        let ft = self.frametime as f32;
        vm.set_e_v(e, fld::ANGLES, ma(&vm.e_v(e, fld::ANGLES), ft, &vm.e_v(e, fld::AVELOCITY)));

        // move origin
        let mv = scale(&vm.e_v(e, fld::VELOCITY), ft);
        let trace = self.push_entity(vm, e, &mv)?;
        if trace.fraction == 1.0 {
            return Ok(());
        }
        if vm.is_free(e) {
            return Ok(());
        }

        let backoff = if mt == MOVETYPE_BOUNCE { 1.5 } else { 1.0 };
        let v = vm.e_v(e, fld::VELOCITY);
        let mut nv = [0.0f32; 3];
        clip_velocity(&v, &trace.normal, &mut nv, backoff);
        vm.set_e_v(e, fld::VELOCITY, nv);

        // stop if on ground
        if (trace.normal[2] as f64) > 0.7 && (nv[2] < 60.0 || mt != MOVETYPE_BOUNCE) {
            Self::set_flags(vm, e, Self::flags(vm, e) | FL_ONGROUND);
            vm.set_e_e(e, fld::GROUNDENTITY, if trace.ent < 0 { 0 } else { trace.ent as Ent });
            vm.set_e_v(e, fld::VELOCITY, VEC3_ORIGIN);
            vm.set_e_v(e, fld::AVELOCITY, VEC3_ORIGIN);
        }

        // check for in water
        self.check_water_transition(vm, e)
    }

    /// SV_Physics_Step: monsters freefall when they don't have a ground entity,
    /// otherwise all movement is done with discrete steps.
    fn physics_step(&mut self, vm: &mut Vm, e: Ent) -> Result<(), VmError> {
        // frefall if not onground
        if Self::flags(vm, e) & (FL_ONGROUND | FL_FLY | FL_SWIM) == 0 {
            let hitsound = (vm.e_v(e, fld::VELOCITY)[2] as f64) < self.movevars.gravity as f64 * -0.1;

            self.add_gravity(vm, e, 1.0);
            self.check_velocity(vm, e);
            let ft = self.frametime as f32;
            self.fly_move(vm, e, ft, None)?;
            self.link_edict(vm, e, true)?;

            if Self::flags(vm, e) & FL_ONGROUND != 0 && hitsound {
                // just hit ground
                self.start_sound(vm, e, 0, b"demon/dland2.wav", 255, 1.0);
            }
        }

        // regular thinking
        self.run_think(vm, e)?;
        self.check_water_transition(vm, e)
    }

    /// SV_ProgStartFrame: let the progs know that a new frame has started
    pub fn prog_start_frame(&mut self, vm: &mut Vm) -> Result<(), VmError> {
        vm.set_g_e(glob::SELF, 0);
        vm.set_g_e(glob::OTHER, 0);
        vm.set_g_f(glob::TIME, self.time as f32);
        let f = vm.g_fn(glob::STARTFRAME);
        if f != 0 {
            vm.call(self, f)?;
        }
        Ok(())
    }

    /// SV_RunEntity
    pub fn run_entity(&mut self, vm: &mut Vm, e: Ent) -> Result<(), VmError> {
        let rt = self.time as f32;
        if vm.e_f(e, fld::LASTRUNTIME) == rt {
            return Ok(());
        }
        vm.set_e_f(e, fld::LASTRUNTIME, rt);

        match vm.e_f(e, fld::MOVETYPE) as i32 {
            MOVETYPE_PUSH => self.physics_pusher(vm, e),
            MOVETYPE_NONE => self.run_think(vm, e).map(|_| ()),
            MOVETYPE_NOCLIP => self.physics_noclip(vm, e),
            MOVETYPE_STEP => self.physics_step(vm, e),
            MOVETYPE_TOSS | MOVETYPE_BOUNCE | MOVETYPE_FLY | MOVETYPE_FLYMISSILE => self.physics_toss(vm, e),
            // QW: SV_Error ("SV_Physics: bad movetype"); walk/angleclip bodies that are not
            // clients only think
            _ => self.run_think(vm, e).map(|_| ()),
        }
    }

    /// SV_RunNewmis: a missile spawned this frame moves 0.05 s at once (QW).
    /// QW leaves host_frametime at 0.05 afterwards (the rest of the SV_Physics loop then
    /// runs with it); here it is restored, so every entity runs with the tick's time.
    pub fn run_newmis(&mut self, vm: &mut Vm) -> Result<(), VmError> {
        let nm = vm.g_e(glob::NEWMIS);
        if nm == 0 {
            return Ok(());
        }
        let saved = self.frametime;
        self.frametime = 0.05;
        vm.set_g_e(glob::NEWMIS, 0);
        let r = if vm.is_free(nm) { Ok(()) } else { self.run_entity(vm, nm) };
        self.frametime = saved;
        r
    }

    /// SV_Physics with frametime `ft` (seconds)
    pub fn physics(&mut self, vm: &mut Vm, ft: f64) -> Result<(), VmError> {
        self.frametime = ft;
        vm.set_g_f(glob::FRAMETIME, ft as f32);

        self.prog_start_frame(vm)?;

        // treat each object in turn; even the world gets a chance to think
        let mut i = 0;
        while i < vm.num_edicts() {
            let e = i;
            i += 1;
            if vm.is_free(e) {
                continue;
            }
            if vm.g_f(glob::FORCE_RETOUCH) != 0.0 {
                self.link_edict(vm, e, true)?; // force retouch even for stationary
            }
            if e > 0 && e as usize <= self.maxclients {
                continue; // clients are run directly from packets
            }
            self.run_entity(vm, e)?;
            self.run_newmis(vm)?;
        }

        let fr = vm.g_f(glob::FORCE_RETOUCH);
        if fr != 0.0 {
            vm.set_g_f(glob::FORCE_RETOUCH, fr - 1.0);
        }
        Ok(())
    }
}
