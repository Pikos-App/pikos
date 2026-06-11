// Cross-module workflow tests — the integration layer above pikos-db's
// per-module `*_tests.rs` unit suites.
//
// WHY THIS FILE EXISTS (architecture decision):
// Each pikos-db writer module already has thorough unit coverage against
// `test_pool()`. What those suites don't prove is that the modules compose the
// way the desktop app actually drives them: a page created in `pages`, scheduled
// in `schedules`, completed through the recurring path, then found again via
// `search` — all against ONE pool, with the FTS triggers, foreign-key cascades
// and the pages.tags⇄page_tags denorm invariant all firing together. These are
// the behaviours a per-module unit test can't see and that production QA
// otherwise has to verify by hand.
//
// WHY IT LIVES IN THE DESKTOP CRATE (not pikos-db):
// CI runs every Rust step from `apps/desktop/src-tauri` (see
// .github/workflows/_validate.yml, `working-directory`). The root workspace
// *excludes* that package, so `cargo test --all` there compiles pikos-db only as
// a normal dependency and never runs pikos-db's own `#[cfg(test)]` modules.
// Tests placed in pikos-db pass under `cargo test -p pikos-db` locally but would
// be invisible to CI. The desktop crate's dev-deps enable pikos-db's
// `test-support` feature precisely so its tests can reuse `test_pool` /
// `insert_test_*` against the production migration tree — so these live here,
// where CI actually executes them, and call pikos-db's public API.
//
// We test at the impl/pool level rather than through the Tauri command shims via
// MockRuntime. The shims are deliberately thin (`state.get_pool().await?;
// delegate to *_impl`) and carry no logic worth a MockRuntime harness — and the
// asset/export shims resolve `app_data_dir()` / `$HOME/Downloads`, which under a
// mock runtime would write to real OS locations. The data logic lives in the
// `*_impl` functions, so that's where the value is. The export → re-import
// round-trip and the asset-copy coverage live alongside the
// `build_export_json_impl` / `save_asset` code they exercise (db/dev, db/assets).
//
// Two groups below:
//   1. `test_pool()` (in-memory, FK-on, full migration tree) for the multi-step
//      workflows.
//   2. `open_pool()` against a real on-disk file for the things an in-memory or
//      mocked pool can't honestly assert: WAL + pragmas, FK cascade enforcement,
//      and the FTS triggers firing on live insert/update/delete.

use pikos_db::*;
use sqlx::SqlitePool;

// ── builders ────────────────────────────────────────────────────────────────

fn new_page(title: &str) -> NewPage {
    NewPage {
        folder_id: None,
        title: title.to_string(),
        subtitle: None,
        content: "{}".to_string(),
        content_text: None,
        status: "not_started".to_string(),
        priority: 0,
        tags: vec![],
        scheduled_start: None,
        scheduled_end: None,
        completed_at: None,
        links: vec![],
        parent_id: None,
        last_opened_at: None,
        created_at: None,
        updated_at: None,
    }
}

