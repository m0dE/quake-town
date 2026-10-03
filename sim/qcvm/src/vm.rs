// Quake Town - qcvm: VM state, accessors, edicts (port of QW/server/pr_edict.c)
// Copyright (C) 1996-1997 Id Software, Inc.
// Copyright (C) 2026 Quake Town contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// This program is free software; you can redistribute it and/or modify it under the terms
// of the GNU General Public License as published by the Free Software Foundation; either
// version 2 of the License, or (at your option) any later version.

use crate::defs::{fld, glob, ty, OFS_PARM0, OFS_RETURN};
use crate::error::{ErrorKind, VmError};
use crate::parse::{atof, atoi, com_parse};
use crate::progs::Progs;
use crate::rng::Pcg32;
use crate::strings::Strings;
use crate::{canon, Ent, Func, Host, Print, Str};
use std::sync::Arc;

/// Deterministic VM limits. Part of the serialized state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VmConfig {
    pub max_edicts: u32,
    pub client_edicts: u32,
    pub max_depth: u32,
    pub local_stack: u32,
    pub runaway: u64,
    pub string_bytes: u32,
}

impl Default for VmConfig {
    fn default() -> Self {
        VmConfig {
            max_edicts: 2048,
            client_edicts: 32,
            max_depth: 64,
            local_stack: 16384,
            runaway: 1_000_000,
            string_bytes: 4 << 20,
        }
    }
}

impl VmConfig {
    pub(crate) fn sanitized(mut self) -> VmConfig {
        self.client_edicts = self.client_edicts.min(255);
        self.max_edicts = self.max_edicts.clamp(self.client_edicts + 2, 65536);
        self.max_depth = self.max_depth.clamp(1, 4096);
        self.local_stack = self.local_stack.clamp(16, 1 << 22);
        self.runaway = self.runaway.max(1);
        self.string_bytes = self.string_bytes.clamp(1024, 1 << 28);
        self
    }
}

/// Result of `alloc_edict`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Alloc {
    pub ent: Ent,
    /// The edict cap was reached and the last edict was reused while live: unlink it.
    pub stepped_on: bool,
}

