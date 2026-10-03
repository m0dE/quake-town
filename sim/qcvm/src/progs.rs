// Quake Town - qcvm: progs loader (port of PR_LoadProgs, QW/server/pr_edict.c)
// Copyright (C) 1996-1997 Id Software, Inc.
// Copyright (C) 2026 Quake Town contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// This program is free software; you can redistribute it and/or modify it under the terms
// of the GNU General Public License as published by the Free Software Foundation; either
// version 2 of the License, or (at your option) any later version.

use crate::defs::{self, ty};
use crate::hash::StateHasher;
use crate::Func;
use std::fmt;
use std::sync::Arc;

/// Biggest progs accepted (DESIGN.md sandbox limits).
pub const MAX_PROGS_BYTES: usize = 4 << 20;
/// Biggest `entityfields` accepted (QW mods use 100..400).
pub const MAX_ENTITYFIELDS: u32 = 4096;

/// One statement. Operands are unsigned global offsets (branch offsets: signed, as i16).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(C)]
pub struct Statement {
    pub op: u16,
    pub a: u16,
    pub b: u16,
    pub c: u16,
}

/// `dfunction_t`.
#[derive(Clone, Debug)]
pub struct Function {
    /// Negative: builtin number `-first_statement`.
    pub first_statement: i32,
    pub parm_start: u32,
    pub locals: u32,
    pub s_name: i32,
    pub s_file: i32,
    pub numparms: u32,
    pub parm_size: [u8; 8],
}

/// A field or global definition.
#[derive(Clone, Debug)]
pub struct Def {
    /// Word offset.
    pub ofs: u32,
    /// `defs::ty::*` with the SAVEGLOBAL bit stripped.
    pub ty: u16,
    /// Whether DEF_SAVEGLOBAL was set (globals only).
    pub save: bool,
    pub name: String,
}

/// Why a progs was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LoadError {
    Truncated(String),
    Version(i32),
    NetQuake,
    Crc(i32),
    Lump(String),
    TooBig(String),
    Layout(String),
    Function(String),
}

impl LoadError {
    /// Negative error code for the ABI.
    pub fn code(&self) -> i32 {
        match self {
            LoadError::Truncated(_) => -1,
            LoadError::Version(_) => -2,
            LoadError::NetQuake => -3,
            LoadError::Crc(_) => -4,
            LoadError::Lump(_) => -5,
            LoadError::TooBig(_) => -6,
            LoadError::Layout(_) => -7,
            LoadError::Function(_) => -8,
        }
    }
}

impl fmt::Display for LoadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LoadError::Truncated(s) => write!(f, "progs: truncated or not a progs file ({})", s),
            LoadError::Version(v) => write!(f, "progs: wrong version number ({} should be 6)", v),
            LoadError::NetQuake => write!(
                f,
                "progs: this is a NetQuake progs.dat (CRC 5927); Quake Town needs QuakeWorld progs (qwprogs.dat, CRC 54730)"
            ),
            LoadError::Crc(c) => write!(f, "progs: unknown progdefs CRC {} (QuakeWorld progs have 54730)", c),
            LoadError::Lump(s) => write!(f, "progs: bad lump: {}", s),
            LoadError::TooBig(s) => write!(f, "progs: too big: {}", s),
            LoadError::Layout(s) => write!(f, "progs: bad layout: {}", s),
            LoadError::Function(s) => write!(f, "progs: bad function: {}", s),
        }
    }
}

impl std::error::Error for LoadError {}

/// A loaded, validated progs. Immutable; shared by every world (`Arc`).
pub struct Progs {
    pub(crate) statements: Vec<Statement>,
    pub(crate) functions: Vec<Function>,
    pub(crate) globaldefs: Vec<Def>,
    pub(crate) fielddefs: Vec<Def>,
    /// String table, with a guaranteed trailing NUL.
    pub(crate) strings: Vec<u8>,
    /// Initial globals, padded to `globals_len`.
    pub(crate) globals: Vec<u32>,
    pub(crate) numglobals: u32,
    /// Length of the VM's globals array: covers every operand + 3 and every function's locals.
    pub(crate) globals_len: u32,
    pub(crate) entityfields: u32,
    pub(crate) crc: i32,
    pub(crate) fingerprint: u64,
    /// (name, function index) sorted by name then index.
    fn_index: Vec<(Box<[u8]>, u32)>,
    field_index: Vec<(Box<[u8]>, u32)>,
    global_index: Vec<(Box<[u8]>, u32)>,
    /// Per field word: true if the word belongs to a float or vector field.
    #[allow(dead_code)]
    pub(crate) field_float: Vec<bool>,
    /// Per global word: true if float/vector typed.
    #[allow(dead_code)]
    pub(crate) global_float: Vec<bool>,
}

