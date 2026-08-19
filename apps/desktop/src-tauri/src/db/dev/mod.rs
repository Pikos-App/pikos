//! Developer/settings commands, split by concern:
//!
//! - [`stats`] — the Settings → Data usage panel.
//! - [`maintenance`] — reset, wipe, backup/vacuum, and dev backdating.
//! - [`export`] — the JSON, Markdown and CSV exports.
//! - [`seed`] — the mock calendar-sync seed.
//!
//! The globs below re-export each submodule's surface at `db::dev::*`, which is
//! where `lib.rs` and `ipc_tests.rs` name these commands. A glob (rather than a
//! hand-written list) is what keeps the `#[tauri::command]` wrapper macros —
//! `__cmd__*`, generated beside each command and needed by `generate_handler!`
//! for a path-qualified registration — travelling with their functions.

mod export;
mod maintenance;
mod seed;
mod stats;

pub use export::*;
pub use maintenance::*;
pub use seed::*;
pub use stats::*;

#[cfg(test)]
mod tests;
