//! What the exports produce. The column order, escaping and frontmatter are a contract with the
//! importer, which `roundtrip.test.ts` reads back.

use crate::export::*;
use crate::{insert_test_folder, insert_test_page, insert_test_page_sync, test_pool, TestPage};
use sqlx::{Row, SqlitePool};
use std::collections::HashMap;

/// A page written straight to SQL, so a test can set `content` and `content_text` independently;
/// the ordinary writer derives one from the other.
#[allow(clippy::too_many_arguments)]
async fn insert_rich_page(
    pool: &SqlitePool,
    id: &str,
    title: &str,
    content: &str,
    content_text: &str,
    priority: i64,
    tags_json: &str,
) {
    let now = crate::now_iso();
    sqlx::query(
        "INSERT INTO pages
         (id, title, content_text, status, priority, tags, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, 'not_started', ?, ?, 0, ?, ?)",
    )
    .bind(id)
    .bind(title)
    .bind(content_text)
    .bind(priority)
    .bind(tags_json)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    crate::page_chunks::write_body(pool, id, content)
        .await
        .unwrap();
}

async fn soft_delete(pool: &SqlitePool, id: &str) {
    sqlx::query("UPDATE pages SET deleted_at = ? WHERE id = ?")
        .bind(crate::now_iso())
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
}

async fn insert_rule_with_rrule(pool: &SqlitePool, id: &str, page_id: &str, rrule: &str) {
    sqlx::query(
        "INSERT INTO page_recurrence_rules
         (id, page_id, rrule, scheduled_start, timezone, created_at)
         VALUES (?, ?, ?, '2026-05-22T09:00:00', 'America/New_York', ?)",
    )
    .bind(id)
    .bind(page_id)
    .bind(rrule)
    .bind(crate::now_iso())
    .execute(pool)
    .await
    .unwrap();
}

async fn insert_reminder(pool: &SqlitePool, id: &str, page_id: &str, minutes_before: i64) {
    sqlx::query(
        "INSERT INTO page_reminders (id, page_id, minutes_before, created_at)
         VALUES (?, ?, ?, ?)",
    )
    .bind(id)
    .bind(page_id)
    .bind(minutes_before)
    .bind(crate::now_iso())
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

/// Writes the denorm alongside the row, as `refresh_schedule_denorm` does.
async fn insert_schedule(pool: &SqlitePool, id: &str, page_id: &str, start: &str) {
    sqlx::query(
        "INSERT INTO page_schedules (id, page_id, scheduled_start, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(id)
    .bind(page_id)
    .bind(start)
    .bind(crate::now_iso())
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("UPDATE pages SET scheduled_start = ? WHERE id = ?")
        .bind(start)
        .bind(page_id)
        .execute(pool)
        .await
        .unwrap();
}

async fn insert_synced_page(pool: &SqlitePool, id: &str, title: &str, sync_state: &str) {
    insert_test_page(pool, TestPage::new(id, title))
        .await
        .unwrap();
    insert_test_page_sync(pool, id, sync_state).await.unwrap();
}

async fn export_titles(pool: &SqlitePool, include_synced: bool) -> Vec<String> {
    fetch_export_pages(pool, "id, title", include_synced)
        .await
        .unwrap()
        .iter()
        .map(|row| row.get::<String, _>("title"))
        .collect()
}

// qa: EXP-08:5
#[tokio::test]
async fn export_drops_only_the_mirrors_the_user_never_actioned() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("native", "My Note"))
        .await
        .unwrap();
    insert_synced_page(&pool, "bare", "Standup", "active").await;
    insert_synced_page(&pool, "done", "Retro", "active").await;
    set_completed(&pool, "done", "2026-05-01T12:00:00Z").await;
    insert_synced_page(&pool, "edited", "Planning", "active").await;
    sqlx::query("UPDATE page_sync SET user_modified = 1 WHERE page_id = 'edited'")
        .execute(&pool)
        .await
        .unwrap();
    insert_synced_page(&pool, "severed", "Old 1:1", "detached").await;

    let kept = export_titles(&pool, false).await;
    assert!(!kept.contains(&"Standup".to_string()));
    assert_eq!(
        kept.len(),
        4,
        "native, completed mirror, edited mirror and detached all stay"
    );

    assert_eq!(export_titles(&pool, true).await.len(), 5);
}

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

    let csv = build_export_csv(&pool, false).await.unwrap();
    let lines: Vec<&str> = csv.lines().collect();

    assert_eq!(
        lines[0],
        "Title,Content,Folder,Status,Priority,Tags,Start Date,End Date,Repeat,Reminder,Created At,Updated At,Completed At"
    );
    assert_eq!(lines.len(), 2);
    let row = lines[1];
    assert!(row.starts_with("My Task,body text,Work,not_started,0,"));
    // Tags joined with ", " contain a comma, forcing quoting.
    assert!(row.contains("\"x, y\""));
}

