use super::*;
use crate::db::DbState;
use pikos_db::{
    create_folder_impl, create_page_impl, insert_test_folder, insert_test_page, list_folders_impl,
    list_pages_impl, now_iso, test_pool, NewFolder, NewPage, TestPage,
};
use sqlx::SqlitePool;
use std::collections::HashMap;

// ── Local insert helpers ──────────────────────────────────────────────────────
// `insert_test_page` always writes content='{}', priority=0, no completed_at /
// parent_id. These helpers reach the columns the dev queries actually read.

/// Insert a page with explicit content JSON, plain text, priority and tags.
async fn insert_rich_page(
    pool: &SqlitePool,
    id: &str,
    title: &str,
    content: &str,
    content_text: &str,
    priority: i64,
    tags_json: &str,
) {
    let now = now_iso();
    sqlx::query(
        "INSERT INTO pages
         (id, title, content, content_text, status, priority, tags, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'not_started', ?, ?, 0, ?, ?)",
    )
    .bind(id)
    .bind(title)
    .bind(content)
    .bind(content_text)
    .bind(priority)
    .bind(tags_json)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
}

/// A minimal `NewPage` for the round-trip tests, which need the real
/// `create_page_impl` writer (not the raw-SQL `insert_rich_page` above).
fn bare_page(title: &str) -> NewPage {
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

async fn set_status(pool: &SqlitePool, id: &str, status: &str) {
    sqlx::query("UPDATE pages SET status = ? WHERE id = ?")
        .bind(status)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
}

async fn set_completed(pool: &SqlitePool, id: &str, completed_at: &str) {
    sqlx::query("UPDATE pages SET status = 'done', completed_at = ? WHERE id = ?")
        .bind(completed_at)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
}

async fn soft_delete(pool: &SqlitePool, id: &str) {
    sqlx::query("UPDATE pages SET deleted_at = ? WHERE id = ?")
        .bind(now_iso())
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
}

async fn set_parent(pool: &SqlitePool, child: &str, parent: &str) {
    sqlx::query("UPDATE pages SET parent_id = ? WHERE id = ?")
        .bind(parent)
        .bind(child)
        .execute(pool)
        .await
        .unwrap();
}

async fn insert_schedule(pool: &SqlitePool, id: &str, page_id: &str, start: &str) {
    sqlx::query(
        "INSERT INTO page_schedules (id, page_id, scheduled_start, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(id)
    .bind(page_id)
    .bind(start)
    .bind(now_iso())
    .execute(pool)
    .await
    .unwrap();
}

async fn insert_rule(pool: &SqlitePool, id: &str, page_id: &str) {
    sqlx::query(
        "INSERT INTO page_recurrence_rules
         (id, page_id, rrule, scheduled_start, timezone, created_at)
         VALUES (?, ?, 'FREQ=DAILY', '2026-05-22T09:00:00', 'America/New_York', ?)",
    )
    .bind(id)
    .bind(page_id)
    .bind(now_iso())
    .execute(pool)
    .await
    .unwrap();
}

async fn insert_focus_session(pool: &SqlitePool, id: &str, page_id: &str, duration_s: i64) {
    sqlx::query(
        "INSERT INTO focus_sessions (id, page_id, started_at, ended_at, duration_s)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(page_id)
    .bind(now_iso())
    .bind(now_iso())
    .bind(duration_s)
    .execute(pool)
    .await
    .unwrap();
}

// ── get_usage_stats_impl ───────────────────────────────────────────────────────

#[tokio::test]
async fn usage_stats_empty_db_is_all_zeros() {
    let pool = test_pool().await;
    let s = get_usage_stats_impl(&pool).await.unwrap();

    assert_eq!(s.total_pages, 0);
    assert_eq!(s.total_folders, 0);
    assert_eq!(s.total_schedules, 0);
    assert_eq!(s.total_focus_sessions, 0);
    assert_eq!(s.total_focus_minutes, 0);
    assert_eq!(s.total_completed, 0);
    assert_eq!(s.total_words, 0);
    assert!(s.pages_by_status.is_empty());
    assert!(!s.has_folders);
    assert!(!s.has_schedules);
    assert!(!s.has_recurring);
    assert!(!s.has_focus_sessions);
    assert!(!s.has_subtasks);
    assert!(!s.has_tags);
    assert!(!s.has_priorities);
    assert!(s.first_page_date.is_none());
    // Always 12 weeks of buckets, regardless of data.
    assert_eq!(s.weekly_activity.len(), 12);
}

#[tokio::test]
async fn usage_stats_counts_totals_and_adoption() {
    let pool = test_pool().await;
    insert_test_folder(&pool, "f1", "Work").await.unwrap();

    // p1: parent task, 2 words, priority 1, a tag
    insert_rich_page(
        &pool,
        "p1",
        "Parent",
        "{}",
        "hello world",
        1,
        "[\"urgent\"]",
    )
    .await;
    // p2: child of p1 (subtask), done, 3 words
    insert_rich_page(&pool, "p2", "Child", "{}", "one two three", 0, "[]").await;
    set_parent(&pool, "p2", "p1").await;
    set_status(&pool, "p2", "done").await;
    // p3: empty content_text contributes 0 words
    insert_rich_page(&pool, "p3", "Empty", "{}", "", 0, "[]").await;

    insert_schedule(&pool, "s1", "p1", "2026-05-22T09:00:00").await;
    insert_rule(&pool, "r1", "p1").await;
    insert_focus_session(&pool, "fs1", "p1", 600).await;
    insert_focus_session(&pool, "fs2", "p1", 600).await;

    let s = get_usage_stats_impl(&pool).await.unwrap();

    assert_eq!(s.total_pages, 3);
    assert_eq!(s.total_folders, 1);
    assert_eq!(s.total_schedules, 1);
    assert_eq!(s.total_focus_sessions, 2);
    assert_eq!(s.total_focus_minutes, 20); // (600+600)/60
    assert_eq!(s.total_completed, 1);
    assert_eq!(s.total_words, 5); // 2 + 3 + 0 (empty skipped)

    assert!(s.has_folders);
    assert!(s.has_schedules);
    assert!(s.has_recurring);
    assert!(s.has_focus_sessions);
    assert!(s.has_subtasks);
    assert!(s.has_tags);
    assert!(s.has_priorities);
    assert!(s.first_page_date.is_some());

    // Status breakdown: 2 not_started, 1 done.
    let by: std::collections::HashMap<_, _> = s
        .pages_by_status
        .iter()
        .map(|c| (c.status.as_str(), c.count))
        .collect();
    assert_eq!(by.get("not_started"), Some(&2));
    assert_eq!(by.get("done"), Some(&1));

    // All three pages were created "now", so they land in the current week.
    let created: i64 = s.weekly_activity.iter().map(|w| w.created).sum();
    assert_eq!(created, 3);
}

#[tokio::test]
async fn usage_stats_excludes_soft_deleted_pages() {
    let pool = test_pool().await;
    insert_rich_page(&pool, "p1", "Live", "{}", "a b", 2, "[\"keep\"]").await;
    insert_rich_page(&pool, "p2", "Gone", "{}", "x y z", 3, "[\"drop\"]").await;
    soft_delete(&pool, "p2").await;

    let s = get_usage_stats_impl(&pool).await.unwrap();
    assert_eq!(s.total_pages, 1);
    assert_eq!(s.total_words, 2); // only the live page
                                  // adoption flags only reflect the surviving page
    assert!(s.has_tags);
    assert!(s.has_priorities);
}

// ── reset_db_impl ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn reset_db_wipes_all_user_tables() {
    let pool = test_pool().await;
    insert_test_folder(&pool, "f1", "Work").await.unwrap();
    insert_rich_page(&pool, "p1", "Task", "{}", "x", 0, "[]").await;
    insert_schedule(&pool, "s1", "p1", "2026-05-22T09:00:00").await;
    insert_rule(&pool, "r1", "p1").await;
    insert_focus_session(&pool, "fs1", "p1", 30).await;

    reset_db_impl(&pool).await.unwrap();

    for (table, expected) in [
        ("pages", 0),
        ("folders", 0),
        ("page_schedules", 0),
        ("page_recurrence_rules", 0),
        ("focus_sessions", 0),
    ] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}")) // sql-ok: table is a constant from the hardcoded list above
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, expected, "table {table} not empty after reset");
    }
}

