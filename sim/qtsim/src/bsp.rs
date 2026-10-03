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
//! BSP29 / BSP2 loading for collision and visibility: a port of the brush model parts of
//! QW/server/model.c (Mod_LoadPlanes/Nodes/Leafs/Clipnodes/Submodels, Mod_MakeHull0,
//! Mod_PointInLeaf, Mod_DecompressVis). Only what the server needs is kept; the renderer
//! loads its own copy for drawing.

use crate::mathlib::*;

pub const CONTENTS_EMPTY: i32 = -1;
pub const CONTENTS_SOLID: i32 = -2;
pub const CONTENTS_WATER: i32 = -3;
pub const CONTENTS_SLIME: i32 = -4;
pub const CONTENTS_LAVA: i32 = -5;
pub const CONTENTS_SKY: i32 = -6;

const LUMP_ENTITIES: usize = 0;
const LUMP_PLANES: usize = 1;
const LUMP_VISIBILITY: usize = 4;
const LUMP_NODES: usize = 5;
const LUMP_CLIPNODES: usize = 9;
const LUMP_LEAFS: usize = 10;
const LUMP_MODELS: usize = 14;
const HEADER_LUMPS: usize = 15;

#[derive(Clone, Copy, Debug, Default)]
pub struct Plane {
    pub normal: Vec3,
    pub dist: f32,
    pub ty: u8,
    pub signbits: u8,
}

/// dclipnode_t; children >= 0 are clipnode indices, < 0 are CONTENTS_*.
#[derive(Clone, Copy, Debug, Default)]
pub struct ClipNode {
    pub plane: u32,
    pub children: [i32; 2],
}

/// mnode_t for PVS work: children >= 0 are nodes, < 0 are -(leaf+1).
#[derive(Clone, Copy, Debug, Default)]
pub struct Node {
    pub plane: u32,
    pub children: [i32; 2],
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Leaf {
    pub contents: i32,
    pub visofs: i32,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SubModel {
    /// already spread by one unit as Mod_LoadSubmodels does
    pub mins: Vec3,
    pub maxs: Vec3,
    pub origin: Vec3,
    pub headnode: [i32; 4],
    pub visleafs: i32,
}

pub const HULL_CLIP: [(Vec3, Vec3); 3] = [
    ([0.0, 0.0, 0.0], [0.0, 0.0, 0.0]),
    ([-16.0, -16.0, -24.0], [16.0, 16.0, 32.0]),
    ([-32.0, -32.0, -24.0], [32.0, 32.0, 64.0]),
];

/// hull_t: a view into clipnodes + planes.
#[derive(Clone, Copy)]
pub struct Hull<'a> {
    pub clipnodes: &'a [ClipNode],
    pub planes: &'a [Plane],
    pub firstclipnode: i32,
    pub clip_mins: Vec3,
    pub clip_maxs: Vec3,
}

#[derive(Debug)]
pub struct Map {
    pub name: String,
    pub planes: Vec<Plane>,
    pub nodes: Vec<Node>,
    pub leafs: Vec<Leaf>,
    /// hull 0, made from the nodes (Mod_MakeHull0)
    pub hull0: Vec<ClipNode>,
    /// hulls 1 and 2 (the clipnodes lump)
    pub clipnodes: Vec<ClipNode>,
    pub models: Vec<SubModel>,
    pub entities: Vec<u8>,
    pub visdata: Vec<u8>,
    /// the world's visleafs (Mod_LeafPVS row size is (numleafs+7)>>3)
    pub numleafs: usize,
    pub bsp2: bool,
    /// FNV-1a 64 of the file bytes
    pub fingerprint: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BspError {
    TooShort,
    BadVersion(u32),
    Bsp2Rev,
    BadLump(usize),
    BadIndex(&'static str),
    Cycle,
    NoModels,
}

impl core::fmt::Display for BspError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            BspError::TooShort => write!(f, "bsp: file too short"),
            BspError::BadVersion(v) => write!(f, "bsp: unsupported version {v:#x} (need 29 or BSP2)"),
            BspError::Bsp2Rev => write!(f, "bsp: 2PSB format is not supported"),
            BspError::BadLump(l) => write!(f, "bsp: lump {l} out of range or bad size"),
            BspError::BadIndex(w) => write!(f, "bsp: bad index in {w}"),
            BspError::Cycle => write!(f, "bsp: cyclic node tree"),
            BspError::NoModels => write!(f, "bsp: no models"),
        }
    }
}

