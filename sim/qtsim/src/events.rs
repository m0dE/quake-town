/*
Copyright (C) 1996-1997 Id Software, Inc.
Copyright (C) 2026 Quake Town authors.

This program is free software; you can redistribute it and/or
modify it under the terms of the GNU General Public License
as published by the Free Software Foundation; either version 2
of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

See the GNU General Public License for more details.
*/
//! Events (DESIGN.md "Event") and the svc message parser that turns QC's
//! WriteByte..WriteEntity streams into events. The message formats are QW's
//! (protocol.h, cl_parse.c, cl_tent.c). QC writes are kept as typed values (no
//! coordinate quantisation), parsed per message as soon as a message is complete.

pub const EV_SOUND: u32 = 1;
pub const EV_TEMPENT: u32 = 2;
pub const EV_PRINT: u32 = 3;
pub const EV_CENTERPRINT: u32 = 4;
pub const EV_MUZZLEFLASH: u32 = 5;
pub const EV_DAMAGE: u32 = 6;
pub const EV_KICK: u32 = 7;
pub const EV_STUFFTEXT: u32 = 8;
pub const EV_LIGHTSTYLE: u32 = 9;
pub const EV_INTERMISSION: u32 = 10;
pub const EV_OBITUARY: u32 = 11;
pub const EV_MATCHSTATE: u32 = 12;
pub const EV_CHANGELEVEL: u32 = 13;
pub const EV_PICKUP: u32 = 14;

// svc_* (protocol.h)
pub const SVC_PRINT: u8 = 8;
pub const SVC_STUFFTEXT: u8 = 9;
pub const SVC_SETANGLE: u8 = 10;
pub const SVC_LIGHTSTYLE: u8 = 12;
pub const SVC_UPDATEFRAGS: u8 = 14;
pub const SVC_DAMAGE: u8 = 19;
pub const SVC_TEMP_ENTITY: u8 = 23;
pub const SVC_CENTERPRINT: u8 = 26;
pub const SVC_KILLEDMONSTER: u8 = 27;
pub const SVC_FOUNDSECRET: u8 = 28;
pub const SVC_SPAWNSTATICSOUND: u8 = 29;
pub const SVC_INTERMISSION: u8 = 30;
pub const SVC_FINALE: u8 = 31;
pub const SVC_CDTRACK: u8 = 32;
pub const SVC_SELLSCREEN: u8 = 33;
pub const SVC_SMALLKICK: u8 = 34;
pub const SVC_BIGKICK: u8 = 35;
pub const SVC_UPDATESTAT: u8 = 3;
pub const SVC_SETVIEW: u8 = 5;
pub const SVC_UPDATESTATLONG: u8 = 38;
pub const SVC_MUZZLEFLASH: u8 = 39;
pub const SVC_NOP: u8 = 1;

pub const TE_SPIKE: i32 = 0;
pub const TE_SUPERSPIKE: i32 = 1;
pub const TE_GUNSHOT: i32 = 2;
pub const TE_EXPLOSION: i32 = 3;
pub const TE_TAREXPLOSION: i32 = 4;
pub const TE_LIGHTNING1: i32 = 5;
pub const TE_LIGHTNING2: i32 = 6;
pub const TE_WIZSPIKE: i32 = 7;
pub const TE_KNIGHTSPIKE: i32 = 8;
pub const TE_LIGHTNING3: i32 = 9;
pub const TE_LAVASPLASH: i32 = 10;
pub const TE_TELEPORT: i32 = 11;
pub const TE_BLOOD: i32 = 12;
pub const TE_LIGHTNINGBLOOD: i32 = 13;

/// One event: `kind, a, b, c, d, x f32, y f32, z f32, e, f` (10 words).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Event {
    pub w: [u32; 10],
}