// ── build_export_json_impl ─────────────────────────────────────────────────────

#[tokio::test]
async fn export_json_shapes_tables_and_parses_json_columns() {
    let pool = test_pool().await;
    insert_test_folder(&pool, "f1", "Work").await.unwrap();
    let content = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"hi"}]}]}"#;
    insert_rich_page(&pool, "p1", "Task", content, "hi", 1, "[\"a\",\"b\"]").await;

    let export = build_export_json_impl(&pool).await.unwrap();

    assert_eq!(export["version"], 1);
    assert!(export["exported_at"].is_string());
    assert_eq!(export["folders"].as_array().unwrap().len(), 1);

    let pages = export["pages"].as_array().unwrap();
    assert_eq!(pages.len(), 1);
    // content/tags are embedded as parsed JSON, not strings.
    assert!(pages[0]["content"].is_object());
    assert_eq!(pages[0]["tags"], serde_json::json!(["a", "b"]));
    // priority comes back as a number.
    assert_eq!(pages[0]["priority"], 1);
}

#[tokio::test]
async fn export_json_excludes_soft_deleted_and_collects_assets() {
    let pool = test_pool().await;
    let content =
        r#"{"type":"doc","content":[{"type":"image","attrs":{"data-asset-path":"/abs/img.png"}}]}"#;
    insert_rich_page(&pool, "p1", "WithImage", content, "", 0, "[]").await;
    insert_rich_page(&pool, "p2", "Deleted", "{}", "", 0, "[]").await;
    soft_delete(&pool, "p2").await;

    let export = build_export_json_impl(&pool).await.unwrap();

    assert_eq!(export["pages"].as_array().unwrap().len(), 1);
    assert_eq!(export["assets"], serde_json::json!(["/abs/img.png"]));
}

