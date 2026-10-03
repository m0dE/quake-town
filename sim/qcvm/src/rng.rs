// Quake Town - qcvm: the world PRNG
// Copyright (C) 2026 Quake Town contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/// PCG32 (XSH RR), the one PRNG of a world. Serialized and hashed with the VM.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pcg32 {
    pub state: u64,
    pub inc: u64,
}

const MUL: u64 = 6364136223846793005;

impl Pcg32 {
    pub fn new(seed: u64) -> Pcg32 {
        let mut r = Pcg32 { state: 0, inc: (0xda3e_39cb_94b9_5bdb ^ seed.rotate_left(17)) << 1 | 1 };
        r.next_u32();
        r.state = r.state.wrapping_add(seed);
        r.next_u32();
        r
    }

    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        let old = self.state;
        self.state = old.wrapping_mul(MUL).wrapping_add(self.inc);
        let xorshifted = (((old >> 18) ^ old) >> 27) as u32;
        let rot = (old >> 59) as u32;
        xorshifted.rotate_right(rot)
    }

    /// QW `random()`: `(rand() & 0x7fff) / (float)0x7fff`, in [0, 1].
    #[inline]
    pub fn qc_random(&mut self) -> f32 {
        (self.next_u32() & 0x7fff) as f32 / 32767.0f32
    }

    /// Uniform in [0, 1) with 24 bits.
    #[inline]
    pub fn f01(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 * (1.0 / 16777216.0)
    }

    /// Uniform integer in [0, n) (n > 0), slight modulo bias is irrelevant here.
    #[inline]
    pub fn below(&mut self, n: u32) -> u32 {
        if n == 0 {
            0
        } else {
            ((self.next_u32() as u64 * n as u64) >> 32) as u32
        }
    }
}
