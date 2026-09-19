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
    ("010", include_str!("../migrations/010_calendar_sync.sql")),
    (
        "011",
        include_str!("../migrations/011_mirror_search_text.sql"),
    ),
    (
        "012",
        include_str!("../migrations/012_notification_reach.sql"),
    ),
];

/// `include_str!` needs a literal path, so the list above is written by hand while
/// the migrator reads the directory — and a migration added to the directory alone
/// is still applied to every user's database with no test replaying it. The
/// stepwise tests would keep passing, one version short, which reads as coverage.
#[test]
fn the_replay_list_holds_every_migration_on_disk() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let mut on_disk: Vec<String> = std::fs::read_dir(&dir)
        .expect("migrations directory")
        .map(|e| e.expect("dir entry").file_name().to_string_lossy().into())
        .filter(|name: &String| name.ends_with(".sql"))
        .collect();
    on_disk.sort();

    let listed: Vec<String> = MIGRATIONS.iter().map(|(v, _)| (*v).to_string()).collect();
    let versions: Vec<String> = on_disk
        .iter()
        .map(|name| name.split('_').next().unwrap_or_default().to_string())
        .collect();

    assert_eq!(
        listed,
        versions,
        "MIGRATIONS is out of step with {}: add the new file to the list so the \
         stepwise and populated-workspace replays actually reach it",
        dir.display()
    );
}

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

/// The upgrade every existing install performs when 0.4.0 lands. `open_pool` runs
/// the same tree against whatever the user already has, and 010 is the first
/// migration to arrive after a real launch — so this is the one step whose failure
/// mode is other people's data, with no rollback behind an auto-update.
///
/// The stepwise test above proves rows *survive* each migration; this one proves
/// the workspace still **works** afterwards: pre-existing pages keep their
/// schedules, rules and reminders, the new tables are usable, and a page that
/// predates sync reads as unsynced rather than as anything ambiguous.
///
/// Note 010 is **not** idempotent — `ALTER TABLE ADD COLUMN` takes no `IF NOT
/// EXISTS` and re-running errors on the duplicate column. It doesn't need to be:
/// sqlx records each applied version and runs each migration in a transaction, so
/// a failure rolls back whole and a retry starts from a clean 009. Don't "fix" it
/// by making the ALTER conditional; the guarantee lives in the migrator.
#[tokio::test]
async fn the_calendar_sync_migration_lands_on_a_populated_workspace() {
    let pool = single_conn_memory_pool().await;
    for (name, sql) in &MIGRATIONS[..9] {
        sqlx::raw_sql(sql)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("migration {name} failed: {e}"));
    }

    // A workspace with the shapes 010 has to carry across: a foldered page, a
    // schedule, a recurrence rule, and a reminder (007 recreated that table, and
    // the stepwise seed leaves it empty — so this is also the first time 007's
    // recreate is asked to preserve a row).
    sqlx::query("INSERT INTO folders (id, name, sort_order, created_at, updated_at) VALUES ('f1', 'Work', 0, '2026-01-01', '2026-01-01')")
        .execute(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO pages
         (id, folder_id, title, content, content_text, status, priority, tags,
          sort_order, created_at, updated_at)
         VALUES ('p1', 'f1', 'Weekly review', '{}', '', 'not_started', 0, '[\"work\"]',
                 0, '2026-01-01', '2026-01-01')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO page_schedules (id, page_id, scheduled_start, scheduled_end, timezone, status, created_at) VALUES ('s1', 'p1', '2026-06-01T09:00:00', '2026-06-01T09:30:00', 'America/New_York', 'not_started', '2026-01-01')")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO page_recurrence_rules (id, page_id, rrule, rrule_exdates, scheduled_start, timezone, created_at) VALUES ('r1', 'p1', 'FREQ=WEEKLY', '[]', '2026-06-01T09:00:00', 'America/New_York', '2026-01-01')")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO page_reminders (id, page_id, minutes_before, created_at) VALUES ('rem1', 'p1', 30, '2026-01-01')")
        .execute(&pool).await.unwrap();

    sqlx::raw_sql(MIGRATIONS[9].1).execute(&pool).await.unwrap();

    // Nothing the user had is gone.
    for (table, id) in [
        ("pages", "p1"),
        ("folders", "f1"),
        ("page_schedules", "s1"),
        ("page_recurrence_rules", "r1"),
        ("page_reminders", "rem1"),
    ] {
        let found: i64 =
            // sql-ok: table and id come from this test's own literal list
            sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table} WHERE id = '{id}'"))
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(found, 1, "{table} lost its row across 010");
    }

    // The folder gained the flag, defaulted off — an existing folder is nobody's
    // calendar, and a default of 1 would lock every folder the user already had.
    let external: i64 =
        sqlx::query_scalar("SELECT is_external_calendar FROM folders WHERE id = 'f1'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(external, 0);

    // A page from before sync existed has no link, so it reads as native.
    let linked: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM page_sync WHERE page_id = 'p1'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(linked, 0);

    // The new tables accept writes against the pre-existing page — a broken FK or
    // a missed table would only surface the first time sync or a completion ran.
    sqlx::query("INSERT INTO completed_set (page_id, occurrence_date, clone_id) VALUES ('p1', '2026-06-01', 'clone-1')")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO skip_set (page_id, occurrence_date) VALUES ('p1', '2026-06-08')")
        .execute(&pool)
        .await
        .unwrap();
}