impl Event {
    pub fn new(kind: u32) -> Event {
        let mut e = Event::default();
        e.w[0] = kind;
        e
    }
    #[inline]
    pub fn kind(&self) -> u32 {
        self.w[0]
    }
    pub fn a(mut self, v: i32) -> Self {
        self.w[1] = v as u32;
        self
    }
    pub fn b(mut self, v: i32) -> Self {
        self.w[2] = v as u32;
        self
    }
    pub fn c(mut self, v: i32) -> Self {
        self.w[3] = v as u32;
        self
    }
    pub fn d(mut self, v: i32) -> Self {
        self.w[4] = v as u32;
        self
    }
    pub fn xyz(mut self, p: [f32; 3]) -> Self {
        self.w[5] = crate::mathlib::canon(p[0]);
        self.w[6] = crate::mathlib::canon(p[1]);
        self.w[7] = crate::mathlib::canon(p[2]);
        self
    }
    pub fn e(mut self, v: u32) -> Self {
        self.w[8] = v;
        self
    }
    pub fn f(mut self, v: u32) -> Self {
        self.w[9] = v;
        self
    }
}

/// A QC Write* value.
#[derive(Clone, Debug, PartialEq)]
pub enum Tok {
    Num(f32),
    Str(Vec<u8>),
}

/// The events of one tick plus the strings they reference.
#[derive(Clone, Default)]
pub struct EventSink {
    pub events: Vec<Event>,
    pub strings: Vec<Vec<u8>>,
}

impl EventSink {
    pub fn clear(&mut self) {
        self.events.clear();
        self.strings.clear();
    }
    pub fn string(&mut self, s: &[u8]) -> i32 {
        self.strings.push(s.to_vec());
        (self.strings.len() - 1) as i32
    }
    pub fn push(&mut self, e: Event) {
        self.events.push(e);
    }

    /// append another sink's events, remapping their string indices
    pub fn append(&mut self, other: EventSink) {
        let base = self.strings.len() as u32;
        for mut e in other.events {
            match e.kind() {
                EV_PRINT => e.w[3] += base,
                EV_CENTERPRINT | EV_STUFFTEXT | EV_LIGHTSTYLE => e.w[2] += base,
                _ => {}
            }
            self.events.push(e);
        }
        self.strings.extend(other.strings);
    }
}

/// Result of trying to parse one message from the front of a token buffer.
pub enum Parsed {
    /// need more tokens
    Incomplete,
    /// consumed n tokens
    Done(usize),
    /// unknown svc: drop the buffer
    Unknown,
}

