// Quake Town - qcvm: serialization and hashing of the whole VM state
// Copyright (C) 2026 Quake Town contributors
// SPDX-License-Identifier: GPL-2.0-or-later

//! Format (little-endian u32 words unless noted), version `QCV1`:
//! magic, version, progs fingerprint (2 words), config (7 words), flags, rng (4 words),
//! globals (len + words), num_edicts, edict words, meta (3 words each), strings,
//! tokens, stop error. Words are raw (VM memory is NaN-canonical by construction).

use crate::error::{ErrorKind, VmError};
use crate::hash::StateHasher;
use crate::progs::Progs;
use crate::rng::Pcg32;
use crate::strings::{rehash, Strings, TEMP_SLOTS};
use crate::vm::{Meta, Vm, VmConfig, DEFAULT_BUDGET};
use std::sync::Arc;

const MAGIC: u32 = 0x3156_4351; // "QCV1"
const VERSION: u32 = 1;

fn put_raw(out: &mut Vec<u8>, ws: &[u32]) {
    let start = out.len();
    out.resize(start + ws.len() * 4, 0);
    for (dst, &x) in out[start..].chunks_exact_mut(4).zip(ws.iter()) {
        dst.copy_from_slice(&x.to_le_bytes());
    }
}

struct W<'a>(&'a mut Vec<u8>);
impl W<'_> {
    fn u32(&mut self, x: u32) {
        self.0.extend_from_slice(&x.to_le_bytes());
    }
    fn bytes(&mut self, b: &[u8]) {
        self.u32(b.len() as u32);
        self.0.extend_from_slice(b);
    }
}

struct R<'a> {
    d: &'a [u8],
    p: usize,
}
fn bad(m: &str) -> VmError {
    VmError::new(ErrorKind::BadState, format!("bad VM state: {}", m))
}
impl<'a> R<'a> {
    fn u32(&mut self) -> Result<u32, VmError> {
        let b = self.d.get(self.p..self.p + 4).ok_or_else(|| bad("truncated"))?;
        self.p += 4;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn u64(&mut self) -> Result<u64, VmError> {
        let lo = self.u32()? as u64;
        let hi = self.u32()? as u64;
        Ok(lo | hi << 32)
    }
    fn count(&mut self, max: usize) -> Result<usize, VmError> {
        let n = self.u32()? as usize;
        if n > max {
            return Err(bad("count too large"));
        }
        Ok(n)
    }
    fn bytes(&mut self, max: usize) -> Result<&'a [u8], VmError> {
        let n = self.count(max)?;
        let b = self.d.get(self.p..self.p + n).ok_or_else(|| bad("truncated"))?;
        self.p += n;
        Ok(b)
    }
    fn words(&mut self, n: usize) -> Result<Vec<u32>, VmError> {
        let len = n.checked_mul(4).ok_or_else(|| bad("size"))?;
        let b = self.d.get(self.p..self.p + len).ok_or_else(|| bad("truncated"))?;
        self.p += len;
        Ok(b.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
    }
}

impl Vm {
    /// Append the whole state to `out`.
    pub fn serialize(&self, out: &mut Vec<u8>) {
        let mut w = W(out);
        w.u32(MAGIC);
        w.u32(VERSION);
        let fp = self.progs.fingerprint;
        w.u32(fp as u32);
        w.u32((fp >> 32) as u32);
        let c = self.cfg;
        w.u32(c.max_edicts);
        w.u32(c.client_edicts);
        w.u32(c.max_depth);
        w.u32(c.local_stack);
        w.u32(c.runaway as u32);
        w.u32((c.runaway >> 32) as u32);
        w.u32(c.string_bytes);
        w.u32(self.world_locked as u32);
        w.u32(self.rng.state as u32);
        w.u32((self.rng.state >> 32) as u32);
        w.u32(self.rng.inc as u32);
        w.u32((self.rng.inc >> 32) as u32);
        w.u32(self.globals.len() as u32);
        w.0.reserve(4 * (self.globals.len() + self.edicts.len() + 3 * self.meta.len()) + self.strings.used_bytes() + 256);
        // raw words: VM memory is NaN-canonical by construction, and a raw copy makes
        // deserialize(serialize(vm)) bit-identical (also for ints that look like NaNs)
        put_raw(w.0, &self.globals);
        w.u32(self.num_edicts);
        put_raw(w.0, &self.edicts);
        for m in &self.meta {
            w.u32(m.free as u32);
            w.u32(crate::canon(m.freetime).to_bits());
            w.u32(m.serial);
        }
        let s = &self.strings;
        w.u32(s.temp_next);
        for t in &s.temp {
            w.bytes(t);
        }
        w.bytes(&s.perm_bytes);
        w.u32(s.perm.len() as u32);
        for &(st, l, _) in &s.perm {
            w.u32(st);
            w.u32(l);
        }
        w.u32(s.zone.len() as u32);
        for z in &s.zone {
            match z {
                Some(v) => {
                    w.u32(1);
                    w.bytes(v);
                }
                None => w.u32(0),
            }
        }
        w.u32(s.zone_free.len() as u32);
        for &f in &s.zone_free {
            w.u32(f);
        }
        w.u32(self.tokens.len() as u32);
        for t in &self.tokens {
            w.bytes(t);
        }
        match &self.stopped {
            None => w.u32(0),
            Some(e) => {
                w.u32(1);
                w.u32(e.kind.code());
                w.bytes(e.message.as_bytes());
                w.bytes(e.trace.as_bytes());
            }
        }
    }

