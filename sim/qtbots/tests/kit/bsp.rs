// Quake Town - qtbots test kit: BSP29/BSP2 clipping hulls and hull traces
// (port of Mod_LoadBrushModel hull parts, QW/client/pmovetst.c)
// Copyright (C) 1996-1997 Id Software, Inc.
// Copyright (C) 2026 Quake Town contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// This program is free software; you can redistribute it and/or modify it under the terms
// of the GNU General Public License as published by the Free Software Foundation; either
// version 2 of the License, or (at your option) any later version.

use qtbots::{Trace, Vec3};

#[derive(Clone, Copy)]
pub struct Plane {
    pub normal: Vec3,
    pub dist: f32,
    pub ty: u32,
}

#[derive(Clone, Copy)]
pub struct ClipNode {
    pub plane: u32,
    pub children: [i32; 2],
}

pub struct Model {
    pub mins: Vec3,
    pub maxs: Vec3,
    pub origin: Vec3,
    pub headnode: [i32; 4],
}

pub struct Bsp {
    pub planes: Vec<Plane>,
    /// hull 0 clipnodes (from nodes) and the file clipnodes (hulls 1, 2)
    pub hull0: Vec<ClipNode>,
    pub clip: Vec<ClipNode>,
    pub models: Vec<Model>,
    pub entities: Vec<u8>,
}

pub const HULL_MINS: [Vec3; 3] = [[0.0; 3], [-16.0, -16.0, -24.0], [-32.0, -32.0, -24.0]];
pub const HULL_MAXS: [Vec3; 3] = [[0.0; 3], [16.0, 16.0, 32.0], [32.0, 32.0, 64.0]];

fn i32at(d: &[u8], o: usize) -> i32 {
    i32::from_le_bytes(d[o..o + 4].try_into().unwrap())
}
fn f32at(d: &[u8], o: usize) -> f32 {
    f32::from_le_bytes(d[o..o + 4].try_into().unwrap())
}
fn i16at(d: &[u8], o: usize) -> i16 {
    i16::from_le_bytes(d[o..o + 2].try_into().unwrap())
}

impl Bsp {
    pub fn load(d: &[u8]) -> Bsp {
        let ver = i32at(d, 0);
        let bsp2 = &d[0..4] == b"BSP2";
        assert!(ver == 29 || bsp2, "unsupported bsp version");
        let lump = |i: usize| -> &[u8] {
            let o = i32at(d, 4 + i * 8) as usize;
            let l = i32at(d, 8 + i * 8) as usize;
            &d[o..o + l]
        };
        let entities = lump(0).to_vec();
        let pl = lump(1);
        let planes: Vec<Plane> = pl
            .chunks_exact(20)
            .map(|c| Plane {
                normal: [f32at(c, 0), f32at(c, 4), f32at(c, 8)],
                dist: f32at(c, 12),
                ty: i32at(c, 16) as u32,
            })
            .collect();
        let leafs = lump(10);
        let leaf_size = if bsp2 { 44 } else { 28 };
        let leaf_contents: Vec<i32> = leafs.chunks_exact(leaf_size).map(|c| i32at(c, 0)).collect();
        let nodes = lump(5);
        let node_size = if bsp2 { 44 } else { 24 };
        let hull0: Vec<ClipNode> = nodes
            .chunks_exact(node_size)
            .map(|c| {
                let planenum = i32at(c, 0) as u32;
                let ch = if bsp2 { [i32at(c, 4), i32at(c, 8)] } else { [i16at(c, 4) as i32, i16at(c, 6) as i32] };
                let children = ch.map(|x| if x < 0 { leaf_contents[(-1 - x) as usize] } else { x });
                ClipNode { plane: planenum, children }
            })
            .collect();
        let cl = lump(9);
        let clip_size = if bsp2 { 12 } else { 8 };
        let clip: Vec<ClipNode> = cl
            .chunks_exact(clip_size)
            .map(|c| ClipNode {
                plane: i32at(c, 0) as u32,
                children: if bsp2 { [i32at(c, 4), i32at(c, 8)] } else { [i16at(c, 4) as i32, i16at(c, 6) as i32] },
            })
            .collect();
        let models = lump(14)
            .chunks_exact(64)
            .map(|c| Model {
                mins: [f32at(c, 0), f32at(c, 4), f32at(c, 8)],
                maxs: [f32at(c, 12), f32at(c, 16), f32at(c, 20)],
                origin: [f32at(c, 24), f32at(c, 28), f32at(c, 32)],
                headnode: [i32at(c, 36), i32at(c, 40), i32at(c, 44), i32at(c, 48)],
            })
            .collect();
        Bsp { planes, hull0, clip, models, entities }
    }

    fn nodes(&self, hull: usize) -> &[ClipNode] {
        if hull == 0 {
            &self.hull0
        } else {
            &self.clip
        }
    }

