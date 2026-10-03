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
//! QW infostrings ("\key\value\key\value"), QW/client/common.c Info_* semantics, kept as an
//! ordered list of pairs (order = insertion order, as the C string).

pub const MAX_INFO_STRING: usize = 512;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Info {
    pub pairs: Vec<(Vec<u8>, Vec<u8>)>,
}

impl Info {
    pub fn parse(s: &[u8]) -> Info {
        let mut info = Info::default();
        let mut parts = s.split(|&c| c == b'\\');
        if s.first() == Some(&b'\\') {
            parts.next();
        }
        loop {
            let k = match parts.next() {
                Some(k) => k,
                None => break,
            };
            let v = parts.next().unwrap_or(b"");
            if k.is_empty() {
                continue;
            }
            info.set(k, v);
        }
        info
    }

    pub fn get(&self, key: &[u8]) -> &[u8] {
        self.pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_slice()).unwrap_or(b"")
    }

    /// Info_SetValueForKey: an empty value removes the key; keys/values with `\` or `"`
    /// are refused; the whole string is capped at MAX_INFO_STRING.
    pub fn set(&mut self, key: &[u8], value: &[u8]) -> bool {
        if key.iter().any(|&c| c == b'\\' || c == b'"') || value.iter().any(|&c| c == b'\\' || c == b'"') {
            return false;
        }
        if key.len() > 63 || value.len() > 63 {
            return false;
        }
        let pos = self.pairs.iter().position(|(k, _)| k == key);
        if let Some(p) = pos {
            self.pairs.remove(p);
        }
        if value.is_empty() {
            return true;
        }
        if self.encoded_len() + key.len() + value.len() + 2 >= MAX_INFO_STRING {
            return false;
        }
        // strip high bits / control characters as QW does for values
        let v: Vec<u8> = value.iter().map(|&c| c & 127).filter(|&c| (32..127).contains(&c)).collect();
        self.pairs.push((key.to_vec(), v));
        true
    }

    pub fn encoded_len(&self) -> usize {
        self.pairs.iter().map(|(k, v)| k.len() + v.len() + 2).sum()
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.encoded_len());
        for (k, v) in &self.pairs {
            out.push(b'\\');
            out.extend_from_slice(k);
            out.push(b'\\');
            out.extend_from_slice(v);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrip() {
        let i = Info::parse(b"\\mode\\ffa\\maxclients\\8\\hostname\\my server");
        assert_eq!(i.get(b"mode"), b"ffa");
        assert_eq!(i.get(b"maxclients"), b"8");
        assert_eq!(i.get(b"hostname"), b"my server");
        assert_eq!(i.get(b"nope"), b"");
        assert_eq!(Info::parse(&i.encode()), i);
        let mut j = i.clone();
        j.set(b"mode", b"");
        assert_eq!(j.get(b"mode"), b"");
        assert_eq!(j.pairs.len(), 2);
    }
}
