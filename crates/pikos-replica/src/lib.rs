//! Replica sync: keeps one workspace the same across a person's own devices.
//!
//! Everything that decides an outcome lives here, in Rust with no I/O, so every
//! failure is reproducible without a network or an Apple ID. Transports (the
//! CloudKit adapter in Swift, a folder of logs later) drive the engine and hold
//! no merge or policy logic of their own.

pub mod clock;
pub mod codec;
pub mod merge;
pub mod record;
pub mod zone;

pub use clock::{Hlc, ParseHlcError};
pub use record::{Entity, ParseRecordNameError, RecordName, ALL_ENTITIES};

/// Bump when a record's shape changes or a migration changes a synced value, so a
/// device that hasn't updated stops syncing instead of holding a clock with another value.
pub const FORMAT_VERSION: u32 = 1;
