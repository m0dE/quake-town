// Quake Town - qcvm: errors
// Copyright (C) 2026 Quake Town contributors
// SPDX-License-Identifier: GPL-2.0-or-later

use std::fmt;

/// Kind of a VM error. Every VM error is fatal for the world (QW SV_Error).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind {
    NullFunction,
    BadFunction,
    BadOpcode,
    StackOverflow,
    LocalStackOverflow,
    Runaway,
    BadEntity,
    BadField,
    BadPointer,
    WorldAssignment,
    BadStatement,
    QcError,
    ObjError,
    Break,
    StringLimit,
    UnknownBuiltin,
    Host,
    Stopped,
    BadState,
    Parse,
}

impl ErrorKind {
    pub(crate) fn code(self) -> u32 {
        self as u32
    }
    pub(crate) fn from_code(c: u32) -> ErrorKind {
        use ErrorKind::*;
        const ALL: [ErrorKind; 20] = [
            NullFunction,
            BadFunction,
            BadOpcode,
            StackOverflow,
            LocalStackOverflow,
            Runaway,
            BadEntity,
            BadField,
            BadPointer,
            WorldAssignment,
            BadStatement,
            QcError,
            ObjError,
            Break,
            StringLimit,
            UnknownBuiltin,
            Host,
            Stopped,
            BadState,
            Parse,
        ];
        ALL.get(c as usize).copied().unwrap_or(BadState)
    }
}

/// A VM error: kind, message and the QC stack trace at the time of the error.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VmError {
    pub kind: ErrorKind,
    pub message: String,
    pub trace: String,
}

impl VmError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> VmError {
        VmError { kind, message: message.into(), trace: String::new() }
    }
    /// An error raised by the engine from inside a builtin.
    pub fn host(message: impl Into<String>) -> VmError {
        VmError::new(ErrorKind::Host, message)
    }
    /// The error for a builtin number nobody implements.
    pub fn unknown_builtin(num: u32) -> VmError {
        VmError::new(ErrorKind::UnknownBuiltin, format!("unknown builtin #{}", num))
    }
}

impl fmt::Display for VmError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)?;
        if !self.trace.is_empty() {
            write!(f, "\n{}", self.trace)?;
        }
        Ok(())
    }
}

impl std::error::Error for VmError {}