    /// Rebuild a VM from `serialize` output. Returns the VM and the bytes consumed.
    pub fn deserialize(progs: Arc<Progs>, data: &[u8]) -> Result<(Vm, usize), VmError> {
        let mut r = R { d: data, p: 0 };
        if r.u32()? != MAGIC || r.u32()? != VERSION {
            return Err(bad("magic/version"));
        }
        if r.u64()? != progs.fingerprint {
            return Err(bad("state belongs to a different progs"));
        }
        let cfg = VmConfig {
            max_edicts: r.u32()?,
            client_edicts: r.u32()?,
            max_depth: r.u32()?,
            local_stack: r.u32()?,
            runaway: r.u64()?,
            string_bytes: r.u32()?,
        };
        if cfg.sanitized() != cfg {
            return Err(bad("config"));
        }
        let world_locked = match r.u32()? {
            0 => false,
            1 => true,
            _ => return Err(bad("flag")),
        };
        let rng = Pcg32 { state: r.u64()?, inc: r.u64()? };
        if rng.inc & 1 == 0 {
            return Err(bad("rng"));
        }
        let gl = r.u32()? as usize;
        if gl != progs.globals_len as usize {
            return Err(bad("globals length"));
        }
        let globals = r.words(gl)?;
        let num_edicts = r.u32()?;
        if num_edicts < cfg.client_edicts + 1 || num_edicts > cfg.max_edicts {
            return Err(bad("num_edicts"));
        }
        let ef = progs.entityfields;
        let edicts = r.words(num_edicts as usize * ef as usize)?;
        let mut meta = Vec::with_capacity(num_edicts as usize);
        for _ in 0..num_edicts {
            let free = match r.u32()? {
                0 => false,
                1 => true,
                _ => return Err(bad("free flag")),
            };
            let freetime = f32::from_bits(r.u32()?);
            let serial = r.u32()?;
            meta.push(Meta { free, freetime, serial });
        }
        let mut strings = Strings::new(cfg.string_bytes as usize);
        let lim = cfg.string_bytes as usize;
        strings.temp_next = r.u32()?;
        if strings.temp_next as usize >= TEMP_SLOTS {
            return Err(bad("temp_next"));
        }
        for i in 0..TEMP_SLOTS {
            strings.temp[i] = r.bytes(lim)?.to_vec();
        }
        strings.perm_bytes = r.bytes(lim)?.to_vec();
        let np = r.count(lim)?;
        for _ in 0..np {
            let (st, l) = (r.u32()?, r.u32()?);
            let end = st.checked_add(l).ok_or_else(|| bad("perm"))?;
            if end as usize > strings.perm_bytes.len() {
                return Err(bad("perm range"));
            }
            let h = rehash(&strings.perm_bytes[st as usize..end as usize]);
            strings.perm.push((st, l, h));
        }
        let nz = r.count(lim)?;
        for _ in 0..nz {
            match r.u32()? {
                0 => strings.zone.push(None),
                1 => strings.zone.push(Some(r.bytes(lim)?.to_vec())),
                _ => return Err(bad("zone flag")),
            }
        }
        let nf = r.count(nz)?;
        for _ in 0..nf {
            let f = r.u32()?;
            if f as usize >= nz || strings.zone[f as usize].is_some() || strings.zone_free.contains(&f) {
                return Err(bad("zone free list"));
            }
            strings.zone_free.push(f);
        }
        if strings.used_bytes() > lim {
            return Err(bad("strings over limit"));
        }
        let nt = r.count(crate::pure::MAX_TOKENS)?;
        let mut tokens = Vec::with_capacity(nt);
        for _ in 0..nt {
            tokens.push(r.bytes(lim)?.to_vec());
        }
        let stopped = match r.u32()? {
            0 => None,
            1 => {
                let kind = ErrorKind::from_code(r.u32()?);
                let message = String::from_utf8_lossy(r.bytes(1 << 20)?).into_owned();
                let trace = String::from_utf8_lossy(r.bytes(1 << 20)?).into_owned();
                Some(VmError { kind, message, trace })
            }
            _ => return Err(bad("stop flag")),
        };
        let vm = Vm {
            progs,
            cfg,
            globals,
            edicts,
            num_edicts,
            ef,
            meta,
            strings,
            rng,
            tokens,
            world_locked,
            stopped,
            stack: Vec::with_capacity(cfg.max_depth as usize),
            localstack: Vec::new(),
            xfunction: 0,
            xstatement: 0,
            argc: 0,
            budget: DEFAULT_BUDGET,
            instructions: 0,
        };
        Ok((vm, r.p))
    }

    /// Mix the whole state into `h` (raw words; see `serialize`).
    pub fn hash_into(&self, h: &mut StateHasher) {
        h.u32(MAGIC);
        h.u32(self.world_locked as u32);
        h.u64(self.rng.state);
        h.u64(self.rng.inc);
        // VM memory is NaN-canonical by construction (interpreter float ops and float
        // setters canonicalise), so raw words hash deterministically.
        h.words_fast(&self.globals);
        h.u32(self.num_edicts);
        h.words_fast(&self.edicts);
        for m in &self.meta {
            h.u32(m.free as u32);
            h.f32(m.freetime);
            h.u32(m.serial);
        }
        self.strings.hash_into(h);
        h.u32(self.tokens.len() as u32);
        for t in &self.tokens {
            h.bytes(t);
        }
        h.u32(self.stopped.is_some() as u32);
    }

    /// 64-bit hash of the whole state.
    pub fn hash(&self) -> u64 {
        let mut h = StateHasher::new();
        self.hash_into(&mut h);
        h.finish()
    }
}