    pub fn hull_point_contents(&self, hull: usize, mut num: i32, p: Vec3) -> i32 {
        let nodes = self.nodes(hull);
        while num >= 0 {
            let node = &nodes[num as usize];
            let pl = &self.planes[node.plane as usize];
            let d = if pl.ty < 3 { p[pl.ty as usize] - pl.dist } else { dot(pl.normal, p) - pl.dist };
            num = if d < 0.0 { node.children[1] } else { node.children[0] };
        }
        num
    }

    pub fn point_contents(&self, p: Vec3) -> i32 {
        self.hull_point_contents(0, self.models[0].headnode[0], p)
    }

    fn recursive(&self, hull: usize, head: i32, num: i32, p1f: f32, p2f: f32, p1: Vec3, p2: Vec3, tr: &mut Trace, st: &mut (bool, bool)) -> bool {
        const DIST_EPSILON: f32 = 0.03125;
        if num < 0 {
            if num != -2 {
                tr.allsolid = false;
                if num == -1 {
                    st.0 = true;
                } else {
                    st.1 = true;
                }
            } else {
                tr.startsolid = true;
            }
            return true;
        }
        let nodes = self.nodes(hull);
        let node = nodes[num as usize];
        let pl = self.planes[node.plane as usize];
        let (t1, t2) = if pl.ty < 3 {
            (p1[pl.ty as usize] - pl.dist, p2[pl.ty as usize] - pl.dist)
        } else {
            (dot(pl.normal, p1) - pl.dist, dot(pl.normal, p2) - pl.dist)
        };
        if t1 >= 0.0 && t2 >= 0.0 {
            return self.recursive(hull, head, node.children[0], p1f, p2f, p1, p2, tr, st);
        }
        if t1 < 0.0 && t2 < 0.0 {
            return self.recursive(hull, head, node.children[1], p1f, p2f, p1, p2, tr, st);
        }
        let mut frac = if t1 < 0.0 { (t1 + DIST_EPSILON) / (t1 - t2) } else { (t1 - DIST_EPSILON) / (t1 - t2) };
        frac = frac.clamp(0.0, 1.0);
        let mut midf = p1f + (p2f - p1f) * frac;
        let mut mid = [p1[0] + frac * (p2[0] - p1[0]), p1[1] + frac * (p2[1] - p1[1]), p1[2] + frac * (p2[2] - p1[2])];
        let side = (t1 < 0.0) as usize;
        if !self.recursive(hull, head, node.children[side], p1f, midf, p1, mid, tr, st) {
            return false;
        }
        if self.hull_point_contents(hull, node.children[side ^ 1], mid) != -2 {
            return self.recursive(hull, head, node.children[side ^ 1], midf, p2f, mid, p2, tr, st);
        }
        if tr.allsolid {
            return false;
        }
        if side == 0 {
            tr.normal = pl.normal;
        } else {
            tr.normal = [-pl.normal[0], -pl.normal[1], -pl.normal[2]];
        }
        while self.hull_point_contents(hull, head, mid) == -2 {
            frac -= 0.1;
            if frac < 0.0 {
                tr.fraction = midf;
                tr.endpos = mid;
                return false;
            }
            midf = p1f + (p2f - p1f) * frac;
            mid = [p1[0] + frac * (p2[0] - p1[0]), p1[1] + frac * (p2[1] - p1[1]), p1[2] + frac * (p2[2] - p1[2])];
        }
        tr.fraction = midf;
        tr.endpos = mid;
        false
    }
}

/// Hull trace against model `m` placed at `offset`; mins/maxs select the hull.
pub fn trace_model(bsp: &Bsp, m: usize, offset: Vec3, start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3) -> Trace {
    let size0 = maxs[0] - mins[0];
    let hull = if size0 < 3.0 { 0 } else if size0 <= 32.0 { 1 } else { 2 };
    let head = bsp.models[m].headnode[hull];
    let off = [HULL_MINS[hull][0] - mins[0] + offset[0], HULL_MINS[hull][1] - mins[1] + offset[1], HULL_MINS[hull][2] - mins[2] + offset[2]];
    let s = sub(start, off);
    let e = sub(end, off);
    let mut tr = Trace { fraction: 1.0, endpos: e, normal: [0.0; 3], allsolid: true, startsolid: false, ent: -1 };
    let mut st = (false, false);
    bsp.recursive(hull, head, head, 0.0, 1.0, s, e, &mut tr, &mut st);
    if tr.allsolid {
        tr.startsolid = true;
    }
    if tr.startsolid {
        tr.fraction = 0.0;
    }
    tr.endpos = add(tr.endpos, off);
    if tr.fraction == 1.0 {
        tr.endpos = end;
    }
    tr
}

pub fn dot(a: Vec3, b: Vec3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
pub fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
pub fn add(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

