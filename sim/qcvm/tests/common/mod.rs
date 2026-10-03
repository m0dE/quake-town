// Quake Town - qcvm test helpers: a mock QW host and a tiny progs assembler.
// Copyright (C) 2026 Quake Town contributors
// SPDX-License-Identifier: GPL-2.0-or-later
#![allow(dead_code)]

use qcvm::defs::{fld, glob, ty};
use qcvm::{Ent, Host, Print, Vm, VmError};

pub const QWPROGS: &str = "/app/data/home/quake-ref/Quake/QW/progs/qwprogs.dat";
pub const MAPS: &str = "/app/data/home/quake-ref/full/id1/maps";

pub fn qwprogs() -> Option<Vec<u8>> {
    std::fs::read(QWPROGS).ok()
}

/// Entities lump of a BSP29/BSP2 file.
pub fn bsp_entities(path: &str) -> Option<Vec<u8>> {
    let d = std::fs::read(path).ok()?;
    let o = i32::from_le_bytes(d[4..8].try_into().ok()?) as usize;
    let l = i32::from_le_bytes(d[8..12].try_into().ok()?) as usize;
    Some(d.get(o..o + l)?.to_vec())
}

/// A mock QW engine: every QW builtin does something plausible and cheap.
#[derive(Default, Clone)]
pub struct MockHost {
    pub time: f64,
    pub calls: Vec<u32>,
    pub models: Vec<Vec<u8>>,
    pub prints: Vec<Vec<u8>>,
    pub changelevel: Option<Vec<u8>>,
    pub record_calls: bool,
}

impl MockHost {
    fn model_index(&mut self, m: &[u8]) -> f32 {
        if m.is_empty() {
            return 0.0;
        }
        match self.models.iter().position(|x| x == m) {
            Some(i) => (i + 1) as f32,
            None => {
                self.models.push(m.to_vec());
                self.models.len() as f32
            }
        }
    }
}

impl Host for MockHost {
    fn builtin(&mut self, vm: &mut Vm, num: u32) -> Result<(), VmError> {
        if self.record_calls {
            self.calls.push(num);
        }
        match num {
            2 => {
                let e = vm.parm_ent(0)?;
                let v = vm.parm_v(1);
                vm.set_e_v(e, fld::ORIGIN, v);
            }
            3 => {
                let e = vm.parm_ent(0)?;
                let h = vm.parm_s(1);
                let m = vm.string(h).to_vec();
                vm.set_e_s(e, fld::MODEL, h);
                let idx = self.model_index(&m);
                vm.set_e_f(e, fld::MODELINDEX, idx);
            }
            4 => {
                let e = vm.parm_ent(0)?;
                let (mn, mx) = (vm.parm_v(1), vm.parm_v(2));
                vm.set_e_v(e, fld::MINS, mn);
                vm.set_e_v(e, fld::MAXS, mx);
                vm.set_e_v(e, fld::SIZE, [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]]);
            }
            14 => {
                let a = vm.alloc_edict(self.time);
                vm.ret_e(a.ent);
            }
            15 | 69 => {
                let e = vm.parm_ent(0)?;
                vm.free_edict(e, self.time);
            }
            16 => {
                let v2 = vm.parm_v(1);
                vm.set_g_f(glob::TRACE_FRACTION, 1.0);
                vm.set_g_v(glob::TRACE_ENDPOS, v2);
                vm.set_g_e(glob::TRACE_ENT, 0);
                vm.set_g_f(glob::TRACE_ALLSOLID, 0.0);
                vm.set_g_f(glob::TRACE_STARTSOLID, 0.0);
                vm.set_g_v(glob::TRACE_PLANE_NORMAL, [0.0, 0.0, 1.0]);
                vm.set_g_f(glob::TRACE_INOPEN, 1.0);
                vm.set_g_f(glob::TRACE_INWATER, 0.0);
            }
            17 => vm.ret_e(0),
            19 | 20 | 68 | 75 | 76 | 77 => {
                let h = vm.parm_s(0);
                if num == 20 || num == 75 {
                    let m = vm.string(h).to_vec();
                    self.model_index(&m);
                }
                vm.ret_s(h);
            }
            32 | 34 | 40 => vm.ret_f(1.0),
            41 => vm.ret_f(-1.0),
            44 => {
                let f = vm.g_v(glob::V_FORWARD);
                vm.ret_v(f);
            }
            45 => {
                let v = match vm.parm_str(0) {
                    b"deathmatch" => 3.0,
                    b"teamplay" => 0.0,
                    b"timelimit" => 10.0,
                    b"fraglimit" => 0.0,
                    _ => 0.0,
                };
                vm.ret_f(v);
            }
            70 => self.changelevel = Some(vm.parm_str(0).to_vec()),
            80 => {
                let v: &[u8] = match vm.parm_str(1) {
                    b"name" => b"tester",
                    _ => b"",
                };
                vm.ret_temp(v)?;
            }
            8 | 21 | 23 | 24 | 35 | 46 | 49 | 52..=59 | 67 | 72 | 73 | 74 | 78 | 79 | 82 => {}
            _ => return Err(VmError::unknown_builtin(num)),
        }
        Ok(())
    }
    fn print(&mut self, _vm: &Vm, _kind: Print, text: &[u8]) {
        if self.prints.len() < 1000 {
            self.prints.push(text.to_vec());
        }
    }
}

