// Quake Town - qcvm: text helpers (COM_Parse from QW/client/common.c, atof, printf %5.1f)
// Copyright (C) 1996-1997 Id Software, Inc.
// Copyright (C) 2026 Quake Town contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// This program is free software; you can redistribute it and/or modify it under the terms
// of the GNU General Public License as published by the Free Software Foundation; either
// version 2 of the License, or (at your option) any later version.

/// Longest token kept (QW's com_token is 1024 bytes and unchecked; we truncate).
pub const MAX_TOKEN: usize = 1023;

/// QW `COM_Parse`: returns (token, rest) or None at end of data. Quoted strings keep
/// everything up to the closing quote; `//` comments are skipped.
pub fn com_parse(data: &[u8]) -> Option<(Vec<u8>, &[u8])> {
    let mut d = data;
    loop {
        // skip whitespace (c <= ' '; a NUL ends the data)
        loop {
            match d.first() {
                None | Some(0) => return None,
                // `char` is signed in id's build: bytes >= 128 count as whitespace
                Some(&c) if (c as i8) <= b' ' as i8 => d = &d[1..],
                _ => break,
            }
        }
        if d.len() >= 2 && d[0] == b'/' && d[1] == b'/' {
            while let Some(&c) = d.first() {
                if c == 0 || c == b'\n' {
                    break;
                }
                d = &d[1..];
            }
            continue;
        }
        break;
    }
    let mut tok = Vec::new();
    if d[0] == b'"' {
        d = &d[1..];
        loop {
            match d.first() {
                None => return Some((tok, d)),
                Some(&c) => {
                    d = &d[1..];
                    if c == b'"' || c == 0 {
                        return Some((tok, d));
                    }
                    if tok.len() < MAX_TOKEN {
                        tok.push(c);
                    }
                }
            }
        }
    }
    loop {
        let c = d[0];
        if tok.len() < MAX_TOKEN {
            tok.push(c);
        }
        d = &d[1..];
        match d.first() {
            Some(&c) if (c as i8) > 32 => {}
            _ => break,
        }
    }
    Some((tok, d))
}

fn is_space(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r')
}

