// Quake Town - qcvm: deterministic QuakeC VM for QuakeWorld progs
// Copyright (C) 1996-1997 Id Software, Inc.
// Copyright (C) 2026 Quake Town contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// This program is free software; you can redistribute it and/or modify it under the terms
// of the GNU General Public License as published by the Free Software Foundation; either
// version 2 of the License, or (at your option) any later version.

//! Deterministic QuakeC VM for QW progs (version 6, progdefs CRC 54730).
//! Port of QW/server pr_exec.c, pr_edict.c and the pure builtins of pr_cmds.c.
//! See `API.md` and DESIGN.md "Simulation architecture".

pub mod defs;
mod error;
mod exec;
pub mod hash;
pub mod math;
mod parse;
mod progs;
mod pure;
mod rng;
mod serial;
mod strings;
mod vm;

pub use error::{ErrorKind, VmError};
pub use hash::StateHasher;
pub use parse::{atof, atoi, com_parse, fmt_5_1, fmt_f, ftos, vtos};
pub use pure::{MAX_TOKENS, PURE_BUILTINS};
pub use progs::{Def, Function, LoadError, Progs, Statement};
pub use rng::Pcg32;
pub use vm::{Alloc, LoadStats, Vm, VmConfig, DEFAULT_BUDGET};

/// Edict number (0 = world).
pub type Ent = u32;
/// `string_t` handle.
pub type Str = i32;
/// `func_t`: index into the function table.
pub type Func = u32;

/// What kind of text `Host::print` receives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Print {
    /// `dprint`
    Dprint,
    /// `eprint` / `coredump` edict dumps
    Eprint,
    /// text of an `error` / `objerror` / runtime error (also in the returned `VmError`)
    Error,
}

/// The engine side of the VM: builtins that need the world.
pub trait Host {
    /// Engine builtin `num` (every number the VM does not implement itself).
    fn builtin(&mut self, vm: &mut Vm, num: u32) -> Result<(), VmError>;
    /// dprint / eprint / error text. Default: ignored.
    fn print(&mut self, _vm: &Vm, _kind: Print, _text: &[u8]) {}
    /// Called by `Vm::load_entities` when `alloc_edict` stepped on a live edict.
    fn unlink(&mut self, _vm: &mut Vm, _e: Ent) {}
}

/// Canonical quiet NaN used everywhere a NaN is stored, hashed or serialized.
pub const CANON_NAN_BITS: u32 = 0x7FC0_0000;

/// NaN canonicalisation (DESIGN.md determinism rules).
#[inline(always)]
pub fn canon(x: f32) -> f32 {
    if x.is_nan() {
        f32::from_bits(CANON_NAN_BITS)
    } else {
        x
    }
}
