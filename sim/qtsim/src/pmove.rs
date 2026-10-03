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
//! Line-by-line port of QW/client/pmove.c and pmovetst.c (QuakeWorld 2.33).
//! The C globals (pmove, onground, waterlevel, watertype, frametime, forward/right/up)
//! are fields of `PlayerMove`.

use crate::bsp::*;
use crate::mathlib::*;
use crate::trace::*;

pub const MAX_PHYSENTS: usize = 32;
pub const STEPSIZE: f32 = 18.0;
pub const BUTTON_JUMP: i32 = 2;
pub const PLAYER_MINS: Vec3 = [-16.0, -16.0, -24.0];
pub const PLAYER_MAXS: Vec3 = [16.0, 16.0, 32.0];

#[derive(Clone, Copy, Debug)]
pub struct MoveVars {
    pub gravity: f32,
    pub stopspeed: f32,
    pub maxspeed: f32,
    pub spectatormaxspeed: f32,
    pub accelerate: f32,
    pub airaccelerate: f32,
    pub wateraccelerate: f32,
    pub friction: f32,
    pub waterfriction: f32,
    pub entgravity: f32,
}

impl Default for MoveVars {
    /// DESIGN.md "pmove" movevars (QW server defaults)
    fn default() -> Self {
        MoveVars {
            gravity: 800.0,
            stopspeed: 100.0,
            maxspeed: 320.0,
            spectatormaxspeed: 500.0,
            accelerate: 10.0,
            airaccelerate: 0.7,
            wateraccelerate: 10.0,
            friction: 4.0,
            waterfriction: 4.0,
            entgravity: 1.0,
        }
    }
}

/// usercmd_t
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct UserCmd {
    pub msec: u8,
    pub angles: Vec3,
    pub forwardmove: i16,
    pub sidemove: i16,
    pub upmove: i16,
    pub buttons: u8,
    pub impulse: u8,
}

/// physent_t. `model` is a brush submodel index of the map (-1 = use the box).
#[derive(Clone, Copy, Debug, Default)]
pub struct PhysEnt {
    pub origin: Vec3,
    pub model: i32,
    pub mins: Vec3,
    pub maxs: Vec3,
    pub info: i32,
}

/// playermove_t + pmove.c's file globals
pub struct PlayerMove<'a> {
    pub map: &'a Map,
    pub movevars: MoveVars,

    // player state
    pub origin: Vec3,
    pub angles: Vec3,
    pub velocity: Vec3,
    pub oldbuttons: i32,
    pub waterjumptime: f32,
    pub dead: bool,
    pub spectator: bool,

    // world state
    pub physents: &'a [PhysEnt],

    // input
    pub cmd: UserCmd,

    // results
    pub numtouch: usize,
    pub touchindex: [i32; MAX_PHYSENTS],

    pub onground: i32,
    pub waterlevel: i32,
    pub watertype: i32,

    frametime: f32,
    forward: Vec3,
    right: Vec3,
    up: Vec3,
    boxhull: BoxHull,
}

impl<'a> PlayerMove<'a> {
    pub fn new(map: &'a Map, physents: &'a [PhysEnt]) -> Self {
        PlayerMove {
            map,
            movevars: MoveVars::default(),
            origin: [0.0; 3],
            angles: [0.0; 3],
            velocity: [0.0; 3],
            oldbuttons: 0,
            waterjumptime: 0.0,
            dead: false,
            spectator: false,
            physents,
            cmd: UserCmd::default(),
            numtouch: 0,
            touchindex: [0; MAX_PHYSENTS],
            onground: -1,
            waterlevel: 0,
            watertype: CONTENTS_EMPTY,
            frametime: 0.0,
            forward: [0.0; 3],
            right: [0.0; 3],
            up: [0.0; 3],
            boxhull: BoxHull::new(),
        }
    }

    #[inline]
    fn add_touch(&mut self, ent: i32) {
        if self.numtouch < MAX_PHYSENTS {
            self.touchindex[self.numtouch] = ent;
            self.numtouch += 1;
        }
    }

    // ------------------------------------------------------------------ pmovetst.c

    /// PM_PointContents
    pub fn point_contents(&self, p: &Vec3) -> i32 {
        let hull = self.map.hull(self.physents[0].model.max(0) as usize, 0);
        hull_point_contents(&hull, hull.firstclipnode, p)
    }

