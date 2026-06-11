// Migration snapshot/replay tests. These are the only tests that run the
// migration tree itself rather than assuming a migrated DB, so they catch schema
// drift and data-loss migrations before they ship to users — who have no easy
// rollback once a release lands via the auto-updater.

use std::path::{Path, PathBuf};
use std::str::FromStr;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

use super::*;

// Each migration's SQL, in order, for stepwise replay.
const MIGRATIONS: &[(&str, &str)] = &[
    ("001", include_str!("../migrations/001_initial.sql")),
    (
        "002",
        include_str!("../migrations/002_drop_duration_mins.sql"),
    ),
    ("003", include_str!("../migrations/003_tags_normalize.sql")),
    ("004", include_str!("../migrations/004_soft_delete.sql")),
    (
        "005",
        include_str!("../migrations/005_folder_soft_delete.sql"),
    ),
    ("006", include_str!("../migrations/006_notifications.sql")),
    (
        "007",
        include_str!("../migrations/007_reminder_none_sentinel.sql"),
    ),
    ("008", include_str!("../migrations/008_tags_nocase.sql")),
    ("009", include_str!("../migrations/009_tags_lowercase.sql")),
];

async fn single_conn_memory_pool() -> SqlitePool {
    let opts = SqliteConnectOptions::from_str(":memory:")
        .expect("parse :memory: opts")
        .foreign_keys(true);
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .expect("connect in-memory sqlite")
}