struct Rd<'a> {
    d: &'a [u8],
}

impl<'a> Rd<'a> {
    fn i32(&self, o: usize) -> i32 {
        i32::from_le_bytes([self.d[o], self.d[o + 1], self.d[o + 2], self.d[o + 3]])
    }
    fn u16(&self, o: usize) -> u16 {
        u16::from_le_bytes([self.d[o], self.d[o + 1]])
    }
}

fn lump(len: usize, ofs: i32, count: i32, size: usize, what: &str) -> Result<(usize, usize), LoadError> {
    if ofs < 0 || count < 0 {
        return Err(LoadError::Lump(format!("{}: negative offset/count", what)));
    }
    let (o, c) = (ofs as usize, count as usize);
    let end = c.checked_mul(size).and_then(|b| b.checked_add(o));
    match end {
        Some(e) if e <= len => Ok((o, c)),
        _ => Err(LoadError::Lump(format!("{}: out of file", what))),
    }
}

fn build_index(names: impl Iterator<Item = (Vec<u8>, u32)>) -> Vec<(Box<[u8]>, u32)> {
    let mut v: Vec<(Box<[u8]>, u32)> = names.map(|(n, i)| (n.into_boxed_slice(), i)).collect();
    v.sort();
    v
}

fn index_find(idx: &[(Box<[u8]>, u32)], name: &[u8]) -> Option<u32> {
    let p = idx.partition_point(|(n, _)| &n[..] < name);
    match idx.get(p) {
        Some((n, i)) if &n[..] == name => Some(*i),
        _ => None,
    }
}

impl Progs {
    /// Load and validate a QW progs (`qwprogs.dat`).
    pub fn load(data: &[u8]) -> Result<Arc<Progs>, LoadError> {
        Progs::load_inner(data).map(Arc::new)
    }