// qa: EXP-02:3
#[tokio::test]
async fn export_csv_escapes_special_characters() {
    let pool = test_pool().await;
    insert_rich_page(&pool, "p1", "a, \"b\"", "{}", "line1\nline2", 0, "[]").await;

    let csv = build_export_csv(&pool, false).await.unwrap();
    let row = csv.lines().nth(1).unwrap();

    assert!(row.contains("\"a, \"\"b\"\"\""));
    assert!(csv.contains("\"line1\nline2\""));
}

#[tokio::test]
async fn export_csv_excludes_un_actioned_mirrors_unless_asked() {
    let pool = test_pool().await;
    insert_synced_page(&pool, "bare", "Standup", "active").await;

    let default = build_export_csv(&pool, false).await.unwrap();
    assert_eq!(default.lines().count(), 1, "header only");

    let with_synced = build_export_csv(&pool, true).await.unwrap();
    assert!(with_synced.contains("Standup"));
}

#[tokio::test]
async fn export_csv_excludes_soft_deleted() {
    let pool = test_pool().await;
    insert_rich_page(&pool, "p1", "Live", "{}", "", 0, "[]").await;
    insert_rich_page(&pool, "p2", "Gone", "{}", "", 0, "[]").await;
    soft_delete(&pool, "p2").await;

    let csv = build_export_csv(&pool, false).await.unwrap();
    assert_eq!(csv.lines().count(), 2); // header + 1 live page
    assert!(csv.contains("Live"));
    assert!(!csv.contains("Gone"));
}

#[tokio::test]
async fn export_csv_includes_completed_at() {
    let pool = test_pool().await;
    insert_rich_page(&pool, "p1", "Done", "{}", "", 0, "[]").await;
    set_completed(&pool, "p1", "2026-05-01T12:00:00Z").await;

    let csv = build_export_csv(&pool, false).await.unwrap();
    let row = csv.lines().nth(1).unwrap();
    assert!(row.ends_with("2026-05-01T12:00:00Z"));
    assert!(row.contains(",done,"));
}

// The importer reads `repeat` and `reminder` cells, so without them a recurring page or one with
// reminders would import as a plain one-off. These pin the exact formats `csv.ts` parses: a bare
// RRULE (it strips at most a leading `RRULE:`) and ISO-8601 durations (`parseDurationToMinutes`).

/// A cell of the single data row, by header name.
fn csv_cell(csv: &str, column: &str) -> String {
    let mut lines = csv.lines();
    let idx = lines
        .next()
        .expect("header")
        .split(',')
        .position(|h| h == column)
        .unwrap_or_else(|| panic!("no {column} column in the export header"));
    lines
        .next()
        .expect("one data row")
        .split(',')
        .nth(idx)
        .unwrap_or_default()
        .to_string()
}

#[tokio::test]
async fn export_csv_emits_a_recurring_rule_the_importer_can_read_back() {
    let pool = test_pool().await;
    insert_rich_page(&pool, "p1", "Standup", "{}", "", 0, "[]").await;
    insert_rule_with_rrule(&pool, "r1", "p1", "FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2").await;

    let csv = build_export_csv(&pool, false).await.unwrap();

    // Verbatim and bare: the anchor is the page's own Start Date column, as the importer pairs them.
    assert!(
        csv.contains("\"FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2\""),
        "{csv}"
    );
}

#[tokio::test]
async fn export_csv_emits_reminders_as_iso_durations_soonest_first() {
    let pool = test_pool().await;
    insert_rich_page(&pool, "p1", "Review", "{}", "", 0, "[]").await;
    insert_reminder(&pool, "rem-late", "p1", 60).await;
    insert_reminder(&pool, "rem-early", "p1", 0).await;
    insert_reminder(&pool, "rem-mid", "p1", 15).await;

    let csv = build_export_csv(&pool, false).await.unwrap();

    // `PT0S` for at-start and negative minute durations for before, the shapes
    // `parseDurationToMinutes` names, semicolon-joined so the cell needs no quoting.
    assert_eq!(csv_cell(&csv, "Reminder"), "PT0S;-PT15M;-PT60M");
}

