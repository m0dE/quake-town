// Quake Town - qcvm: engine strings (temp ring, permanent interned strings, strzone)
// Copyright (C) 2026 Quake Town contributors
// SPDX-License-Identifier: GPL-2.0-or-later

//! Non-progs strings. Handles are negative `i32`s: `-1 - (kind << 28 | index)`. Nothing here
//! is a pointer, so the whole store serializes and hashes.

use crate::error::{ErrorKind, VmError};
use crate::hash::StateHasher;
use crate::Str;

pub(crate) const TEMP_SLOTS: usize = 16;
const KIND_TEMP: u32 = 0;
const KIND_PERM: u32 = 1;
const KIND_ZONE: u32 = 2;
const INDEX_MASK: u32 = 0x0FFF_FFFF;

#[inline]
fn make(kind: u32, idx: u32) -> Str {
    -1 - ((kind << 28) | idx) as i32
}

#[inline]
fn split(h: Str) -> (u32, u32) {
    let k = (-1i32).wrapping_sub(h) as u32;
    (k >> 28, k & INDEX_MASK)
}

fn fnv(b: &[u8]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for &c in b {
        h = (h ^ c as u32).wrapping_mul(0x0100_0193);
    }
    h
}

#[derive(Clone, Debug)]
pub(crate) struct Strings {
    pub temp: Vec<Vec<u8>>,
    pub temp_next: u32,
    pub perm_bytes: Vec<u8>,
    /// (start, len, fnv hash)
    pub perm: Vec<(u32, u32, u32)>,
    pub zone: Vec<Option<Vec<u8>>>,
    pub zone_free: Vec<u32>,
    pub limit: usize,
}

impl Strings {
    pub fn new(limit: usize) -> Strings {
        Strings {
            temp: vec![Vec::new(); TEMP_SLOTS],
            temp_next: 0,
            perm_bytes: Vec::new(),
            perm: Vec::new(),
            zone: Vec::new(),
            zone_free: Vec::new(),
            limit,
        }
    }

    pub fn clear(&mut self) {
        *self = Strings::new(self.limit);
    }

    pub fn used_bytes(&self) -> usize {
        self.perm_bytes.len()
            + self.temp.iter().map(|t| t.len()).sum::<usize>()
            + self.zone.iter().map(|z| z.as_ref().map_or(0, |v| v.len())).sum::<usize>()
    }

    fn check(&self, extra: usize) -> Result<(), VmError> {
        if self.used_bytes() + extra > self.limit {
            return Err(VmError::new(ErrorKind::StringLimit, "string memory limit reached"));
        }
        Ok(())
    }

    /// Contents of a negative handle; "" when unknown.
    pub fn get(&self, h: Str) -> &[u8] {
        let (kind, idx) = split(h);
        match kind {
            KIND_TEMP => self.temp.get(idx as usize).map_or(&[][..], |v| &v[..]),
            KIND_PERM => match self.perm.get(idx as usize) {
                Some(&(s, l, _)) => self.perm_bytes.get(s as usize..(s + l) as usize).unwrap_or(&[]),
                None => &[],
            },
            KIND_ZONE => match self.zone.get(idx as usize) {
                Some(Some(v)) => &v[..],
                _ => &[],
            },
            _ => &[],
        }
    }

    fn strip(b: &[u8]) -> &[u8] {
        // C strings end at the first NUL.
        match b.iter().position(|&c| c == 0) {
            Some(p) => &b[..p],
            None => b,
        }
    }

    pub fn temp(&mut self, b: &[u8]) -> Result<Str, VmError> {
        let b = Self::strip(b);
        let slot = (self.temp_next as usize) % TEMP_SLOTS;
        let old = self.temp[slot].len();
        if b.len() > old {
            self.check(b.len() - old)?;
        }
        self.temp_next = ((slot + 1) % TEMP_SLOTS) as u32;
        let t = &mut self.temp[slot];
        t.clear();
        t.extend_from_slice(b);
        Ok(make(KIND_TEMP, slot as u32))
    }

    pub fn perm(&mut self, b: &[u8]) -> Result<Str, VmError> {
        let b = Self::strip(b);
        let h = fnv(b);
        for (i, &(s, l, hh)) in self.perm.iter().enumerate() {
            if hh == h && l as usize == b.len() && &self.perm_bytes[s as usize..(s + l) as usize] == b {
                return Ok(make(KIND_PERM, i as u32));
            }
        }
        self.check(b.len())?;
        if self.perm.len() as u32 >= INDEX_MASK {
            return Err(VmError::new(ErrorKind::StringLimit, "too many strings"));
        }
        let s = self.perm_bytes.len() as u32;
        self.perm_bytes.extend_from_slice(b);
        self.perm.push((s, b.len() as u32, h));
        Ok(make(KIND_PERM, (self.perm.len() - 1) as u32))
    }

    pub fn zone(&mut self, b: &[u8]) -> Result<Str, VmError> {
        let b = Self::strip(b);
        self.check(b.len())?;
        let idx = match self.zone_free.pop() {
            Some(i) => {
                self.zone[i as usize] = Some(b.to_vec());
                i
            }
            None => {
                if self.zone.len() as u32 >= INDEX_MASK {
                    return Err(VmError::new(ErrorKind::StringLimit, "too many zone strings"));
                }
                self.zone.push(Some(b.to_vec()));
                (self.zone.len() - 1) as u32
            }
        };
        Ok(make(KIND_ZONE, idx))
    }

    /// strunzone; false if `h` is not a live zone string.
    pub fn unzone(&mut self, h: Str) -> bool {
        if h >= 0 {
            return false;
        }
        let (kind, idx) = split(h);
        if kind != KIND_ZONE {
            return false;
        }
        match self.zone.get_mut(idx as usize) {
            Some(z @ Some(_)) => {
                *z = None;
                self.zone_free.push(idx);
                true
            }
            _ => false,
        }
    }

    pub fn hash_into(&self, hs: &mut StateHasher) {
        hs.u32(self.temp_next);
        for t in &self.temp {
            hs.bytes(t);
        }
        hs.bytes(&self.perm_bytes);
        hs.u32(self.perm.len() as u32);
        for &(s, l, _) in &self.perm {
            hs.u32(s);
            hs.u32(l);
        }
        hs.u32(self.zone.len() as u32);
        for z in &self.zone {
            match z {
                Some(v) => hs.bytes(v),
                None => hs.u32(0xFFFF_FFFF),
            }
        }
        hs.words(&self.zone_free);
    }
}

pub(crate) fn rehash(b: &[u8]) -> u32 {
    fnv(b)
}
