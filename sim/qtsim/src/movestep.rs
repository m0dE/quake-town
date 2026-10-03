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
//! Port of QW/server/sv_move.c: monster movement (walkmove, movetogoal, checkbottom).
//! C's rand() draws from the world PRNG.

use qcvm::defs::{fld, glob};
use qcvm::{Ent, Vm, VmError};

use crate::bsp::{CONTENTS_EMPTY, CONTENTS_SOLID};
use crate::mathlib::*;
use crate::world::*;

const STEPSIZE: f32 = 18.0;
const DI_NODIR: f32 = -1.0;

impl Server {
    /// SV_CheckBottom: false if any part of the bottom of the entity is off an edge
    /// that is not a staircase.
    pub fn check_bottom(&mut self, vm: &Vm, ent: Ent) -> bool {
        let o = vm.e_v(ent, fld::ORIGIN);
        let mins = add(&o, &vm.e_v(ent, fld::MINS));
        let maxs = add(&o, &vm.e_v(ent, fld::MAXS));

        // if all of the points under the corners are solid world, don't bother
        // with the tougher checks; the corners must be within 16 of the midpoint
        let mut start = [0.0f32; 3];
        start[2] = mins[2] - 1.0;
        let mut easy = true;
        'c: for x in 0..=1 {
            for y in 0..=1 {
                start[0] = if x != 0 { maxs[0] } else { mins[0] };
                start[1] = if y != 0 { maxs[1] } else { mins[1] };
                if self.point_contents(&start) != CONTENTS_SOLID {
                    easy = false;
                    break 'c;
                }
            }
        }
        if easy {
            return true; // we got out easy
        }

        // check it for real...
        start[2] = mins[2];
        // the midpoint must be within 16 of the bottom
        start[0] = ((mins[0] + maxs[0]) as f64 * 0.5) as f32;
        start[1] = ((mins[1] + maxs[1]) as f64 * 0.5) as f32;
        let mut stop = [start[0], start[1], start[2] - 2.0 * STEPSIZE];
        let trace = self.sv_move(vm, &start, &VEC3_ORIGIN, &VEC3_ORIGIN, &stop, MOVE_NOMONSTERS, Some(ent));
        if trace.fraction == 1.0 {
            return false;
        }
        let mid = trace.endpos[2];
        let mut bottom = mid;