/// The reconciler only rewrites an event whose etag moved, so a mirror synced
/// before 011 would stay out of the index forever if the migration didn't
/// backfill it. That backfill is a second, frozen copy of `mirror_search_text`'s
/// projection written in SQL — this is what catches the two drifting apart.
#[tokio::test]
async fn the_search_migration_backfills_mirrors_synced_before_it() {
    let pool = single_conn_memory_pool().await;
    for (name, sql) in &MIGRATIONS[..10] {
        sqlx::raw_sql(sql)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("migration {name} failed: {e}"));
    }

    sqlx::query(
        "INSERT INTO pages
         (id, title, content, content_text, status, priority, tags, sort_order, created_at, updated_at)
         VALUES ('p1', 'Standup', '{}', '', 'not_started', 0, '[]', 0, '2026-01-01', '2026-01-01')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO sync_account
         (id, provider, display_name, auth_kind, created_at, updated_at)
         VALUES ('a1', 'caldav', 'you@example.com', 'basic', '2026-01-01', '2026-01-01')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO page_sync
         (id, page_id, account_id, provider, calendar_id, external_id, ical_uid,
          mirror_location, mirror_attendees, created_at)
         VALUES ('ps1', 'p1', 'a1', 'caldav', 'cal', '/ev.ics', 'uid-1',
                 'Weyland Room', '[\"priya@example.com\"]', '2026-01-01')",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::raw_sql(MIGRATIONS[10].1)
        .execute(&pool)
        .await
        .unwrap();

    let projected: Option<String> =
        sqlx::query_scalar("SELECT mirror_search_text FROM pages WHERE id = 'p1'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        projected,
        crate::reconciler::mirror_search_text(
            Some("Weyland Room"),
            Some(r#"["priya@example.com"]"#)
        ),
        "the migration's SQL projection drifted from the writer's"
    );

    for term in ["weyland", "priya"] {
        let hits: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM pages_fts WHERE pages_fts MATCH ?")
                .bind(term)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(hits, 1, "the rebuilt index missed \"{term}\"");
    }
}

/// 012 recreates both notification tables to widen their CHECK constraints, and
/// a recreate is the migration shape that loses data when a column list drifts.
/// The reminder row and the fired-notification row here are what a user upgrading
/// mid-week actually has: dropping either would re-fire every reminder already
/// delivered and forget every per-page lead.
#[tokio::test]
async fn the_reach_migration_keeps_reminders_and_the_fired_log() {
    let pool = single_conn_memory_pool().await;
    for (name, sql) in &MIGRATIONS[..11] {
        sqlx::raw_sql(sql)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("migration {name} failed: {e}"));
    }

    sqlx::query(
        "INSERT INTO pages
         (id, title, content, content_text, status, priority, tags, sort_order, created_at, updated_at)
         VALUES ('p1', 'Standup', '{}', '', 'not_started', 0, '[]', 0, '2026-01-01', '2026-01-01')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO page_reminders (id, page_id, minutes_before, created_at)
         VALUES ('r1', 'p1', 15, '2026-01-01')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO notification_log (id, page_id, schedule_id, type, fired_at, action)
         VALUES ('n1', 'p1', 's1#15', 'reminder', '2026-01-02 08:45:00', 'opened')",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::raw_sql(MIGRATIONS[11].1)
        .execute(&pool)
        .await
        .unwrap();

    let lead: i64 = sqlx::query_scalar("SELECT minutes_before FROM page_reminders WHERE id = 'r1'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(lead, 15, "the per-page lead did not survive the recreate");
    let logged: (String, String) =
        sqlx::query_as("SELECT schedule_id, action FROM notification_log WHERE id = 'n1'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        logged,
        ("s1#15".to_string(), "opened".to_string()),
        "the dedup anchor did not survive the recreate"
    );

    // Both widenings are usable immediately after the migration, not just
    // declared — a CHECK typo would only surface on the first real write.
    sqlx::query(
        "INSERT INTO page_reminders (id, page_id, minutes_before, created_at)
         VALUES ('r2', 'p1', -2, '2026-01-01')",
    )
    .execute(&pool)
    .await
    .expect("the day-before sentinel must be storable");
    sqlx::query(
        "INSERT INTO notification_log (id, page_id, schedule_id, type, fired_at)
         VALUES ('n2', 'p1', 's2#10', 'suppressed', '2026-01-02 22:10:00')",
    )
    .execute(&pool)
    .await
    .expect("a quiet-hours suppression must be storable");
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
    sqlx::query(
        "DELETE FROM _sqlx_migrations WHERE version = (SELECT MAX(version) FROM _sqlx_migrations)",
    )
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
    assert_eq!(
        hits, 1,
        "snapshot's FTS index should be intact and searchable"
    );

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
    for ts in [
        "20260101T000000000Z",
        "20260102T000000000Z",
        "20260103T000000000Z",
        "20260104T000000000Z",
    ] {
        std::fs::write(
            dir.join(format!("pre-migration-{ts}-v8-to-v9.sqlite")),
            b"x",
        )
        .unwrap();
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
    assert!(!dir
        .join("pre-migration-20260101T000000000Z-v8-to-v9.sqlite")
        .exists());
    assert!(dir
        .join("pre-migration-20260104T000000000Z-v8-to-v9.sqlite")
        .exists());
    // Non-migration files untouched.
    assert!(dir.join("pre-import-20260101T000000Z.sqlite").exists());
    assert!(dir.join("notes.txt").exists());

    let _ = std::fs::remove_dir_all(&dir);
}

// ─── Shipped-workspace upgrades ──────────────────────────────────────────────
//
// Everything above builds its schema from empty, in this process. That misses
// the only migration run that can lose a user's data: the one where a database
// written by a *released* build meets a newer migrator. `tests/fixtures/
// workspaces/` holds one real file per shipped version, and the test below walks
// all of them, so covering a new release is adding a file rather than editing a
// test.

fn workspace_fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("workspaces")
}

fn shipped_workspace_fixtures() -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(workspace_fixture_dir())
        .expect("workspace fixture directory")
        .map(|e| e.expect("dir entry").path())
        .filter(|p| p.extension().is_some_and(|e| e == "sqlite"))
        .collect();
    found.sort();
    found
}

/// The fixtures exist to be migrated, so an empty directory has to fail rather
/// than pass vacuously — the loop below would otherwise report success having
/// checked nothing at all.
#[test]
fn every_shipped_version_has_a_workspace_fixture() {
    let found = shipped_workspace_fixtures();
    assert!(
        !found.is_empty(),
        "no .sqlite fixtures in {} — regenerate with `cargo test -p pikos-db \
         regenerate_shipped_workspace_fixture -- --ignored`",
        workspace_fixture_dir().display()
    );
}

#[tokio::test]
async fn a_shipped_workspace_migrates_forward_without_losing_anything() {
    for fixture in shipped_workspace_fixtures() {
        let name = fixture.file_name().unwrap().to_string_lossy().to_string();
        let dir = std::env::temp_dir().join(format!("pkos_upgrade_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("workspace.sqlite");
        std::fs::copy(&fixture, &path).expect("copy fixture");

        // The real entry point the app and the CLI both use: it migrates on connect.
        let pool = open_pool(path.to_str().unwrap())
            .await
            .unwrap_or_else(|e| panic!("{name} failed to open and migrate: {e:?}"));

        let count = |table: &'static str| {
            let pool = pool.clone();
            async move {
                // sql-ok: table name is a test-local literal, never user input.
                sqlx::query_scalar::<_, i64>(&format!("SELECT COUNT(*) FROM {table}"))
                    .fetch_one(&pool)
                    .await
                    .unwrap()
            }
        };

        // What the fixture was seeded with. A migration that rebuilds a table by
        // recreating it is the shape that drops rows, and 011 recreates the FTS
        // index outright.
        assert_eq!(count("folders").await, 2, "{name}: folders lost");
        assert_eq!(count("pages").await, 5, "{name}: pages lost");
        assert_eq!(count("page_schedules").await, 3, "{name}: schedules lost");
        assert_eq!(
            count("page_recurrence_rules").await,
            1,
            "{name}: recurrence rules lost"
        );
        assert_eq!(count("tags").await, 2, "{name}: tags lost");
        assert_eq!(count("page_tags").await, 2, "{name}: page_tags lost");
        assert_eq!(count("page_reminders").await, 1, "{name}: reminders lost");
        assert_eq!(
            count("focus_sessions").await,
            1,
            "{name}: focus sessions lost"
        );
        assert_eq!(
            count("notification_log").await,
            1,
            "{name}: notification log lost"
        );

        // Field-level survival on a page that carries every column a migration
        // touches, including the soft-delete flag 004 added.
        let (title, status, completed, deleted): (String, String, Option<String>, Option<String>) =
            sqlx::query_as("SELECT title, status, completed_at, deleted_at FROM pages WHERE id = ?")
                .bind("page-done")
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("{name}: the completed page is gone: {e:?}"));
        assert_eq!(title, "Ship the release");
        assert_eq!(status, "done");
        assert!(completed.is_some(), "{name}: completed_at cleared");
        assert!(deleted.is_none(), "{name}: a live page was soft-deleted");

        // The soft-deleted page must still be in the trash, not swept.
        let trashed: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM pages WHERE deleted_at IS NOT NULL")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(trashed, 1, "{name}: the trashed page did not survive");

        // 010-012 are what this upgrade is for.
        let tables = table_names(&pool).await;
        for expected in [
            "sync_account",
            "sync_calendar",
            "page_sync",
            "completed_set",
            "skip_set",
        ] {
            assert!(
                tables.iter().any(|t| t == expected),
                "{name}: {expected} missing after upgrade; have {tables:?}"
            );
        }

        // 011 rebuilds the search index. A backfill that skips existing rows
        // leaves every page written before the upgrade unfindable, with every
        // other check here still green.
        sqlx::query("INSERT INTO pages_fts(pages_fts) VALUES('integrity-check')")
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("{name}: pages_fts failed integrity-check: {e:?}"));
        let hits: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM pages_fts WHERE pages_fts MATCH 'tarragon'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            hits, 1,
            "{name}: a page written before the upgrade is not in the search index"
        );

        pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Writes `tests/fixtures/workspaces/0.3.1.sqlite` by running the migrations that
/// version actually shipped, then seeding it. Ignored because it writes into the
/// source tree; run it once per release, with the new version's list:
///
///   cargo test -p pikos-db regenerate_shipped_workspace_fixture -- --ignored
///
/// It goes through sqlx rather than raw SQL so `_sqlx_migrations` carries the
/// same bookkeeping and checksums a real install has. A hand-built table there
/// makes the next migrator refuse the file, which is the failure this whole
/// fixture exists to catch, arriving in the fixture instead of in the product.
#[tokio::test]
#[ignore]
async fn regenerate_shipped_workspace_fixture() {
    const SHIPPED_IN_0_3_1: &[&str] = &[
        "001_initial.sql",
        "002_drop_duration_mins.sql",
        "003_tags_normalize.sql",
        "004_soft_delete.sql",
        "005_folder_soft_delete.sql",
        "006_notifications.sql",
        "007_reminder_none_sentinel.sql",
        "008_tags_nocase.sql",
        "009_tags_lowercase.sql",
    ];

    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let staged = std::env::temp_dir().join(format!("pkos_mig_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&staged).unwrap();
    for name in SHIPPED_IN_0_3_1 {
        std::fs::copy(source.join(name), staged.join(name))
            .unwrap_or_else(|e| panic!("{name} is not in {}: {e}", source.display()));
    }

    let work = std::env::temp_dir().join(format!("pkos_fix_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&work).unwrap();
    let path = work.join("0.3.1.sqlite");

    let opts = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .unwrap();

    Migrator::new(staged.as_path())
        .await
        .expect("read the staged migrations")
        .run(&pool)
        .await
        .expect("apply the 0.3.1 migrations");

    seed_shipped_workspace(&pool).await;
    // Committed file, so it is worth the pages SQLite would otherwise leave
    // allocated: ~205KB of mostly-empty pages down to a few tens of KB.
    sqlx::query("VACUUM").execute(&pool).await.unwrap();
    pool.close().await;

    let target = workspace_fixture_dir();
    std::fs::create_dir_all(&target).unwrap();
    std::fs::copy(&path, target.join("0.3.1.sqlite")).expect("write the fixture");

    let _ = std::fs::remove_dir_all(&staged);
    let _ = std::fs::remove_dir_all(&work);

    assert!(
        target.join("0.3.1.sqlite").exists(),
        "the fixture was not written"
    );
}

/// A workspace with one row of every shape a migration touches, written in the
/// 0.3.1 schema. "tarragon" appears in one page's body and nowhere else: it is
/// what proves the search index was backfilled rather than merely rebuilt empty.
async fn seed_shipped_workspace(pool: &SqlitePool) {
    let t = "2026-07-01T09:00:00";

    for (id, name, deleted) in [
        ("folder-work", "Work", None::<&str>),
        ("folder-old", "Archived", Some("2026-07-02T09:00:00")),
    ] {
        sqlx::query(
            "INSERT INTO folders (id, name, parent_id, sort_order, color, icon, created_at, updated_at, deleted_at)
             VALUES (?, ?, NULL, 0, NULL, NULL, ?, ?, ?)",
        )
        .bind(id).bind(name).bind(t).bind(t).bind(deleted)
        .execute(pool).await.unwrap();
    }

    /// One seeded page. Named because a seven-wide tuple of `&str` and
    /// `Option<&str>` is unreadable at the call sites below, where the whole
    /// point is being able to see which column is which.
    struct SeedPage {
        id: &'static str,
        title: &'static str,
        text: &'static str,
        status: &'static str,
        completed_at: Option<&'static str>,
        deleted_at: Option<&'static str>,
        folder_id: Option<&'static str>,
    }

    let pages = [
        SeedPage {
            completed_at: None,
            deleted_at: None,
            folder_id: Some("folder-work"),
            id: "page-plain",
            status: "not_started",
            text: "A note about tarragon and butter.",
            title: "Weeknight pasta",
        },
        SeedPage {
            completed_at: Some("2026-07-03T18:00:00"),
            deleted_at: None,
            folder_id: Some("folder-work"),
            id: "page-done",
            status: "done",
            text: "Cut the tag.",
            title: "Ship the release",
        },
        SeedPage {
            completed_at: None,
            deleted_at: None,
            folder_id: None,
            id: "page-sched",
            status: "not_started",
            text: "",
            title: "Dentist",
        },
        SeedPage {
            completed_at: None,
            deleted_at: None,
            folder_id: Some("folder-work"),
            id: "page-recurring",
            status: "not_started",
            text: "",
            title: "Standup",
        },
        SeedPage {
            completed_at: None,
            deleted_at: Some("2026-07-04T10:00:00"),
            folder_id: None,
            id: "page-trashed",
            status: "not_started",
            text: "",
            title: "Abandoned draft",
        },
    ];
    for page in &pages {
        let text = page.text;
        let content = format!(
            r#"{{"type":"doc","content":[{{"type":"paragraph","content":[{{"type":"text","text":"{text}"}}]}}]}}"#
        );
        sqlx::query(
            "INSERT INTO pages (id, folder_id, title, subtitle, content, content_text, status,
                                priority, tags, sort_order, scheduled_start, scheduled_end,
                                completed_at, links, parent_id, last_opened_at, created_at,
                                updated_at, deleted_at)
             VALUES (?, ?, ?, NULL, ?, ?, ?, 0, '[]', 0, NULL, NULL, ?, NULL, NULL, NULL, ?, ?, ?)",
        )
        .bind(page.id)
        .bind(page.folder_id)
        .bind(page.title)
        .bind(&content)
        .bind(page.text)
        .bind(page.status)
        .bind(page.completed_at)
        .bind(t)
        .bind(t)
        .bind(page.deleted_at)
        .execute(pool)
        .await
        .unwrap();
    }

    for (id, page, start) in [
        ("sched-1", "page-sched", "2026-07-10T09:00:00"),
        ("sched-2", "page-recurring", "2026-07-11T09:00:00"),
        ("sched-3", "page-recurring", "2026-07-12T09:00:00"),
    ] {
        sqlx::query(
            "INSERT INTO page_schedules (id, page_id, scheduled_start, scheduled_end, timezone,
                                         rule_id, original_date, status, created_at)
             VALUES (?, ?, ?, NULL, NULL, NULL, NULL, 'scheduled', ?)",
        )
        .bind(id)
        .bind(page)
        .bind(start)
        .bind(t)
        .execute(pool)
        .await
        .unwrap();
    }

    sqlx::query(
        "INSERT INTO page_recurrence_rules (id, page_id, rrule, rrule_exdates, scheduled_start,
                                            scheduled_end, timezone, created_at)
         VALUES ('rule-1', 'page-recurring', 'FREQ=WEEKLY;BYDAY=MO', '[]', '2026-07-11T09:00:00',
                 NULL, 'Europe/London', ?)",
    )
    .bind(t)
    .execute(pool)
    .await
    .unwrap();

    for (id, name) in [("tag-work", "work"), ("tag-food", "food")] {
        sqlx::query("INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)")
            .bind(id)
            .bind(name)
            .bind(t)
            .execute(pool)
            .await
            .unwrap();
    }
    for (page, tag) in [("page-plain", "tag-food"), ("page-done", "tag-work")] {
        sqlx::query("INSERT INTO page_tags (page_id, tag_id) VALUES (?, ?)")
            .bind(page)
            .bind(tag)
            .execute(pool)
            .await
            .unwrap();
    }

    sqlx::query(
        "INSERT INTO page_reminders (id, page_id, minutes_before, created_at)
         VALUES ('rem-1', 'page-sched', 15, ?)",
    )
    .bind(t)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO focus_sessions (id, page_id, started_at, ended_at, duration_s)
         VALUES ('focus-1', 'page-plain', ?, '2026-07-01T09:25:00', 1500)",
    )
    .bind(t)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO notification_log (id, page_id, schedule_id, type, fired_at, action)
         VALUES ('notif-1', 'page-sched', 'sched-1', 'reminder', ?, NULL)",
    )
    .bind(t)
    .execute(pool)
    .await
    .unwrap();
}