    fn load_inner(data: &[u8]) -> Result<Progs, LoadError> {
        if data.len() > MAX_PROGS_BYTES {
            return Err(LoadError::TooBig(format!("{} bytes > 4 MB", data.len())));
        }
        if data.len() < 60 {
            return Err(LoadError::Truncated(format!("{} bytes", data.len())));
        }
        let r = Rd { d: data };
        let h: Vec<i32> = (0..15).map(|i| r.i32(i * 4)).collect();
        let (version, crc) = (h[0], h[1]);
        if version != defs::PROG_VERSION {
            return Err(LoadError::Version(version));
        }
        if crc == defs::NQ_PROGHEADER_CRC {
            return Err(LoadError::NetQuake);
        }
        if crc != defs::QW_PROGHEADER_CRC {
            return Err(LoadError::Crc(crc));
        }
        let n = data.len();
        let (so, sc) = lump(n, h[2], h[3], 8, "statements")?;
        let (go, gc) = lump(n, h[4], h[5], 8, "globaldefs")?;
        let (fo, fc) = lump(n, h[6], h[7], 8, "fielddefs")?;
        let (fno, fnc) = lump(n, h[8], h[9], 36, "functions")?;
        let (sto, stc) = lump(n, h[10], h[11], 1, "strings")?;
        let (glo, glc) = lump(n, h[12], h[13], 4, "globals")?;
        let entityfields = h[14];
        if entityfields < defs::fld::COUNT as i32 || entityfields as u32 > MAX_ENTITYFIELDS {
            return Err(LoadError::Layout(format!("entityfields {}", entityfields)));
        }
        let entityfields = entityfields as u32;
        if (glc as u32) < defs::glob::COUNT || glc > 65536 {
            return Err(LoadError::Layout(format!("numglobals {}", glc)));
        }

        let mut strings = data[sto..sto + stc].to_vec();
        strings.push(0);

        let statements: Vec<Statement> = (0..sc)
            .map(|i| {
                let o = so + i * 8;
                Statement { op: r.u16(o), a: r.u16(o + 2), b: r.u16(o + 4), c: r.u16(o + 6) }
            })
            .collect();

        let str_at = |s: i32| -> Vec<u8> {
            if s < 0 || s as usize >= strings.len() {
                return Vec::new();
            }
            let b = &strings[s as usize..];
            let e = b.iter().position(|&c| c == 0).unwrap_or(b.len());
            b[..e].to_vec()
        };

        let read_defs = |o: usize, c: usize| -> Vec<Def> {
            (0..c)
                .map(|i| {
                    let p = o + i * 8;
                    let t = r.u16(p);
                    Def {
                        ty: t & !ty::SAVEGLOBAL,
                        save: t & ty::SAVEGLOBAL != 0,
                        ofs: r.u16(p + 2) as u32,
                        name: String::from_utf8_lossy(&str_at(r.i32(p + 4))).into_owned(),
                    }
                })
                .collect()
        };
        let globaldefs = read_defs(go, gc);
        let fielddefs = read_defs(fo, fc);
        for d in &fielddefs {
            if d.save {
                return Err(LoadError::Layout("field def with DEF_SAVEGLOBAL".into()));
            }
        }

        let mut functions = Vec::with_capacity(fnc);
        for i in 0..fnc {
            let p = fno + i * 36;
            let mut parm_size = [0u8; 8];
            parm_size.copy_from_slice(&data[p + 28..p + 36]);
            functions.push(Function {
                first_statement: r.i32(p),
                parm_start: r.i32(p + 4) as u32,
                locals: r.i32(p + 8) as u32,
                s_name: r.i32(p + 16),
                s_file: r.i32(p + 20),
                numparms: r.i32(p + 24) as u32,
                parm_size,
            });
        }
        if functions.is_empty() {
            return Err(LoadError::Function("no functions".into()));
        }

        // Size of the globals array: numglobals, every operand + 3, every function frame.
        let mut glen: u64 = glc as u64;
        for s in &statements {
            use crate::defs::op;
            let m = match s.op {
                op::GOTO => 0,
                op::IF | op::IFNOT => s.a as u64 + 3,
                o if o <= op::BITOR => s.a.max(s.b).max(s.c) as u64 + 3,
                _ => 0, // bad opcode: a runtime error if ever reached
            };
            glen = glen.max(m);
        }
        for (i, f) in functions.iter().enumerate() {
            if f.first_statement < 0 {
                continue; // builtin
            }
            if f.first_statement as usize >= statements.len() && i != 0 {
                return Err(LoadError::Function(format!("function {} starts outside the code", i)));
            }
            if f.numparms > 8 || f.parm_size.iter().any(|&p| p > 3) {
                return Err(LoadError::Function(format!("function {} has bad parms", i)));
            }
            let parms: u64 = f.parm_size.iter().take(f.numparms as usize).map(|&p| p as u64).sum();
            let frame = f.locals as u64;
            if (f.parm_start as i32) < 0 || (f.locals as i32) < 0 || frame > 65536 || parms > 24 {
                return Err(LoadError::Function(format!("function {} has a bad frame", i)));
            }
            glen = glen.max(f.parm_start as u64 + frame.max(parms));
        }
        if glen > 65536 + 3 {
            return Err(LoadError::TooBig(format!("globals {}", glen)));
        }
        let globals_len = glen as u32;
        let mut globals = vec![0u32; globals_len as usize];
        for i in 0..glc {
            globals[i] = r.i32(glo + i * 4) as u32;
        }

        let mut field_float = vec![false; entityfields as usize];
        for d in &fielddefs {
            let w = match d.ty {
                ty::FLOAT => 1,
                ty::VECTOR => 3,
                _ => 0,
            };
            for k in 0..w {
                if let Some(x) = field_float.get_mut((d.ofs + k) as usize) {
                    *x = true;
                }
            }
        }
        let mut global_float = vec![false; globals_len as usize];
        for d in &globaldefs {
            let w = match d.ty {
                ty::FLOAT => 1,
                ty::VECTOR => 3,
                _ => 0,
            };
            for k in 0..w {
                if let Some(x) = global_float.get_mut((d.ofs + k) as usize) {
                    *x = true;
                }
            }
        }

        let fn_index = build_index(functions.iter().enumerate().map(|(i, f)| (str_at(f.s_name), i as u32)));
        let field_index = build_index(fielddefs.iter().enumerate().map(|(i, d)| (d.name.as_bytes().to_vec(), i as u32)));
        let global_index =
            build_index(globaldefs.iter().enumerate().map(|(i, d)| (d.name.as_bytes().to_vec(), i as u32)));

        let mut hs = StateHasher::new();
        hs.bytes(data);

        Ok(Progs {
            statements,
            functions,
            globaldefs,
            fielddefs,
            strings,
            globals,
            numglobals: glc as u32,
            globals_len,
            entityfields,
            crc,
            fingerprint: hs.finish(),
            fn_index,
            field_index,
            global_index,
            field_float,
            global_float,
        })
    }

