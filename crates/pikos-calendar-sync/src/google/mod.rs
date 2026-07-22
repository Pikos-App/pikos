//! Google provider (Phase 2): OAuth 2.0 + PKCE over an ephemeral loopback
//! redirect, tokens in the OS keychain, and the Calendar API sync on top.
//!
//! This module is the auth half. Credentials are keyed by `sync_account` row id,
//! so connecting a second Google account creates its own account row and its own
//! keychain entry rather than replacing the first.

mod auth;
mod config;
mod credentials;
mod error;
mod loopback;

pub use auth::{access_token, begin_authorization, revoke, store, PendingAuth};
pub use config::is_available;
pub use credentials::GoogleCredentials;
pub use error::GoogleError;
