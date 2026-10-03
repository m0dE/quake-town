// Quake Town - qcvm: QuakeWorld progdefs (generated from QW/server/progdefs.h)
// Copyright (C) 1996-1997 Id Software, Inc.
// Copyright (C) 2026 Quake Town contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// This program is free software; you can redistribute it and/or modify it under the terms
// of the GNU General Public License as published by the Free Software Foundation; either
// version 2 of the License, or (at your option) any later version.

//! Fixed layout of the QW system globals and entity fields. A progs with CRC 54730 has
//! exactly this layout (checked at load), so the engine can use these constants directly.

/// `PROGHEADER_CRC` of QW progdefs.h.
pub const QW_PROGHEADER_CRC: i32 = 54730;
/// NetQuake progdefs CRC (refused).
pub const NQ_PROGHEADER_CRC: i32 = 5927;
/// `PROG_VERSION`.
pub const PROG_VERSION: i32 = 6;

pub const OFS_NULL: u32 = 0;
pub const OFS_RETURN: u32 = 1;
/// Parameter `i` lives at `OFS_PARM0 + 3*i` (8 parameters, 3 words each).
pub const OFS_PARM0: u32 = 4;
pub const RESERVED_OFS: u32 = 28;
pub const MAX_PARMS: usize = 8;

/// `etype_t`.
pub mod ty {
    pub const VOID: u16 = 0;
    pub const STRING: u16 = 1;
    pub const FLOAT: u16 = 2;
    pub const VECTOR: u16 = 3;
    pub const ENTITY: u16 = 4;
    pub const FIELD: u16 = 5;
    pub const FUNCTION: u16 = 6;
    pub const POINTER: u16 = 7;
    /// `DEF_SAVEGLOBAL` flag bit on global defs.
    pub const SAVEGLOBAL: u16 = 1 << 15;
}

/// Word offsets of QW `globalvars_t` (progdefs.h, CRC 54730). `int` here means entity.
pub mod glob {
    /// `int self` (E)
    pub const SELF: u32 = 28;
    /// `int other` (E)
    pub const OTHER: u32 = 29;
    /// `int world` (E)
    pub const WORLD: u32 = 30;
    /// `float time` (F)
    pub const TIME: u32 = 31;
    /// `float frametime` (F)
    pub const FRAMETIME: u32 = 32;
    /// `int newmis` (E)
    pub const NEWMIS: u32 = 33;
    /// `float force_retouch` (F)
    pub const FORCE_RETOUCH: u32 = 34;
    /// `string_t mapname` (S)
    pub const MAPNAME: u32 = 35;
    /// `float serverflags` (F)
    pub const SERVERFLAGS: u32 = 36;
    /// `float total_secrets` (F)
    pub const TOTAL_SECRETS: u32 = 37;
    /// `float total_monsters` (F)
    pub const TOTAL_MONSTERS: u32 = 38;
    /// `float found_secrets` (F)
    pub const FOUND_SECRETS: u32 = 39;
    /// `float killed_monsters` (F)
    pub const KILLED_MONSTERS: u32 = 40;
    /// `float parm1` (F)
    pub const PARM1: u32 = 41;
    /// `float parm2` (F)
    pub const PARM2: u32 = 42;
    /// `float parm3` (F)
    pub const PARM3: u32 = 43;
    /// `float parm4` (F)
    pub const PARM4: u32 = 44;
    /// `float parm5` (F)
    pub const PARM5: u32 = 45;
    /// `float parm6` (F)
    pub const PARM6: u32 = 46;
    /// `float parm7` (F)
    pub const PARM7: u32 = 47;
    /// `float parm8` (F)
    pub const PARM8: u32 = 48;
    /// `float parm9` (F)
    pub const PARM9: u32 = 49;
    /// `float parm10` (F)
    pub const PARM10: u32 = 50;
    /// `float parm11` (F)
    pub const PARM11: u32 = 51;
    /// `float parm12` (F)
    pub const PARM12: u32 = 52;
    /// `float parm13` (F)
    pub const PARM13: u32 = 53;
    /// `float parm14` (F)
    pub const PARM14: u32 = 54;
    /// `float parm15` (F)
    pub const PARM15: u32 = 55;
    /// `float parm16` (F)
    pub const PARM16: u32 = 56;
    /// `vec3_t v_forward` (V)
    pub const V_FORWARD: u32 = 57;
    /// `vec3_t v_up` (V)
    pub const V_UP: u32 = 60;
    /// `vec3_t v_right` (V)
    pub const V_RIGHT: u32 = 63;
    /// `float trace_allsolid` (F)
    pub const TRACE_ALLSOLID: u32 = 66;
    /// `float trace_startsolid` (F)
    pub const TRACE_STARTSOLID: u32 = 67;
    /// `float trace_fraction` (F)
    pub const TRACE_FRACTION: u32 = 68;
    /// `vec3_t trace_endpos` (V)
    pub const TRACE_ENDPOS: u32 = 69;
    /// `vec3_t trace_plane_normal` (V)
    pub const TRACE_PLANE_NORMAL: u32 = 72;
    /// `float trace_plane_dist` (F)
    pub const TRACE_PLANE_DIST: u32 = 75;
    /// `int trace_ent` (E)
    pub const TRACE_ENT: u32 = 76;
    /// `float trace_inopen` (F)
    pub const TRACE_INOPEN: u32 = 77;
    /// `float trace_inwater` (F)
    pub const TRACE_INWATER: u32 = 78;
    /// `int msg_entity` (E)
    pub const MSG_ENTITY: u32 = 79;
    /// `func_t main` (FN)
    pub const MAIN: u32 = 80;
    /// `func_t StartFrame` (FN)
    pub const STARTFRAME: u32 = 81;
    /// `func_t PlayerPreThink` (FN)
    pub const PLAYERPRETHINK: u32 = 82;
    /// `func_t PlayerPostThink` (FN)
    pub const PLAYERPOSTTHINK: u32 = 83;
    /// `func_t ClientKill` (FN)
    pub const CLIENTKILL: u32 = 84;
    /// `func_t ClientConnect` (FN)
    pub const CLIENTCONNECT: u32 = 85;
    /// `func_t PutClientInServer` (FN)
    pub const PUTCLIENTINSERVER: u32 = 86;
    /// `func_t ClientDisconnect` (FN)
    pub const CLIENTDISCONNECT: u32 = 87;
    /// `func_t SetNewParms` (FN)
    pub const SETNEWPARMS: u32 = 88;
    /// `func_t SetChangeParms` (FN)
    pub const SETCHANGEPARMS: u32 = 89;
    /// Size in words of the fixed part.
    pub const COUNT: u32 = 90;
}

