//! Quake Town simulation: a deterministic port of the QuakeWorld server + pmove.
//! See DESIGN.md "Simulation architecture". GPL-2.0-or-later.

pub mod bsp;
pub mod info;
pub mod mathlib;
pub mod pmove;
pub mod testmap;
pub mod trace;

#[cfg(feature = "vm")]
pub mod abi;
#[cfg(feature = "vm")]
pub mod bots;
#[cfg(feature = "vm")]
mod builtins;
#[cfg(feature = "vm")]
pub mod events;
#[cfg(feature = "vm")]
pub mod game;
#[cfg(feature = "vm")]
mod movestep;
#[cfg(feature = "vm")]
mod phys;
#[cfg(feature = "vm")]
pub mod scenario;
#[cfg(feature = "vm")]
pub mod state;
#[cfg(feature = "vm")]
mod user;
#[cfg(feature = "vm")]
pub mod views;
#[cfg(feature = "vm")]
pub mod world;

#[cfg(feature = "vm")]
pub use world::World;
#[cfg(feature = "vm")]
pub use qcvm;

/// Bumped on any change to behaviour or layout (ABI `sim_version`).
pub const SIM_VERSION: u32 = 3;