    /// First function with that name (QW ED_FindFunction).
    pub fn find_function(&self, name: &str) -> Option<Func> {
        self.find_function_bytes(name.as_bytes())
    }
    pub fn find_function_bytes(&self, name: &[u8]) -> Option<Func> {
        index_find(&self.fn_index, name)
    }
    /// First field def with that name (QW ED_FindField).
    pub fn find_field(&self, name: &str) -> Option<&Def> {
        self.find_field_bytes(name.as_bytes())
    }
    pub fn find_field_bytes(&self, name: &[u8]) -> Option<&Def> {
        index_find(&self.field_index, name).map(|i| &self.fielddefs[i as usize])
    }
    /// First global def with that name (QW ED_FindGlobal).
    pub fn find_global(&self, name: &str) -> Option<&Def> {
        index_find(&self.global_index, name.as_bytes()).map(|i| &self.globaldefs[i as usize])
    }
    pub fn entityfields(&self) -> u32 {
        self.entityfields
    }
    pub fn numglobals(&self) -> u32 {
        self.numglobals
    }
    pub fn crc(&self) -> i32 {
        self.crc
    }
    /// Hash of the progs bytes (used to check serialized states belong to this progs).
    pub fn fingerprint(&self) -> u64 {
        self.fingerprint
    }
    pub fn statements(&self) -> &[Statement] {
        &self.statements
    }
    pub fn functions(&self) -> &[Function] {
        &self.functions
    }
    pub fn fielddefs(&self) -> &[Def] {
        &self.fielddefs
    }
    pub fn globaldefs(&self) -> &[Def] {
        &self.globaldefs
    }
    /// A progs string-table string (offset >= 0); "" when out of range.
    pub fn string_at(&self, ofs: i32) -> &[u8] {
        if ofs < 0 || ofs as usize >= self.strings.len() {
            return b"";
        }
        let b = &self.strings[ofs as usize..];
        let e = b.iter().position(|&c| c == 0).unwrap_or(b.len());
        &b[..e]
    }
    /// Name of function `f` ("" if out of range).
    pub fn function_name(&self, f: Func) -> &[u8] {
        match self.functions.get(f as usize) {
            Some(func) => self.string_at(func.s_name),
            None => b"",
        }
    }
    pub(crate) fn function_file(&self, f: Func) -> &[u8] {
        match self.functions.get(f as usize) {
            Some(func) => self.string_at(func.s_file),
            None => b"",
        }
    }
    /// Field def at a word offset (QW ED_FieldAtOfs).
    pub fn field_at_ofs(&self, ofs: u32) -> Option<&Def> {
        self.fielddefs.iter().find(|d| d.ofs == ofs)
    }
    /// Global def at a word offset (QW ED_GlobalAtOfs).
    pub fn global_at_ofs(&self, ofs: u32) -> Option<&Def> {
        self.globaldefs.iter().find(|d| d.ofs == ofs)
    }
}