/// Word offsets of QW `entvars_t` (progdefs.h, CRC 54730). `int` here means entity.
pub mod fld {
    /// `float modelindex` (F)
    pub const MODELINDEX: u32 = 0;
    /// `vec3_t absmin` (V)
    pub const ABSMIN: u32 = 1;
    /// `vec3_t absmax` (V)
    pub const ABSMAX: u32 = 4;
    /// `float ltime` (F)
    pub const LTIME: u32 = 7;
    /// `float lastruntime` (F)
    pub const LASTRUNTIME: u32 = 8;
    /// `float movetype` (F)
    pub const MOVETYPE: u32 = 9;
    /// `float solid` (F)
    pub const SOLID: u32 = 10;
    /// `vec3_t origin` (V)
    pub const ORIGIN: u32 = 11;
    /// `vec3_t oldorigin` (V)
    pub const OLDORIGIN: u32 = 14;
    /// `vec3_t velocity` (V)
    pub const VELOCITY: u32 = 17;
    /// `vec3_t angles` (V)
    pub const ANGLES: u32 = 20;
    /// `vec3_t avelocity` (V)
    pub const AVELOCITY: u32 = 23;
    /// `string_t classname` (S)
    pub const CLASSNAME: u32 = 26;
    /// `string_t model` (S)
    pub const MODEL: u32 = 27;
    /// `float frame` (F)
    pub const FRAME: u32 = 28;
    /// `float skin` (F)
    pub const SKIN: u32 = 29;
    /// `float effects` (F)
    pub const EFFECTS: u32 = 30;
    /// `vec3_t mins` (V)
    pub const MINS: u32 = 31;
    /// `vec3_t maxs` (V)
    pub const MAXS: u32 = 34;
    /// `vec3_t size` (V)
    pub const SIZE: u32 = 37;
    /// `func_t touch` (FN)
    pub const TOUCH: u32 = 40;
    /// `func_t use` (FN)
    pub const USE: u32 = 41;
    /// `func_t think` (FN)
    pub const THINK: u32 = 42;
    /// `func_t blocked` (FN)
    pub const BLOCKED: u32 = 43;
    /// `float nextthink` (F)
    pub const NEXTTHINK: u32 = 44;
    /// `int groundentity` (E)
    pub const GROUNDENTITY: u32 = 45;
    /// `float health` (F)
    pub const HEALTH: u32 = 46;
    /// `float frags` (F)
    pub const FRAGS: u32 = 47;
    /// `float weapon` (F)
    pub const WEAPON: u32 = 48;
    /// `string_t weaponmodel` (S)
    pub const WEAPONMODEL: u32 = 49;
    /// `float weaponframe` (F)
    pub const WEAPONFRAME: u32 = 50;
    /// `float currentammo` (F)
    pub const CURRENTAMMO: u32 = 51;
    /// `float ammo_shells` (F)
    pub const AMMO_SHELLS: u32 = 52;
    /// `float ammo_nails` (F)
    pub const AMMO_NAILS: u32 = 53;
    /// `float ammo_rockets` (F)
    pub const AMMO_ROCKETS: u32 = 54;
    /// `float ammo_cells` (F)
    pub const AMMO_CELLS: u32 = 55;
    /// `float items` (F)
    pub const ITEMS: u32 = 56;
    /// `float takedamage` (F)
    pub const TAKEDAMAGE: u32 = 57;
    /// `int chain` (E)
    pub const CHAIN: u32 = 58;
    /// `float deadflag` (F)
    pub const DEADFLAG: u32 = 59;
    /// `vec3_t view_ofs` (V)
    pub const VIEW_OFS: u32 = 60;
    /// `float button0` (F)
    pub const BUTTON0: u32 = 63;
    /// `float button1` (F)
    pub const BUTTON1: u32 = 64;
    /// `float button2` (F)
    pub const BUTTON2: u32 = 65;
    /// `float impulse` (F)
    pub const IMPULSE: u32 = 66;
    /// `float fixangle` (F)
    pub const FIXANGLE: u32 = 67;
    /// `vec3_t v_angle` (V)
    pub const V_ANGLE: u32 = 68;
    /// `string_t netname` (S)
    pub const NETNAME: u32 = 71;
    /// `int enemy` (E)
    pub const ENEMY: u32 = 72;
    /// `float flags` (F)
    pub const FLAGS: u32 = 73;
    /// `float colormap` (F)
    pub const COLORMAP: u32 = 74;
    /// `float team` (F)
    pub const TEAM: u32 = 75;
    /// `float max_health` (F)
    pub const MAX_HEALTH: u32 = 76;
    /// `float teleport_time` (F)
    pub const TELEPORT_TIME: u32 = 77;
    /// `float armortype` (F)
    pub const ARMORTYPE: u32 = 78;
    /// `float armorvalue` (F)
    pub const ARMORVALUE: u32 = 79;
    /// `float waterlevel` (F)
    pub const WATERLEVEL: u32 = 80;
    /// `float watertype` (F)
    pub const WATERTYPE: u32 = 81;
    /// `float ideal_yaw` (F)
    pub const IDEAL_YAW: u32 = 82;
    /// `float yaw_speed` (F)
    pub const YAW_SPEED: u32 = 83;
    /// `int aiment` (E)
    pub const AIMENT: u32 = 84;
    /// `int goalentity` (E)
    pub const GOALENTITY: u32 = 85;
    /// `float spawnflags` (F)
    pub const SPAWNFLAGS: u32 = 86;
    /// `string_t target` (S)
    pub const TARGET: u32 = 87;
    /// `string_t targetname` (S)
    pub const TARGETNAME: u32 = 88;
    /// `float dmg_take` (F)
    pub const DMG_TAKE: u32 = 89;
    /// `float dmg_save` (F)
    pub const DMG_SAVE: u32 = 90;
    /// `int dmg_inflictor` (E)
    pub const DMG_INFLICTOR: u32 = 91;
    /// `int owner` (E)
    pub const OWNER: u32 = 92;
    /// `vec3_t movedir` (V)
    pub const MOVEDIR: u32 = 93;
    /// `string_t message` (S)
    pub const MESSAGE: u32 = 96;
    /// `float sounds` (F)
    pub const SOUNDS: u32 = 97;
    /// `string_t noise` (S)
    pub const NOISE: u32 = 98;
    /// `string_t noise1` (S)
    pub const NOISE1: u32 = 99;
    /// `string_t noise2` (S)
    pub const NOISE2: u32 = 100;
    /// `string_t noise3` (S)
    pub const NOISE3: u32 = 101;
    /// Size in words of the fixed part.
    pub const COUNT: u32 = 102;
}

