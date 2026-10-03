// Quake Town - qtbots: small deterministic vector math (libm only)
// Copyright (C) 2026 Quake Town contributors
// SPDX-License-Identifier: GPL-2.0-or-later

use crate::Vec3;

#[inline]
pub fn add(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
#[inline]
pub fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
#[inline]
pub fn scale(a: Vec3, k: f32) -> Vec3 {
    [a[0] * k, a[1] * k, a[2] * k]
}
#[inline]
pub fn ma(a: Vec3, k: f32, b: Vec3) -> Vec3 {
    [a[0] + k * b[0], a[1] + k * b[1], a[2] + k * b[2]]
}
#[inline]
pub fn dot(a: Vec3, b: Vec3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
#[inline]
pub fn len(a: Vec3) -> f32 {
    dot(a, a).sqrt()
}
#[inline]
pub fn len2d(a: Vec3) -> f32 {
    (a[0] * a[0] + a[1] * a[1]).sqrt()
}
#[inline]
pub fn dist(a: Vec3, b: Vec3) -> f32 {
    len(sub(a, b))
}
#[inline]
pub fn dist2d(a: Vec3, b: Vec3) -> f32 {
    len2d(sub(a, b))
}
pub fn norm(a: Vec3) -> Vec3 {
    let l = len(a);
    if l == 0.0 {
        [0.0; 3]
    } else {
        scale(a, 1.0 / l)
    }
}

pub const RAD: f32 = core::f32::consts::PI / 180.0;

/// Yaw in degrees (0..360) of a direction.
pub fn yaw_of(v: Vec3) -> f32 {
    if v[0] == 0.0 && v[1] == 0.0 {
        return 0.0;
    }
    let y = libm::atan2f(v[1], v[0]) / RAD;
    if y < 0.0 {
        y + 360.0
    } else {
        y
    }
}

/// Quake pitch (positive looks down) of a direction, -90..90.
pub fn pitch_of(v: Vec3) -> f32 {
    let f = len2d(v);
    -libm::atan2f(v[2], f) / RAD
}

/// Wrap to (-180, 180].
pub fn wrap180(a: f32) -> f32 {
    let mut a = a - 360.0 * libm::floorf(a / 360.0);
    if a > 180.0 {
        a -= 360.0;
    }
    a
}

/// Unit 2D direction for a yaw.
pub fn yaw_dir(yaw: f32) -> Vec3 {
    [libm::cosf(yaw * RAD), libm::sinf(yaw * RAD), 0.0]
}

/// Forward vector for (pitch, yaw) in Quake convention.
pub fn angles_dir(pitch: f32, yaw: f32) -> Vec3 {
    let (sp, cp) = (libm::sinf(pitch * RAD), libm::cosf(pitch * RAD));
    let (sy, cy) = (libm::sinf(yaw * RAD), libm::cosf(yaw * RAD));
    [cp * cy, cp * sy, -sp]
}