struct Rd<'a> {
    b: &'a [u8],
}
impl<'a> Rd<'a> {
    #[inline]
    fn u32(&self, o: usize) -> u32 {
        u32::from_le_bytes([self.b[o], self.b[o + 1], self.b[o + 2], self.b[o + 3]])
    }
    #[inline]
    fn i32(&self, o: usize) -> i32 {
        self.u32(o) as i32
    }
    #[inline]
    fn f32(&self, o: usize) -> f32 {
        f32::from_bits(self.u32(o))
    }
    #[inline]
    fn u16(&self, o: usize) -> u16 {
        u16::from_le_bytes([self.b[o], self.b[o + 1]])
    }
}

impl Map {
    pub fn load(name: &str, bytes: &[u8]) -> Result<Map, BspError> {
        if bytes.len() < 4 + HEADER_LUMPS * 8 {
            return Err(BspError::TooShort);
        }
        let r = Rd { b: bytes };
        let magic = r.u32(0);
        let bsp2 = match magic {
            29 => false,
            0x3250_5342 => true, // "BSP2"
            0x4253_5032 => return Err(BspError::Bsp2Rev), // "2PSB"
            v => return Err(BspError::BadVersion(v)),
        };
        let mut lumps = [(0usize, 0usize); HEADER_LUMPS];
        for (i, l) in lumps.iter_mut().enumerate() {
            let ofs = r.u32(4 + i * 8) as usize;
            let len = r.u32(8 + i * 8) as usize;
            if ofs.checked_add(len).map_or(true, |e| e > bytes.len()) {
                return Err(BspError::BadLump(i));
            }
            *l = (ofs, len);
        }
        let lump = |i: usize, size: usize| -> Result<(usize, usize), BspError> {
            let (ofs, len) = lumps[i];
            if len % size != 0 {
                return Err(BspError::BadLump(i));
            }
            Ok((ofs, len / size))
        };

        // planes
        let (ofs, n) = lump(LUMP_PLANES, 20)?;
        let mut planes = Vec::with_capacity(n);
        for i in 0..n {
            let o = ofs + i * 20;
            let normal = [r.f32(o), r.f32(o + 4), r.f32(o + 8)];
            let mut bits = 0u8;
            for (j, v) in normal.iter().enumerate() {
                if *v < 0.0 {
                    bits |= 1 << j;
                }
            }
            let ty = r.i32(o + 16);
            planes.push(Plane { normal, dist: r.f32(o + 12), ty: ty.clamp(0, 5) as u8, signbits: bits });
        }

        // leafs
        let lsize = if bsp2 { 44 } else { 28 };
        let (ofs, n) = lump(LUMP_LEAFS, lsize)?;
        let mut leafs = Vec::with_capacity(n);
        for i in 0..n {
            let o = ofs + i * lsize;
            leafs.push(Leaf { contents: r.i32(o), visofs: r.i32(o + 4) });
        }
        if leafs.is_empty() {
            return Err(BspError::BadIndex("leafs"));
        }

        // nodes
        let nsize = if bsp2 { 44 } else { 24 };
        let (ofs, n) = lump(LUMP_NODES, nsize)?;
        let numnodes = n;
        let mut nodes = Vec::with_capacity(n);
        for i in 0..n {
            let o = ofs + i * nsize;
            let plane = r.u32(o);
            let mut children = [0i32; 2];
            for (j, c) in children.iter_mut().enumerate() {
                *c = if bsp2 {
                    r.i32(o + 4 + j * 4)
                } else {
                    // as unsigned so maps with > 32767 nodes work (QuakeSpasm)
                    let p = r.u16(o + 4 + j * 2) as i32;
                    if (p as usize) < numnodes {
                        p
                    } else {
                        -1 - (0xffff - p)
                    }
                };
            }
            nodes.push(Node { plane, children });
        }

        // clipnodes
        let csize = if bsp2 { 12 } else { 8 };
        let (ofs, n) = lump(LUMP_CLIPNODES, csize)?;
        let numclip = n;
        let mut clipnodes = Vec::with_capacity(n);
        for i in 0..n {
            let o = ofs + i * csize;
            let plane = r.u32(o);
            let mut children = [0i32; 2];
            for (j, c) in children.iter_mut().enumerate() {
                *c = if bsp2 {
                    r.i32(o + 4 + j * 4)
                } else {
                    let p = r.u16(o + 4 + j * 2) as i32;
                    if (p as usize) < numclip && p < 0xfff0 {
                        p
                    } else {
                        p - 0x10000
                    }
                };
            }
            clipnodes.push(ClipNode { plane, children });
        }

        // models
        let (ofs, n) = lump(LUMP_MODELS, 64)?;
        if n == 0 {
            return Err(BspError::NoModels);
        }
        let mut models = Vec::with_capacity(n);
        for i in 0..n {
            let o = ofs + i * 64;
            let mut m = SubModel::default();
            for j in 0..3 {
                m.mins[j] = r.f32(o + j * 4) - 1.0;
                m.maxs[j] = r.f32(o + 12 + j * 4) + 1.0;
                m.origin[j] = r.f32(o + 24 + j * 4);
            }
            for j in 0..4 {
                m.headnode[j] = r.i32(o + 36 + j * 4);
            }
            m.visleafs = r.i32(o + 52);
            models.push(m);
        }

        let (eo, el) = lumps[LUMP_ENTITIES];
        let mut entities = bytes[eo..eo + el].to_vec();
        if let Some(z) = entities.iter().position(|&c| c == 0) {
            entities.truncate(z);
        }
        let (vo, vl) = lumps[LUMP_VISIBILITY];
        let visdata = bytes[vo..vo + vl].to_vec();

        // validate indices so traversal can never index out of bounds
        let np = planes.len() as u32;
        for nd in &nodes {
            if nd.plane >= np {
                return Err(BspError::BadIndex("node plane"));
            }
            for &c in &nd.children {
                if c >= 0 {
                    if c as usize >= nodes.len() {
                        return Err(BspError::BadIndex("node child"));
                    }
                } else if (-1 - c) as usize >= leafs.len() {
                    return Err(BspError::BadIndex("node leaf"));
                }
            }
        }
        for cn in &clipnodes {
            if cn.plane >= np {
                return Err(BspError::BadIndex("clipnode plane"));
            }
            for &c in &cn.children {
                if c >= 0 && c as usize >= clipnodes.len() {
                    return Err(BspError::BadIndex("clipnode child"));
                }
            }
        }
        if nodes.is_empty() {
            return Err(BspError::BadIndex("no nodes"));
        }
        for m in &models {
            if m.headnode[0] < 0 || m.headnode[0] as usize >= nodes.len() {
                return Err(BspError::BadIndex("model headnode"));
            }
            for j in 1..3 {
                let h = m.headnode[j];
                if h >= 0 && h as usize >= clipnodes.len() && !clipnodes.is_empty() {
                    return Err(BspError::BadIndex("model clip headnode"));
                }
            }
        }
        for l in &leafs {
            if l.visofs >= 0 && l.visofs as usize > visdata.len() {
                return Err(BspError::BadIndex("leaf visofs"));
            }
        }
        if !acyclic(&nodes.iter().map(|n| n.children).collect::<Vec<_>>(), true)
            || !acyclic(&clipnodes.iter().map(|n| n.children).collect::<Vec<_>>(), false)
        {
            return Err(BspError::Cycle);
        }

        // Mod_MakeHull0
        let hull0 = nodes
            .iter()
            .map(|nd| {
                let mut ch = [0i32; 2];
                for j in 0..2 {
                    let c = nd.children[j];
                    ch[j] = if c >= 0 { c } else { leafs[(-1 - c) as usize].contents };
                    // a node child pointing to a leaf whose contents is >= 0 would read as a
                    // node index; clamp it to a valid content
                    if c < 0 && ch[j] >= 0 {
                        ch[j] = CONTENTS_EMPTY;
                    }
                }
                ClipNode { plane: nd.plane, children: ch }
            })
            .collect();

        let numleafs = (models[0].visleafs.max(0) as usize).min(leafs.len().saturating_sub(1));
        Ok(Map {
            name: name.to_string(),
            planes,
            nodes,
            leafs,
            hull0,
            clipnodes,
            models,
            entities,
            visdata,
            numleafs,
            bsp2,
            fingerprint: bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, &b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3)),
        })
    }

    /// The clipping hull `hullnum` (0..2) of brush model `model` (0 = world).
    #[inline]
    pub fn hull(&self, model: usize, hullnum: usize) -> Hull<'_> {
        let m = &self.models[model.min(self.models.len() - 1)];
        let (clip_mins, clip_maxs) = HULL_CLIP[hullnum];
        if hullnum == 0 {
            Hull { clipnodes: &self.hull0, planes: &self.planes, firstclipnode: m.headnode[0], clip_mins, clip_maxs }
        } else {
            Hull {
                clipnodes: &self.clipnodes,
                planes: &self.planes,
                firstclipnode: if self.clipnodes.is_empty() { CONTENTS_EMPTY } else { m.headnode[hullnum] },
                clip_mins,
                clip_maxs,
            }
        }
    }

    /// Mod_PointInLeaf: index of the leaf containing p
    pub fn point_in_leaf(&self, p: &Vec3) -> usize {
        let mut n = 0i32;
        loop {
            if n < 0 {
                return (-1 - n) as usize;
            }
            let node = &self.nodes[n as usize];
            let plane = &self.planes[node.plane as usize];
            let d = dot(p, &plane.normal) - plane.dist;
            n = if d > 0.0 { node.children[0] } else { node.children[1] };
        }
    }

    /// Mod_LeafPVS into `out` ((numleafs+7)>>3 bytes); bit i = leaf i+1.
    pub fn leaf_pvs(&self, leaf: usize, out: &mut Vec<u8>) {
        let row = (self.numleafs + 7) >> 3;
        out.clear();
        if leaf == 0 || self.leafs[leaf].visofs < 0 || self.visdata.is_empty() {
            out.resize(row, 0xff);
            return;
        }
        let mut i = self.leafs[leaf].visofs as usize;
        let v = &self.visdata;
        while out.len() < row {
            if i >= v.len() {
                break;
            }
            if v[i] != 0 {
                out.push(v[i]);
                i += 1;
                continue;
            }
            let c = if i + 1 < v.len() { v[i + 1] } else { 0 };
            i += 2;
            for _ in 0..c {
                out.push(0);
            }
        }
        out.resize(row, 0);
    }

    /// BOX_ON_PLANE_SIDE / BoxOnPlaneSide
    pub fn box_on_plane_side(emins: &Vec3, emaxs: &Vec3, p: &Plane) -> i32 {
        if p.ty < 3 {
            let t = p.ty as usize;
            return if p.dist <= emins[t] {
                1
            } else if p.dist >= emaxs[t] {
                2
            } else {
                3
            };
        }
        let n = &p.normal;
        let (d1, d2) = match p.signbits {
            0 => (n[0] * emaxs[0] + n[1] * emaxs[1] + n[2] * emaxs[2], n[0] * emins[0] + n[1] * emins[1] + n[2] * emins[2]),
            1 => (n[0] * emins[0] + n[1] * emaxs[1] + n[2] * emaxs[2], n[0] * emaxs[0] + n[1] * emins[1] + n[2] * emins[2]),
            2 => (n[0] * emaxs[0] + n[1] * emins[1] + n[2] * emaxs[2], n[0] * emins[0] + n[1] * emaxs[1] + n[2] * emins[2]),
            3 => (n[0] * emins[0] + n[1] * emins[1] + n[2] * emaxs[2], n[0] * emaxs[0] + n[1] * emaxs[1] + n[2] * emins[2]),
            4 => (n[0] * emaxs[0] + n[1] * emaxs[1] + n[2] * emins[2], n[0] * emins[0] + n[1] * emins[1] + n[2] * emaxs[2]),
            5 => (n[0] * emins[0] + n[1] * emaxs[1] + n[2] * emins[2], n[0] * emaxs[0] + n[1] * emins[1] + n[2] * emaxs[2]),
            6 => (n[0] * emaxs[0] + n[1] * emins[1] + n[2] * emins[2], n[0] * emins[0] + n[1] * emaxs[1] + n[2] * emaxs[2]),
            _ => (n[0] * emins[0] + n[1] * emins[1] + n[2] * emins[2], n[0] * emaxs[0] + n[1] * emaxs[1] + n[2] * emaxs[2]),
        };
        let mut sides = 0;
        if d1 >= p.dist {
            sides = 1;
        }
        if d2 < p.dist {
            sides |= 2;
        }
        sides
    }

    /// SV_FindTouchedLeafs: leaf numbers (leaf index - 1) the box touches, up to `max`.
    pub fn find_touched_leafs(&self, absmin: &Vec3, absmax: &Vec3, out: &mut Vec<u16>, max: usize) {
        out.clear();
        self.touched_rec(0, absmin, absmax, out, max);
    }

    fn touched_rec(&self, n: i32, absmin: &Vec3, absmax: &Vec3, out: &mut Vec<u16>, max: usize) {
        if n < 0 {
            let leaf = (-1 - n) as usize;
            if self.leafs[leaf].contents == CONTENTS_SOLID {
                return;
            }
            if out.len() == max {
                return;
            }
            out.push((leaf as u16).wrapping_sub(1));
            return;
        }
        let node = &self.nodes[n as usize];
        let sides = Self::box_on_plane_side(absmin, absmax, &self.planes[node.plane as usize]);
        if sides & 1 != 0 {
            self.touched_rec(node.children[0], absmin, absmax, out, max);
        }
        if sides & 2 != 0 {
            self.touched_rec(node.children[1], absmin, absmax, out, max);
        }
    }

    /// Classname + key/values of the entity lump (for tools/tests).
    pub fn entities_text(&self) -> String {
        self.entities.iter().map(|&c| c as char).collect()
    }
}

/// true if following children (>= 0 are node indices) never revisits a node.
fn acyclic(children: &[[i32; 2]], _nodes: bool) -> bool {
    // fast path: qbsp writes nodes in pre-order, so every child index is larger
    if children.iter().enumerate().all(|(i, c)| c.iter().all(|&x| x < 0 || x as usize > i)) {
        return true;
    }
    // general DFS with colours (iterative)
    let n = children.len();
    let mut state = vec![0u8; n]; // 0 new, 1 on stack, 2 done
    for root in 0..n {
        if state[root] != 0 {
            continue;
        }
        let mut stack: Vec<(usize, u8)> = vec![(root, 0)];
        state[root] = 1;
        while let Some(&mut (v, ref mut k)) = stack.last_mut() {
            if *k == 2 {
                state[v] = 2;
                stack.pop();
                continue;
            }
            let c = children[v][*k as usize];
            *k += 1;
            if c >= 0 {
                let c = c as usize;
                match state[c] {
                    1 => return false,
                    0 => {
                        state[c] = 1;
                        stack.push((c, 0));
                    }
                    _ => {}
                }
            }
        }
    }
    true
}
