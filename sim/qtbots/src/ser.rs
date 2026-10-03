// Quake Town - qtbots: tiny little-endian serializer
// Copyright (C) 2026 Quake Town contributors
// SPDX-License-Identifier: GPL-2.0-or-later

use crate::Vec3;

pub(crate) struct W<'a>(pub &'a mut Vec<u8>);

impl W<'_> {
    pub fn u32(&mut self, x: u32) {
        self.0.extend_from_slice(&x.to_le_bytes());
    }
    pub fn i32(&mut self, x: i32) {
        self.u32(x as u32)
    }
    pub fn u8(&mut self, x: u8) {
        self.0.push(x);
    }
    pub fn bool(&mut self, x: bool) {
        self.0.push(x as u8);
    }
    pub fn f32(&mut self, x: f32) {
        let b = if x.is_nan() { 0x7FC0_0000 } else { x.to_bits() };
        self.u32(b);
    }
    pub fn f64(&mut self, x: f64) {
        let b = if x.is_nan() { 0x7FF8_0000_0000_0000 } else { x.to_bits() };
        self.0.extend_from_slice(&b.to_le_bytes());
    }
    pub fn v3(&mut self, v: Vec3) {
        self.f32(v[0]);
        self.f32(v[1]);
        self.f32(v[2]);
    }
}

pub(crate) struct R<'a> {
    pub d: &'a [u8],
    pub p: usize,
}

impl<'a> R<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let b = self.d.get(self.p..self.p + n).ok_or_else(|| "bots: truncated state".to_string())?;
        self.p += n;
        Ok(b)
    }
    pub fn u32(&mut self) -> Result<u32, String> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    pub fn i32(&mut self) -> Result<i32, String> {
        Ok(self.u32()? as i32)
    }
    pub fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    pub fn bool(&mut self) -> Result<bool, String> {
        match self.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err("bots: bad bool".into()),
        }
    }
    pub fn f32(&mut self) -> Result<f32, String> {
        Ok(f32::from_bits(self.u32()?))
    }
    pub fn f64(&mut self) -> Result<f64, String> {
        let b = self.take(8)?;
        Ok(f64::from_bits(u64::from_le_bytes(b.try_into().unwrap_or([0; 8]))))
    }
    pub fn v3(&mut self) -> Result<Vec3, String> {
        Ok([self.f32()?, self.f32()?, self.f32()?])
    }
}

/// 64-bit hash of bytes (deterministic, not cryptographic).
pub(crate) fn hash_bytes(b: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut chunks = b.chunks_exact(8);
    for c in &mut chunks {
        let w = u64::from_le_bytes(c.try_into().unwrap_or([0; 8]));
        h = (h.rotate_left(5) ^ w).wrapping_mul(0x517c_c1b7_2722_0a95);
    }
    for &x in chunks.remainder() {
        h = (h.rotate_left(5) ^ x as u64).wrapping_mul(0x517c_c1b7_2722_0a95);
    }
    h ^= h >> 33;
    h = h.wrapping_mul(0xff51_afd7_ed55_8ccd);
    h ^ (h >> 33)
}
