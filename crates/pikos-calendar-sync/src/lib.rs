//! pikos-calendar-sync — external calendar sync: HTTP + OS-keychain plumbing and provider
//! impls (CalDAV, then Google) producing `pikos-db`'s `SyncDelta`.
//!
//! Kept apart from `pikos-db` so its OS-specific, networked deps (`keyring`,
//! `reqwest`) stay out of that crate's toolchain-agnostic workspace check.

pub mod http;
pub mod keychain;

pub use keychain::{Keychain, KeychainError};