/// Opcodes of the vanilla v6 instruction set (pr_comp.h).
pub mod op {
    pub const DONE: u16 = 0;
    pub const MUL_F: u16 = 1;
    pub const MUL_V: u16 = 2;
    pub const MUL_FV: u16 = 3;
    pub const MUL_VF: u16 = 4;
    pub const DIV_F: u16 = 5;
    pub const ADD_F: u16 = 6;
    pub const ADD_V: u16 = 7;
    pub const SUB_F: u16 = 8;
    pub const SUB_V: u16 = 9;
    pub const EQ_F: u16 = 10;
    pub const EQ_V: u16 = 11;
    pub const EQ_S: u16 = 12;
    pub const EQ_E: u16 = 13;
    pub const EQ_FNC: u16 = 14;
    pub const NE_F: u16 = 15;
    pub const NE_V: u16 = 16;
    pub const NE_S: u16 = 17;
    pub const NE_E: u16 = 18;
    pub const NE_FNC: u16 = 19;
    pub const LE: u16 = 20;
    pub const GE: u16 = 21;
    pub const LT: u16 = 22;
    pub const GT: u16 = 23;
    pub const LOAD_F: u16 = 24;
    pub const LOAD_V: u16 = 25;
    pub const LOAD_S: u16 = 26;
    pub const LOAD_ENT: u16 = 27;
    pub const LOAD_FLD: u16 = 28;
    pub const LOAD_FNC: u16 = 29;
    pub const ADDRESS: u16 = 30;
    pub const STORE_F: u16 = 31;
    pub const STORE_V: u16 = 32;
    pub const STORE_S: u16 = 33;
    pub const STORE_ENT: u16 = 34;
    pub const STORE_FLD: u16 = 35;
    pub const STORE_FNC: u16 = 36;
    pub const STOREP_F: u16 = 37;
    pub const STOREP_V: u16 = 38;
    pub const STOREP_S: u16 = 39;
    pub const STOREP_ENT: u16 = 40;
    pub const STOREP_FLD: u16 = 41;
    pub const STOREP_FNC: u16 = 42;
    pub const RETURN: u16 = 43;
    pub const NOT_F: u16 = 44;
    pub const NOT_V: u16 = 45;
    pub const NOT_S: u16 = 46;
    pub const NOT_ENT: u16 = 47;
    pub const NOT_FNC: u16 = 48;
    pub const IF: u16 = 49;
    pub const IFNOT: u16 = 50;
    pub const CALL0: u16 = 51;
    pub const CALL1: u16 = 52;
    pub const CALL2: u16 = 53;
    pub const CALL3: u16 = 54;
    pub const CALL4: u16 = 55;
    pub const CALL5: u16 = 56;
    pub const CALL6: u16 = 57;
    pub const CALL7: u16 = 58;
    pub const CALL8: u16 = 59;
    pub const STATE: u16 = 60;
    pub const GOTO: u16 = 61;
    pub const AND: u16 = 62;
    pub const OR: u16 = 63;
    pub const BITAND: u16 = 64;
    pub const BITOR: u16 = 65;

    pub const NAMES: [&str; 66] = [
        "DONE", "MUL_F", "MUL_V", "MUL_FV", "MUL_VF", "DIV", "ADD_F", "ADD_V", "SUB_F", "SUB_V", "EQ_F", "EQ_V",
        "EQ_S", "EQ_E", "EQ_FNC", "NE_F", "NE_V", "NE_S", "NE_E", "NE_FNC", "LE", "GE", "LT", "GT", "INDIRECT",
        "INDIRECT", "INDIRECT", "INDIRECT", "INDIRECT", "INDIRECT", "ADDRESS", "STORE_F", "STORE_V", "STORE_S",
        "STORE_ENT", "STORE_FLD", "STORE_FNC", "STOREP_F", "STOREP_V", "STOREP_S", "STOREP_ENT", "STOREP_FLD",
        "STOREP_FNC", "RETURN", "NOT_F", "NOT_V", "NOT_S", "NOT_ENT", "NOT_FNC", "IF", "IFNOT", "CALL0", "CALL1",
        "CALL2", "CALL3", "CALL4", "CALL5", "CALL6", "CALL7", "CALL8", "STATE", "GOTO", "AND", "OR", "BITAND",
        "BITOR",
    ];
}
