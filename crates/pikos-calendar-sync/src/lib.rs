//! pikos-calendar-sync — external calendar sync: HTTP + OS-keychain plumbing and provider
//! impls (CalDAV, then Google) producing `pikos-db`'s `SyncDelta`.
//!
//! Kept apart from `pikos-db` so its OS-specific, networked deps (`keyring`,
//! `reqwest`) stay out of that crate's toolchain-agnostic workspace check.

pub mod caldav;
pub mod commands;
pub mod engine;
pub mod google;
pub mod http;
pub mod keychain;
pub mod scheduler;

#[cfg(test)]
#[path = "test_support.rs"]
mod test_support;

pub use caldav::{CaldavCredentials, CaldavError, CaldavProvider};
pub use commands::{connect_caldav, disconnect_account, resync_account, CalendarSyncResult};
pub use engine::{sync_calendar, SyncOutcome};
pub use google::{GoogleCredentials, GoogleError};
pub use keychain::{Keychain, KeychainError};
pub use scheduler::{run_sync_loop, PassReport, SchedulerConfig, SyncTrigger, TriggerSource};
