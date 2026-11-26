//! The app's error type is the shared `pikos_db::AppError` — the data layer
//! owns it so the desktop app and the CLI report failures identically. The
//! Tauri command boundary serializes it as `{ kind, message }` (the hand-rolled
//! Serialize impl lives in pikos-db); frontends discriminate on `kind`.
//!
//! Re-exported here as `crate::error::{AppError, AppResult}`.

pub use pikos_db::{AppError, AppResult};
