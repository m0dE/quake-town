// Test maps built in code: a union of axis-aligned solid boxes compiled to a BSP29 file
// (hull 0 as nodes + leafs, hulls 1/2 as clipnodes from the boxes expanded by the
// player / large hull sizes). Used by the pmove regression tests and benches.
// Copyright (C) 2026 Quake Town authors. GPL-2.0-or-later.

use crate::bsp::{CONTENTS_EMPTY, CONTENTS_SOLID, HULL_CLIP};
use crate::mathlib::Vec3;

#[derive(Clone, Copy, Debug)]
pub struct BoxBrush {
    pub mins: Vec3,
    pub maxs: Vec3,
}

pub fn bx(mins: [f32; 3], maxs: [f32; 3]) -> BoxBrush {
    BoxBrush { mins, maxs }
}

struct Builder {
    planes: Vec<(usize, f32)>,
    nodes: Vec<(u32, [i32; 2])>,
    leafs: Vec<i32>,
}

impl Builder {
    fn plane(&mut self, axis: usize, dist: f32) -> u32 {
        if let Some(i) = self.planes.iter().position(|&(a, d)| a == axis && d == dist) {
            return i as u32;
        }
        self.planes.push((axis, dist));
        (self.planes.len() - 1) as u32
    }

    /// returns a child reference: >= 0 node index, < 0 contents (clip) / leaf (draw)
    fn build(&mut self, boxes: &[BoxBrush], cmin: Vec3, cmax: Vec3, draw: bool) -> i32 {
        let inside: Vec<BoxBrush> = boxes
            .iter()
            .filter(|b| (0..3).all(|a| b.mins[a] < cmax[a] && b.maxs[a] > cmin[a]))
            .copied()
            .collect();
        let leaf = |s: &mut Builder, contents: i32| -> i32 {
            if !draw {
                return contents;
            }
            if contents == CONTENTS_SOLID {
                return -1; // leaf 0
            }
            s.leafs.push(contents);
            -(s.leafs.len() as i32)
        };
        if inside.is_empty() {
            return leaf(self, CONTENTS_EMPTY);
        }
        if inside.iter().any(|b| (0..3).all(|a| b.mins[a] <= cmin[a] && b.maxs[a] >= cmax[a])) {
            return leaf(self, CONTENTS_SOLID);
        }
        // first face plane strictly inside the cell
        let mut split = None;
        'outer: for b in &inside {
            for a in 0..3 {
                for d in [b.mins[a], b.maxs[a]] {
                    if d > cmin[a] && d < cmax[a] {
                        split = Some((a, d));
                        break 'outer;
                    }
                }
            }
        }
        let (axis, dist) = split.expect("a partially covered cell has a splitting face");
        let p = self.plane(axis, dist);
        let idx = self.nodes.len();
        self.nodes.push((p, [0, 0]));
        let mut fmin = cmin;
        fmin[axis] = dist;
        let mut bmax = cmax;
        bmax[axis] = dist;
        let front = self.build(&inside, fmin, cmax, draw);
        let back = self.build(&inside, cmin, bmax, draw);
        self.nodes[idx].1 = [front, back];
        idx as i32
    }
}

/// Builds BSP29 bytes for the solid boxes, with world bounds `wmin..wmax` and the
/// given entity lump text.
pub fn build_bsp(boxes: &[BoxBrush], wmin: Vec3, wmax: Vec3, entities: &str) -> Vec<u8> {
    let mut b = Builder { planes: Vec::new(), nodes: Vec::new(), leafs: vec![CONTENTS_SOLID] };
    let big = 65536.0f32;
    let cell_min = [-big; 3];
    let cell_max = [big; 3];

    // hull 0: nodes + leafs
    let head0 = b.build(boxes, cell_min, cell_max, true);
    assert!(head0 >= 0, "need at least one box");
    let draw_nodes = std::mem::take(&mut b.nodes);

    // hulls 1, 2: clipnodes from the expanded boxes
    let mut heads = [0i32; 3];
    let mut clip = Vec::new();
    for h in 1..3 {
        let (cmins, cmaxs) = HULL_CLIP[h];
        let exp: Vec<BoxBrush> = boxes
            .iter()
            .map(|bb| BoxBrush {
                mins: [bb.mins[0] - cmaxs[0], bb.mins[1] - cmaxs[1], bb.mins[2] - cmaxs[2]],
                maxs: [bb.maxs[0] - cmins[0], bb.maxs[1] - cmins[1], bb.maxs[2] - cmins[2]],
            })
            .collect();
        b.nodes.clear();
        let base = clip.len() as i32;
        let head = b.build(&exp, cell_min, cell_max, false);
        for (p, ch) in b.nodes.drain(..) {
            let ch = ch.map(|c| if c >= 0 { c + base } else { c });
            clip.push((p, ch));
        }
        heads[h] = if head >= 0 { head + base } else { head };
    }

    // ---- write the file
    let mut lumps: Vec<Vec<u8>> = vec![Vec::new(); 15];
    let mut ent = entities.as_bytes().to_vec();
    ent.push(0);
    lumps[0] = ent;
    for &(axis, dist) in &b.planes {
        let mut n = [0f32; 3];
        n[axis] = 1.0;
        for v in n {
            lumps[1].extend_from_slice(&v.to_le_bytes());
        }
        lumps[1].extend_from_slice(&dist.to_le_bytes());
        lumps[1].extend_from_slice(&(axis as i32).to_le_bytes());
    }
    for &(p, ch) in &draw_nodes {
        lumps[5].extend_from_slice(&(p as i32).to_le_bytes());
        for c in ch {
            lumps[5].extend_from_slice(&(c as i16).to_le_bytes());
        }
        lumps[5].extend_from_slice(&[0u8; 12 + 4]);
    }
    for &(p, ch) in &clip {
        lumps[9].extend_from_slice(&(p as i32).to_le_bytes());
        for c in ch {
            lumps[9].extend_from_slice(&(c as i16).to_le_bytes());
        }
    }
    for &c in &b.leafs {
        lumps[10].extend_from_slice(&c.to_le_bytes());
        lumps[10].extend_from_slice(&(-1i32).to_le_bytes());
        lumps[10].extend_from_slice(&[0u8; 20]);
    }
    {
        let m = &mut lumps[14];
        for v in wmin.iter().chain(wmax.iter()) {
            m.extend_from_slice(&v.to_le_bytes());
        }
        m.extend_from_slice(&[0u8; 12]);
        m.extend_from_slice(&head0.to_le_bytes());
        m.extend_from_slice(&heads[1].to_le_bytes());
        m.extend_from_slice(&heads[2].to_le_bytes());
        m.extend_from_slice(&0i32.to_le_bytes());
        m.extend_from_slice(&((b.leafs.len() - 1) as i32).to_le_bytes());
        m.extend_from_slice(&0i32.to_le_bytes());
        m.extend_from_slice(&0i32.to_le_bytes());
    }
    let mut out = Vec::new();
    out.extend_from_slice(&29i32.to_le_bytes());
    let mut ofs = 4 + 15 * 8;
    for l in &lumps {
        out.extend_from_slice(&(ofs as i32).to_le_bytes());
        out.extend_from_slice(&(l.len() as i32).to_le_bytes());
        ofs += (l.len() + 3) & !3;
    }
    for l in &lumps {
        out.extend_from_slice(l);
        while out.len() % 4 != 0 {
            out.push(0);
        }
    }
    out
}

