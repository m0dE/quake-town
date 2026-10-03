// Quake Town - qcvm: state hashing
// Copyright (C) 2026 Quake Town contributors
// SPDX-License-Identifier: GPL-2.0-or-later

//! A fast deterministic 64-bit state hasher (word at a time). Not cryptographic: it only
//! has to detect desyncs. The engine may use it for its own state too.

#[derive(Clone, Copy, Debug)]
pub struct StateHasher {
    h: u64,
}

const K: u64 = 0x517c_c1b7_2722_0a95;

impl Default for StateHasher {
    fn default() -> Self {
        StateHasher::new()
    }
}

impl StateHasher {
    pub fn new() -> StateHasher {
        StateHasher { h: 0x243f_6a88_85a3_08d3 }
    }
    #[inline(always)]
    pub fn u32(&mut self, w: u32) {
        self.h = (self.h.rotate_left(5) ^ w as u64).wrapping_mul(K);
    }
    #[inline(always)]
    pub fn u64(&mut self, w: u64) {
        self.u32(w as u32);
        self.u32((w >> 32) as u32);
    }
    /// A float, NaN canonicalised.
    #[inline(always)]
    pub fn f32(&mut self, x: f32) {
        self.u32(crate::canon(x).to_bits());
    }
    #[inline(always)]
    pub fn f64(&mut self, x: f64) {
        let b = if x.is_nan() { 0x7FF8_0000_0000_0000 } else { x.to_bits() };
        self.u64(b);
    }
    /// Two words in one mixing step.
    #[inline(always)]
    pub fn pair(&mut self, a: u32, b: u32) {
        self.h = (self.h.rotate_left(5) ^ (a as u64 | (b as u64) << 32)).wrapping_mul(K);
    }
    pub fn words(&mut self, ws: &[u32]) {
        self.u32(ws.len() as u32);
        let mut it = ws.chunks_exact(2);
        for c in &mut it {
            self.pair(c[0], c[1]);
        }
        for &w in it.remainder() {
            self.u32(w);
        }
    }
    /// Raw words, 4 independent 64-bit lanes of word pairs (fast path for VM memory,
    /// which is NaN-canonical by construction).
    pub fn words_fast(&mut self, ws: &[u32]) {
        self.u32(ws.len() as u32);
        let mut l0 = self.h;
        let mut l1 = self.h ^ 0x9e37_79b9_7f4a_7c15;
        let mut l2 = self.h ^ 0x3c6e_f372_fe94_f82a;
        let mut l3 = self.h ^ 0xdaa6_6d2c_7ddf_743f;
        let mut it = ws.chunks_exact(8);
        for c in &mut it {
            l0 = (l0.rotate_left(5) ^ (c[0] as u64 | (c[1] as u64) << 32)).wrapping_mul(K);
            l1 = (l1.rotate_left(5) ^ (c[2] as u64 | (c[3] as u64) << 32)).wrapping_mul(K);
            l2 = (l2.rotate_left(5) ^ (c[4] as u64 | (c[5] as u64) << 32)).wrapping_mul(K);
            l3 = (l3.rotate_left(5) ^ (c[6] as u64 | (c[7] as u64) << 32)).wrapping_mul(K);
        }
        self.u64(l0);
        self.u64(l1);
        self.u64(l2);
        self.u64(l3);
        for &w in it.remainder() {
            self.u32(w);
        }
    }

    /// Words where `is_float[i]` marks float-typed words: those are NaN-canonicalised.
    pub fn words_typed(&mut self, ws: &[u32], is_float: &[bool]) {
        self.u32(ws.len() as u32);
        let canon = |w: u32, i: usize| -> u32 {
            if (w & 0x7F80_0000) == 0x7F80_0000 && (w & 0x007F_FFFF) != 0 && is_float.get(i).copied().unwrap_or(false) {
                crate::CANON_NAN_BITS
            } else {
                w
            }
        };
        // 4 independent lanes of word pairs (breaks the multiply dependency chain).
        let mut lanes = [self.h, self.h ^ 0x9e37_79b9_7f4a_7c15, self.h ^ 0x3c6e_f372_fe94_f82a, self.h ^ 0xdaa6_6d2c_7ddf_743f];
        let n = ws.len() & !7;
        let mut i = 0;
        while i < n {
            for l in 0..4 {
                let (a, b) = (canon(ws[i + 2 * l], i + 2 * l), canon(ws[i + 2 * l + 1], i + 2 * l + 1));
                lanes[l] = (lanes[l].rotate_left(5) ^ (a as u64 | (b as u64) << 32)).wrapping_mul(K);
            }
            i += 8;
        }
        for l in lanes {
            self.u64(l);
        }
        while i < ws.len() {
            self.u32(canon(ws[i], i));
            i += 1;
        }
    }
    pub fn bytes(&mut self, b: &[u8]) {
        self.u32(b.len() as u32);
        let mut chunks = b.chunks_exact(4);
        for c in &mut chunks {
            self.u32(u32::from_le_bytes([c[0], c[1], c[2], c[3]]));
        }
        let mut last = 0u32;
        for (i, &x) in chunks.remainder().iter().enumerate() {
            last |= (x as u32) << (8 * i);
        }
        self.u32(last);
    }
    /// Final 64-bit value (with an avalanche step).
    pub fn finish(&self) -> u64 {
        let mut x = self.h;
        x ^= x >> 33;
        x = x.wrapping_mul(0xff51_afd7_ed55_8ccd);
        x ^= x >> 33;
        x = x.wrapping_mul(0xc4ce_b9fe_1a85_ec53);
        x ^= x >> 33;
        x
    }
    /// Final value folded to 32 bits.
    pub fn finish32(&self) -> u32 {
        let x = self.finish();
        (x ^ (x >> 32)) as u32
    }
}