/// `to`: -1 = everyone, else a client slot. Returns how many tokens one message used.
pub fn parse_message(toks: &[Tok], to: i32, sink: &mut EventSink) -> Parsed {
    let num = |i: usize| -> Option<f32> {
        match toks.get(i) {
            Some(Tok::Num(x)) => Some(*x),
            Some(Tok::Str(_)) => Some(0.0),
            None => None,
        }
    };
    let string = |i: usize| -> Option<Vec<u8>> {
        match toks.get(i) {
            Some(Tok::Str(s)) => Some(s.clone()),
            Some(Tok::Num(_)) => Some(Vec::new()),
            None => None,
        }
    };
    let svc = match num(0) {
        Some(x) => x as i32 as u8,
        None => return Parsed::Incomplete,
    };
    macro_rules! need {
        ($n:expr) => {
            if toks.len() < $n {
                return Parsed::Incomplete;
            }
        };
    }
    match svc {
        SVC_NOP | SVC_KILLEDMONSTER | SVC_FOUNDSECRET | SVC_SELLSCREEN => Parsed::Done(1),
        SVC_CDTRACK => {
            need!(2);
            Parsed::Done(2)
        }
        SVC_UPDATESTAT | SVC_UPDATESTATLONG => {
            need!(3);
            Parsed::Done(3)
        }
        SVC_SETVIEW => {
            need!(2);
            Parsed::Done(2)
        }
        SVC_MUZZLEFLASH => {
            need!(2);
            sink.push(Event::new(EV_MUZZLEFLASH).a(num(1).unwrap() as i32));
            Parsed::Done(2)
        }
        SVC_SETANGLE => {
            need!(4);
            Parsed::Done(4)
        }
        SVC_UPDATEFRAGS => {
            need!(3);
            Parsed::Done(3)
        }
        SVC_PRINT => {
            need!(3);
            let level = num(1).unwrap() as i32;
            let s = string(2).unwrap();
            let si = sink.string(&s);
            sink.push(Event::new(EV_PRINT).a(to).b(level).c(si));
            Parsed::Done(3)
        }
        SVC_STUFFTEXT => {
            need!(2);
            let s = string(1).unwrap();
            let si = sink.string(&s);
            sink.push(Event::new(EV_STUFFTEXT).a(to).b(si));
            Parsed::Done(2)
        }
        SVC_CENTERPRINT => {
            need!(2);
            let s = string(1).unwrap();
            let si = sink.string(&s);
            sink.push(Event::new(EV_CENTERPRINT).a(to).b(si));
            Parsed::Done(2)
        }
        SVC_FINALE => {
            need!(2);
            Parsed::Done(2)
        }
        SVC_LIGHTSTYLE => {
            need!(3);
            Parsed::Done(3)
        }
        SVC_SMALLKICK | SVC_BIGKICK => {
            sink.push(Event::new(EV_KICK).a(to).b((svc == SVC_BIGKICK) as i32));
            Parsed::Done(1)
        }
        SVC_INTERMISSION => {
            need!(7);
            let o = [num(1).unwrap(), num(2).unwrap(), num(3).unwrap()];
            // angles (4..6) are carried by the info_intermission entity; the client
            // reads them from the fixangle of its view
            sink.push(Event::new(EV_INTERMISSION).a(to).xyz(o).e(num(4).unwrap().to_bits()).f(num(5).unwrap().to_bits()));
            Parsed::Done(7)
        }
        SVC_SPAWNSTATICSOUND => {
            need!(7);
            Parsed::Done(7)
        }
        SVC_DAMAGE => {
            need!(6);
            Parsed::Done(6)
        }
        SVC_TEMP_ENTITY => {
            need!(2);
            let te = num(1).unwrap() as i32;
            match te {
                TE_GUNSHOT | TE_BLOOD => {
                    need!(6);
                    let p = [num(3).unwrap(), num(4).unwrap(), num(5).unwrap()];
                    sink.push(Event::new(EV_TEMPENT).a(te).b(num(2).unwrap() as i32).xyz(p));
                    Parsed::Done(6)
                }
                TE_LIGHTNING1 | TE_LIGHTNING2 | TE_LIGHTNING3 => {
                    need!(9);
                    let ent = num(2).unwrap() as i32;
                    let s = [num(3).unwrap(), num(4).unwrap(), num(5).unwrap()];
                    let e = [num(6).unwrap(), num(7).unwrap(), num(8).unwrap()];
                    sink.push(
                        Event::new(EV_TEMPENT)
                            .a(te)
                            .b(1)
                            .c(ent)
                            .d(crate::mathlib::canon(e[2]) as i32)
                            .xyz(s)
                            .e(crate::mathlib::canon(e[0]))
                            .f(crate::mathlib::canon(e[1])),
                    );
                    Parsed::Done(9)
                }
                TE_SPIKE | TE_SUPERSPIKE | TE_EXPLOSION | TE_TAREXPLOSION | TE_WIZSPIKE | TE_KNIGHTSPIKE | TE_LAVASPLASH
                | TE_TELEPORT | TE_LIGHTNINGBLOOD => {
                    need!(5);
                    let p = [num(2).unwrap(), num(3).unwrap(), num(4).unwrap()];
                    sink.push(Event::new(EV_TEMPENT).a(te).b(1).xyz(p));
                    Parsed::Done(5)
                }
                _ => Parsed::Unknown,
            }
        }
        _ => Parsed::Unknown,
    }
}

/// A QC message destination buffer (MSG_ALL / MSG_BROADCAST / MSG_ONE / MSG_MULTICAST).
/// After an unknown svc byte the rest of the tick's writes cannot be framed and are
/// dropped (`bad`).
#[derive(Clone, Default)]
pub struct MsgBuf {
    pub toks: Vec<Tok>,
    pub bad: bool,
}

impl MsgBuf {
    pub fn write(&mut self, t: Tok) {
        if !self.bad {
            self.toks.push(t);
        }
    }

    /// Parses every complete message at the front and removes it. With `flush`
    /// (multicast / end of tick) an incomplete tail is dropped and the buffer reset.
    pub fn drain(&mut self, to: i32, sink: &mut EventSink, flush: bool) {
        let mut at = 0;
        while at < self.toks.len() && !self.bad {
            match parse_message(&self.toks[at..], to, sink) {
                Parsed::Done(n) => at += n,
                Parsed::Incomplete => break,
                Parsed::Unknown => self.bad = true,
            }
        }
        if self.bad || flush {
            self.toks.clear();
        } else {
            self.toks.drain(..at);
        }
        if flush {
            self.bad = false;
        }
    }
}