// ── export → re-import round-trip ──────────────────────────────────────────────
// import-export.md calls out two gaps explicitly: "no dedicated export test
// suite" and "no export→re-import round-trip test". Production re-import is the
// TS `WorkspaceContext.importBatch()`, which fans out to the same `create_*`
// commands these tests drive directly — so this exercises the real export
// builder and the real page/folder writers end to end. It proves the JSON export
// is a faithful, re-importable snapshot: content (incl. image asset references)
// and tags survive a round trip into a fresh workspace.

/// Rebuild a `NewPage` from one exported page object, resolving the old folder id
/// to the freshly-created one. Mirrors what `importBatch` does field-for-field
/// (parent resolution aside — not relevant to these fixtures).
fn page_from_export(v: &serde_json::Value, folder_map: &HashMap<String, String>) -> NewPage {
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    let str_array = |k: &str| {
        v.get(k)
            .and_then(|t| t.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    };
    NewPage {
        folder_id: v
            .get("folder_id")
            .and_then(|x| x.as_str())
            .and_then(|old| folder_map.get(old).cloned()),
        title: s("title").unwrap_or_default(),
        subtitle: s("subtitle"),
        // content is exported as parsed JSON — re-serialize to the string the writer wants.
        content: v
            .get("content")
            .map(|c| c.to_string())
            .unwrap_or_else(|| "{}".to_string()),
        content_text: s("content_text"),
        status: s("status").unwrap_or_else(|| "not_started".to_string()),
        priority: v.get("priority").and_then(|p| p.as_i64()).unwrap_or(0),
        tags: str_array("tags"),
        scheduled_start: s("scheduled_start"),
        scheduled_end: s("scheduled_end"),
        completed_at: s("completed_at"),
        links: str_array("links"),
        parent_id: None,
        last_opened_at: s("last_opened_at"),
        created_at: s("created_at"),
        updated_at: s("updated_at"),
    }
}

/// Replay an export JSON into a fresh pool the way importBatch would: create
/// folders first (remapping ids), then pages against the new folder ids.
async fn reimport(pool: &SqlitePool, export: &serde_json::Value) {
    let mut folder_map: HashMap<String, String> = HashMap::new();
    for f in export["folders"].as_array().unwrap() {
        let created = create_folder_impl(
            pool,
            NewFolder {
                name: f["name"].as_str().unwrap().to_string(),
                parent_id: None,
                color: f.get("color").and_then(|c| c.as_str()).map(str::to_string),
                icon: f.get("icon").and_then(|c| c.as_str()).map(str::to_string),
            },
        )
        .await
        .unwrap();
        folder_map.insert(f["id"].as_str().unwrap().to_string(), created.id);
    }
    for p in export["pages"].as_array().unwrap() {
        create_page_impl(pool, page_from_export(p, &folder_map))
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn export_reimport_round_trip_preserves_content_tags_and_image_refs() {
    // Source workspace: a folder with a page that has body text, a tag, and an
    // image node carrying an absolute asset path.
    let src = test_pool().await;
    let folder = create_folder_impl(
        &src,
        NewFolder {
            name: "Work".to_string(),
            parent_id: None,
            color: None,
            icon: None,
        },
    )
    .await
    .unwrap();

    // Absolute asset path, matching the `/abs/img.png` fixture style used above
    // (a real path would be under the OS app-data dir; the value is opaque to the
    // round trip, which only asserts it survives verbatim).
    let image_path = "/abs/pikos/assets/abc123.png";
    let content = format!(
        r#"{{"type":"doc","content":[
            {{"type":"paragraph","content":[{{"type":"text","text":"hello world"}}]}},
            {{"type":"image","attrs":{{"data-asset-path":"{image_path}"}}}}
        ]}}"#
    );
    let mut page = NewPage {
        folder_id: Some(folder.id.clone()),
        content,
        content_text: Some("hello world".to_string()),
        tags: vec!["Work".to_string(), "urgent".to_string()],
        ..bare_page("Has image")
    };
    page.priority = 2;
    create_page_impl(&src, page).await.unwrap();
    // A second, plain page to confirm multi-row export/import.
    create_page_impl(&src, bare_page("Plain note"))
        .await
        .unwrap();

    // Export, then replay into a brand-new workspace.
    let export = build_export_json_impl(&src).await.unwrap();
    assert_eq!(
        export["assets"],
        serde_json::json!([image_path]),
        "export manifest should list the referenced image"
    );

    let dst = test_pool().await;
    reimport(&dst, &export).await;

    // Folders + pages came across.
    assert_eq!(list_folders_impl(&dst).await.unwrap().len(), 1);
    let pages = list_pages_impl(&dst, None).await.unwrap();
    assert_eq!(pages.len(), 2);

    // Re-export the destination and compare the meaningful shape against the
    // source — a round trip should be a fixed point for content/tags/assets.
    let re_export = build_export_json_impl(&dst).await.unwrap();
    assert_eq!(
        re_export["assets"], export["assets"],
        "image asset reference must survive the round trip"
    );

    // The image page kept its tags (normalized), priority, and the asset path
    // embedded in content.
    let imported = re_export["pages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["title"] == "Has image")
        .expect("image page should be present after re-import");
    assert_eq!(imported["tags"], serde_json::json!(["work", "urgent"]));
    assert_eq!(imported["priority"], 2);
    assert_eq!(
        imported["content"]["content"][1]["attrs"]["data-asset-path"], image_path,
        "the image node's asset path must be preserved verbatim"
    );
}

// ── build_export_csv_impl ──────────────────────────────────────────────────────

#[tokio::test]
async fn export_csv_header_and_row_basics() {
    let pool = test_pool().await;
    insert_test_folder(&pool, "f1", "Work").await.unwrap();
    insert_test_page(
        &pool,
        TestPage {
            folder_id: Some("f1"),
            content_text: "body text",
            tags_json: "[\"x\",\"y\"]",
            ..TestPage::new("p1", "My Task")
        },
    )
    .await
    .unwrap();

    let csv = build_export_csv_impl(&pool).await.unwrap();
    let lines: Vec<&str> = csv.lines().collect();

    assert_eq!(
        lines[0],
        "Title,Content,Folder,Status,Priority,Tags,Start Date,End Date,Created At,Updated At,Completed At"
    );
    assert_eq!(lines.len(), 2);
    let row = lines[1];
    assert!(row.starts_with("My Task,body text,Work,not_started,0,"));
    // tags joined with ", " forces quoting (contains a comma).
    assert!(row.contains("\"x, y\""));
}

#[tokio::test]
async fn export_csv_escapes_special_characters() {
    let pool = test_pool().await;
    // Title with comma + quote, content with newline.
    insert_rich_page(&pool, "p1", "a, \"b\"", "{}", "line1\nline2", 0, "[]").await;

    let csv = build_export_csv_impl(&pool).await.unwrap();
    let row = csv.lines().nth(1).unwrap();

    // Comma+quote field → wrapped in quotes with "" escaping.
    assert!(row.contains("\"a, \"\"b\"\"\""));
    // Newline field → wrapped in quotes (so the row spans a literal newline).
    assert!(csv.contains("\"line1\nline2\""));
}

#[tokio::test]
async fn export_csv_excludes_soft_deleted() {
    let pool = test_pool().await;
    insert_rich_page(&pool, "p1", "Live", "{}", "", 0, "[]").await;
    insert_rich_page(&pool, "p2", "Gone", "{}", "", 0, "[]").await;
    soft_delete(&pool, "p2").await;

    let csv = build_export_csv_impl(&pool).await.unwrap();
    assert_eq!(csv.lines().count(), 2); // header + 1 live page
    assert!(csv.contains("Live"));
    assert!(!csv.contains("Gone"));
}

#[tokio::test]
async fn export_csv_includes_completed_at() {
    let pool = test_pool().await;
    insert_rich_page(&pool, "p1", "Done", "{}", "", 0, "[]").await;
    set_completed(&pool, "p1", "2026-05-01T12:00:00Z").await;

    let csv = build_export_csv_impl(&pool).await.unwrap();
    let row = csv.lines().nth(1).unwrap();
    assert!(row.ends_with("2026-05-01T12:00:00Z"));
    assert!(row.contains(",done,"));
}

// ── build_frontmatter ──────────────────────────────────────────────────────────

#[test]
fn frontmatter_omits_defaults() {
    let fm = build_frontmatter(
        "Title",
        "not_started",
        0,
        "[]",
        None,
        None,
        "2026-01-01",
        "2026-01-02",
    );
    assert!(fm.starts_with("---\ntitle: \"Title\"\n"));
    assert!(!fm.contains("status:")); // not_started omitted
    assert!(!fm.contains("priority:")); // 0 omitted
    assert!(!fm.contains("tags:")); // empty omitted
    assert!(!fm.contains("scheduled_start:"));
    assert!(fm.contains("created: \"2026-01-01\"\n"));
    assert!(fm.contains("updated: \"2026-01-02\"\n"));
    assert!(fm.ends_with("---\n\n"));
}

#[test]
fn frontmatter_includes_non_default_fields() {
    let fm = build_frontmatter(
        "T",
        "done",
        3,
        "[\"home\",\"errand\"]",
        Some("2026-05-22T09:00:00"),
        Some("2026-05-22T10:00:00"),
        "c",
        "u",
    );
    assert!(fm.contains("status: done\n"));
    assert!(fm.contains("priority: 3\n"));
    assert!(fm.contains("tags:\n  - \"home\"\n  - \"errand\"\n"));
    assert!(fm.contains("scheduled_start: \"2026-05-22T09:00:00\"\n"));
    assert!(fm.contains("scheduled_end: \"2026-05-22T10:00:00\"\n"));
}

#[test]
fn frontmatter_escapes_quotes_in_title_and_tags() {
    let fm = build_frontmatter(
        "a\"b",
        "not_started",
        0,
        "[\"x\\\"y\"]",
        None,
        None,
        "c",
        "u",
    );
    assert!(fm.contains("title: \"a\\\"b\"\n"));
    assert!(fm.contains("  - \"x\\\"y\"\n"));
}

// ── markdown_body ──────────────────────────────────────────────────────────────

#[test]
fn markdown_body_empty_inputs_yield_empty_string() {
    assert_eq!(markdown_body(""), "");
    assert_eq!(markdown_body("{}"), "");
    assert_eq!(markdown_body("not json at all"), ""); // parse error → empty
}

#[test]
fn markdown_body_converts_prosemirror_to_markdown() {
    let content = r#"{"type":"doc","content":[
        {"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Title"}]},
        {"type":"paragraph","content":[{"type":"text","text":"hello"}]}
    ]}"#;
    let body = markdown_body(content);
    assert!(body.contains("## Title"));
    assert!(body.contains("hello"));
}