        // the corners must be within 16 of the midpoint
        for x in 0..=1 {
            for y in 0..=1 {
                start[0] = if x != 0 { maxs[0] } else { mins[0] };
                stop[0] = start[0];
                start[1] = if y != 0 { maxs[1] } else { mins[1] };
                stop[1] = start[1];
                let trace = self.sv_move(vm, &start, &VEC3_ORIGIN, &VEC3_ORIGIN, &stop, MOVE_NOMONSTERS, Some(ent));
                if trace.fraction != 1.0 && trace.endpos[2] > bottom {
                    bottom = trace.endpos[2];
                }
                if trace.fraction == 1.0 || mid - trace.endpos[2] > STEPSIZE {
                    return false;
                }
            }
        }
        true
    }

    /// SV_movestep: the move will be adjusted for slopes and stairs, but if the move
    /// isn't possible, no move is done and false is returned.
    pub fn movestep(&mut self, vm: &mut Vm, ent: Ent, mv: &Vec3, relink: bool) -> Result<bool, VmError> {
        let oldorg = vm.e_v(ent, fld::ORIGIN);
        let mut neworg = add(&oldorg, mv);
        let (mins, maxs) = (vm.e_v(ent, fld::MINS), vm.e_v(ent, fld::MAXS));
        let flags = Self::flags(vm, ent);

        // flying monsters don't step up
        if flags & (FL_SWIM | FL_FLY) != 0 {
            // try one move with vertical motion, then one without
            for i in 0..2 {
                let origin = vm.e_v(ent, fld::ORIGIN);
                neworg = add(&origin, mv);
                let enemy = vm.e_e(ent, fld::ENEMY);
                if i == 0 && enemy != 0 {
                    let dz = origin[2] - vm.e_v(enemy, fld::ORIGIN)[2];
                    if dz > 40.0 {
                        neworg[2] -= 8.0;
                    }
                    if dz < 30.0 {
                        neworg[2] += 8.0;
                    }
                }
                let trace = self.sv_move(vm, &origin, &mins, &maxs, &neworg, MOVE_NORMAL, Some(ent));
                if trace.fraction == 1.0 {
                    if flags & FL_SWIM != 0 && self.point_contents(&trace.endpos) == CONTENTS_EMPTY {
                        return Ok(false); // swim monster left water
                    }
                    vm.set_e_v(ent, fld::ORIGIN, trace.endpos);
                    if relink {
                        self.link_edict(vm, ent, true)?;
                    }
                    return Ok(true);
                }
                if enemy == 0 {
                    break;
                }
            }
            return Ok(false);
        }

        // push down from a step height above the wished position
        neworg[2] += STEPSIZE;
        let mut end = neworg;
        end[2] -= STEPSIZE * 2.0;

        let mut trace = self.sv_move(vm, &neworg, &mins, &maxs, &end, MOVE_NORMAL, Some(ent));
        if trace.allsolid {
            return Ok(false);
        }
        if trace.startsolid {
            neworg[2] -= STEPSIZE;
            trace = self.sv_move(vm, &neworg, &mins, &maxs, &end, MOVE_NORMAL, Some(ent));
            if trace.allsolid || trace.startsolid {
                return Ok(false);
            }
        }
        if trace.fraction == 1.0 {
            // if monster had the ground pulled out, go ahead and fall
            if flags & FL_PARTIALGROUND != 0 {
                vm.set_e_v(ent, fld::ORIGIN, add(&oldorg, mv));
                if relink {
                    self.link_edict(vm, ent, true)?;
                }
                Self::set_flags(vm, ent, Self::flags(vm, ent) & !FL_ONGROUND);
                return Ok(true);
            }
            return Ok(false); // walked off an edge
        }

        // check point traces down for dangling corners
        vm.set_e_v(ent, fld::ORIGIN, trace.endpos);

        if !self.check_bottom(vm, ent) {
            if flags & FL_PARTIALGROUND != 0 {
                // entity had floor mostly pulled out from underneath it and is trying
                // to correct
                if relink {
                    self.link_edict(vm, ent, true)?;
                }
                return Ok(true);
            }
            vm.set_e_v(ent, fld::ORIGIN, oldorg);
            return Ok(false);
        }

        if flags & FL_PARTIALGROUND != 0 {
            Self::set_flags(vm, ent, Self::flags(vm, ent) & !FL_PARTIALGROUND);
        }
        vm.set_e_e(ent, fld::GROUNDENTITY, trace.ent.max(0) as Ent);

        // the move is ok
        if relink {
            self.link_edict(vm, ent, true)?;
        }
        Ok(true)
    }

    /// SV_StepDirection: turns to the movement direction, and walks the current
    /// distance if facing it.
    fn step_direction(&mut self, vm: &mut Vm, ent: Ent, yaw: f32, dist: f32) -> Result<bool, VmError> {
        vm.set_e_f(ent, fld::IDEAL_YAW, yaw);
        Self::change_yaw(vm, ent);

        let yaw = (yaw as f64 * core::f64::consts::PI * 2.0 / 360.0) as f32;
        let mv = [(libm::cos(yaw as f64) * dist as f64) as f32, (libm::sin(yaw as f64) * dist as f64) as f32, 0.0];
        let oldorigin = vm.e_v(ent, fld::ORIGIN);
        if self.movestep(vm, ent, &mv, false)? {
            let delta = vm.e_v(ent, fld::ANGLES)[YAW] - vm.e_f(ent, fld::IDEAL_YAW);
            if delta > 45.0 && delta < 315.0 {
                // not turned far enough, so don't take the step
                vm.set_e_v(ent, fld::ORIGIN, oldorigin);
            }
            self.link_edict(vm, ent, true)?;
            return Ok(true);
        }
        self.link_edict(vm, ent, true)?;
        Ok(false)
    }

    /// SV_NewChaseDir
    fn new_chase_dir(&mut self, vm: &mut Vm, actor: Ent, enemy: Ent, dist: f32) -> Result<(), VmError> {
        let olddir = anglemod(((vm.e_f(actor, fld::IDEAL_YAW) / 45.0) as i32 * 45) as f32);
        let turnaround = anglemod(olddir - 180.0);

        let ao = vm.e_v(actor, fld::ORIGIN);
        let eo = vm.e_v(enemy, fld::ORIGIN);
        let deltax = eo[0] - ao[0];
        let deltay = eo[1] - ao[1];
        let mut d = [0.0f32; 3];
        d[1] = if deltax > 10.0 {
            0.0
        } else if deltax < -10.0 {
            180.0
        } else {
            DI_NODIR
        };
        d[2] = if deltay < -10.0 {
            270.0
        } else if deltay > 10.0 {
            90.0
        } else {
            DI_NODIR
        };

        // try direct route
        if d[1] != DI_NODIR && d[2] != DI_NODIR {
            let tdir = if d[1] == 0.0 {
                if d[2] == 90.0 {
                    45.0
                } else {
                    315.0
                }
            } else if d[2] == 90.0 {
                135.0
            } else {
                215.0
            };
            if tdir != turnaround && self.step_direction(vm, actor, tdir, dist)? {
                return Ok(());
            }
        }

        // try other directions
        if (vm.rng_u32() & 3) & 1 != 0 || (deltay as i32).abs() > (deltax as i32).abs() {
            d.swap(1, 2);
        }
        if d[1] != DI_NODIR && d[1] != turnaround && self.step_direction(vm, actor, d[1], dist)? {
            return Ok(());
        }
        if d[2] != DI_NODIR && d[2] != turnaround && self.step_direction(vm, actor, d[2], dist)? {
            return Ok(());
        }

        // there is no direct path to the player, so pick another direction
        if olddir != DI_NODIR && self.step_direction(vm, actor, olddir, dist)? {
            return Ok(());
        }
        if vm.rng_u32() & 1 != 0 {
            // randomly determine direction of search
            let mut tdir = 0.0f32;
            while tdir <= 315.0 {
                if tdir != turnaround && self.step_direction(vm, actor, tdir, dist)? {
                    return Ok(());
                }
                tdir += 45.0;
            }
        } else {
            let mut tdir = 315.0f32;
            while tdir >= 0.0 {
                if tdir != turnaround && self.step_direction(vm, actor, tdir, dist)? {
                    return Ok(());
                }
                tdir -= 45.0;
            }
        }
        if turnaround != DI_NODIR && self.step_direction(vm, actor, turnaround, dist)? {
            return Ok(());
        }

        vm.set_e_f(actor, fld::IDEAL_YAW, olddir); // can't move

        // if a bridge was pulled out from underneath a monster, it may not have a valid
        // standing position at all
        if !self.check_bottom(vm, actor) {
            Self::set_flags(vm, actor, Self::flags(vm, actor) | FL_PARTIALGROUND);
        }
        Ok(())
    }

    /// SV_CloseEnough
    fn close_enough(vm: &Vm, ent: Ent, goal: Ent, dist: f32) -> bool {
        let (gmin, gmax) = (vm.e_v(goal, fld::ABSMIN), vm.e_v(goal, fld::ABSMAX));
        let (emin, emax) = (vm.e_v(ent, fld::ABSMIN), vm.e_v(ent, fld::ABSMAX));
        for i in 0..3 {
            if gmin[i] > emax[i] + dist {
                return false;
            }
            if gmax[i] < emin[i] - dist {
                return false;
            }
        }
        true
    }

    /// SV_MoveToGoal
    pub fn move_to_goal(&mut self, vm: &mut Vm) -> Result<(), VmError> {
        let ent = vm.g_e(glob::SELF);
        let goal = vm.e_e(ent, fld::GOALENTITY);
        let dist = vm.parm_f(0);

        if Self::flags(vm, ent) & (FL_ONGROUND | FL_FLY | FL_SWIM) == 0 {
            vm.ret_f(0.0);
            return Ok(());
        }

        // if the next step hits the enemy, return immediately
        if vm.e_e(ent, fld::ENEMY) != 0 && Self::close_enough(vm, ent, goal, dist) {
            return Ok(());
        }

        // bump around...
        let ideal = vm.e_f(ent, fld::IDEAL_YAW);
        if vm.rng_u32() & 3 == 1 || !self.step_direction(vm, ent, ideal, dist)? {
            self.new_chase_dir(vm, ent, goal, dist)?;
        }
        Ok(())
    }
}