/// QW-ish frame without collision: StartFrame, client think, entity thinks.
pub struct MiniWorld {
    pub vm: Vm,
    pub host: MockHost,
    pub tick: u32,
}

pub const FRAMETIME: f64 = 0.013;

impl MiniWorld {
    pub fn new(vm: Vm) -> MiniWorld {
        MiniWorld { vm, host: MockHost { time: 1.0, ..Default::default() }, tick: 0 }
    }

    pub fn spawn_map(&mut self, ents: &[u8]) -> Result<qcvm::LoadStats, VmError> {
        let mapname = self.vm.new_string(b"lqdm1")?;
        self.vm.set_g_s(glob::MAPNAME, mapname);
        let t = self.host.time;
        let st = self.vm.load_entities(&mut self.host, ents, t)?;
        self.vm.set_world_locked(true);
        Ok(st)
    }

    pub fn connect(&mut self, e: Ent) -> Result<(), VmError> {
        let vm = &mut self.vm;
        let f = vm.g_fn(glob::SETNEWPARMS);
        vm.call(&mut self.host, f)?;
        let name = vm.new_string(b"tester")?;
        vm.set_e_s(e, fld::NETNAME, name);
        vm.set_e_f(e, fld::COLORMAP, e as f32);
        vm.set_g_e(glob::SELF, e);
        let f = vm.g_fn(glob::CLIENTCONNECT);
        vm.call(&mut self.host, f)?;
        vm.set_g_e(glob::SELF, e);
        let f = vm.g_fn(glob::PUTCLIENTINSERVER);
        vm.call(&mut self.host, f)
    }

    /// One tick. `attack`: hold button0 on client 1.
    pub fn step(&mut self, client: bool, attack: bool, impulse: f32) -> Result<(), VmError> {
        self.tick += 1;
        self.host.time += FRAMETIME;
        let time = self.host.time;
        let vm = &mut self.vm;
        vm.set_budget(qcvm::DEFAULT_BUDGET);
        vm.set_g_f(glob::TIME, time as f32);
        vm.set_g_f(glob::FRAMETIME, FRAMETIME as f32);
        vm.set_g_e(glob::SELF, 0);
        vm.set_g_e(glob::OTHER, 0);
        let f = vm.g_fn(glob::STARTFRAME);
        vm.call(&mut self.host, f)?;
        if client {
            vm.set_e_f(1, fld::BUTTON0, if attack { 1.0 } else { 0.0 });
            vm.set_e_f(1, fld::IMPULSE, impulse);
            vm.set_g_e(glob::SELF, 1);
            let f = vm.g_fn(glob::PLAYERPRETHINK);
            vm.call(&mut self.host, f)?;
            vm.set_g_e(glob::SELF, 1);
            let f = vm.g_fn(glob::PLAYERPOSTTHINK);
            vm.call(&mut self.host, f)?;
        }
        let mut e = 1;
        while e < vm.num_edicts() {
            if !vm.is_free(e) {
                let nt = vm.e_f(e, fld::NEXTTHINK) as f64;
                if nt > 0.0 && nt <= time + FRAMETIME {
                    let t = if nt < time { time } else { nt };
                    vm.set_e_f(e, fld::NEXTTHINK, 0.0);
                    vm.set_g_f(glob::TIME, t as f32);
                    vm.set_g_e(glob::SELF, e);
                    vm.set_g_e(glob::OTHER, 0);
                    let th = vm.e_fn(e, fld::THINK);
                    if th != 0 {
                        vm.call(&mut self.host, th)?;
                    }
                }
            }
            e += 1;
        }
        Ok(())
    }
}

