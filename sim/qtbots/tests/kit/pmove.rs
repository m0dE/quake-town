// Quake Town - qtbots test kit: QW player movement (port of QW/client/pmove.c, world +
// brush-model physents only) so bot usercmds can be checked against real movement.
// Copyright (C) 1996-1997 Id Software, Inc.
// Copyright (C) 2026 Quake Town contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// This program is free software; you can redistribute it and/or modify it under the terms
// of the GNU General Public License as published by the Free Software Foundation; either
// version 2 of the License, or (at your option) any later version.

use super::bsp::{trace_model, Bsp};
use qtbots::{Trace, UserCmd, Vec3};

pub const PMINS: Vec3 = [-16.0, -16.0, -24.0];
pub const PMAXS: Vec3 = [16.0, 16.0, 32.0];

/// A brush model physent at an offset.
#[derive(Clone, Copy)]
pub struct PhysEnt {
    pub model: usize,
    pub origin: Vec3,
    pub ent: i32,
}

#[derive(Clone, Copy, Default, Debug)]
pub struct PState {
    pub origin: Vec3,
    pub velocity: Vec3,
    pub angles: Vec3,
    pub oldbuttons: u32,
    pub waterjumptime: f32,
    pub dead: bool,
    pub onground: i32,
    pub waterlevel: i32,
    pub watertype: i32,
}

struct Ctx<'a> {
    bsp: &'a Bsp,
    phys: &'a [PhysEnt],
    frametime: f32,
    forward: Vec3,
    right: Vec3,
}