async fn table_names(pool: &SqlitePool) -> Vec<String> {
    sqlx::query_scalar::<_, String>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn column_names(pool: &SqlitePool, table: &str) -> Vec<String> {
    // sql-ok: table name is a test-local literal, never user input.
    sqlx::query_scalar::<_, String>(&format!("SELECT name FROM pragma_table_info('{table}')"))
        .fetch_all(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn empty_to_current_snapshot() {
    // test_pool() applies the full migration tree via sqlx::migrate!.
    let pool = test_pool().await;

    let tables = table_names(&pool).await;
    for expected in [
        "folders",
        "pages",
        "page_recurrence_rules",
        "page_schedules",
        "focus_sessions",
        "tags",
        "page_tags",
        "notification_log",
        "pages_fts",
    ] {
        assert!(
            tables.iter().any(|t| t == expected),
            "missing table {expected}; have {tables:?}"
        );
    }

    // Columns that migrations added/removed must be in their final state.
    let page_cols = column_names(&pool, "pages").await;
    assert!(
        page_cols.iter().any(|c| c == "deleted_at"),
        "004 not applied"
    );
    assert!(
        !page_cols.iter().any(|c| c == "duration_mins"),
        "002 should have dropped duration_mins"
    );
    assert!(column_names(&pool, "folders")
        .await
        .iter()
        .any(|c| c == "deleted_at"));

    // FTS5 internal consistency — fails loudly if the index is structurally broken.
    sqlx::query("INSERT INTO pages_fts(pages_fts) VALUES('integrity-check')")
        .execute(&pool)
        .await
        .expect("pages_fts failed integrity-check");
}

#[tokio::test]
async fn stepwise_preserves_seeded_data() {
    let pool = single_conn_memory_pool().await;

    // Apply 001 only, then seed legacy-shaped rows: a duration_mins value (dropped
    // in 002), case/whitespace tag variants (deduped in 008), a multi-byte title,
    // and NULL columns.
    sqlx::raw_sql(MIGRATIONS[0].1).execute(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO pages
         (id, folder_id, title, subtitle, content, content_text, status, priority, tags,
          sort_order, duration_mins, created_at, updated_at)
         VALUES ('p1', NULL, '日本語タスク', NULL, '{}', '', 'not_started', 0,
                 '[\"Work\",\"work\",\"  work  \"]', 0, 90, '2026-01-01', '2026-01-01')",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Apply the rest one at a time; the row must survive every step.
    for (name, sql) in &MIGRATIONS[1..] {
        sqlx::raw_sql(sql)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("migration {name} failed: {e}"));

        let title: String = sqlx::query_scalar("SELECT title FROM pages WHERE id = 'p1'")
            .fetch_one(&pool)
            .await
            .unwrap_or_else(|e| panic!("page lost after migration {name}: {e}"));
        assert_eq!(
            title, "日本語タスク",
            "multi-byte title corrupted at {name}"
        );
    }

    // 002 dropped duration_mins.
    assert!(
        !column_names(&pool, "pages")
            .await
            .iter()
            .any(|c| c == "duration_mins"),
        "duration_mins should be gone after 002"
    );

    // 003 backfilled three case/whitespace tag variants; 008 deduped them to one.
    let tag_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        tag_count, 1,
        "008 should dedupe Work/work/'  work  ' to one tag"
    );

    // 009 lowercased the survivor (008 kept first-seen casing; 009 forces lower).
    let name: String = sqlx::query_scalar("SELECT name FROM tags")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(name, "work");

    // The page keeps exactly one association, pointing at the surviving tag.
    let assoc: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM page_tags WHERE page_id = 'p1'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        assoc, 1,
        "page_tags association lost or duplicated during dedupe"
    );

    // 009 collapsed the three variants in the pages.tags JSON denorm to the one
    // canonical tag (its exact casing depends on the 008 id tiebreak).
    let denorm_len: i64 =
        sqlx::query_scalar("SELECT json_array_length(tags) FROM pages WHERE id = 'p1'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(denorm_len, 1, "009 should collapse the pages.tags denorm");
    let denorm_tag: String =
        sqlx::query_scalar("SELECT json_extract(tags, '$[0]') FROM pages WHERE id = 'p1'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(denorm_tag, "work", "denorm tag must be lowercased");
}

#[tokio::test]
async fn fts_rebuilds_on_schema_version_mismatch() {
    // open_pool's rebuild path needs a real file: reopening a :memory: DB would
    // start empty. Use a unique temp path and clean it (plus WAL/SHM) up after.
    let path = std::env::temp_dir().join(format!("pkos_fts_{}.db", uuid::Uuid::new_v4()));
    let path_str = path.to_str().unwrap().to_string();

    {
        let pool = open_pool(&path_str).await.unwrap();
        insert_test_page(
            &pool,
            TestPage {
                content_text: "needle in the haystack",
                ..TestPage::new("p1", "Findable")
            },
        )
        .await
        .unwrap();

        // Simulate a stale index after a hypothetical FTS-touching migration:
        // wipe the FTS rows and reset the stored schema version.
        sqlx::query("DELETE FROM pages_fts")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("PRAGMA user_version = 0")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
    }

    // Reopen: the version mismatch must trigger a rebuild.
    let pool = open_pool(&path_str).await.unwrap();
    let hits: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pages_fts WHERE pages_fts MATCH 'needle'")
            .fetch_one(&pool)
            .await
            .unwrap();
    pool.close().await;

    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{path_str}{suffix}"));
    }

    assert_eq!(
        hits, 1,
        "FTS index was not rebuilt on schema-version mismatch"
    );
}

// ── pre-migration backup ───────────────────────────────────────────────
//
// These tests drive `maybe_backup_before_migrations` directly rather than
// through a real `open_pool` reopen. To make `open_pool` actually see a pending
// migration we'd delete the top `_sqlx_migrations` row and reopen — but that
// forces sqlx to re-run that migration, which only survives if the migration is
// idempotent (a future `ADD COLUMN` would fail). So the open_pool→gate wiring
// itself (the call site before `MIGRATOR.run`) is intentionally not asserted
// here; it's a one-line call verified by reading the code.

/// Isolated temp dir so each test's backups/ subfolder can't collide with
/// another's (tests run in parallel and share std::env::temp_dir()).
fn unique_tmp_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pkos_db14_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn migration_backup_count(backup_dir: &Path) -> usize {
    std::fs::read_dir(backup_dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| {
                    e.file_name()
                        .to_str()
                        .is_some_and(|n| n.starts_with("pre-migration-") && n.ends_with(".sqlite"))
                })
                .count()
        })
        .unwrap_or(0)
}