/// The `-1` sentinel is "no reminders on this page", which has no ISO-8601
/// spelling — it must not leave as `-PT1M`, which would import as a real
/// one-minute-before reminder the user never set.
#[tokio::test]
async fn export_csv_leaves_the_no_reminders_sentinel_out_of_the_cell() {
    let pool = test_pool().await;
    insert_rich_page(&pool, "p1", "Quiet", "{}", "", 0, "[]").await;
    insert_reminder(&pool, "rem-none", "p1", -1).await;

    let csv = build_export_csv(&pool, false).await.unwrap();
    assert_eq!(csv_cell(&csv, "Reminder"), "");
}

#[tokio::test]
async fn export_csv_leaves_repeat_and_reminder_empty_for_a_plain_page() {
    let pool = test_pool().await;
    insert_rich_page(&pool, "p1", "Plain", "{}", "", 0, "[]").await;

    let csv = build_export_csv(&pool, false).await.unwrap();
    assert_eq!(csv_cell(&csv, "Repeat"), "");
    assert_eq!(csv_cell(&csv, "Reminder"), "");
    // The two empty cells keep a plain page's row lined up with the header.
    assert_eq!(csv.lines().nth(1).unwrap().split(',').count(), 13);
}

// The cross-language fixture; `roundtrip.test.ts` imports the same file.
const CSV_EXPORT: &str = include_str!("../tests/fixtures/csv-export.csv");

// qa: EXP-06:2
#[tokio::test]
async fn export_csv_writes_the_file_the_importer_round_trips() {
    let pool = test_pool().await;
    insert_test_folder(&pool, "f1", "Work").await.unwrap();
    insert_rich_page(&pool, "p1", "Standup", "{}", "", 3, "[\"team\"]").await;
    insert_schedule(&pool, "s1", "p1", "2026-06-01T09:00:00").await;
    insert_rule_with_rrule(&pool, "r1", "p1", "FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2").await;
    insert_reminder(&pool, "rem-start", "p1", 0).await;
    insert_reminder(&pool, "rem-before", "p1", 15).await;
    insert_rich_page(&pool, "p2", "Plain note", "{}", "", 0, "[]").await;
    sqlx::query(
        "UPDATE pages SET folder_id = 'f1', created_at = '2026-05-20T08:00:00',
         updated_at = '2026-05-21T08:00:00', sort_order = CASE id WHEN 'p1' THEN 0 ELSE 1 END",
    )
    .execute(&pool)
    .await
    .unwrap();

    let csv = build_export_csv(&pool, false).await.unwrap();

    assert_eq!(csv, CSV_EXPORT);
}

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

#[test]
fn markdown_body_empty_inputs_yield_empty_string() {
    assert_eq!(markdown_body("", &HashMap::new()), "");
    assert_eq!(markdown_body("{}", &HashMap::new()), "");
    assert_eq!(markdown_body("not json at all", &HashMap::new()), ""); // parse error → empty
}

#[test]
fn markdown_body_converts_prosemirror_to_markdown() {
    let content = r#"{"type":"doc","content":[
        {"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Title"}]},
        {"type":"paragraph","content":[{"type":"text","text":"hello"}]}
    ]}"#;
    let body = markdown_body(content, &HashMap::new());
    assert!(body.contains("## Title"));
    assert!(body.contains("hello"));
}

#[test]
fn exported_markdown_file_is_frontmatter_then_body() {
    let content = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"note"}]}]}"#;
    let fm = build_frontmatter("My Page", "done", 2, "[]", None, None, "c", "u");
    let full = format!("{fm}{}", markdown_body(content, &HashMap::new()));

    assert!(full.starts_with("---\ntitle: \"My Page\"\n"));
    assert!(full.contains("status: done\n"));
    assert!(full.contains("---\n\nnote")); // separator then body, no gap
}

#[test]
fn sanitize_filename_replaces_problem_chars_and_trims() {
    assert_eq!(
        sanitize_filename("a/b\\c:d*e?f\"g<h>i|j"),
        "a_b_c_d_e_f_g_h_i_j"
    );
    assert_eq!(sanitize_filename("  spaced  "), "spaced");
    assert_eq!(sanitize_filename("normal name"), "normal name");
}

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

// sqlx decodes a SQLite NULL into `Ok("")`, so `try_get::<String, _>(col).ok()` yields `Some("")`
// for every absent value and its `None` arm never runs.

#[tokio::test]
async fn an_unfiled_page_is_exported_at_the_root_not_under_uncategorized() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Loose thought"))
        .await
        .unwrap();

    let plan = plan_markdown_export(&pool, false).await.unwrap();
    assert_eq!(
        plan.iter().map(|p| p.path.as_str()).collect::<Vec<_>>(),
        ["Loose thought.md"],
        "a page with no folder has no directory — `Uncategorized/` is for a \
         folder id whose folder is missing, which is a different thing"
    );
    assert!(
        !plan[0].in_folder,
        "and so it is not one level down from assets/"
    );
}

