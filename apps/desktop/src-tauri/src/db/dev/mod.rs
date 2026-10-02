//! Developer/settings commands, split by concern:
//!
//! - [`stats`] — the Settings → Data usage panel.
//! - [`maintenance`] — reset, wipe, backup/vacuum, and dev backdating.
//! - [`export`] — the JSON, Markdown and CSV exports.
//! - [`ics`] — the `.ics` calendar export of the scheduled pages.
//! - [`seed`] — the mock calendar-sync seed, in debug builds only.
//!
//! The globs below re-export each submodule's surface at `db::dev::*`, which is
//! where `lib.rs` and `ipc_tests.rs` name these commands. A glob (rather than a
//! hand-written list) is what keeps the `#[tauri::command]` wrapper macros —
//! `__cmd__*`, generated beside each command and needed by `generate_handler!`
//! for a path-qualified registration — travelling with their functions.

mod export;
mod ics;
mod maintenance;
// The seed's command is debug-only; the e2e bridge seeds through its impl in any build.
#[cfg(any(debug_assertions, test, feature = "e2e-bridge"))]
mod seed;
mod stats;

pub use export::*;
pub use ics::*;
pub use maintenance::*;
#[cfg(all(not(debug_assertions), feature = "e2e-bridge"))]
pub(crate) use seed::dev_seed_synced_calendar_impl;
#[cfg(debug_assertions)]
pub use seed::*;
pub use stats::*;

#[cfg(test)]
mod seed_conformance_tests;
#[cfg(test)]
mod tests;
