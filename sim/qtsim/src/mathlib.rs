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
//! Port of QW/client/mathlib.c (the parts the server uses).
//!
//! Float semantics follow the C source compiled with SSE (FLT_EVAL_METHOD 0): float
//! expressions are evaluated in f32; an expression with a double literal (`0.7`,
//! `M_PI*2/360`) or a call to `sin`/`sqrt` is evaluated in f64 and rounded back when
//! stored into a float. Transcendentals come from `libm` (pure Rust, deterministic).

pub type Vec3 = [f32; 3];

pub const PITCH: usize = 0;
pub const YAW: usize = 1;
pub const ROLL: usize = 2;

pub const VEC3_ORIGIN: Vec3 = [0.0; 3];

#[inline(always)]
pub fn dot(a: &Vec3, b: &Vec3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[inline(always)]
pub fn sub(a: &Vec3, b: &Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

#[inline(always)]
pub fn add(a: &Vec3, b: &Vec3) -> Vec3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

#[inline(always)]
pub fn scale(a: &Vec3, s: f32) -> Vec3 {
    [a[0] * s, a[1] * s, a[2] * s]
}

/// VectorMA(veca, scale, vecb, out): out = veca + scale*vecb
#[inline(always)]
pub fn ma(a: &Vec3, s: f32, b: &Vec3) -> Vec3 {
    [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2]]
}

#[inline(always)]
pub fn cross(v1: &Vec3, v2: &Vec3) -> Vec3 {
    [
        v1[1] * v2[2] - v1[2] * v2[1],
        v1[2] * v2[0] - v1[0] * v2[2],
        v1[0] * v2[1] - v1[1] * v2[0],
    ]
}

/// sqrt of a float through double, as C's `sqrt(float)` stored into a float.
#[inline(always)]
pub fn sqrtf(x: f32) -> f32 {
    // f64 sqrt rounded to f32 equals the correctly rounded f32 sqrt.
    x.sqrt()
}

/// mathlib.c Length
#[inline]
pub fn length(v: &Vec3) -> f32 {
    let mut l = 0.0f32;
    for i in 0..3 {
        l += v[i] * v[i];
    }
    sqrtf(l)
}

/// mathlib.c VectorNormalize
#[inline]
pub fn normalize(v: &mut Vec3) -> f32 {
    let mut length = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    length = sqrtf(length);
    if length != 0.0 {
        let il = 1.0 / length;
        v[0] *= il;
        v[1] *= il;
        v[2] *= il;
    }
    length
}

const DEG2RAD: f64 = core::f64::consts::PI * 2.0 / 360.0;

/// sin/cos of a float angle in degrees, as `angle = deg * (M_PI*2/360); s = sin(angle)`.
#[inline]
fn sincos_deg(deg: f32) -> (f32, f32) {
    let angle = (deg as f64 * DEG2RAD) as f32;
    (libm::sin(angle as f64) as f32, libm::cos(angle as f64) as f32)
}

/// mathlib.c AngleVectors
pub fn angle_vectors(angles: &Vec3) -> (Vec3, Vec3, Vec3) {
    let (sy, cy) = sincos_deg(angles[YAW]);
    let (sp, cp) = sincos_deg(angles[PITCH]);
    let (sr, cr) = sincos_deg(angles[ROLL]);
    let forward = [cp * cy, cp * sy, -sp];
    let right = [
        -1.0 * sr * sp * cy + -1.0 * cr * -sy,
        -1.0 * sr * sp * sy + -1.0 * cr * cy,
        -1.0 * sr * cp,
    ];
    let up = [cr * sp * cy + -sr * -sy, cr * sp * sy + -sr * cy, cr * cp];
    (forward, right, up)
}

/// mathlib.c anglemod
#[inline]
pub fn anglemod(a: f32) -> f32 {
    let i = (a as f64 * (65536.0 / 360.0)) as i32 & 65535;
    ((360.0 / 65536.0) * i as f64) as f32
}

/// C `(int)f` for a float: truncation; NaN and out of range saturate (Rust `as`).
#[inline(always)]
pub fn ftoi(f: f32) -> i32 {
    f as i32
}

/// Canonical NaN for hashing / serialization.
#[inline(always)]
pub fn canon(x: f32) -> u32 {
    if x.is_nan() {
        0x7fc0_0000
    } else {
        x.to_bits()
    }
}