fn dot(a: Vec3, b: Vec3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn vnorm(v: &mut Vec3) -> f32 {
    let l = dot(*v, *v).sqrt();
    if l != 0.0 {
        let il = 1.0 / l;
        v[0] *= il;
        v[1] *= il;
        v[2] *= il;
    }
    l
}

impl<'a> Ctx<'a> {
    fn pm_move(&self, start: Vec3, end: Vec3) -> Trace {
        let mut total = Trace { fraction: 1.0, endpos: end, normal: [0.0; 3], allsolid: false, startsolid: false, ent: -1 };
        for pe in self.phys.iter() {
            let t = trace_model(self.bsp, pe.model, pe.origin, start, PMINS, PMAXS, end);
            if t.fraction < total.fraction {
                total = t;
                total.ent = pe.ent;
            }
        }
        total
    }
    fn point_contents(&self, p: Vec3) -> i32 {
        self.bsp.point_contents(p)
    }
}

fn clip_velocity(inv: Vec3, normal: Vec3, overbounce: f32) -> Vec3 {
    let backoff = dot(inv, normal) * overbounce;
    let mut out = [0.0; 3];
    for i in 0..3 {
        out[i] = inv[i] - normal[i] * backoff;
        if out[i] > -0.1 && out[i] < 0.1 {
            out[i] = 0.0;
        }
    }
    out
}

fn fly_move(c: &Ctx, s: &mut PState) -> i32 {
    let mut blocked = 0;
    let original = s.velocity;
    let primal = s.velocity;
    let mut planes: Vec<Vec3> = Vec::new();
    let mut time_left = c.frametime;
    for _ in 0..4 {
        let end = [
            s.origin[0] + time_left * s.velocity[0],
            s.origin[1] + time_left * s.velocity[1],
            s.origin[2] + time_left * s.velocity[2],
        ];
        let t = c.pm_move(s.origin, end);
        if t.startsolid || t.allsolid {
            s.velocity = [0.0; 3];
            return 3;
        }
        if t.fraction > 0.0 {
            s.origin = t.endpos;
            planes.clear();
        }
        if t.fraction == 1.0 {
            break;
        }
        if t.normal[2] > 0.7 {
            blocked |= 1;
        }
        if t.normal[2] == 0.0 {
            blocked |= 2;
        }
        time_left -= time_left * t.fraction;
        if planes.len() >= 5 {
            s.velocity = [0.0; 3];
            break;
        }
        planes.push(t.normal);
        let mut i = 0;
        while i < planes.len() {
            s.velocity = clip_velocity(original, planes[i], 1.0);
            let mut j = 0;
            while j < planes.len() {
                if j != i && dot(s.velocity, planes[j]) < 0.0 {
                    break;
                }
                j += 1;
            }
            if j == planes.len() {
                break;
            }
            i += 1;
        }
        if i == planes.len() {
            if planes.len() != 2 {
                s.velocity = [0.0; 3];
                break;
            }
            let (a, b) = (planes[0], planes[1]);
            let dir = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
            let d = dot(dir, s.velocity);
            s.velocity = [dir[0] * d, dir[1] * d, dir[2] * d];
        }
        if dot(s.velocity, primal) <= 0.0 {
            s.velocity = [0.0; 3];
            break;
        }
    }
    if s.waterjumptime != 0.0 {
        s.velocity = primal;
    }
    blocked
}

fn ground_move(c: &Ctx, s: &mut PState) {
    s.velocity[2] = 0.0;
    if s.velocity[0] == 0.0 && s.velocity[1] == 0.0 {
        return;
    }
    let dest = [s.origin[0] + s.velocity[0] * c.frametime, s.origin[1] + s.velocity[1] * c.frametime, s.origin[2]];
    let t = c.pm_move(s.origin, dest);
    if t.fraction == 1.0 {
        s.origin = t.endpos;
        return;
    }
    let original = s.origin;
    let originalvel = s.velocity;
    fly_move(c, s);
    let down = s.origin;
    let downvel = s.velocity;
    s.origin = original;
    s.velocity = originalvel;
    let mut dest = s.origin;
    dest[2] += 18.0;
    let t = c.pm_move(s.origin, dest);
    if !t.startsolid && !t.allsolid {
        s.origin = t.endpos;
    }
    fly_move(c, s);
    let mut dest = s.origin;
    dest[2] -= 18.0;
    let t = c.pm_move(s.origin, dest);
    if t.normal[2] < 0.7 {
        s.origin = down;
        s.velocity = downvel;
        return;
    }
    if !t.startsolid && !t.allsolid {
        s.origin = t.endpos;
    }
    let up = s.origin;
    let downdist = (down[0] - original[0]) * (down[0] - original[0]) + (down[1] - original[1]) * (down[1] - original[1]);
    let updist = (up[0] - original[0]) * (up[0] - original[0]) + (up[1] - original[1]) * (up[1] - original[1]);
    if downdist > updist {
        s.origin = down;
        s.velocity = downvel;
    } else {
        s.velocity[2] = downvel[2];
    }
}

fn friction(c: &Ctx, s: &mut PState) {
    if s.waterjumptime != 0.0 {
        return;
    }
    let v = s.velocity;
    let speed = dot(v, v).sqrt();
    if speed < 1.0 {
        s.velocity[0] = 0.0;
        s.velocity[1] = 0.0;
        return;
    }
    let mut fr = 4.0;
    if s.onground != -1 {
        let start = [s.origin[0] + v[0] / speed * 16.0, s.origin[1] + v[1] / speed * 16.0, s.origin[2] + PMINS[2]];
        let stop = [start[0], start[1], start[2] - 34.0];
        if c.pm_move(start, stop).fraction == 1.0 {
            fr *= 2.0;
        }
    }
    let mut drop = 0.0;
    if s.waterlevel >= 2 {
        drop += speed * 4.0 * s.waterlevel as f32 * c.frametime;
    } else if s.onground != -1 {
        let control = if speed < 100.0 { 100.0 } else { speed };
        drop += control * fr * c.frametime;
    }
    let mut ns = speed - drop;
    if ns < 0.0 {
        ns = 0.0;
    }
    ns /= speed;
    s.velocity = [v[0] * ns, v[1] * ns, v[2] * ns];
}

fn accelerate(c: &Ctx, s: &mut PState, wishdir: Vec3, wishspeed: f32, accel: f32, air: bool) {
    if s.dead || s.waterjumptime != 0.0 {
        return;
    }
    let wishspd = if air && wishspeed > 30.0 { 30.0 } else { wishspeed };
    let cur = dot(s.velocity, wishdir);
    let add = wishspd - cur;
    if add <= 0.0 {
        return;
    }
    let mut a = accel * wishspeed * c.frametime;
    if a > add {
        a = add;
    }
    for i in 0..3 {
        s.velocity[i] += a * wishdir[i];
    }
}

fn categorize(c: &Ctx, s: &mut PState) {
    let point = [s.origin[0], s.origin[1], s.origin[2] - 1.0];
    if s.velocity[2] > 180.0 {
        s.onground = -1;
    } else {
        let t = c.pm_move(s.origin, point);
        s.onground = if t.normal[2] < 0.7 { -1 } else { t.ent.max(0) };
        if s.onground != -1 {
            s.waterjumptime = 0.0;
            if !t.startsolid && !t.allsolid {
                s.origin = t.endpos;
            }
        }
    }
    s.waterlevel = 0;
    s.watertype = -1;
    let mut p = [s.origin[0], s.origin[1], s.origin[2] + PMINS[2] + 1.0];
    let cont = c.point_contents(p);
    if cont <= -3 {
        s.watertype = cont;
        s.waterlevel = 1;
        p[2] = s.origin[2] + (PMINS[2] + PMAXS[2]) * 0.5;
        if c.point_contents(p) <= -3 {
            s.waterlevel = 2;
            p[2] = s.origin[2] + 22.0;
            if c.point_contents(p) <= -3 {
                s.waterlevel = 3;
            }
        }
    }
}

fn jump_button(c: &Ctx, s: &mut PState) {
    if s.dead {
        s.oldbuttons |= 2;
        return;
    }
    if s.waterjumptime != 0.0 {
        s.waterjumptime -= c.frametime;
        if s.waterjumptime < 0.0 {
            s.waterjumptime = 0.0;
        }
        return;
    }
    if s.waterlevel >= 2 {
        s.onground = -1;
        s.velocity[2] = match s.watertype {
            -3 => 100.0,
            -4 => 80.0,
            _ => 50.0,
        };
        return;
    }
    if s.onground == -1 || s.oldbuttons & 2 != 0 {
        return;
    }
    s.onground = -1;
    s.velocity[2] += 270.0;
    s.oldbuttons |= 2;
}

fn angle_vectors(a: Vec3) -> (Vec3, Vec3) {
    let k = std::f64::consts::PI * 2.0 / 360.0;
    let (sy, cy) = ((libm::sin(a[1] as f64 * k)) as f32, (libm::cos(a[1] as f64 * k)) as f32);
    let (sp, cp) = ((libm::sin(a[0] as f64 * k)) as f32, (libm::cos(a[0] as f64 * k)) as f32);
    let (sr, cr) = ((libm::sin(a[2] as f64 * k)) as f32, (libm::cos(a[2] as f64 * k)) as f32);
    let fwd = [cp * cy, cp * sy, -sp];
    let right = [-1.0 * sr * sp * cy + -1.0 * cr * -sy, -1.0 * sr * sp * sy + -1.0 * cr * cy, -1.0 * sr * cp];
    (fwd, right)
}

/// One PlayerMove with msec 13 (angles from the cmd, as SV_RunCmd does).
pub fn player_move(bsp: &Bsp, phys: &[PhysEnt], s: &mut PState, cmd: &UserCmd) {
    s.angles = [qtbots::short2angle(cmd.pitch16), qtbots::short2angle(cmd.yaw16), 0.0];
    let (forward, right) = angle_vectors(s.angles);
    let c = Ctx { bsp, phys, frametime: 0.013, forward, right };
    categorize(&c, s);
    if s.velocity[2] < 0.0 {
        s.waterjumptime = 0.0;
    }
    if cmd.buttons & 2 != 0 {
        jump_button(&c, s);
    } else {
        s.oldbuttons &= !2;
    }
    friction(&c, s);
    let (fm, sm, um) = (cmd.forward as f32, cmd.side as f32, cmd.up as f32);
    if s.waterlevel >= 2 {
        let mut wishvel = [0.0; 3];
        for i in 0..3 {
            wishvel[i] = c.forward[i] * fm + c.right[i] * sm;
        }
        if fm == 0.0 && sm == 0.0 && um == 0.0 {
            wishvel[2] -= 60.0;
        } else {
            wishvel[2] += um;
        }
        let mut wishdir = wishvel;
        let mut wishspeed = vnorm(&mut wishdir);
        if wishspeed > 320.0 {
            wishspeed = 320.0;
        }
        wishspeed *= 0.7;
        accelerate(&c, s, wishdir, wishspeed, 10.0, false);
        let dest = [
            s.origin[0] + c.frametime * s.velocity[0],
            s.origin[1] + c.frametime * s.velocity[1],
            s.origin[2] + c.frametime * s.velocity[2],
        ];
        let mut start = dest;
        start[2] += 19.0;
        let t = c.pm_move(start, dest);
        if !t.startsolid && !t.allsolid {
            s.origin = t.endpos;
        } else {
            fly_move(&c, s);
        }
    } else {
        let mut f = c.forward;
        let mut r = c.right;
        f[2] = 0.0;
        r[2] = 0.0;
        vnorm(&mut f);
        vnorm(&mut r);
        let wishvel = [f[0] * fm + r[0] * sm, f[1] * fm + r[1] * sm, 0.0];
        let mut wishdir = wishvel;
        let mut wishspeed = vnorm(&mut wishdir);
        if wishspeed > 320.0 {
            wishspeed = 320.0;
        }
        if s.onground != -1 {
            s.velocity[2] = 0.0;
            accelerate(&c, s, wishdir, wishspeed, 10.0, false);
            s.velocity[2] -= 800.0 * c.frametime;
            ground_move(&c, s);
        } else {
            accelerate(&c, s, wishdir, wishspeed, 10.0, true);
            s.velocity[2] -= 800.0 * c.frametime;
            fly_move(&c, s);
        }
    }
    categorize(&c, s);
}
