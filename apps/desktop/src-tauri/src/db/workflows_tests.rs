// Cross-module workflow tests: the integration layer above pikos-db's per-module unit suites.
//
// Each module is unit-tested against `test_pool()`. These prove they compose the way the
// app drives them, against ONE pool with the FTS triggers, foreign-key cascades and the
// pages.tags <-> page_tags denorm all firing together. They live in the desktop crate
// because they assert how the desktop app composes pikos-db.
//
// They enter at `*_impl` rather than the Tauri shims, which only resolve the pool and
// delegate. The wire below the shims is `ipc_tests.rs`; asset and export shims stay out
// of both because they would write to real OS locations under a mock runtime.
//
// Two groups: `test_pool()` (in-memory, FK-on, full migration tree) for multi-step
// workflows, and `open_pool()` on a real file for what an in-memory pool can't honestly
// assert: WAL pragmas, FK cascade enforcement, and FTS triggers on live writes.

use pikos_db::*;
use sqlx::SqlitePool;

fn new_page(title: &str) -> NewPage {
    NewPage {
        id: None,
        folder_id: None,
        title: title.to_string(),
        subtitle: None,
        content: "{}".to_string(),
        status: "not_started".to_string(),
        priority: 0,
        tags: vec![],
        scheduled_start: None,
        scheduled_end: None,
        completed_at: None,
        parent_id: None,
        last_opened_at: None,
        created_at: None,
        updated_at: None,
    }
}

