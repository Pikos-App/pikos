//! The local SQLite data layer: migrations, the pool opener, and the writer
//! functions with their IO types. Tauri-free, so the desktop app and the CLI
//! call the same writers.

// The sqlx QueryBuilder pattern uses drop(fields) to release the Separated
// borrow before pushing additional clauses — clippy flags this but it's required.
#![allow(clippy::drop_non_drop)]

pub mod assets;
pub mod backups;
pub mod changes;
pub mod error;
pub mod export;
pub mod export_ics;

pub mod focus;
pub mod folders;
pub mod fresh;
pub mod moves;
pub mod notification_log;
pub mod page_chunks;
pub mod page_links;
pub mod pages;
mod pool;
pub mod reads;
pub mod reconciler;
pub mod recurrence_derive;
pub mod reminder_horizon;
pub mod reminders;
pub mod replica;
pub mod schedules;
pub mod search;
pub mod sql_functions;
pub mod sync;
pub mod sync_commands;
pub mod sync_delta;
pub mod tags;
pub mod title_key;
pub mod tx;
pub mod views;

/// The Tiptap document schema this build writes and can safely read.
///
/// Stamped into `pages.content_schema_version`. Bump it in the same commit that
/// changes the editor's document schema (a new node type, a renamed attribute,
/// anything that makes an older build's round-trip lossy) and ship a content
/// migration alongside.
///
/// It versions the shape of `pages.content` alone, not this crate or the app,
/// so it lives beside the database that outlives any one client.
pub const CONTENT_SCHEMA_VERSION: i64 = 2;

pub use backups::{
    backups_dir, list_backups, restore_backup, verify_restorable, BackupEntry, BackupKind,
};
pub use error::{AppError, AppResult};
pub use export::*;
pub use export_ics::build_export_ics;
pub use focus::*;
pub use folders::*;
pub use notification_log::*;
pub use pages::*;
pub use pool::{
    build_tiptap_doc, checkpoint_once, close_pool, device_zone, extract_text_from_tiptap,
    gather_statistics, migration_versions, now_iso, now_local_iso, now_local_parts, open_pool,
    open_pool_checkpointing, today_local, with_functions, CheckpointHooks, Checkpoints,
};
#[cfg(any(test, feature = "test-support"))]
pub use pool::{
    insert_test_folder, insert_test_page, insert_test_page_sync,
    insert_test_page_sync_connected_at, test_pool, test_pool_on, TestPage, TEST_CONNECTED_LONG_AGO,
};
pub use reconciler::*;
pub use recurrence_derive::*;
pub use reminder_horizon::*;
pub use reminders::*;
pub use schedules::*;
pub use search::*;
pub use sync::*;
pub use sync_commands::*;
pub use sync_delta::*;
pub use tags::*;

#[cfg(test)]
mod content_schema_version_tests {
    //! `CONTENT_SCHEMA_VERSION` is mirrored in `packages/core/src/types.ts`. If the
    //! copies drift, a client can write a document shape it cannot represent,
    //! which loses data instead of crashing, so this test fails when one side is
    //! bumped alone.

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

#[cfg(test)]
#[path = "views_differential_tests.rs"]
mod views_differential_tests;