/// Result of `load_entities`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LoadStats {
    pub spawned: u32,
    pub inhibited: u32,
    pub no_spawn_fn: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Meta {
    pub free: bool,
    pub freetime: f32,
    pub serial: u32,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Frame {
    pub s: i32,
    pub f: u32,
}

/// Default total instruction budget (`set_budget`).
pub const DEFAULT_BUDGET: u64 = 50_000_000;

/// One world's QuakeC VM. `Clone` gives an independent copy.
#[derive(Clone)]
pub struct Vm {
    pub(crate) progs: Arc<Progs>,
    pub(crate) cfg: VmConfig,
    pub(crate) globals: Vec<u32>,
    pub(crate) edicts: Vec<u32>,
    pub(crate) num_edicts: u32,
    pub(crate) ef: u32,
    pub(crate) meta: Vec<Meta>,
    pub(crate) strings: Strings,
    pub(crate) rng: Pcg32,
    pub(crate) tokens: Vec<Vec<u8>>,
    pub(crate) world_locked: bool,
    pub(crate) stopped: Option<VmError>,
    // --- transient execution state (not serialized; empty between calls) ---
    pub(crate) stack: Vec<Frame>,
    pub(crate) localstack: Vec<u32>,
    pub(crate) xfunction: u32,
    pub(crate) xstatement: i32,
    pub(crate) argc: u32,
    pub(crate) budget: u64,
    pub(crate) instructions: u64,
}

impl Vm {
    /// PR_LoadProgs + the edict part of SV_SpawnServer.
    pub fn new(progs: Arc<Progs>, config: VmConfig, seed: u64) -> Vm {
        let cfg = config.sanitized();
        let ef = progs.entityfields;
        let mut vm = Vm {
            globals: Vec::new(),
            edicts: Vec::new(),
            num_edicts: 0,
            ef,
            meta: Vec::new(),
            strings: Strings::new(cfg.string_bytes as usize),
            rng: Pcg32::new(seed),
            tokens: Vec::new(),
            world_locked: false,
            stopped: None,
            stack: Vec::with_capacity(cfg.max_depth as usize),
            localstack: Vec::new(),
            xfunction: 0,
            xstatement: 0,
            argc: 0,
            budget: DEFAULT_BUDGET,
            instructions: 0,
            progs,
            cfg,
        };
        vm.restart();
        vm
    }

    /// Map change: globals back to the progs values, `client_edicts + 1` zeroed live edicts,
    /// all engine/zone/temp strings dropped, tokens cleared, world unlocked. PRNG continues.
    pub fn restart(&mut self) {
        self.globals.clear();
        self.globals.extend_from_slice(&self.progs.globals);
        self.num_edicts = self.cfg.client_edicts + 1;
        self.edicts.clear();
        self.edicts.resize((self.num_edicts * self.ef) as usize, 0);
        let serials: Vec<u32> = self.meta.iter().map(|m| m.serial).collect();
        self.meta.clear();
        for i in 0..self.num_edicts as usize {
            let serial = serials.get(i).copied().unwrap_or(0).wrapping_add(1);
            self.meta.push(Meta { free: false, freetime: 0.0, serial });
        }
        self.strings.clear();
        self.tokens.clear();
        self.world_locked = false;
        self.stopped = None;
        self.stack.clear();
        self.localstack.clear();
        self.xfunction = 0;
        self.argc = 0;
    }

    pub fn progs(&self) -> &Arc<Progs> {
        &self.progs
    }
    pub fn config(&self) -> VmConfig {
        self.cfg
    }

    // ------------------------------------------------------------------ control

    /// The error that stopped this VM, if any.
    pub fn stopped(&self) -> Option<&VmError> {
        self.stopped.as_ref()
    }
    /// Forget a stop (tests/tools only: the QC state after an error is whatever it was).
    pub fn clear_error(&mut self) {
        self.stopped = None;
        self.stack.clear();
        self.localstack.clear();
        self.xfunction = 0;
    }
    /// Total instruction budget across calls (reset it every tick).
    pub fn set_budget(&mut self, n: u64) {
        self.budget = n;
    }
    pub fn budget_left(&self) -> u64 {
        self.budget
    }
    /// Statements executed since creation (statistics; not state).
    pub fn instructions(&self) -> u64 {
        self.instructions
    }
    /// QW `sv.state == ss_active`: QC may not write fields of the world entity.
    pub fn set_world_locked(&mut self, on: bool) {
        self.world_locked = on;
    }
    pub fn world_locked(&self) -> bool {
        self.world_locked
    }
    /// True while QuakeC is running (inside a builtin).
    pub fn executing(&self) -> bool {
        !self.stack.is_empty()
    }
    /// The function currently executing (the caller of the current builtin).
    pub fn current_function(&self) -> Func {
        self.xfunction
    }

    // ------------------------------------------------------------------ globals

    #[inline]
    pub fn g_i(&self, o: u32) -> i32 {
        self.globals.get(o as usize).copied().unwrap_or(0) as i32
    }
    #[inline]
    pub fn g_f(&self, o: u32) -> f32 {
        f32::from_bits(self.g_i(o) as u32)
    }
    #[inline]
    pub fn g_v(&self, o: u32) -> [f32; 3] {
        [self.g_f(o), self.g_f(o + 1), self.g_f(o + 2)]
    }
    #[inline]
    pub fn g_e(&self, o: u32) -> Ent {
        self.g_i(o) as u32
    }
    #[inline]
    pub fn g_s(&self, o: u32) -> Str {
        self.g_i(o)
    }
    #[inline]
    pub fn g_fn(&self, o: u32) -> Func {
        self.g_i(o) as u32
    }
    pub fn g_str(&self, o: u32) -> &[u8] {
        self.string(self.g_s(o))
    }
    #[inline]
    pub fn set_g_i(&mut self, o: u32, v: i32) {
        if let Some(w) = self.globals.get_mut(o as usize) {
            *w = v as u32;
        }
    }
    #[inline]
    pub fn set_g_f(&mut self, o: u32, v: f32) {
        self.set_g_i(o, canon(v).to_bits() as i32)
    }
    #[inline]
    pub fn set_g_v(&mut self, o: u32, v: [f32; 3]) {
        self.set_g_f(o, v[0]);
        self.set_g_f(o + 1, v[1]);
        self.set_g_f(o + 2, v[2]);
    }
    #[inline]
    pub fn set_g_e(&mut self, o: u32, e: Ent) {
        self.set_g_i(o, e as i32)
    }
    #[inline]
    pub fn set_g_s(&mut self, o: u32, h: Str) {
        self.set_g_i(o, h)
    }
    #[inline]
    pub fn set_g_fn(&mut self, o: u32, f: Func) {
        self.set_g_i(o, f as i32)
    }
    /// All global words (read only).
    pub fn globals(&self) -> &[u32] {
        &self.globals
    }

    // ------------------------------------------------------------------ parms / return

    pub fn argc(&self) -> usize {
        self.argc as usize
    }
    #[inline]
    pub fn parm_f(&self, i: u32) -> f32 {
        self.g_f(OFS_PARM0 + 3 * i)
    }
    #[inline]
    pub fn parm_v(&self, i: u32) -> [f32; 3] {
        self.g_v(OFS_PARM0 + 3 * i)
    }
    #[inline]
    pub fn parm_i(&self, i: u32) -> i32 {
        self.g_i(OFS_PARM0 + 3 * i)
    }
    #[inline]
    pub fn parm_s(&self, i: u32) -> Str {
        self.g_s(OFS_PARM0 + 3 * i)
    }
    #[inline]
    pub fn parm_fn(&self, i: u32) -> Func {
        self.g_fn(OFS_PARM0 + 3 * i)
    }
    pub fn parm_str(&self, i: u32) -> &[u8] {
        self.string(self.parm_s(i))
    }
    /// Entity parameter, validated like QW NUM_FOR_EDICT.
    pub fn parm_ent(&self, i: u32) -> Result<Ent, VmError> {
        self.check_ent(self.parm_i(i))
    }
    /// Validate a raw entity value (< num_edicts).
    pub fn check_ent(&self, raw: i32) -> Result<Ent, VmError> {
        if raw < 0 || raw as u32 >= self.num_edicts {
            return Err(VmError::new(ErrorKind::BadEntity, format!("bad entity number {}", raw)));
        }
        Ok(raw as u32)
    }
    pub fn set_parm_f(&mut self, i: u32, v: f32) {
        self.set_g_f(OFS_PARM0 + 3 * i, v)
    }
    pub fn set_parm_v(&mut self, i: u32, v: [f32; 3]) {
        self.set_g_v(OFS_PARM0 + 3 * i, v)
    }
    pub fn set_parm_e(&mut self, i: u32, e: Ent) {
        self.set_g_e(OFS_PARM0 + 3 * i, e)
    }
    pub fn set_parm_s(&mut self, i: u32, h: Str) {
        self.set_g_s(OFS_PARM0 + 3 * i, h)
    }
    pub fn set_parm_i(&mut self, i: u32, v: i32) {
        self.set_g_i(OFS_PARM0 + 3 * i, v)
    }
    /// PF_VarString: concatenation of string parms `first..argc` (capped at 4096 bytes).
    pub fn var_string(&self, first: u32) -> Vec<u8> {
        let mut out = Vec::new();
        for i in first..self.argc {
            out.extend_from_slice(self.parm_str(i));
        }
        out.truncate(4096);
        out
    }
    pub fn ret_f(&mut self, v: f32) {
        self.set_g_f(OFS_RETURN, v)
    }
    pub fn ret_v(&mut self, v: [f32; 3]) {
        self.set_g_v(OFS_RETURN, v)
    }
    pub fn ret_i(&mut self, v: i32) {
        self.set_g_i(OFS_RETURN, v)
    }
    pub fn ret_e(&mut self, e: Ent) {
        self.set_g_e(OFS_RETURN, e)
    }
    pub fn ret_s(&mut self, h: Str) {
        self.set_g_s(OFS_RETURN, h)
    }
    /// Return a temp string with these bytes.
    pub fn ret_temp(&mut self, b: &[u8]) -> Result<(), VmError> {
        let h = self.strings.temp(b)?;
        self.ret_s(h);
        Ok(())
    }
    pub fn return_f(&self) -> f32 {
        self.g_f(OFS_RETURN)
    }
    pub fn return_v(&self) -> [f32; 3] {
        self.g_v(OFS_RETURN)
    }
    pub fn return_i(&self) -> i32 {
        self.g_i(OFS_RETURN)
    }
    pub fn return_e(&self) -> Ent {
        self.g_e(OFS_RETURN)
    }
    pub fn return_s(&self) -> Str {
        self.g_s(OFS_RETURN)
    }

    // ------------------------------------------------------------------ fields

    #[inline]
    fn fidx(&self, e: Ent, o: u32, w: u32) -> Option<usize> {
        if e < self.num_edicts && o.checked_add(w).map_or(false, |x| x <= self.ef) {
            Some((e * self.ef + o) as usize)
        } else {
            None
        }
    }
    #[inline]
    pub fn e_i(&self, e: Ent, o: u32) -> i32 {
        match self.fidx(e, o, 1) {
            Some(i) => self.edicts[i] as i32,
            None => 0,
        }
    }
    #[inline]
    pub fn e_f(&self, e: Ent, o: u32) -> f32 {
        f32::from_bits(self.e_i(e, o) as u32)
    }
    #[inline]
    pub fn e_v(&self, e: Ent, o: u32) -> [f32; 3] {
        match self.fidx(e, o, 3) {
            Some(i) => [
                f32::from_bits(self.edicts[i]),
                f32::from_bits(self.edicts[i + 1]),
                f32::from_bits(self.edicts[i + 2]),
            ],
            None => [0.0; 3],
        }
    }
    #[inline]
    pub fn e_e(&self, e: Ent, o: u32) -> Ent {
        self.e_i(e, o) as u32
    }
    #[inline]
    pub fn e_s(&self, e: Ent, o: u32) -> Str {
        self.e_i(e, o)
    }
    #[inline]
    pub fn e_fn(&self, e: Ent, o: u32) -> Func {
        self.e_i(e, o) as u32
    }
    pub fn e_str(&self, e: Ent, o: u32) -> &[u8] {
        self.string(self.e_s(e, o))
    }
    #[inline]
    pub fn set_e_i(&mut self, e: Ent, o: u32, v: i32) {
        if let Some(i) = self.fidx(e, o, 1) {
            self.edicts[i] = v as u32;
        }
    }
    #[inline]
    pub fn set_e_f(&mut self, e: Ent, o: u32, v: f32) {
        self.set_e_i(e, o, canon(v).to_bits() as i32)
    }
    #[inline]
    pub fn set_e_v(&mut self, e: Ent, o: u32, v: [f32; 3]) {
        if let Some(i) = self.fidx(e, o, 3) {
            self.edicts[i] = canon(v[0]).to_bits();
            self.edicts[i + 1] = canon(v[1]).to_bits();
            self.edicts[i + 2] = canon(v[2]).to_bits();
        }
    }
    #[inline]
    pub fn set_e_e(&mut self, e: Ent, o: u32, v: Ent) {
        self.set_e_i(e, o, v as i32)
    }
    #[inline]
    pub fn set_e_s(&mut self, e: Ent, o: u32, h: Str) {
        self.set_e_i(e, o, h)
    }
    #[inline]
    pub fn set_e_fn(&mut self, e: Ent, o: u32, f: Func) {
        self.set_e_i(e, o, f as i32)
    }
    /// Raw field words of edict `e` (empty if out of range).
    pub fn edict_words(&self, e: Ent) -> &[u32] {
        if e < self.num_edicts {
            let s = (e * self.ef) as usize;
            &self.edicts[s..s + self.ef as usize]
        } else {
            &[]
        }
    }
    pub fn edict_words_mut(&mut self, e: Ent) -> &mut [u32] {
        if e < self.num_edicts {
            let s = (e * self.ef) as usize;
            &mut self.edicts[s..s + self.ef as usize]
        } else {
            &mut []
        }
    }

    // ------------------------------------------------------------------ edicts

    pub fn num_edicts(&self) -> u32 {
        self.num_edicts
    }
    pub fn max_edicts(&self) -> u32 {
        self.cfg.max_edicts
    }
    pub fn client_edicts(&self) -> u32 {
        self.cfg.client_edicts
    }
    pub fn is_free(&self, e: Ent) -> bool {
        self.meta.get(e as usize).map_or(true, |m| m.free)
    }
    pub fn free_time(&self, e: Ent) -> f32 {
        self.meta.get(e as usize).map_or(0.0, |m| m.freetime)
    }
    pub fn serial(&self, e: Ent) -> u32 {
        self.meta.get(e as usize).map_or(0, |m| m.serial)
    }

    /// ED_ClearEdict: zero the fields, mark live.
    pub fn clear_edict(&mut self, e: Ent) {
        if e < self.num_edicts {
            let s = (e * self.ef) as usize;
            self.edicts[s..s + self.ef as usize].fill(0);
            self.meta[e as usize].free = false;
        }
    }

    /// ED_Alloc (see API.md).
    pub fn alloc_edict(&mut self, time: f64) -> Alloc {
        let first = self.cfg.client_edicts + 1;
        let mut i = first;
        while i < self.num_edicts {
            let m = self.meta[i as usize];
            if m.free && (m.freetime < 2.0 || time - m.freetime as f64 > 0.5) {
                self.clear_edict(i);
                self.meta[i as usize].serial = m.serial.wrapping_add(1);
                return Alloc { ent: i, stepped_on: false };
            }
            i += 1;
        }
        let stepped_on;
        if i >= self.cfg.max_edicts {
            i = self.cfg.max_edicts - 1;
            stepped_on = !self.meta[i as usize].free;
        } else {
            self.num_edicts += 1;
            self.edicts.resize((self.num_edicts * self.ef) as usize, 0);
            self.meta.push(Meta::default());
            stepped_on = false;
        }
        self.clear_edict(i);
        let m = &mut self.meta[i as usize];
        m.serial = m.serial.wrapping_add(1);
        Alloc { ent: i, stepped_on }
    }

    /// ED_Free without the unlink (the engine unlinks first).
    pub fn free_edict(&mut self, e: Ent, time: f64) {
        if e >= self.num_edicts {
            return;
        }
        self.meta[e as usize].free = true;
        self.set_e_i(e, fld::MODEL, 0);
        self.set_e_f(e, fld::TAKEDAMAGE, 0.0);
        self.set_e_f(e, fld::MODELINDEX, 0.0);
        self.set_e_f(e, fld::COLORMAP, 0.0);
        self.set_e_f(e, fld::SKIN, 0.0);
        self.set_e_f(e, fld::FRAME, 0.0);
        self.set_e_v(e, fld::ORIGIN, [0.0; 3]);
        self.set_e_v(e, fld::ANGLES, [0.0; 3]);
        self.set_e_f(e, fld::NEXTTHINK, -1.0);
        self.set_e_f(e, fld::SOLID, 0.0);
        self.meta[e as usize].freetime = time as f32;
    }

    // ------------------------------------------------------------------ strings

    /// Contents of a string handle ("" when invalid).
    #[inline]
    pub fn string(&self, h: Str) -> &[u8] {
        if h >= 0 {
            self.progs.string_at(h)
        } else {
            self.strings.get(h)
        }
    }
    /// Permanent, interned engine string (until `restart`).
    pub fn new_string(&mut self, b: &[u8]) -> Result<Str, VmError> {
        self.strings.perm(b)
    }
    /// Temp string from the rotating ring.
    pub fn temp_string(&mut self, b: &[u8]) -> Result<Str, VmError> {
        self.strings.temp(b)
    }
    /// strzone.
    pub fn zone_string(&mut self, b: &[u8]) -> Result<Str, VmError> {
        self.strings.zone(b)
    }
    /// strunzone; false if `h` is not a live zone string.
    pub fn unzone(&mut self, h: Str) -> bool {
        self.strings.unzone(h)
    }
    /// Bytes held by engine/zone/temp strings.
    pub fn string_bytes(&self) -> usize {
        self.strings.used_bytes()
    }

    // ------------------------------------------------------------------ PRNG

    /// QC `random()`.
    pub fn random(&mut self) -> f32 {
        self.rng.qc_random()
    }
    pub fn rng_u32(&mut self) -> u32 {
        self.rng.next_u32()
    }
    pub fn rng_f01(&mut self) -> f32 {
        self.rng.f01()
    }
    pub fn rng(&mut self) -> &mut Pcg32 {
        &mut self.rng
    }

    // ------------------------------------------------------------------ entity text

    /// ED_ParseEpair into globals (`ent = None`) or a field of `ent`.
    fn parse_epair(&mut self, ent: Option<Ent>, def_ofs: u32, def_ty: u16, s: &[u8]) -> Result<bool, VmError> {
        let write = |vm: &mut Vm, k: u32, v: u32| match ent {
            Some(e) => vm.set_e_i(e, def_ofs + k, v as i32),
            None => vm.set_g_i(def_ofs + k, v as i32),
        };
        match def_ty {
            ty::STRING => {
                // ED_NewString: "\n" escapes, other "\x" become "\"
                let mut out = Vec::with_capacity(s.len());
                let mut i = 0;
                while i < s.len() {
                    if s[i] == b'\\' && i + 1 < s.len() {
                        i += 1;
                        out.push(if s[i] == b'n' { b'\n' } else { b'\\' });
                    } else {
                        out.push(s[i]);
                    }
                    i += 1;
                }
                let h = self.new_string(&out)?;
                write(self, 0, h as u32);
            }
            ty::FLOAT => write(self, 0, canon(atof(s) as f32).to_bits()),
            ty::VECTOR => {
                let s = &s[..s.len().min(127)];
                let mut parts = s.split(|&c| c == b' ');
                for k in 0..3 {
                    let p = parts.next().unwrap_or(b"");
                    write(self, k, canon(atof(p) as f32).to_bits());
                }
            }
            ty::ENTITY => {
                let n = atoi(s);
                if n < 0 || n as u32 >= self.cfg.max_edicts {
                    return Err(VmError::new(ErrorKind::Parse, format!("EDICT_NUM: bad number {}", n)));
                }
                write(self, 0, n as u32);
            }
            ty::FIELD => match self.progs.find_field_bytes(s) {
                Some(d) => {
                    let v = self.g_i(d.ofs) as u32;
                    write(self, 0, v);
                }
                None => return Ok(false),
            },
            ty::FUNCTION => match self.progs.find_function_bytes(s) {
                Some(f) => write(self, 0, f),
                None => return Ok(false),
            },
            _ => {}
        }
        Ok(true)
    }

    /// ED_ParseEdict: fill `ent` from `{ "key" "value" ... }` (the opening brace already
    /// consumed). Returns the rest of the data.
    fn parse_edict<'a>(&mut self, mut data: &'a [u8], ent: Ent) -> Result<&'a [u8], VmError> {
        let perr = |m: &str| VmError::new(ErrorKind::Parse, m.to_string());
        let mut init = false;
        if ent != 0 {
            self.clear_edict(ent);
        }
        loop {
            let (mut key, rest) = match com_parse(data) {
                Some(t) => t,
                None => return Err(perr("ED_ParseEntity: EOF without closing brace")),
            };
            data = rest;
            if key.first() == Some(&b'}') {
                break;
            }
            let anglehack = key == b"angle";
            if anglehack {
                key = b"angles".to_vec();
            }
            if key == b"light" {
                key = b"light_lev".to_vec();
            }
            let (val, rest) = match com_parse(data) {
                Some(t) => t,
                None => return Err(perr("ED_ParseEntity: EOF without closing brace")),
            };
            data = rest;
            if val.first() == Some(&b'}') {
                return Err(perr("ED_ParseEntity: closing brace without data"));
            }
            init = true;
            if key.first() == Some(&b'_') {
                continue;
            }
            let (ofs, dty) = match self.progs.find_field_bytes(&key) {
                Some(d) => (d.ofs, d.ty),
                None => continue, // "%s is not a field"
            };
            let val = if anglehack {
                let mut v = b"0 ".to_vec();
                v.extend_from_slice(&val[..val.len().min(31)]);
                v.extend_from_slice(b" 0");
                v
            } else {
                val
            };
            if !self.parse_epair(Some(ent), ofs, dty, &val)? {
                return Err(perr("ED_ParseEdict: parse error"));
            }
        }
        if !init {
            if let Some(m) = self.meta.get_mut(ent as usize) {
                m.free = true;
            }
        }
        Ok(data)
    }

    /// ED_ParseGlobals for a `{ "global" "value" ... }` block (savegames, tools).
    pub fn parse_globals(&mut self, data: &[u8]) -> Result<(), VmError> {
        let mut d = data;
        if let Some((t, r)) = com_parse(d) {
            if t == b"{" {
                d = r;
            }
        }
        loop {
            let (key, r) = match com_parse(d) {
                Some(t) => t,
                None => return Err(VmError::new(ErrorKind::Parse, "ED_ParseGlobals: EOF without closing brace")),
            };
            if key.first() == Some(&b'}') {
                return Ok(());
            }
            let (val, r) = match com_parse(r) {
                Some(t) => t,
                None => return Err(VmError::new(ErrorKind::Parse, "ED_ParseGlobals: EOF without closing brace")),
            };
            d = r;
            let def = match self.progs.find_global(&String::from_utf8_lossy(&key)) {
                Some(def) => (def.ofs, def.ty),
                None => continue,
            };
            if !self.parse_epair(None, def.0, def.1, &val)? {
                return Err(VmError::new(ErrorKind::Parse, "ED_ParseGlobals: parse error"));
            }
        }
    }

    /// ED_LoadFromFile (see API.md).
    pub fn load_entities<H: Host + ?Sized>(
        &mut self,
        host: &mut H,
        data: &[u8],
        time: f64,
    ) -> Result<LoadStats, VmError> {
        let mut stats = LoadStats::default();
        let mut first = true;
        let mut d = data;
        self.set_g_f(glob::TIME, time as f32);
        loop {
            let (tok, rest) = match com_parse(d) {
                Some(t) => t,
                None => break,
            };
            d = rest;
            if tok.first() != Some(&b'{') {
                return Err(self.fail(VmError::new(
                    ErrorKind::Parse,
                    format!("ED_LoadFromFile: found {} when expecting {{", String::from_utf8_lossy(&tok)),
                )));
            }
            let ent = if first {
                first = false;
                0
            } else {
                let a = self.alloc_edict(time);
                if a.stepped_on {
                    host.unlink(self, a.ent);
                }
                a.ent
            };
            d = match self.parse_edict(d, ent) {
                Ok(r) => r,
                Err(e) => return Err(self.fail(e)),
            };
            const SPAWNFLAG_NOT_DEATHMATCH: i32 = 2048;
            if (self.e_f(ent, fld::SPAWNFLAGS) as i32) & SPAWNFLAG_NOT_DEATHMATCH != 0 {
                self.free_edict(ent, time);
                stats.inhibited += 1;
                continue;
            }
            let cls = self.e_s(ent, fld::CLASSNAME);
            if cls == 0 {
                host.print(self, Print::Dprint, b"No classname for entity\n");
                self.free_edict(ent, time);
                stats.no_spawn_fn += 1;
                continue;
            }
            let name = self.string(cls).to_vec();
            let func = match self.progs.find_function_bytes(&name) {
                Some(f) => f,
                None => {
                    let mut m = b"No spawn function for: ".to_vec();
                    m.extend_from_slice(&name);
                    m.push(b'\n');
                    host.print(self, Print::Dprint, &m);
                    self.free_edict(ent, time);
                    stats.no_spawn_fn += 1;
                    continue;
                }
            };
            self.set_g_e(glob::SELF, ent);
            self.call(host, func)?;
            stats.spawned += 1;
        }
        Ok(stats)
    }

    /// Text dump of an edict like ED_Print (eprint, errors).
    pub fn edict_text(&self, e: Ent) -> Vec<u8> {
        use std::io::Write;
        let mut out = Vec::new();
        let _ = writeln!(out, "EDICT {}:", e);
        if self.is_free(e) {
            out.extend_from_slice(b"FREE\n");
            return out;
        }
        for d in self.progs.fielddefs.iter().skip(1) {
            let n = d.name.as_bytes();
            if n.len() >= 2 && n[n.len() - 2] == b'_' {
                continue;
            }
            let w = if d.ty == ty::VECTOR { 3 } else { 1 };
            let words: Vec<u32> = (0..w).map(|k| self.e_i(e, d.ofs + k) as u32).collect();
            if words.iter().all(|&x| x == 0) {
                continue;
            }
            let _ = write!(out, "{:<15}", d.name);
            self.value_text(&mut out, d.ty, &words);
            out.push(b'\n');
        }
        out
    }

    /// PR_ValueString.
    pub(crate) fn value_text(&self, out: &mut Vec<u8>, t: u16, w: &[u32]) {
        use std::io::Write;
        let w0 = w.first().copied().unwrap_or(0);
        match t {
            ty::STRING => out.extend_from_slice(self.string(w0 as i32)),
            ty::ENTITY => {
                let _ = write!(out, "entity {}", w0 as i32);
            }
            ty::FUNCTION => {
                out.extend_from_slice(self.progs.function_name(w0));
                out.extend_from_slice(b"()");
            }
            ty::FIELD => {
                out.push(b'.');
                if let Some(d) = self.progs.field_at_ofs(w0) {
                    out.extend_from_slice(d.name.as_bytes());
                }
            }
            ty::VOID => out.extend_from_slice(b"void"),
            ty::FLOAT => crate::parse::fmt_5_1(out, f32::from_bits(w0)),
            ty::VECTOR => {
                let v = [
                    f32::from_bits(w0),
                    f32::from_bits(w.get(1).copied().unwrap_or(0)),
                    f32::from_bits(w.get(2).copied().unwrap_or(0)),
                ];
                out.extend_from_slice(&crate::parse::vtos(v));
            }
            ty::POINTER => out.extend_from_slice(b"pointer"),
            _ => {
                let _ = write!(out, "bad type {}", t);
            }
        }
    }

    /// Stop the VM with this error (fills the trace), returning it.
    pub(crate) fn fail(&mut self, mut e: VmError) -> VmError {
        if self.stopped.is_none() {
            if e.trace.is_empty() {
                e.trace = self.stack_trace();
            }
            self.stopped = Some(e.clone());
        }
        self.stack.clear();
        self.localstack.clear();
        self.xfunction = 0;
        e
    }

    /// PR_StackTrace as text (innermost first).
    pub fn stack_trace(&self) -> String {
        let mut s = String::new();
        if self.stack.is_empty() && self.xfunction == 0 {
            return s;
        }
        let name = |f: u32| {
            format!(
                "{:>12} : {}",
                String::from_utf8_lossy(self.progs.function_file(f)),
                String::from_utf8_lossy(self.progs.function_name(f))
            )
        };
        s.push_str(&name(self.xfunction));
        for fr in self.stack.iter().rev() {
            if fr.f == 0 {
                continue;
            }
            s.push('\n');
            s.push_str(&name(fr.f));
        }
        s
    }
}