async fn count(pool: &SqlitePool, table: &str, page_id: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT COUNT(*) FROM {table} WHERE page_id = ?"
    ))) // sql-ok:
    .bind(page_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn recurring_completion_clone_is_searchable() {
    let pool = test_pool().await;

    let mut head = new_page("Standup");
    head.content = pikos_db::build_tiptap_doc("daily standup notes");
    head.tags = vec!["work".to_string()];
    head.scheduled_start = Some("2026-05-29T09:00:00".to_string());
    let head = create_page_impl(&pool, head).await.unwrap();

    create_page_schedule_impl(
        &pool,
        NewPageSchedule {
            page_id: head.id.clone(),
            scheduled_start: "2026-05-29T09:00:00".to_string(),
            scheduled_end: None,
            timezone: Some("America/New_York".to_string()),
            rule_id: None,
            original_date: None,
        },
    )
    .await
    .unwrap();

    create_recurrence_rule_impl(
        &pool,
        NewRecurrenceRule {
            page_id: head.id.clone(),
            rrule: "FREQ=DAILY".to_string(),
            rrule_exdates: vec![],
            scheduled_start: "2026-05-29T09:00:00".to_string(),
            scheduled_end: None,
            timezone: "America/New_York".to_string(),
        },
    )
    .await
    .unwrap();

    let result = complete_recurring_page_impl(
        &pool,
        CompleteRecurringInput {
            page_id: head.id.clone(),
            occurrence_date: None,
            scheduled_start: None,
            scheduled_end: None,
            expected_occurrence_date: None,
        },
    )
    .await
    .unwrap();

    assert_eq!(result.clone.status, "done");
    assert_eq!(result.head.status, "not_started");
    assert_eq!(
        result.head.scheduled_start.as_deref(),
        Some("2026-05-30T09:00:00")
    );
    assert_ne!(result.clone.id, head.id);
    assert_eq!(result.clone.tags, vec!["work".to_string()]);

    let open = search_pages_impl(&pool, "Standup".to_string(), Some(false))
        .await
        .unwrap();
    assert_eq!(
        open.results.len(),
        1,
        "open search should see only the head"
    );
    assert_eq!(open.results[0].id, head.id);
    assert_eq!(
        open.completed_count, 1,
        "the clone counts as a completed match"
    );

    let all = search_pages_impl(&pool, "Standup".to_string(), Some(true))
        .await
        .unwrap();
    let ids: Vec<&str> = all.results.iter().map(|r| r.id.as_str()).collect();
    assert!(
        ids.contains(&result.clone.id.as_str()),
        "completed clone must be searchable"
    );
    assert!(ids.contains(&head.id.as_str()));
}

/// The hard folder delete soft-deletes its pages, then `ON DELETE SET NULL` orphans them to the
/// inbox. Their schedules survive, since the page rows still exist.
#[tokio::test]
async fn hard_folder_delete_soft_deletes_pages_nulls_folder_and_keeps_schedules() {
    let pool = test_pool().await;
    let folder = create_folder_impl(
        &pool,
        NewFolder {
            name: "Work".to_string(),
            parent_id: None,
            color: None,
            icon: None,
        },
    )
    .await
    .unwrap();

    let mut p = new_page("In folder");
    p.folder_id = Some(folder.id.clone());
    p.tags = vec!["work".to_string()];
    let page = create_page_impl(&pool, p).await.unwrap();

    create_page_schedule_impl(
        &pool,
        NewPageSchedule {
            page_id: page.id.clone(),
            scheduled_start: "2026-06-01T09:00:00".to_string(),
            scheduled_end: None,
            timezone: None,
            rule_id: None,
            original_date: None,
        },
    )
    .await
    .unwrap();

    delete_folder_impl(&pool, folder.id.clone()).await.unwrap();

    assert!(get_folder_impl(&pool, &folder.id).await.unwrap().is_none());

    let row = get_page(&pool, &page.id)
        .await
        .unwrap()
        .expect("page row survives");
    assert!(
        row.folder_id.is_none(),
        "FK ON DELETE SET NULL should null folder_id"
    );
    let deleted_at: Option<String> =
        sqlx::query_scalar("SELECT deleted_at FROM pages WHERE id = ?")
            .bind(&page.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        deleted_at.is_some(),
        "page should be soft-deleted, not hard-removed"
    );

    assert_eq!(count(&pool, "page_schedules", &page.id).await, 1);
}

#[tokio::test]
async fn soft_folder_delete_then_restore_round_trips_pages() {
    let pool = test_pool().await;
    let folder = create_folder_impl(
        &pool,
        NewFolder {
            name: "Work".to_string(),
            parent_id: None,
            color: None,
            icon: None,
        },
    )
    .await
    .unwrap();

    let mut p = new_page("In folder");
    p.folder_id = Some(folder.id.clone());
    let page = create_page_impl(&pool, p).await.unwrap();

    soft_delete_folder_impl(&pool, folder.id.clone())
        .await
        .unwrap();

    assert!(list_folders_impl(&pool).await.unwrap().is_empty());
    assert!(list_pages_impl(&pool, None).await.unwrap().is_empty());
    let row = get_page(&pool, &page.id).await.unwrap().unwrap();
    assert_eq!(row.folder_id.as_deref(), Some(folder.id.as_str()));

    restore_folder_impl(&pool, folder.id.clone()).await.unwrap();

    assert_eq!(list_folders_impl(&pool).await.unwrap().len(), 1);
    let pages = list_pages_impl(&pool, None).await.unwrap();
    assert_eq!(
        pages.len(),
        1,
        "the folder's page should come back from trash"
    );
    assert_eq!(pages[0].id, page.id);
}

/// `pages.tags` (JSON, FTS-indexed) and the `page_tags` join (queried) must agree after every write.
#[tokio::test]
async fn tag_writes_normalize_and_keep_denorm_in_sync() {
    let pool = test_pool().await;

    let mut p = new_page("Tagged");
    p.tags = vec![
        "Work".to_string(),
        "  work  ".to_string(),
        "Urgent".to_string(),
    ];
    let page = create_page_impl(&pool, p).await.unwrap();

    assert_eq!(page.tags, vec!["work".to_string(), "urgent".to_string()]);
    assert_eq!(count(&pool, "page_tags", &page.id).await, 2);
    assert_denorm_matches_join(&pool, &page.id).await;

    let updated = update_page_impl(
        &pool,
        page.id.clone(),
        PageUpdate {
            tags: Some(vec!["Urgent".to_string(), "new".to_string()]),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    assert_eq!(updated.tags, vec!["urgent".to_string(), "new".to_string()]);
    assert_eq!(count(&pool, "page_tags", &page.id).await, 2);
    assert_denorm_matches_join(&pool, &page.id).await;

    // Autocomplete reads the global tags table, which update doesn't GC.
    let mut suggestions = search_tags(&pool, "").await.unwrap();
    suggestions.sort();
    assert_eq!(suggestions, vec!["new", "urgent", "work"]);
}

async fn assert_denorm_matches_join(pool: &SqlitePool, page_id: &str) {
    let denorm: String = sqlx::query_scalar("SELECT tags FROM pages WHERE id = ?")
        .bind(page_id)
        .fetch_one(pool)
        .await
        .unwrap();
    let mut denorm: Vec<String> = serde_json::from_str(&denorm).unwrap();
    denorm.sort();

    let mut joined: Vec<String> = sqlx::query_scalar(
        "SELECT t.name FROM page_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.page_id = ?",
    )
    .bind(page_id)
    .fetch_all(pool)
    .await
    .unwrap();
    joined.sort();

    assert_eq!(
        denorm, joined,
        "pages.tags JSON must equal the page_tags join"
    );
}

fn body_linking(ids: &[&str]) -> String {
    let links: Vec<serde_json::Value> = ids
        .iter()
        .map(|id| serde_json::json!({ "type": "pageLink", "attrs": { "pageId": id, "title": "" } }))
        .collect();
    serde_json::json!({ "type": "doc", "content": [{ "type": "paragraph", "content": links }] })
        .to_string()
}

#[tokio::test]
async fn page_links_follow_the_body_through_create_and_update() {
    let pool = test_pool().await;

    let mut p = new_page("Linker");
    p.content = body_linking(&["page-a", "page-b", "page-a"]);
    let page = create_page_impl(&pool, p).await.unwrap();
    assert_eq!(page.links, vec!["page-a".to_string(), "page-b".to_string()]);

    let updated = update_page_impl(
        &pool,
        page.id.clone(),
        PageUpdate {
            content: Some(body_linking(&["page-c"])),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(updated.links, vec!["page-c".to_string()]);

    let untouched = update_page_impl(
        &pool,
        page.id.clone(),
        PageUpdate {
            title: Some("Renamed".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(untouched.links, vec!["page-c".to_string()]);
}

//
// A `:memory:` pool reports a different journal_mode and starts empty on reopen, so these use a
// unique temp file and clean up the DB + WAL/SHM sidecars.

struct TempDb {
    path: String,
}

impl TempDb {
    fn new(tag: &str) -> Self {
        let path = std::env::temp_dir()
            .join(format!("pkos_wf_{tag}_{}.db", uuid::Uuid::new_v4()))
            .to_string_lossy()
            .to_string();
        TempDb { path }
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", self.path));
        }
    }
}

/// The WAL and foreign_keys pragmas make concurrent access with the CLI safe.
#[tokio::test]
async fn open_pool_sets_wal_and_foreign_keys() {
    let db = TempDb::new("pragmas");
    let pool = open_pool(&db.path).await.unwrap();

    let journal: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(journal.to_lowercase(), "wal", "open_pool must enable WAL");

    let fk: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(fk, 1, "foreign keys must be enforced");

    pool.close().await;
}

/// Proves the FKs are enforced, not just declared: `ON DELETE CASCADE` children go, while
/// `SET NULL` (focus_sessions) keeps its row.
#[tokio::test]
async fn open_pool_enforces_fk_cascade_on_hard_delete() {
    let db = TempDb::new("cascade");
    let pool = open_pool(&db.path).await.unwrap();

    let mut p = new_page("Cascade me");
    p.tags = vec!["work".to_string()];
    let page = create_page_impl(&pool, p).await.unwrap();

    create_page_schedule_impl(
        &pool,
        NewPageSchedule {
            page_id: page.id.clone(),
            scheduled_start: "2026-06-01T09:00:00".to_string(),
            scheduled_end: None,
            timezone: None,
            rule_id: None,
            original_date: None,
        },
    )
    .await
    .unwrap();
    create_recurrence_rule_impl(
        &pool,
        NewRecurrenceRule {
            page_id: page.id.clone(),
            rrule: "FREQ=DAILY".to_string(),
            rrule_exdates: vec![],
            scheduled_start: "2026-06-01T09:00:00".to_string(),
            scheduled_end: None,
            timezone: "America/New_York".to_string(),
        },
    )
    .await
    .unwrap();
    create_page_reminder(&pool, &page.id, 10).await.unwrap();

    sqlx::query(
        "INSERT INTO focus_sessions (id, page_id, started_at, duration_s) VALUES (?, ?, ?, ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(&page.id)
    .bind(now_iso())
    .bind(300_i64)
    .execute(&pool)
    .await
    .unwrap();

    assert_eq!(count(&pool, "page_schedules", &page.id).await, 1);
    assert_eq!(count(&pool, "page_recurrence_rules", &page.id).await, 1);
    assert_eq!(count(&pool, "page_reminders", &page.id).await, 1);
    assert_eq!(count(&pool, "page_tags", &page.id).await, 1);

    delete_page_impl(&pool, &page.id).await.unwrap();

    assert_eq!(
        count(&pool, "page_schedules", &page.id).await,
        0,
        "schedules should cascade"
    );
    assert_eq!(
        count(&pool, "page_recurrence_rules", &page.id).await,
        0,
        "rule should cascade"
    );
    assert_eq!(
        count(&pool, "page_reminders", &page.id).await,
        0,
        "reminders should cascade"
    );
    assert_eq!(
        count(&pool, "page_tags", &page.id).await,
        0,
        "tag links should cascade"
    );

    let orphaned: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM focus_sessions WHERE page_id IS NULL")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        orphaned, 1,
        "focus_sessions is ON DELETE SET NULL, not CASCADE"
    );

    pool.close().await;
}

/// The per-module search tests seed rows directly and don't prove the triggers fire against `open_pool`.
#[tokio::test]
async fn open_pool_fts_triggers_track_writer_inserts_updates_deletes() {
    let db = TempDb::new("fts");
    let pool = open_pool(&db.path).await.unwrap();

    let page = create_page_impl(&pool, new_page("Artichoke"))
        .await
        .unwrap();
    let hits = search_pages_impl(&pool, "Artichoke".to_string(), Some(false))
        .await
        .unwrap();
    assert_eq!(
        hits.results.len(),
        1,
        "insert trigger should index the new page"
    );

    update_page_impl(
        &pool,
        page.id.clone(),
        PageUpdate {
            title: Some("Broccoli".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert!(
        search_pages_impl(&pool, "Artichoke".to_string(), Some(false))
            .await
            .unwrap()
            .results
            .is_empty(),
        "update trigger should drop the stale title from the index"
    );
    assert_eq!(
        search_pages_impl(&pool, "Broccoli".to_string(), Some(false))
            .await
            .unwrap()
            .results
            .len(),
        1,
        "update trigger should index the new title"
    );

    delete_page_impl(&pool, &page.id).await.unwrap();
    assert!(
        search_pages_impl(&pool, "Broccoli".to_string(), Some(false))
            .await
            .unwrap()
            .results
            .is_empty(),
        "delete trigger should remove the page from the index"
    );

    pool.close().await;
}

// Pruning the reminder log and sweeping the trash change nothing the workspace's integrity rests
// on, so either failing still lets the workspace open.

#[tokio::test]
async fn a_workspace_opens_when_pruning_the_notification_log_fails() {
    let db = TempDb::new("prune");
    let pool = open_pool(&db.path).await.unwrap();
    sqlx::query("DROP TABLE notification_log")
        .execute(&pool)
        .await
        .unwrap();
    close_pool(&pool).await;

    let pool = super::open_pool(&db.path)
        .await
        .expect("a failed prune kept the workspace from opening");
    close_pool(&pool).await;
}

#[tokio::test]
async fn a_workspace_opens_when_sweeping_the_trash_fails() {
    let db = TempDb::new("sweep");
    let pool = open_pool(&db.path).await.unwrap();
    insert_test_page(&pool, TestPage::new("old", "Trashed long ago"))
        .await
        .unwrap();
    sqlx::query("UPDATE pages SET deleted_at = '2000-01-01T00:00:00.000Z' WHERE id = 'old'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "CREATE TRIGGER held BEFORE DELETE ON pages BEGIN SELECT RAISE(ABORT, 'held'); END",
    )
    .execute(&pool)
    .await
    .unwrap();
    close_pool(&pool).await;

    let pool = super::open_pool(&db.path)
        .await
        .expect("a failed trash sweep kept the workspace from opening");
    let kept: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pages WHERE id = 'old'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(kept, 1, "the sweep's page is left for the next launch");
    close_pool(&pool).await;
}

#[test]
fn a_sweep_that_finds_the_workspace_damaged_still_fails_the_open() {
    let damaged = super::carry_on_after(
        "sweeping the trash",
        AppError::Corrupt("database disk image is malformed".into()),
    )
    .unwrap_err();
    assert_eq!(damaged.kind(), "Corrupt");
    assert!(
        damaged.to_string().contains("sweeping the trash"),
        "{damaged}"
    );

    assert!(super::carry_on_after(
        "sweeping the trash",
        AppError::Internal("anything else".into())
    )
    .is_ok());
}
