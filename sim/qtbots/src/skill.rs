// Quake Town - qtbots: skill levels
// Copyright (C) 2026 Quake Town contributors
// SPDX-License-Identifier: GPL-2.0-or-later

/// Per-skill human parameters.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Skill {
    /// Seconds from first sight to reacting (turning / firing).
    pub reaction: f32,
    /// Aim error amplitude in degrees (resampled a few times per second).
    pub aim_error: f32,
    /// Max view turn in degrees per second.
    pub turn_rate: f32,
    /// Fraction of the remaining angle turned per tick (smoothness).
    pub track: f32,
    /// Half field of view in degrees.
    pub fov: f32,
    /// Hearing radius (units): enemies closer than this are noticed out of view.
    pub hear: f32,
    /// Strafe direction flips per second in a fight.
    pub dodge: f32,
    /// Projectile lead quality 0..1.
    pub lead: f32,
    pub circle_strafe: bool,
    pub bunny_hop: bool,
    pub dodge_jump: bool,
}

pub fn skill(level: u8) -> Skill {
    let l = level.clamp(1, 5) as usize - 1;
    Skill {
        reaction: [0.35, 0.30, 0.25, 0.20, 0.15][l],
        aim_error: [8.0, 5.5, 3.5, 2.0, 1.0][l],
        turn_rate: [220.0, 320.0, 450.0, 650.0, 900.0][l],
        track: [0.18, 0.25, 0.33, 0.42, 0.55][l],
        fov: [55.0, 60.0, 65.0, 70.0, 75.0][l],
        hear: [250.0, 350.0, 450.0, 550.0, 650.0][l],
        dodge: [0.3, 0.6, 0.9, 1.2, 1.5][l],
        lead: [0.2, 0.4, 0.65, 0.85, 0.95][l],
        circle_strafe: l >= 1,
        bunny_hop: l >= 2,
        dodge_jump: l >= 2,
    }
}