/// Drop the highest-version row from `_sqlx_migrations` so the workspace looks
/// one migration behind the binary — i.e. has a pending migration.
async fn simulate_pending_migration(pool: &SqlitePool) {
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version = (SELECT MAX(version) FROM _sqlx_migrations)")
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn snapshots_before_pending_migration_when_data_present() {
    let dir = unique_tmp_dir();
    let path = dir.join("workspace.sqlite");
    let path_str = path.to_str().unwrap().to_string();

    let pool = open_pool(&path_str).await.unwrap();
    insert_test_page(&pool, TestPage::new("p1", "Keep me"))
        .await
        .unwrap();
    simulate_pending_migration(&pool).await;

    maybe_backup_before_migrations(&pool, &path_str)
        .await
        .unwrap();
    pool.close().await;

    assert_eq!(
        migration_backup_count(&dir.join("backups")),
        1,
        "a pending migration on a workspace with data must produce a snapshot"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn snapshot_is_a_valid_restorable_copy() {
    // The point of the snapshot is recovery, so prove the produced file opens as
    // a real DB and still holds the pre-migration data (incl. a working FTS
    // index) — not just that a file appears on disk.
    let dir = unique_tmp_dir();
    let path = dir.join("workspace.sqlite");
    let path_str = path.to_str().unwrap().to_string();

    let pool = open_pool(&path_str).await.unwrap();
    insert_test_page(
        &pool,
        TestPage {
            content_text: "needle in the haystack",
            ..TestPage::new("p1", "Keep me")
        },
    )
    .await
    .unwrap();
    simulate_pending_migration(&pool).await;
    maybe_backup_before_migrations(&pool, &path_str)
        .await
        .unwrap();
    pool.close().await;

    let snapshot = std::fs::read_dir(dir.join("backups"))
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .find(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("pre-migration-") && n.ends_with(".sqlite"))
        })
        .expect("a snapshot file");

    // Open the copy directly (no migrations) so this exercises only the copy's
    // validity and contents, not the migrator.
    let restored = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(SqliteConnectOptions::new().filename(&snapshot))
        .await
        .expect("snapshot should open as a valid sqlite DB");

    let title: String = sqlx::query_scalar("SELECT title FROM pages WHERE id = 'p1'")
        .fetch_one(&restored)
        .await
        .expect("seeded page should survive in the snapshot");
    assert_eq!(title, "Keep me");

    let hits: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pages_fts WHERE pages_fts MATCH 'needle'")
            .fetch_one(&restored)
            .await
            .unwrap();
    assert_eq!(hits, 1, "snapshot's FTS index should be intact and searchable");

    restored.close().await;
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn no_snapshot_when_up_to_date() {
    let dir = unique_tmp_dir();
    let path = dir.join("workspace.sqlite");
    let path_str = path.to_str().unwrap().to_string();

    let pool = open_pool(&path_str).await.unwrap();
    insert_test_page(&pool, TestPage::new("p1", "Data"))
        .await
        .unwrap();
    // No pending migration: open_pool already applied the full tree.

    maybe_backup_before_migrations(&pool, &path_str)
        .await
        .unwrap();
    pool.close().await;

    assert_eq!(
        migration_backup_count(&dir.join("backups")),
        0,
        "no pending migration => no snapshot"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn no_snapshot_for_empty_workspace() {
    let dir = unique_tmp_dir();
    let path = dir.join("workspace.sqlite");
    let path_str = path.to_str().unwrap().to_string();

    let pool = open_pool(&path_str).await.unwrap();
    // Pending migration but no pages or folders => nothing to lose.
    simulate_pending_migration(&pool).await;

    maybe_backup_before_migrations(&pool, &path_str)
        .await
        .unwrap();
    pool.close().await;

    assert_eq!(
        migration_backup_count(&dir.join("backups")),
        0,
        "empty workspace must not be snapshotted even with a pending migration"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn prune_keeps_newest_n_and_ignores_other_files() {
    let dir = unique_tmp_dir();

    // Timestamp-first names: lexical order == chronological order.
    for ts in ["20260101T000000000Z", "20260102T000000000Z", "20260103T000000000Z", "20260104T000000000Z"] {
        std::fs::write(dir.join(format!("pre-migration-{ts}-v8-to-v9.sqlite")), b"x").unwrap();
    }
    // Unrelated files must be left alone.
    std::fs::write(dir.join("pre-import-20260101T000000Z.sqlite"), b"x").unwrap();
    std::fs::write(dir.join("notes.txt"), b"x").unwrap();

    prune_migration_backups(&dir, 3);

    assert_eq!(
        migration_backup_count(&dir),
        3,
        "prune should keep exactly the newest 3 migration snapshots"
    );
    // Oldest removed, newest kept.
    assert!(!dir.join("pre-migration-20260101T000000000Z-v8-to-v9.sqlite").exists());
    assert!(dir.join("pre-migration-20260104T000000000Z-v8-to-v9.sqlite").exists());
    // Non-migration files untouched.
    assert!(dir.join("pre-import-20260101T000000Z.sqlite").exists());
    assert!(dir.join("notes.txt").exists());

    let _ = std::fs::remove_dir_all(&dir);
}