    /// PM_TestPlayerPosition: false if the position is in solid
    pub fn test_player_position(&mut self, pos: &Vec3) -> bool {
        for i in 0..self.physents.len() {
            let pe = self.physents[i];
            let test = sub(pos, &pe.origin);
            let c = if pe.model >= 0 {
                let hull = self.map.hull(pe.model as usize, 1);
                hull_point_contents(&hull, hull.firstclipnode, &test)
            } else {
                let mins = sub(&pe.mins, &PLAYER_MAXS);
                let maxs = sub(&pe.maxs, &PLAYER_MINS);
                self.boxhull.set(&mins, &maxs);
                let hull = self.boxhull.hull();
                hull_point_contents(&hull, hull.firstclipnode, &test)
            };
            if c == CONTENTS_SOLID {
                return false;
            }
        }
        true
    }

    /// PM_PlayerMove
    pub fn player_trace(&mut self, start: &Vec3, end: &Vec3) -> Trace {
        let mut total = Trace::start(end);
        total.allsolid = false;
        total.ent = -1;

        for i in 0..self.physents.len() {
            let pe = self.physents[i];
            let offset = pe.origin;
            let start_l = sub(start, &offset);
            let end_l = sub(end, &offset);

            let mut trace = Trace::start(end);
            if pe.model >= 0 {
                let hull = self.map.hull(pe.model as usize, 1);
                recursive_hull_check(&hull, hull.firstclipnode, 0.0, 1.0, &start_l, &end_l, &mut trace);
            } else {
                let mins = sub(&pe.mins, &PLAYER_MAXS);
                let maxs = sub(&pe.maxs, &PLAYER_MINS);
                self.boxhull.set(&mins, &maxs);
                let hull = self.boxhull.hull();
                recursive_hull_check(&hull, hull.firstclipnode, 0.0, 1.0, &start_l, &end_l, &mut trace);
            }

            if trace.allsolid {
                trace.startsolid = true;
            }
            if trace.startsolid {
                trace.fraction = 0.0;
            }

            // did we clip the move?
            if trace.fraction < total.fraction {
                // fix trace up by the offset
                trace.endpos = add(&trace.endpos, &offset);
                total = trace;
                total.ent = i as i32;
            }
        }
        total
    }

    // ------------------------------------------------------------------ pmove.c