#[test]
fn exported_markdown_file_is_frontmatter_then_body() {
    // The shape export_markdown writes per page: frontmatter block immediately
    // followed by the converted body.
    let content = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"note"}]}]}"#;
    let fm = build_frontmatter("My Page", "done", 2, "[]", None, None, "c", "u");
    let full = format!("{fm}{}", markdown_body(content));

    assert!(full.starts_with("---\ntitle: \"My Page\"\n"));
    assert!(full.contains("status: done\n"));
    assert!(full.contains("---\n\nnote")); // separator then body, no gap
}

// ── vacuum_into ────────────────────────────────────────────────────────────────

/// Open a file-based SQLite pool with migrations applied. `VACUUM INTO` is a
/// no-op from a `:memory:` source under sqlx, so the backup tests must mirror
/// the production path (a real DB file) to exercise vacuum_into honestly.
async fn file_pool(path: &str) -> SqlitePool {
    // Routes through the production opener so this stays on the same
    // migration tree (pikos-db's) as the app proper.
    pikos_db::open_pool(path).await.unwrap()
}

async fn open_existing(path: &str) -> SqlitePool {
    use std::str::FromStr;
    sqlx::sqlite::SqlitePoolOptions::new()
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::from_str(path)
                .unwrap()
                .create_if_missing(false),
        )
        .await
        .unwrap()
}