/// C `atof` for decimal numbers (leading space, sign, digits, '.', exponent), parsed
/// exactly (correctly rounded to f64). Hex floats, inf and nan read as 0.
pub fn atof(s: &[u8]) -> f64 {
    let mut i = 0;
    while i < s.len() && is_space(s[i]) {
        i += 1;
    }
    let start = i;
    if i < s.len() && (s[i] == b'+' || s[i] == b'-') {
        i += 1;
    }
    let mut digits = 0;
    while i < s.len() && s[i].is_ascii_digit() {
        i += 1;
        digits += 1;
    }
    if i < s.len() && s[i] == b'.' {
        i += 1;
        while i < s.len() && s[i].is_ascii_digit() {
            i += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return 0.0;
    }
    let mant_end = i;
    if i < s.len() && (s[i] == b'e' || s[i] == b'E') {
        let mut j = i + 1;
        if j < s.len() && (s[j] == b'+' || s[j] == b'-') {
            j += 1;
        }
        let ds = j;
        while j < s.len() && s[j].is_ascii_digit() {
            j += 1;
        }
        if j > ds {
            i = j;
        }
    }
    let mut text: &[u8] = &s[start..i];
    // Rust's parser rejects "5." and ".5" forms? It accepts both; it rejects a bare sign.
    let parsed = std::str::from_utf8(text).ok().and_then(|t| t.parse::<f64>().ok());
    match parsed {
        Some(v) => v,
        None => {
            text = &s[start..mant_end];
            std::str::from_utf8(text).ok().and_then(|t| t.parse::<f64>().ok()).unwrap_or(0.0)
        }
    }
}

/// C `atoi` (saturating instead of undefined on overflow).
pub fn atoi(s: &[u8]) -> i32 {
    let mut i = 0;
    while i < s.len() && is_space(s[i]) {
        i += 1;
    }
    let mut neg = false;
    if i < s.len() && (s[i] == b'+' || s[i] == b'-') {
        neg = s[i] == b'-';
        i += 1;
    }
    let mut v: i64 = 0;
    while i < s.len() && s[i].is_ascii_digit() {
        v = (v * 10 + (s[i] - b'0') as i64).min(1 << 40);
        i += 1;
    }
    let v = if neg { -v } else { v };
    v.clamp(i32::MIN as i64, i32::MAX as i64) as i32
}

/// `printf("%5.1f", (double)x)`.
pub fn fmt_5_1(out: &mut Vec<u8>, x: f32) {
    use std::io::Write;
    let x = x as f64;
    if x.is_nan() {
        out.extend_from_slice(b"  nan");
    } else if x.is_infinite() {
        out.extend_from_slice(if x > 0.0 { b"  inf" } else { b" -inf" });
    } else {
        let _ = write!(out, "{:5.1}", x);
    }
}

/// `printf("%f", (double)x)`.
pub fn fmt_f(out: &mut Vec<u8>, x: f32) {
    use std::io::Write;
    let x = x as f64;
    if x.is_nan() {
        out.extend_from_slice(b"nan");
    } else if x.is_infinite() {
        out.extend_from_slice(if x > 0.0 { b"inf" } else { b"-inf" });
    } else {
        let _ = write!(out, "{:.6}", x);
    }
}

/// QW `PF_ftos`: `%d` when integral, else `%5.1f`.
pub fn ftos(x: f32) -> Vec<u8> {
    let mut out = Vec::with_capacity(12);
    let i = x as i32; // saturating, NaN -> 0
    if x == i as f32 {
        use std::io::Write;
        let _ = write!(out, "{}", i);
    } else {
        fmt_5_1(&mut out, x);
    }
    out
}

/// QW `PF_vtos`: `'%5.1f %5.1f %5.1f'`.
pub fn vtos(v: [f32; 3]) -> Vec<u8> {
    let mut out = Vec::with_capacity(24);
    out.push(b'\'');
    fmt_5_1(&mut out, v[0]);
    out.push(b' ');
    fmt_5_1(&mut out, v[1]);
    out.push(b' ');
    fmt_5_1(&mut out, v[2]);
    out.push(b'\'');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_tokens() {
        let d = b"{ \"classname\" \"worldspawn\" // c\n wad x }";
        let (t, r) = com_parse(d).unwrap();
        assert_eq!(t, b"{");
        let (t, r) = com_parse(r).unwrap();
        assert_eq!(t, b"classname");
        let (t, r) = com_parse(r).unwrap();
        assert_eq!(t, b"worldspawn");
        let (t, r) = com_parse(r).unwrap();
        assert_eq!(t, b"wad");
        let (t, r) = com_parse(r).unwrap();
        assert_eq!(t, b"x");
        let (t, r) = com_parse(r).unwrap();
        assert_eq!(t, b"}");
        assert!(com_parse(r).is_none());
        assert!(com_parse(b"   ").is_none());
        let (t, _) = com_parse(b"\"unterminated").unwrap();
        assert_eq!(t, b"unterminated");
    }

    #[test]
    fn atof_cases() {
        assert_eq!(atof(b"  12.5xyz"), 12.5);
        assert_eq!(atof(b"-3"), -3.0);
        assert_eq!(atof(b".5"), 0.5);
        assert_eq!(atof(b"5."), 5.0);
        assert_eq!(atof(b"1e3"), 1000.0);
        assert_eq!(atof(b"1e"), 1.0);
        assert_eq!(atof(b"abc"), 0.0);
        assert_eq!(atof(b"-"), 0.0);
        assert_eq!(atof(b""), 0.0);
        assert_eq!(atoi(b" -42z"), -42);
        assert_eq!(atoi(b"99999999999"), i32::MAX);
    }

    #[test]
    fn ftos_like_qw() {
        assert_eq!(ftos(5.0), b"5");
        assert_eq!(ftos(-0.0), b"0");
        assert_eq!(ftos(0.5), b"  0.5");
        assert_eq!(ftos(-12.25), b"-12.2"); // glibc rounds the exact binary tie to even
        assert_eq!(ftos(0.25), b"  0.2");
        assert_eq!(ftos(0.75), b"  0.8");
        assert_eq!(ftos(123456.7), b"123456.7");
        assert_eq!(ftos(f32::NAN), b"  nan");
        assert_eq!(vtos([1.0, -2.5, 0.0]), b"'  1.0  -2.5   0.0'");
    }
}