/// Converts a BSP29 file to BSP2 (wider nodes/leafs/clipnodes); for loader tests.
pub fn bsp29_to_bsp2(src: &[u8]) -> Vec<u8> {
    let rd = |o: usize| i32::from_le_bytes([src[o], src[o + 1], src[o + 2], src[o + 3]]);
    let rs = |o: usize| i16::from_le_bytes([src[o], src[o + 1]]) as i32;
    let rus = |o: usize| u16::from_le_bytes([src[o], src[o + 1]]) as i32;
    let mut lumps: Vec<Vec<u8>> = (0..15)
        .map(|i| {
            let o = rd(4 + i * 8) as usize;
            let l = rd(8 + i * 8) as usize;
            src[o..o + l].to_vec()
        })
        .collect();
    let numnodes = lumps[5].len() / 24;
    let numclip = lumps[9].len() / 8;
    let mut nodes = Vec::new();
    for n in lumps[5].chunks(24) {
        nodes.extend_from_slice(&n[0..4]);
        for j in 0..2 {
            let p = u16::from_le_bytes([n[4 + j * 2], n[5 + j * 2]]) as i32;
            let c = if (p as usize) < numnodes { p } else { -1 - (0xffff - p) };
            nodes.extend_from_slice(&c.to_le_bytes());
        }
        for j in 0..6 {
            let v = i16::from_le_bytes([n[8 + j * 2], n[9 + j * 2]]) as f32;
            nodes.extend_from_slice(&v.to_le_bytes());
        }
        nodes.extend_from_slice(&(u16::from_le_bytes([n[20], n[21]]) as u32).to_le_bytes());
        nodes.extend_from_slice(&(u16::from_le_bytes([n[22], n[23]]) as u32).to_le_bytes());
    }
    let mut clip = Vec::new();
    for c in lumps[9].chunks(8) {
        clip.extend_from_slice(&c[0..4]);
        for j in 0..2 {
            let p = u16::from_le_bytes([c[4 + j * 2], c[5 + j * 2]]) as i32;
            let v = if (p as usize) < numclip && p < 0xfff0 { p } else { p - 0x10000 };
            clip.extend_from_slice(&v.to_le_bytes());
        }
    }
    let mut leafs = Vec::new();
    for l in lumps[10].chunks(28) {
        leafs.extend_from_slice(&l[0..8]);
        for j in 0..6 {
            let v = i16::from_le_bytes([l[8 + j * 2], l[9 + j * 2]]) as f32;
            leafs.extend_from_slice(&v.to_le_bytes());
        }
        leafs.extend_from_slice(&(u16::from_le_bytes([l[20], l[21]]) as u32).to_le_bytes());
        leafs.extend_from_slice(&(u16::from_le_bytes([l[22], l[23]]) as u32).to_le_bytes());
        leafs.extend_from_slice(&l[24..28]);
    }
    let _ = (rs, rus);
    lumps[5] = nodes;
    lumps[9] = clip;
    lumps[10] = leafs;
    let mut out = Vec::new();
    out.extend_from_slice(b"BSP2");
    let mut ofs = 4 + 15 * 8;
    for l in &lumps {
        out.extend_from_slice(&(ofs as i32).to_le_bytes());
        out.extend_from_slice(&(l.len() as i32).to_le_bytes());
        ofs += (l.len() + 3) & !3;
    }
    for l in &lumps {
        out.extend_from_slice(l);
        while out.len() % 4 != 0 {
            out.push(0);
        }
    }
    out
}