    /// PM_FlyMove
    fn fly_move(&mut self) -> i32 {
        const MAX_CLIP_PLANES: usize = 5;
        let numbumps = 4;
        let mut blocked = 0;
        let original_velocity = self.velocity;
        let primal_velocity = self.velocity;
        let mut numplanes = 0usize;
        let mut planes = [[0.0f32; 3]; MAX_CLIP_PLANES];
        let mut time_left = self.frametime;

        for _bumpcount in 0..numbumps {
            let mut end = [0.0f32; 3];
            for i in 0..3 {
                end[i] = self.origin[i] + time_left * self.velocity[i];
            }

            let origin = self.origin;
            let trace = self.player_trace(&origin, &end);

            if trace.startsolid || trace.allsolid {
                // entity is trapped in another solid
                self.velocity = VEC3_ORIGIN;
                return 3;
            }

            if trace.fraction > 0.0 {
                // actually covered some distance
                self.origin = trace.endpos;
                numplanes = 0;
            }

            if trace.fraction == 1.0 {
                break; // moved the entire distance
            }

            // save entity for contact
            self.add_touch(trace.ent);

            if (trace.normal[2] as f64) > 0.7 {
                blocked |= 1; // floor
            }
            if trace.normal[2] == 0.0 {
                blocked |= 2; // step
            }

            time_left -= time_left * trace.fraction;

            // cliped to another plane
            if numplanes >= MAX_CLIP_PLANES {
                // this shouldn't really happen
                self.velocity = VEC3_ORIGIN;
                break;
            }

            planes[numplanes] = trace.normal;
            numplanes += 1;

            // modify original_velocity so it parallels all of the clip planes
            let mut i = 0;
            while i < numplanes {
                clip_velocity(&original_velocity, &planes[i], &mut self.velocity, 1.0);
                let mut j = 0;
                while j < numplanes {
                    if j != i && dot(&self.velocity, &planes[j]) < 0.0 {
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
            } else {
                // go along the crease
                if numplanes != 2 {
                    self.velocity = VEC3_ORIGIN;
                    break;
                }
                let dir = cross(&planes[0], &planes[1]);
                let d = dot(&dir, &self.velocity);
                self.velocity = scale(&dir, d);
            }

            // if original velocity is against the original velocity, stop dead
            // to avoid tiny occilations in sloping corners
            if dot(&self.velocity, &primal_velocity) <= 0.0 {
                self.velocity = VEC3_ORIGIN;
                break;
            }
        }

        if self.waterjumptime != 0.0 {
            self.velocity = primal_velocity;
        }
        blocked
    }

    /// PM_GroundMove: player is on ground, with no upwards velocity
    fn ground_move(&mut self) {
        self.velocity[2] = 0.0;
        if self.velocity[0] == 0.0 && self.velocity[1] == 0.0 && self.velocity[2] == 0.0 {
            return;
        }

        // first try just moving to the destination
        let mut dest = [
            self.origin[0] + self.velocity[0] * self.frametime,
            self.origin[1] + self.velocity[1] * self.frametime,
            self.origin[2],
        ];

        // first try moving directly to the next spot
        let origin = self.origin;
        let trace = self.player_trace(&origin, &dest);
        if trace.fraction == 1.0 {
            self.origin = trace.endpos;
            return;
        }

        // try sliding forward both on ground and up 16 pixels
        // take the move that goes farthest
        let original = self.origin;
        let originalvel = self.velocity;

        // slide move
        self.fly_move();

        let down = self.origin;
        let downvel = self.velocity;

        self.origin = original;
        self.velocity = originalvel;

        // move up a stair height
        dest = self.origin;
        dest[2] += STEPSIZE;
        let origin = self.origin;
        let trace = self.player_trace(&origin, &dest);
        if !trace.startsolid && !trace.allsolid {
            self.origin = trace.endpos;
        }

        // slide move
        self.fly_move();

        // press down the stepheight
        dest = self.origin;
        dest[2] -= STEPSIZE;
        let origin = self.origin;
        let trace = self.player_trace(&origin, &dest);
        let usedown;
        if (trace.normal[2] as f64) < 0.7 {
            usedown = true;
        } else {
            if !trace.startsolid && !trace.allsolid {
                self.origin = trace.endpos;
            }
            let up = self.origin;

            // decide which one went farther
            let downdist = (down[0] - original[0]) * (down[0] - original[0]) + (down[1] - original[1]) * (down[1] - original[1]);
            let updist = (up[0] - original[0]) * (up[0] - original[0]) + (up[1] - original[1]) * (up[1] - original[1]);
            usedown = downdist > updist;
        }
        if usedown {
            self.origin = down;
            self.velocity = downvel;
        } else {
            // copy z value from slide move
            self.velocity[2] = downvel[2];
        }
    }

    /// PM_Friction: handles both ground friction and water friction
    fn friction(&mut self) {
        if self.waterjumptime != 0.0 {
            return;
        }
        let vel = self.velocity;
        let speed = sqrtf(vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2]);
        if speed < 1.0 {
            self.velocity[0] = 0.0;
            self.velocity[1] = 0.0;
            return;
        }

        let mut friction = self.movevars.friction;

        // if the leading edge is over a dropoff, increase friction
        if self.onground != -1 {
            let mut start = [0.0f32; 3];
            let mut stop = [0.0f32; 3];
            start[0] = self.origin[0] + vel[0] / speed * 16.0;
            stop[0] = start[0];
            start[1] = self.origin[1] + vel[1] / speed * 16.0;
            stop[1] = start[1];
            start[2] = self.origin[2] + PLAYER_MINS[2];
            stop[2] = start[2] - 34.0;

            let trace = self.player_trace(&start, &stop);
            if trace.fraction == 1.0 {
                friction *= 2.0;
            }
        }

        let mut drop = 0.0f32;
        if self.waterlevel >= 2 {
            // apply water friction
            drop += speed * self.movevars.waterfriction * self.waterlevel as f32 * self.frametime;
        } else if self.onground != -1 {
            // apply ground friction
            let control = if speed < self.movevars.stopspeed { self.movevars.stopspeed } else { speed };
            drop += control * friction * self.frametime;
        }

        // scale the velocity
        let mut newspeed = speed - drop;
        if newspeed < 0.0 {
            newspeed = 0.0;
        }
        newspeed /= speed;

        self.velocity[0] *= newspeed;
        self.velocity[1] *= newspeed;
        self.velocity[2] *= newspeed;
    }

    /// PM_Accelerate
    fn accelerate(&mut self, wishdir: &Vec3, wishspeed: f32, accel: f32) {
        if self.dead || self.waterjumptime != 0.0 {
            return;
        }
        let currentspeed = dot(&self.velocity, wishdir);
        let addspeed = wishspeed - currentspeed;
        if addspeed <= 0.0 {
            return;
        }
        let mut accelspeed = accel * self.frametime * wishspeed;
        if accelspeed > addspeed {
            accelspeed = addspeed;
        }
        for i in 0..3 {
            self.velocity[i] += accelspeed * wishdir[i];
        }
    }

    /// PM_AirAccelerate
    fn air_accelerate(&mut self, wishdir: &Vec3, wishspeed: f32, accel: f32) {
        if self.dead || self.waterjumptime != 0.0 {
            return;
        }
        let mut wishspd = wishspeed;
        if wishspd > 30.0 {
            wishspd = 30.0;
        }
        let currentspeed = dot(&self.velocity, wishdir);
        let addspeed = wishspd - currentspeed;
        if addspeed <= 0.0 {
            return;
        }
        let mut accelspeed = accel * wishspeed * self.frametime;
        if accelspeed > addspeed {
            accelspeed = addspeed;
        }
        for i in 0..3 {
            self.velocity[i] += accelspeed * wishdir[i];
        }
    }

    /// PM_WaterMove
    fn water_move(&mut self) {
        let mut wishvel = [0.0f32; 3];
        for i in 0..3 {
            wishvel[i] = self.forward[i] * self.cmd.forwardmove as f32 + self.right[i] * self.cmd.sidemove as f32;
        }

        if self.cmd.forwardmove == 0 && self.cmd.sidemove == 0 && self.cmd.upmove == 0 {
            wishvel[2] -= 60.0; // drift towards bottom
        } else {
            wishvel[2] += self.cmd.upmove as f32;
        }

        let mut wishdir = wishvel;
        let mut wishspeed = normalize(&mut wishdir);

        if wishspeed > self.movevars.maxspeed {
            wishvel = scale(&wishvel, self.movevars.maxspeed / wishspeed);
            wishspeed = self.movevars.maxspeed;
        }
        let _ = wishvel;
        wishspeed = (wishspeed as f64 * 0.7) as f32;

        // water acceleration
        self.accelerate(&wishdir, wishspeed, self.movevars.wateraccelerate);

        // assume it is a stair or a slope, so press down from stepheight above
        let dest = ma(&self.origin, self.frametime, &self.velocity);
        let mut start = dest;
        start[2] += STEPSIZE + 1.0;
        let trace = self.player_trace(&start, &dest);
        if !trace.startsolid && !trace.allsolid {
            // walked up the step
            self.origin = trace.endpos;
            return;
        }

        self.fly_move();
    }

    /// PM_AirMove
    fn air_move(&mut self) {
        let fmove = self.cmd.forwardmove as f32;
        let smove = self.cmd.sidemove as f32;

        self.forward[2] = 0.0;
        self.right[2] = 0.0;
        normalize(&mut self.forward);
        normalize(&mut self.right);

        let mut wishvel = [0.0f32; 3];
        for i in 0..2 {
            wishvel[i] = self.forward[i] * fmove + self.right[i] * smove;
        }
        wishvel[2] = 0.0;

        let mut wishdir = wishvel;
        let mut wishspeed = normalize(&mut wishdir);

        // clamp to server defined max speed
        if wishspeed > self.movevars.maxspeed {
            wishvel = scale(&wishvel, self.movevars.maxspeed / wishspeed);
            wishspeed = self.movevars.maxspeed;
        }
        let _ = wishvel;

        if self.onground != -1 {
            self.velocity[2] = 0.0;
            self.accelerate(&wishdir, wishspeed, self.movevars.accelerate);
            self.velocity[2] -= self.movevars.entgravity * self.movevars.gravity * self.frametime;
            self.ground_move();
        } else {
            // not on ground, so little effect on velocity
            self.air_accelerate(&wishdir, wishspeed, self.movevars.accelerate);

            // add gravity
            self.velocity[2] -= self.movevars.entgravity * self.movevars.gravity * self.frametime;

            self.fly_move();
        }
    }

    /// PM_CatagorizePosition
    fn categorize_position(&mut self) {
        // if the player hull point one unit down is solid, the player is on ground

        // see if standing on something solid
        let mut point = [self.origin[0], self.origin[1], self.origin[2] - 1.0];
        if self.velocity[2] > 180.0 {
            self.onground = -1;
        } else {
            let origin = self.origin;
            let tr = self.player_trace(&origin, &point);
            if (tr.normal[2] as f64) < 0.7 {
                self.onground = -1; // too steep
            } else {
                self.onground = tr.ent;
            }
            if self.onground != -1 {
                self.waterjumptime = 0.0;
                if !tr.startsolid && !tr.allsolid {
                    self.origin = tr.endpos;
                }
            }

            // standing on an entity other than the world
            if tr.ent > 0 {
                self.add_touch(tr.ent);
            }
        }

        // get waterlevel
        self.waterlevel = 0;
        self.watertype = CONTENTS_EMPTY;

        point[2] = self.origin[2] + PLAYER_MINS[2] + 1.0;
        let mut cont = self.point_contents(&point);

        if cont <= CONTENTS_WATER {
            self.watertype = cont;
            self.waterlevel = 1;
            point[2] = (self.origin[2] as f64 + (PLAYER_MINS[2] + PLAYER_MAXS[2]) as f64 * 0.5) as f32;
            cont = self.point_contents(&point);
            if cont <= CONTENTS_WATER {
                self.waterlevel = 2;
                point[2] = self.origin[2] + 22.0;
                cont = self.point_contents(&point);
                if cont <= CONTENTS_WATER {
                    self.waterlevel = 3;
                }
            }
        }
    }

    /// JumpButton
    fn jump_button(&mut self) {
        if self.dead {
            self.oldbuttons |= BUTTON_JUMP; // don't jump again until released
            return;
        }

        if self.waterjumptime != 0.0 {
            self.waterjumptime -= self.frametime;
            if self.waterjumptime < 0.0 {
                self.waterjumptime = 0.0;
            }
            return;
        }

        if self.waterlevel >= 2 {
            // swimming, not jumping
            self.onground = -1;
            self.velocity[2] = if self.watertype == CONTENTS_WATER {
                100.0
            } else if self.watertype == CONTENTS_SLIME {
                80.0
            } else {
                50.0
            };
            return;
        }

        if self.onground == -1 {
            return; // in air, so no effect
        }

        if self.oldbuttons & BUTTON_JUMP != 0 {
            return; // don't pogo stick
        }

        self.onground = -1;
        self.velocity[2] += 270.0;

        self.oldbuttons |= BUTTON_JUMP; // don't jump again until released
    }

    /// CheckWaterJump
    fn check_water_jump(&mut self) {
        if self.waterjumptime != 0.0 {
            return;
        }

        // ZOID, don't hop out if we just jumped in
        if self.velocity[2] < -180.0 {
            return; // only hop out if we are moving up
        }

        // see if near an edge
        let mut flatforward = [self.forward[0], self.forward[1], 0.0];
        normalize(&mut flatforward);

        let mut spot = ma(&self.origin, 24.0, &flatforward);
        spot[2] += 8.0;
        let mut cont = self.point_contents(&spot);
        if cont != CONTENTS_SOLID {
            return;
        }
        spot[2] += 24.0;
        cont = self.point_contents(&spot);
        if cont != CONTENTS_EMPTY {
            return;
        }
        // jump out of water
        self.velocity = scale(&flatforward, 50.0);
        self.velocity[2] = 310.0;
        self.waterjumptime = 2.0; // safety net
        self.oldbuttons |= BUTTON_JUMP; // don't jump again until released
    }

    /// NudgePosition: if pmove.origin is in a solid position, try nudging slightly on
    /// all axis to allow for the cut precision of the net coordinates
    fn nudge_position(&mut self) {
        const SIGN: [i32; 3] = [0, -1, 1];
        let base = self.origin;

        for i in 0..3 {
            self.origin[i] = (((self.origin[i] * 8.0) as i32) as f64 * 0.125) as f32;
        }

        for z in 0..=2 {
            for x in 0..=2 {
                for y in 0..=2 {
                    self.origin[0] = (base[0] as f64 + (SIGN[x] as f64 * 1.0 / 8.0)) as f32;
                    self.origin[1] = (base[1] as f64 + (SIGN[y] as f64 * 1.0 / 8.0)) as f32;
                    self.origin[2] = (base[2] as f64 + (SIGN[z] as f64 * 1.0 / 8.0)) as f32;
                    let o = self.origin;
                    if self.test_player_position(&o) {
                        return;
                    }
                }
            }
        }
        self.origin = base;
    }

    /// SpectatorMove
    fn spectator_move(&mut self) {
        // friction
        let speed = length(&self.velocity);
        if speed < 1.0 {
            self.velocity = VEC3_ORIGIN;
        } else {
            let friction = (self.movevars.friction as f64 * 1.5) as f32; // extra friction
            let control = if speed < self.movevars.stopspeed { self.movevars.stopspeed } else { speed };
            let drop = control * friction * self.frametime;

            // scale the velocity
            let mut newspeed = speed - drop;
            if newspeed < 0.0 {
                newspeed = 0.0;
            }
            newspeed /= speed;
            self.velocity = scale(&self.velocity, newspeed);
        }

        // accelerate
        let fmove = self.cmd.forwardmove as f32;
        let smove = self.cmd.sidemove as f32;

        normalize(&mut self.forward);
        normalize(&mut self.right);

        let mut wishvel = [0.0f32; 3];
        for i in 0..3 {
            wishvel[i] = self.forward[i] * fmove + self.right[i] * smove;
        }
        wishvel[2] += self.cmd.upmove as f32;

        let mut wishdir = wishvel;
        let mut wishspeed = normalize(&mut wishdir);

        // clamp to server defined max speed
        if wishspeed > self.movevars.spectatormaxspeed {
            wishspeed = self.movevars.spectatormaxspeed;
        }

        let currentspeed = dot(&self.velocity, &wishdir);
        let addspeed = wishspeed - currentspeed;
        if addspeed <= 0.0 {
            return;
        }
        let mut accelspeed = self.movevars.accelerate * self.frametime * wishspeed;
        if accelspeed > addspeed {
            accelspeed = addspeed;
        }
        for i in 0..3 {
            self.velocity[i] += accelspeed * wishdir[i];
        }

        // move
        self.origin = ma(&self.origin, self.frametime, &self.velocity);
    }

    /// PlayerMove: returns with origin, angles, and velocity modified in place.
    /// numtouch and touchindex[] are set if any of the physents were contacted.
    pub fn player_move(&mut self) {
        self.frametime = (self.cmd.msec as f64 * 0.001) as f32;
        self.numtouch = 0;

        let (f, r, u) = angle_vectors(&self.angles);
        self.forward = f;
        self.right = r;
        self.up = u;

        if self.spectator {
            self.spectator_move();
            return;
        }

        self.nudge_position();

        // take angles directly from command
        self.angles = self.cmd.angles;

        // set onground, watertype, and waterlevel
        self.categorize_position();

        if self.waterlevel == 2 {
            self.check_water_jump();
        }

        if self.velocity[2] < 0.0 {
            self.waterjumptime = 0.0;
        }

        if self.cmd.buttons as i32 & BUTTON_JUMP != 0 {
            self.jump_button();
        } else {
            self.oldbuttons &= !BUTTON_JUMP;
        }

        self.friction();

        if self.waterlevel >= 2 {
            self.water_move();
        } else {
            self.air_move();
        }

        // set onground, watertype, and waterlevel for final spot
        self.categorize_position();
    }
}

/// PM_ClipVelocity / ClipVelocity: slide off of the impacting object.
/// Returns the blocked flags (1 = floor, 2 = step / wall).
#[inline]
pub fn clip_velocity(input: &Vec3, normal: &Vec3, out: &mut Vec3, overbounce: f32) -> i32 {
    const STOP_EPSILON: f64 = 0.1;
    let mut blocked = 0;
    if normal[2] > 0.0 {
        blocked |= 1; // floor
    }
    if normal[2] == 0.0 {
        blocked |= 2; // step
    }

    let backoff = dot(input, normal) * overbounce;

    for i in 0..3 {
        let change = normal[i] * backoff;
        out[i] = input[i] - change;
        if (out[i] as f64) > -STOP_EPSILON && (out[i] as f64) < STOP_EPSILON {
            out[i] = 0.0;
        }
    }
    blocked
}
