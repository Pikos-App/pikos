//! pikos-db — the Pikos local SQLite data layer.
//!
//! Schema/migrations, the pool opener (WAL + pragmas), and the writer functions
//! (`*_impl`) plus their IO types. Tauri-free: the desktop app wraps these in
//! `#[tauri::command]` shims, and the CLI calls them directly — one writer, one
//! source of truth.

// The sqlx QueryBuilder pattern uses drop(fields) to release the Separated
// borrow before pushing additional clauses — clippy flags this but it's required.
#![allow(clippy::drop_non_drop)]

pub mod error;
pub mod folders;
pub mod notification_log;
pub mod pages;
mod pool;
pub mod reminders;
pub mod schedules;
pub mod search;
pub mod tags;
pub mod tx;

pub use error::{AppError, AppResult};
pub use folders::*;
pub use notification_log::*;
pub use pages::*;
pub use pool::{now_iso, now_local_iso, open_pool};
#[cfg(any(test, feature = "test-support"))]
pub use pool::{insert_test_folder, insert_test_page, test_pool, TestPage};
pub use reminders::*;
pub use schedules::*;
pub use search::*;
pub use tags::*;
