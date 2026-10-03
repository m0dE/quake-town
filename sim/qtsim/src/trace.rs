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
//! Hull tracing shared by the server (world.c SV_RecursiveHullCheck,
//! SV_HullPointContents, SV_HullForBox) and pmove (pmovetst.c PM_RecursiveHullCheck,
//! PM_HullPointContents, PM_HullForBox). The two C copies are identical apart from the
//! trace type, so one implementation serves both.

use crate::bsp::*;
use crate::mathlib::*;

/// trace_t / pmtrace_t. `ent` is an edict number (server) or a physent index (pmove);
/// -1 = none.
#[derive(Clone, Copy, Debug)]
pub struct Trace {
    pub allsolid: bool,
    pub startsolid: bool,
    pub inopen: bool,
    pub inwater: bool,
    pub fraction: f32,
    pub endpos: Vec3,
    pub normal: Vec3,
    pub dist: f32,
    pub ent: i32,
}

impl Trace {
    /// memset 0 + fraction 1 + allsolid + endpos = end
    #[inline]
    pub fn start(end: &Vec3) -> Trace {
        Trace {
            allsolid: true,
            startsolid: false,
            inopen: false,
            inwater: false,
            fraction: 1.0,
            endpos: *end,
            normal: [0.0; 3],
            dist: 0.0,
            ent: -1,
        }
    }
}

/// SV_HullPointContents / PM_HullPointContents
#[inline]
pub fn hull_point_contents(hull: &Hull, mut num: i32, p: &Vec3) -> i32 {
    while num >= 0 {
        let node = &hull.clipnodes[num as usize];
        let plane = &hull.planes[node.plane as usize];
        let d = if plane.ty < 3 { p[plane.ty as usize] - plane.dist } else { dot(&plane.normal, p) - plane.dist };
        num = if d < 0.0 { node.children[1] } else { node.children[0] };
    }
    num
}

const DIST_EPSILON: f64 = 0.03125;

/// SV_RecursiveHullCheck / PM_RecursiveHullCheck
pub fn recursive_hull_check(hull: &Hull, num: i32, p1f: f32, p2f: f32, p1: &Vec3, p2: &Vec3, trace: &mut Trace) -> bool {
    // check for empty
    if num < 0 {
        if num != CONTENTS_SOLID {
            trace.allsolid = false;
            if num == CONTENTS_EMPTY {
                trace.inopen = true;
            } else {
                trace.inwater = true;
            }
        } else {
            trace.startsolid = true;
        }
        return true; // empty
    }

    // find the point distances
    let node = &hull.clipnodes[num as usize];
    let plane = &hull.planes[node.plane as usize];
    let (t1, t2) = if plane.ty < 3 {
        let t = plane.ty as usize;
        (p1[t] - plane.dist, p2[t] - plane.dist)
    } else {
        (dot(&plane.normal, p1) - plane.dist, dot(&plane.normal, p2) - plane.dist)
    };

    if t1 >= 0.0 && t2 >= 0.0 {
        return recursive_hull_check(hull, node.children[0], p1f, p2f, p1, p2, trace);
    }
    if t1 < 0.0 && t2 < 0.0 {
        return recursive_hull_check(hull, node.children[1], p1f, p2f, p1, p2, trace);
    }

    // put the crosspoint DIST_EPSILON pixels on the near side
    let mut frac: f32 = if t1 < 0.0 {
        ((t1 as f64 + DIST_EPSILON) / ((t1 - t2) as f64)) as f32
    } else {
        ((t1 as f64 - DIST_EPSILON) / ((t1 - t2) as f64)) as f32
    };
    if frac < 0.0 {
        frac = 0.0;
    }
    if frac > 1.0 {
        frac = 1.0;
    }

    let mut midf = p1f + (p2f - p1f) * frac;
    let mut mid = [0.0f32; 3];
    for i in 0..3 {
        mid[i] = p1[i] + frac * (p2[i] - p1[i]);
    }

    let side = (t1 < 0.0) as usize;

    // move up to the node
    if !recursive_hull_check(hull, node.children[side], p1f, midf, p1, &mid, trace) {
        return false;
    }

    if hull_point_contents(hull, node.children[side ^ 1], &mid) != CONTENTS_SOLID {
        // go past the node
        return recursive_hull_check(hull, node.children[side ^ 1], midf, p2f, &mid, p2, trace);
    }

    if trace.allsolid {
        return false; // never got out of the solid area
    }

    // the other side of the node is solid, this is the impact point
    if side == 0 {
        trace.normal = plane.normal;
        trace.dist = plane.dist;
    } else {
        trace.normal = sub(&VEC3_ORIGIN, &plane.normal);
        trace.dist = -plane.dist;
    }

    while hull_point_contents(hull, hull.firstclipnode, &mid) == CONTENTS_SOLID {
        // shouldn't really happen, but does occasionally
        frac = (frac as f64 - 0.1) as f32;
        if frac < 0.0 {
            trace.fraction = midf;
            trace.endpos = mid;
            return false;
        }
        midf = p1f + (p2f - p1f) * frac;
        for i in 0..3 {
            mid[i] = p1[i] + frac * (p2[i] - p1[i]);
        }
    }

    trace.fraction = midf;
    trace.endpos = mid;
    false
}

#[derive(Clone)]
/// box_hull of SV_InitBoxHull / PM_InitBoxHull, filled by SV_HullForBox.
pub struct BoxHull {
    pub planes: [Plane; 6],
    pub clipnodes: [ClipNode; 6],
}

impl BoxHull {
    pub fn new() -> BoxHull {
        let mut planes = [Plane::default(); 6];
        let mut clipnodes = [ClipNode::default(); 6];
        for i in 0..6 {
            clipnodes[i].plane = i as u32;
            let side = i & 1;
            clipnodes[i].children[side] = CONTENTS_EMPTY;
            clipnodes[i].children[side ^ 1] = if i != 5 { i as i32 + 1 } else { CONTENTS_SOLID };
            planes[i].ty = (i >> 1) as u8;
            planes[i].normal[i >> 1] = 1.0;
        }
        BoxHull { planes, clipnodes }
    }

    /// SV_HullForBox
    #[inline]
    pub fn set(&mut self, mins: &Vec3, maxs: &Vec3) {
        self.planes[0].dist = maxs[0];
        self.planes[1].dist = mins[0];
        self.planes[2].dist = maxs[1];
        self.planes[3].dist = mins[1];
        self.planes[4].dist = maxs[2];
        self.planes[5].dist = mins[2];
    }

    #[inline]
    pub fn hull(&self) -> Hull<'_> {
        Hull { clipnodes: &self.clipnodes, planes: &self.planes, firstclipnode: 0, clip_mins: [0.0; 3], clip_maxs: [0.0; 3] }
    }
}

impl Default for BoxHull {
    fn default() -> Self {
        Self::new()
    }
}