#[tokio::test]
async fn an_unscheduled_page_has_no_date_lines_in_its_frontmatter() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Someday"))
        .await
        .unwrap();

    let plan = plan_markdown_export(&pool, false).await.unwrap();
    assert!(
        !plan[0].contents.contains("scheduled_start"),
        "an empty date is not a date: {:?}",
        plan[0].contents
    );
    assert!(!plan[0].contents.contains("scheduled_end"));
}

async fn tick_head(pool: &SqlitePool, page_id: &str) {
    crate::complete_recurring_page_impl(
        pool,
        crate::CompleteRecurringInput {
            page_id: page_id.into(),
            occurrence_date: None,
            scheduled_start: None,
            scheduled_end: None,
            expected_occurrence_date: None,
        },
    )
    .await
    .unwrap();
}

// qa: EXP-03:2
#[tokio::test]
async fn pages_sharing_a_title_each_get_their_own_file() {
    let pool = test_pool().await;
    insert_test_folder(&pool, "f1", "Work").await.unwrap();
    for (id, title) in [("a", "Notes"), ("b", "notes"), ("c", "")] {
        insert_test_page(
            &pool,
            TestPage {
                folder_id: Some("f1"),
                ..TestPage::new(id, title)
            },
        )
        .await
        .unwrap();
    }
    insert_test_page(&pool, TestPage::new("d", ""))
        .await
        .unwrap();
    insert_test_page(&pool, TestPage::new("e", ""))
        .await
        .unwrap();
    insert_test_page(
        &pool,
        TestPage {
            folder_id: Some("f1"),
            scheduled_start: Some("2026-05-21"),
            ..TestPage::new("weekly", "Review")
        },
    )
    .await
    .unwrap();
    crate::create_recurrence_rule_impl(
        &pool,
        crate::NewRecurrenceRule {
            page_id: "weekly".into(),
            rrule: "FREQ=WEEKLY".into(),
            rrule_exdates: vec![],
            scheduled_start: "2026-05-21".into(),
            scheduled_end: None,
            timezone: "America/Los_Angeles".into(),
        },
    )
    .await
    .unwrap();
    tick_head(&pool, "weekly").await;
    tick_head(&pool, "weekly").await;
    let out = std::env::temp_dir().join(format!("pkos_md_clash_{}", uuid::Uuid::new_v4()));

    let (pages, _) = write_markdown_export(&pool, &out, &out.join("no-assets"), false)
        .await
        .unwrap();

    let written: Vec<String> = walk_files(&out)
        .iter()
        .map(|path| {
            path.strip_prefix(&out)
                .unwrap()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    assert_eq!(pages, 8);
    assert_eq!(written.len(), pages, "{written:?}");
    assert_eq!(
        written
            .iter()
            .map(|path| path.to_lowercase())
            .collect::<std::collections::HashSet<_>>()
            .len(),
        pages,
        "two names that differ only in case are one file on macOS: {written:?}"
    );
    let _ = std::fs::remove_dir_all(&out);
}

fn walk_files(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    std::fs::read_dir(dir)
        .unwrap()
        .flat_map(|entry| {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk_files(&path)
            } else {
                vec![path]
            }
        })
        .collect()
}

/// Why the `Uncategorized` fallback can't be reached, so nobody deletes it as dead code unaware.
///
/// It fires for a page whose `folder_id` names a missing folder, which the schema forbids: the
/// foreign key refuses a dangling id and deleting a folder sets the column NULL. The arm guards a
/// future schema change.
#[tokio::test]
async fn the_schema_is_what_makes_a_missing_folder_impossible() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Orphan"))
        .await
        .unwrap();

    let dangling = sqlx::query("UPDATE pages SET folder_id = 'gone' WHERE id = 'p1'")
        .execute(&pool)
        .await;
    assert!(
        dangling.is_err(),
        "a page cannot name a folder that does not exist"
    );

    insert_test_folder(&pool, "f1", "Work").await.unwrap();
    sqlx::query("UPDATE pages SET folder_id = 'f1' WHERE id = 'p1'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM folders WHERE id = 'f1'")
        .execute(&pool)
        .await
        .unwrap();

    let plan = plan_markdown_export(&pool, false).await.unwrap();
    assert_eq!(
        plan[0].path, "Orphan.md",
        "deleting the folder nulls the column, so the page becomes unfiled"
    );
}