async fn count(pool: &SqlitePool, table: &str) -> i64 {
    // table is a constant supplied by the test, never user input.
    sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}")) // sql-ok: constant table name
        .fetch_one(pool)
        .await
        .unwrap()
}

/// The guarantee `backup_db_before_import` exists to provide: the VACUUM INTO
/// copy is a complete, faithful snapshot that survives a full wipe of the
/// source DB — so a user can recover by hand from the `.sqlite` file even after
/// the live workspace is gone. (There is no programmatic restore command; undo
/// is soft-delete, the backup file is the manual safety net.)
#[tokio::test]
async fn backup_preserves_all_data_after_source_wipe() {
    let src = std::env::temp_dir().join(format!("pikos-src-{}.sqlite", uuid::Uuid::new_v4()));
    let src_str = src.to_string_lossy().to_string();
    let pool = file_pool(&src_str).await;

    insert_test_folder(&pool, "f1", "Work").await.unwrap();
    insert_rich_page(
        &pool,
        "p1",
        "Task one",
        "{}",
        "",
        1,
        "[\"home\",\"urgent\"]",
    )
    .await;
    insert_rich_page(&pool, "p2", "Task two", "{}", "", 0, "[]").await;
    insert_schedule(&pool, "s1", "p1", "2026-05-22T09:00:00").await;
    insert_rule(&pool, "r1", "p2").await;

    let dest = std::env::temp_dir().join(format!("pikos-bak-{}.sqlite", uuid::Uuid::new_v4()));
    let dest_str = dest.to_string_lossy().to_string();
    vacuum_into(&pool, &dest_str).await.unwrap();
    assert!(dest.exists());

    // Wipe the source completely — the backup must stand on its own.
    reset_db_impl(&pool).await.unwrap();
    assert_eq!(count(&pool, "pages").await, 0);

    // Re-open the backup and confirm every table round-tripped intact.
    let copy = open_existing(&dest_str).await;
    assert_eq!(count(&copy, "pages").await, 2);
    assert_eq!(count(&copy, "folders").await, 1);
    assert_eq!(count(&copy, "page_schedules").await, 1);
    assert_eq!(count(&copy, "page_recurrence_rules").await, 1);
    let tags: String = sqlx::query_scalar("SELECT tags FROM pages WHERE id = 'p1'")
        .fetch_one(&copy)
        .await
        .unwrap();
    assert_eq!(tags, "[\"home\",\"urgent\"]");

    copy.close().await;
    pool.close().await;
    let _ = std::fs::remove_file(&dest);
    let _ = std::fs::remove_file(&src);
}

