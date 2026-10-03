// Quake Town - qcvm: QW vector math with exact float behaviour (mathlib.c, pr_cmds.c)
// Copyright (C) 1996-1997 Id Software, Inc.
// Copyright (C) 2026 Quake Town contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// This program is free software; you can redistribute it and/or modify it under the terms
// of the GNU General Public License as published by the Free Software Foundation; either
// version 2 of the License, or (at your option) any later version.

//! Transcendentals come from `libm` only (DESIGN.md determinism rules). The float/double
//! mix follows id's C exactly (float variables, double library calls and constants).

pub type Vec3 = [f32; 3];

/// `M_PI` as in id's mathlib.h.
pub const M_PI: f64 = 3.14159265358979323846;

/// QW `AngleVectors`: (forward, right, up) from (pitch, yaw, roll) in degrees.
pub fn angle_vectors(angles: Vec3) -> (Vec3, Vec3, Vec3) {
    let k = M_PI * 2.0 / 360.0;
    let angle = (angles[1] as f64 * k) as f32;
    let sy = libm::sin(angle as f64) as f32;
    let cy = libm::cos(angle as f64) as f32;
    let angle = (angles[0] as f64 * k) as f32;
    let sp = libm::sin(angle as f64) as f32;
    let cp = libm::cos(angle as f64) as f32;
    let angle = (angles[2] as f64 * k) as f32;
    let sr = libm::sin(angle as f64) as f32;
    let cr = libm::cos(angle as f64) as f32;

    let forward = [cp * cy, cp * sy, -sp];
    let right = [
        -1.0 * sr * sp * cy + -1.0 * cr * -sy,
        -1.0 * sr * sp * sy + -1.0 * cr * cy,
        -1.0 * sr * cp,
    ];
    let up = [cr * sp * cy + -sr * -sy, cr * sp * sy + -sr * cy, cr * cp];
    (forward, right, up)
}

/// `PF_vlen`.
pub fn vlen(v: Vec3) -> f32 {
    let n = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    n.sqrt()
}

/// `PF_normalize`.
pub fn normalize(v: Vec3) -> Vec3 {
    let n = vlen(v);
    if n == 0.0 {
        [0.0; 3]
    } else {
        let n = 1.0 / n;
        [v[0] * n, v[1] * n, v[2] * n]
    }
}

/// `(int)(atan2(y, x) * 180 / M_PI)` in double, as id's code.
fn atan2_deg_trunc(y: f32, x: f32) -> f32 {
    let d = libm::atan2(y as f64, x as f64) * 180.0 / M_PI;
    (d as i32) as f32
}

/// `PF_vectoyaw`.
pub fn vectoyaw(v: Vec3) -> f32 {
    if v[1] == 0.0 && v[0] == 0.0 {
        0.0
    } else {
        let mut yaw = atan2_deg_trunc(v[1], v[0]);
        if yaw < 0.0 {
            yaw += 360.0;
        }
        yaw
    }
}

/// `PF_vectoangles`: (pitch, yaw, 0), integer degrees.
pub fn vectoangles(v: Vec3) -> Vec3 {
    let (pitch, yaw);
    if v[1] == 0.0 && v[0] == 0.0 {
        yaw = 0.0;
        pitch = if v[2] > 0.0 { 90.0 } else { 270.0 };
    } else {
        let mut y = atan2_deg_trunc(v[1], v[0]);
        if y < 0.0 {
            y += 360.0;
        }
        yaw = y;
        let forward = (v[0] * v[0] + v[1] * v[1]).sqrt();
        let mut p = atan2_deg_trunc(v[2], forward);
        if p < 0.0 {
            p += 360.0;
        }
        pitch = p;
    }
    [pitch, yaw, 0.0]
}

/// mathlib `anglemod` (the 16-bit quantised version QW uses).
pub fn anglemod(a: f32) -> f32 {
    let q = ((a as f64 * (65536.0 / 360.0)) as i32) & 65535;
    ((360.0 / 65536.0) * q as f64) as f32
}

/// `DotProduct` in float.
#[inline]
pub fn dot(a: Vec3, b: Vec3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn basics() {
        let (f, r, u) = angle_vectors([0.0, 90.0, 0.0]);
        assert!(f[0].abs() < 1e-6 && (f[1] - 1.0).abs() < 1e-6);
        assert!((r[0] - 1.0).abs() < 1e-6);
        assert!((u[2] - 1.0).abs() < 1e-6);
        assert_eq!(vectoyaw([0.0, -1.0, 0.0]), 270.0);
        assert_eq!(vectoyaw([1.0, 1.0, 0.0]), 45.0);
        assert_eq!(vectoangles([0.0, 0.0, 5.0]), [90.0, 0.0, 0.0]);
        assert_eq!(vectoangles([1.0, 0.0, -1.0]), [315.0, 0.0, 0.0]);
        assert_eq!(normalize([3.0, 4.0, 0.0]), [0.6, 0.8, 0.0]);
        assert_eq!(vlen([3.0, 4.0, 0.0]), 5.0);
        assert_eq!(anglemod(-90.0), 270.0);
    }
}
