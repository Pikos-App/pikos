//! Portable Pikos domain logic, shared by the desktop app, the CLI, and
//! (via UniFFI) the iOS app.
//!
//! This crate is the Rust destination for logic that currently lives in
//! `packages/core` (TypeScript). Everything here is graded against a golden
//! corpus generated from the TypeScript reference — see
//! `packages/core/scripts/gen-parity-corpus.ts` and `tests/parity.rs`. The TS
//! path is the reference implementation until a module reaches parity; only
//! then may it be deleted.
//!
//! Deliberately dependency-free of `pikos-db`: this is pure logic with no I/O,
//! which is what makes it testable against a fixture corpus and cheap to bind
//! from Swift.

pub mod dates;
pub mod recurrence;

pub use dates::{
    format_date_only, format_local_iso, is_all_day_iso, is_timed_iso, parse_local_iso,
};
pub use recurrence::{compute_next_end, expand_for_range, next_occurrence_after, Occurrence};
