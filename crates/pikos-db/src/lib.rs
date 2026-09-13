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
pub mod focus;
pub mod folders;
pub mod notification_log;
pub mod pages;
mod pool;
pub mod reconciler;
pub mod recurrence_derive;
pub mod reminders;
pub mod schedules;
pub mod search;
pub mod sync;
pub mod sync_commands;
pub mod sync_delta;
pub mod tags;
pub mod tx;

/// The Tiptap document schema this build writes and can safely read.
///
/// Single source of truth for the `pages.content_schema_version` column added
/// in migration 013. Bump it in the same commit that changes the editor's
/// document schema — a new node type, a renamed attribute, anything that makes
/// an older build's round-trip lossy — and ship a content migration alongside.
///
/// The number is not a version of *this crate* or of the app. It versions the
/// shape of `pages.content` alone, which is why it lives beside the data layer
/// rather than in the editor package: the database is what outlives any one
/// client, and with iOS in the picture there is more than one client.
pub const CONTENT_SCHEMA_VERSION: i64 = 1;

pub use error::{AppError, AppResult};
pub use focus::*;
pub use folders::*;
pub use notification_log::*;
pub use pages::*;
pub use pool::{
    build_tiptap_doc, device_zone, extract_text_from_tiptap, migration_versions, now_iso,
    now_local_iso, now_local_parts, open_pool, today_local,
};
#[cfg(any(test, feature = "test-support"))]
pub use pool::{
    insert_test_folder, insert_test_page, insert_test_page_sync,
    insert_test_page_sync_connected_at, test_pool, TestPage, TEST_CONNECTED_LONG_AGO,
};
pub use reconciler::*;
pub use recurrence_derive::*;
pub use reminders::*;
pub use schedules::*;
pub use search::*;
pub use sync::*;
pub use sync_commands::*;
pub use sync_delta::*;
pub use tags::*;

#[cfg(test)]
mod content_schema_version_tests {
    //! Guards the one constant that exists on both sides of the language
    //! boundary. `CONTENT_SCHEMA_VERSION` is mirrored in
    //! `packages/core/src/types.ts` so TypeScript callers can stamp mock pages
    //! and reason about document compatibility. Two copies of a number that
    //! must agree is exactly the kind of thing that silently drifts, and the
    //! failure mode when it does — a client believing it can safely write a
    //! document shape it cannot represent — is data loss rather than a crash.
    //!
    //! Reading the TypeScript source from a Rust test is unusual, but it is the
    //! only place the check can live and still fail at the moment somebody
    //! bumps one side.

    use std::path::PathBuf;

    #[test]
    fn matches_the_typescript_mirror() {
        let ts_path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/core/src/types.ts");
        let src = std::fs::read_to_string(&ts_path).unwrap_or_else(|e| {
            panic!(
                "cannot read the TypeScript mirror at {}: {e}",
                ts_path.display()
            )
        });

        const NEEDLE: &str = "export const CONTENT_SCHEMA_VERSION = ";
        let start = src.find(NEEDLE).unwrap_or_else(|| {
            panic!(
                "`{NEEDLE}` not found in {} — if the constant moved or was \
                 renamed, update this guard rather than deleting it",
                ts_path.display()
            )
        }) + NEEDLE.len();
        let digits: String = src[start..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        let ts_value: i64 = digits.parse().unwrap_or_else(|e| {
            panic!("could not parse the TypeScript constant's value `{digits}`: {e}")
        });

        assert_eq!(
            super::CONTENT_SCHEMA_VERSION,
            ts_value,
            "CONTENT_SCHEMA_VERSION has drifted: Rust says {}, TypeScript says {ts_value}. \
             Bump both together, and ship a content migration with the change.",
            super::CONTENT_SCHEMA_VERSION
        );
    }
}

#[cfg(test)]
#[path = "sync_conformance_tests.rs"]
mod sync_conformance_tests;

#[cfg(test)]
#[path = "recurrence_conformance_tests.rs"]
mod recurrence_conformance_tests;

#[cfg(test)]
#[path = "core_conformance_tests.rs"]
mod core_conformance_tests;

#[cfg(test)]
#[path = "content_text_conformance_tests.rs"]
mod content_text_conformance_tests;

#[cfg(test)]
#[path = "search_tokenization_conformance_tests.rs"]
mod search_tokenization_conformance_tests;

#[cfg(test)]
#[path = "folder_matching_conformance_tests.rs"]
mod folder_matching_conformance_tests;

#[cfg(test)]
#[path = "schedule_snap_conformance_tests.rs"]
mod schedule_snap_conformance_tests;