#[tokio::test]
async fn vacuum_into_escapes_single_quotes_in_path() {
    let src = std::env::temp_dir().join(format!("pikos-src-{}.sqlite", uuid::Uuid::new_v4()));
    let src_str = src.to_string_lossy().to_string();
    let pool = file_pool(&src_str).await;

    let dir = std::env::temp_dir().join(format!("pikos'test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let dest = dir.join("backup.sqlite");
    let dest_str = dest.to_string_lossy().to_string();

    // A literal single-quote in the path must not break the VACUUM INTO SQL.
    vacuum_into(&pool, &dest_str).await.unwrap();
    assert!(dest.exists());

    pool.close().await;
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_file(&src);
}

// ── wipe_app_data pool-drop ────────────────────────────────────────────────────
// `wipe_app_data` can't be called directly (it needs a `tauri::AppHandle`, and
// invoking it would `remove_dir_all` the real app-data dir). Its data-safety
// contract is the *ordering*: it `take_pool()`s first so SQLite releases its
// file handles before the on-disk DB is removed — without this the directory
// removal fails on Windows. We test that mechanism on `DbState` directly.

#[tokio::test]
async fn wipe_drops_pool_so_handles_release_before_file_removal() {
    let src = std::env::temp_dir().join(format!("pikos-wipe-{}.sqlite", uuid::Uuid::new_v4()));
    let src_str = src.to_string_lossy().to_string();
    let pool = file_pool(&src_str).await;
    let state = DbState::with_pool(pool);

    // Pool is live before the wipe.
    assert!(state.get_pool().await.is_ok());

    // The first thing wipe_app_data does: take the pool out of shared state.
    let taken = state.take_pool().await;
    assert!(taken.is_some(), "take_pool must yield the live pool");

    // State no longer hands out a pool — a stray query now fails fast instead
    // of racing the file removal.
    assert!(state.get_pool().await.is_err());

    // Closing the taken pool releases the file handle; only then is removal safe.
    taken.unwrap().close().await;
    std::fs::remove_file(&src).unwrap();
    assert!(!src.exists());
}

// ── backdate_page_impl ─────────────────────────────────────────────────────────

async fn timestamps(pool: &SqlitePool, id: &str) -> (String, String, Option<String>) {
    sqlx::query_as("SELECT created_at, updated_at, completed_at FROM pages WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn backdate_overwrites_all_three_timestamps() {
    let pool = test_pool().await;
    insert_rich_page(&pool, "p1", "T", "{}", "", 0, "[]").await;

    backdate_page_impl(
        &pool,
        BackdateParams {
            id: "p1".into(),
            created_at: Some("2025-01-01T00:00:00Z".into()),
            updated_at: Some("2025-01-02T00:00:00Z".into()),
            completed_at: Some("2025-01-03T00:00:00Z".into()),
        },
    )
    .await
    .unwrap();

    let (c, u, done) = timestamps(&pool, "p1").await;
    assert_eq!(c, "2025-01-01T00:00:00Z");
    assert_eq!(u, "2025-01-02T00:00:00Z");
    assert_eq!(done.as_deref(), Some("2025-01-03T00:00:00Z"));
}

#[tokio::test]
async fn backdate_partial_leaves_other_columns_untouched() {
    let pool = test_pool().await;
    insert_rich_page(&pool, "p1", "T", "{}", "", 0, "[]").await;
    let (orig_created, _, _) = timestamps(&pool, "p1").await;

    backdate_page_impl(
        &pool,
        BackdateParams {
            id: "p1".into(),
            created_at: None,
            updated_at: Some("2025-06-01T00:00:00Z".into()),
            completed_at: None,
        },
    )
    .await
    .unwrap();

    let (c, u, done) = timestamps(&pool, "p1").await;
    assert_eq!(c, orig_created); // unchanged
    assert_eq!(u, "2025-06-01T00:00:00Z");
    assert!(done.is_none());
}

#[tokio::test]
async fn backdate_with_no_fields_is_a_noop() {
    let pool = test_pool().await;
    insert_rich_page(&pool, "p1", "T", "{}", "", 0, "[]").await;
    let before = timestamps(&pool, "p1").await;

    backdate_page_impl(
        &pool,
        BackdateParams {
            id: "p1".into(),
            created_at: None,
            updated_at: None,
            completed_at: None,
        },
    )
    .await
    .unwrap();

    let after = timestamps(&pool, "p1").await;
    assert_eq!(before, after);
}

// ── sanitize_filename ──────────────────────────────────────────────────────────

#[test]
fn sanitize_filename_replaces_problem_chars_and_trims() {
    assert_eq!(
        sanitize_filename("a/b\\c:d*e?f\"g<h>i|j"),
        "a_b_c_d_e_f_g_h_i_j"
    );
    assert_eq!(sanitize_filename("  spaced  "), "spaced");
    assert_eq!(sanitize_filename("normal name"), "normal name");
}

// ── collect_asset_paths ────────────────────────────────────────────────────────

#[test]
fn collect_asset_paths_finds_nested_images_only() {
    let doc: serde_json::Value = serde_json::from_str(
        r#"{
          "type":"doc",
          "content":[
            {"type":"image","attrs":{"data-asset-path":"/a/one.png"}},
            {"type":"paragraph","content":[
              {"type":"image","attrs":{"data-asset-path":"/a/two.png"}},
              {"type":"text","text":"hi"}
            ]},
            {"type":"image","attrs":{"data-asset-path":""}}
          ]
        }"#,
    )
    .unwrap();

    let mut paths = Vec::new();
    collect_asset_paths(&doc, &mut paths);
    assert_eq!(paths, vec!["/a/one.png", "/a/two.png"]); // empty path skipped
}