// --------------------------------------------------------------------------- assembler

/// Builds a minimal valid QW progs (CRC 54730) in memory.
pub struct Asm {
    pub statements: Vec<[u16; 4]>,
    pub functions: Vec<(i32, u32, u32, String, u32, [u8; 8])>, // first, parm_start, locals, name, numparms, sizes
    pub globals: Vec<u32>,
    pub globaldefs: Vec<(u16, u16, String)>,
    pub fielddefs: Vec<(u16, u16, String)>,
    pub strings: Vec<u8>,
    pub entityfields: u32,
}

impl Asm {
    pub fn new() -> Asm {
        let mut a = Asm {
            statements: vec![[0, 0, 0, 0]],
            functions: vec![(0, 0, 0, String::new(), 0, [0; 8])],
            globals: vec![0; 100],
            globaldefs: vec![],
            fielddefs: vec![(ty::VOID, 0, String::new())],
            strings: vec![0],
            entityfields: fld::COUNT + 8,
        };
        a.fielddefs.push((ty::VECTOR, fld::ORIGIN as u16, "origin".into()));
        a.fielddefs.push((ty::STRING, fld::CLASSNAME as u16, "classname".into()));
        a.fielddefs.push((ty::FLOAT, fld::HEALTH as u16, "health".into()));
        a.fielddefs.push((ty::FLOAT, fld::FRAME as u16, "frame".into()));
        a.fielddefs.push((ty::FUNCTION, fld::THINK as u16, "think".into()));
        a.fielddefs.push((ty::FLOAT, fld::NEXTTHINK as u16, "nextthink".into()));
        a.fielddefs.push((ty::FLOAT, fld::SPAWNFLAGS as u16, "spawnflags".into()));
        a.fielddefs.push((ty::STRING, fld::MESSAGE as u16, "message".into()));
        a.fielddefs.push((ty::VECTOR, fld::ANGLES as u16, "angles".into()));
        a.fielddefs.push((ty::ENTITY, fld::OWNER as u16, "owner".into()));
        a.globaldefs.push((ty::FLOAT, glob::TIME as u16, "time".into()));
        a.globaldefs.push((ty::ENTITY, glob::SELF as u16, "self".into()));
        a
    }
    pub fn string(&mut self, s: &str) -> i32 {
        let o = self.strings.len() as i32;
        self.strings.extend_from_slice(s.as_bytes());
        self.strings.push(0);
        o
    }
    /// A new global word (returns its offset), initial raw value.
    pub fn global(&mut self, v: u32) -> u16 {
        self.globals.push(v);
        (self.globals.len() - 1) as u16
    }
    pub fn gf(&mut self, v: f32) -> u16 {
        self.global(v.to_bits())
    }
    pub fn gv(&mut self, v: [f32; 3]) -> u16 {
        let o = self.gf(v[0]);
        self.gf(v[1]);
        self.gf(v[2]);
        o
    }
    pub fn st(&mut self, o: u16, a: u16, b: u16, c: u16) -> usize {
        self.statements.push([o, a, b, c]);
        self.statements.len() - 1
    }
    /// Begin a function at the next statement; returns its index.
    pub fn func(&mut self, name: &str, parm_start: u32, locals: u32, parms: &[u8]) -> u32 {
        let mut sizes = [0u8; 8];
        sizes[..parms.len()].copy_from_slice(parms);
        let first = self.statements.len() as i32;
        self.functions.push((first, parm_start, locals, name.into(), parms.len() as u32, sizes));
        (self.functions.len() - 1) as u32
    }
    pub fn builtin(&mut self, name: &str, num: i32) -> u32 {
        self.functions.push((-num, 0, 0, name.into(), 0, [0; 8]));
        (self.functions.len() - 1) as u32
    }
    pub fn build(&self) -> Vec<u8> {
        let mut out = vec![0u8; 60];
        let mut hdr = [0i32; 15];
        hdr[0] = 6;
        hdr[1] = 54730;
        let push = |out: &mut Vec<u8>, b: &[u8]| -> i32 {
            let o = out.len() as i32;
            out.extend_from_slice(b);
            o
        };
        let mut sb = Vec::new();
        for s in &self.statements {
            for w in s {
                sb.extend_from_slice(&w.to_le_bytes());
            }
        }
        hdr[2] = push(&mut out, &sb);
        hdr[3] = self.statements.len() as i32;
        let mut strings = self.strings.clone();
        let name_ofs = |strings: &mut Vec<u8>, n: &str| -> i32 {
            if n.is_empty() {
                return 0;
            }
            let o = strings.len() as i32;
            strings.extend_from_slice(n.as_bytes());
            strings.push(0);
            o
        };
        let defs = |strings: &mut Vec<u8>, d: &[(u16, u16, String)]| -> Vec<u8> {
            let mut b = Vec::new();
            for (t, o, n) in d {
                b.extend_from_slice(&t.to_le_bytes());
                b.extend_from_slice(&o.to_le_bytes());
                b.extend_from_slice(&name_ofs(strings, n).to_le_bytes());
            }
            b
        };
        let gd = defs(&mut strings, &self.globaldefs);
        let fd = defs(&mut strings, &self.fielddefs);
        let mut fb = Vec::new();
        for (first, ps, locals, name, np, sizes) in &self.functions {
            let mut nameo = 0;
            if !name.is_empty() {
                nameo = strings.len() as i32;
                strings.extend_from_slice(name.as_bytes());
                strings.push(0);
            }
            for v in [*first, *ps as i32, *locals as i32, 0, nameo, 0, *np as i32] {
                fb.extend_from_slice(&v.to_le_bytes());
            }
            fb.extend_from_slice(sizes);
        }
        hdr[4] = push(&mut out, &gd);
        hdr[5] = self.globaldefs.len() as i32;
        hdr[6] = push(&mut out, &fd);
        hdr[7] = self.fielddefs.len() as i32;
        hdr[8] = push(&mut out, &fb);
        hdr[9] = self.functions.len() as i32;
        hdr[10] = push(&mut out, &strings);
        hdr[11] = strings.len() as i32;
        let mut gb = Vec::new();
        for g in &self.globals {
            gb.extend_from_slice(&g.to_le_bytes());
        }
        hdr[12] = push(&mut out, &gb);
        hdr[13] = self.globals.len() as i32;
        hdr[14] = self.entityfields as i32;
        for (i, h) in hdr.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&h.to_le_bytes());
        }
        out
    }
}


/// Host that only knows nothing (pure builtins are inside the VM).
pub struct NullHost;
impl Host for NullHost {
    fn builtin(&mut self, _vm: &mut Vm, num: u32) -> Result<(), VmError> {
        Err(VmError::unknown_builtin(num))
    }
}

/// CPU time of this thread in seconds (the box is shared: wall time lies).
pub fn cpu_time() -> f64 {
    std::fs::read_to_string("/proc/thread-self/schedstat")
        .ok()
        .and_then(|s| s.split_whitespace().next().and_then(|x| x.parse::<f64>().ok()))
        .map(|ns| ns / 1e9)
        .unwrap_or(0.0)
}