async fn count(pool: &SqlitePool, table: &str, page_id: &str) -> i64 {
    // `table` is a test-local literal, never user input.
    sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table} WHERE page_id = ?")) // sql-ok:
        .bind(page_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

// ── 1. create → schedule → complete recurring head → search finds the clone ──

/// The headline workflow: a recurring task is scheduled, the current occurrence
/// is completed (which clones a "done" snapshot and advances the head to the
/// next occurrence), and unified search then surfaces that completed clone.
/// Exercises pages + schedules + recurrence + the FTS insert/update triggers in
/// one pool, the way the desktop app drives a recurring-task completion.
#[tokio::test]
async fn recurring_completion_clone_is_searchable() {
    let pool = test_pool().await;

    // A recurring "Standup" task with content text + a tag.
    let mut head = new_page("Standup");
    head.content_text = Some("daily standup notes".to_string());
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

    // Complete today's occurrence and advance the head to tomorrow.
    let result = complete_recurring_page_impl(
        &pool,
        CompleteRecurringInput {
            page_id: head.id.clone(),
            next_scheduled_start: Some("2026-05-30T09:00:00".to_string()),
            next_scheduled_end: None,
            rule_id: None,
            add_exdates: None,
        },
    )
    .await
    .unwrap();

    // The clone is a done snapshot of the occurrence just completed; the head
    // stays open, advanced to the next date.
    assert_eq!(result.clone.status, "done");
    assert_eq!(result.head.status, "not_started");
    assert_eq!(
        result.head.scheduled_start.as_deref(),
        Some("2026-05-30T09:00:00")
    );
    assert_ne!(result.clone.id, head.id);
    // Clone inherits the head's tags through the same tag-sync path.
    assert_eq!(result.clone.tags, vec!["work".to_string()]);

    // Excluding completed: only the still-open head matches.
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

    // Including completed: the FTS insert trigger fired for the clone, so it is
    // now findable. Both head and clone match the title.
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

// ── 2. folder deletion: the two paths behave differently ─────────────────────

/// `delete_folder_impl` is the HARD folder delete. It soft-deletes the folder's
/// pages, then `DELETE`s the folder row — at which point the `ON DELETE SET
/// NULL` FK orphans those (now-trashed) pages to the inbox. Crucially it does
/// NOT remove their schedules.
///
/// This documents the actual behaviour: the task framing ("folder cascade-delete
/// removes the folder's pages, schedules, and links") is not what the code does.
/// Pages are soft-deleted (recoverable from trash, not hard-removed), schedules
/// survive, and folder_id is nulled by the FK rather than left dangling.
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

    // Folder row is hard-gone.
    assert!(get_folder_impl(&pool, &folder.id).await.unwrap().is_none());

    // The page is soft-deleted (still on disk, deleted_at stamped) and the FK
    // SET NULL has orphaned it to the inbox.
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

    // Schedules are NOT cascaded away by a hard folder delete (pages were only
    // soft-deleted, so the page row — and its schedule FK — still exist).
    assert_eq!(count(&pool, "page_schedules", &page.id).await, 1);
}

/// `soft_delete_folder_impl` is the reversible path used by the sidebar: it
/// stamps the folder and its pages with the same `deleted_at`, leaves folder_id
/// intact, and `restore_folder_impl` revives exactly that cohort.
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

    // Both vanish from the live listings...
    assert!(list_folders_impl(&pool).await.unwrap().is_empty());
    assert!(list_pages_impl(&pool, None).await.unwrap().is_empty());
    // ...but folder_id is preserved (unlike the hard-delete path).
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

// ── 3. tag writes round-trip + the pages.tags ⇄ page_tags invariant ──────────

/// Asserts the denorm invariant the migration skill calls out: `pages.tags`
/// (JSON, FTS-indexed) and the `page_tags` join (queried) must agree after every
/// write, with tags normalised (trimmed, lowercased, de-duped) on the way in.
#[tokio::test]
async fn tag_writes_normalize_and_keep_denorm_in_sync() {
    let pool = test_pool().await;

    // Mixed case + whitespace + a duplicate collapse to two canonical tags.
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

    // Update to a new set: "work" association drops, "urgent" stays, "new" adds.
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

    // Autocomplete reads the global tags table (work survives there even though
    // the page no longer references it — the tags table is not GC'd on update).
    let mut suggestions = search_tags(&pool, "").await.unwrap();
    suggestions.sort();
    assert_eq!(suggestions, vec!["new", "urgent", "work"]);
}

/// The pages.tags JSON denorm must list exactly the tag names joined through
/// page_tags — no more, no less.
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

// ── 4. page links round-trip on save ─────────────────────────────────────────

/// `links` is a plain JSON-array column on `pages` (there is no separate
/// `page_links` table and no server-side reconciliation — wikilink resolution is
/// a frontend concern). This pins the writer contract: links round-trip verbatim
/// through create and are fully replaced on update.
#[tokio::test]
async fn page_links_round_trip_through_create_and_update() {
    let pool = test_pool().await;

    let mut p = new_page("Linker");
    p.links = vec!["page-a".to_string(), "page-b".to_string()];
    let page = create_page_impl(&pool, p).await.unwrap();
    assert_eq!(page.links, vec!["page-a".to_string(), "page-b".to_string()]);

    let updated = update_page_impl(
        &pool,
        page.id.clone(),
        PageUpdate {
            links: Some(vec!["page-c".to_string()]),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(
        updated.links,
        vec!["page-c".to_string()],
        "update replaces the link set"
    );

    // An update that doesn't touch links must leave them intact.
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

// ── 5. the real open_pool path: WAL + pragmas, FK cascade, live FTS triggers ──
//
// These need a real on-disk file (a `:memory:` pool reports a different
// journal_mode and starts empty on reopen), so each test uses a unique temp path
// and cleans up the DB + WAL/SHM sidecars.

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

/// `open_pool` must apply the WAL journal mode and foreign_keys pragmas the
/// desktop app relies on for safe concurrent access with the CLI. A fresh
/// on-disk workspace is the only honest way to assert journal_mode = wal.
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

/// On the real pool, hard-deleting a page must cascade to every child table that
/// declares `ON DELETE CASCADE` (schedules, recurrence rule, reminders, the
/// page_tags join) while a `SET NULL` reference (focus_sessions) keeps the row
/// and nulls the link. Proves the FKs are actually enforced end-to-end, not just
/// declared in the schema.
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

    // A focus session references the page via ON DELETE SET NULL.
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

    // Sanity: everything is wired up before the delete.
    assert_eq!(count(&pool, "page_schedules", &page.id).await, 1);
    assert_eq!(count(&pool, "page_recurrence_rules", &page.id).await, 1);
    assert_eq!(count(&pool, "page_reminders", &page.id).await, 1);
    assert_eq!(count(&pool, "page_tags", &page.id).await, 1);

    delete_page_impl(&pool, &page.id).await.unwrap();

    // CASCADE children are gone.
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

    // SET NULL child survives with a nulled page_id.
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

/// The FTS index is trigger-maintained (insert/update/delete) on the live
/// `pages` table. Drive each writer through the real pool and confirm search
/// reflects the change immediately — the guarantee the per-module search tests
/// (which seed rows directly) don't make against `open_pool`.
#[tokio::test]
async fn open_pool_fts_triggers_track_writer_inserts_updates_deletes() {
    let db = TempDb::new("fts");
    let pool = open_pool(&db.path).await.unwrap();

    // INSERT trigger: a created page is immediately searchable by title.
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

    // UPDATE trigger: the old title stops matching, the new one starts.
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

    // DELETE trigger: a hard-deleted page leaves no FTS residue.
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
