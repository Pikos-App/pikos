//! What the exports produce, pinned where the exports now live.
//!
//! Moved from `apps/desktop/src-tauri/src/db/dev/tests.rs` together with the
//! code they cover. The column order, the escaping and the frontmatter are a
//! contract with the importer — `roundtrip.test.ts` reads this output back —
//! and a contract tested in a crate that no longer owns it is one that quietly
//! stops being run.

use crate::export::*;
use crate::{insert_test_folder, insert_test_page, insert_test_page_sync, test_pool, TestPage};
use sqlx::{Row, SqlitePool};

/// A page written straight to SQL, so a test can set `content` and
/// `content_text` independently — which is exactly what the exports read and
/// what the ordinary writer derives from each other.
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

// ── fetch_export_pages ─────────────────────────────────────────────────────────

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

#[tokio::test]
async fn export_drops_only_the_mirrors_the_user_never_actioned() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("native", "My Note"))
        .await
        .unwrap();
    insert_synced_page(&pool, "bare", "Standup", "active").await;
    insert_synced_page(&pool, "done", "Retro", "active").await;
    set_completed(&pool, "done", "2026-05-01T12:00:00Z").await;
    insert_synced_page(&pool, "severed", "Old 1:1", "detached").await;

    let kept = export_titles(&pool, false).await;
    assert!(!kept.contains(&"Standup".to_string()));
    assert_eq!(
        kept.len(),
        3,
        "native, completed mirror and detached all stay"
    );

    assert_eq!(export_titles(&pool, true).await.len(), 4);
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

    let csv = build_export_csv(&pool, false).await.unwrap();
    let lines: Vec<&str> = csv.lines().collect();

    assert_eq!(
        lines[0],
        "Title,Content,Folder,Status,Priority,Tags,Start Date,End Date,Repeat,Reminder,Created At,Updated At,Completed At"
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

    let csv = build_export_csv(&pool, false).await.unwrap();
    let row = csv.lines().nth(1).unwrap();

    // Comma+quote field → wrapped in quotes with "" escaping.
    assert!(row.contains("\"a, \"\"b\"\"\""));
    // Newline field → wrapped in quotes (so the row spans a literal newline).
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

// ── CSV Repeat / Reminder columns ─────────────────────────────────────────────
// The importer has understood both since it shipped (`repeat`/`rrule` and
// `reminder` are in its header heuristics), but the export emitted neither, so
// a recurring page or a page with reminders came back through import as a plain
// one-off. These pin the two cells to the exact formats `csv.ts` parses:
// a bare RRULE (it strips at most a leading `RRULE:` and hands the rest to
// `parseRrule`) and ISO-8601 durations (`parseDurationToMinutes`).

/// Cell `i` of the single data row, by header name.
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
    // Semicolons inside an RRULE are why the cell has to survive CSV escaping.
    insert_rule_with_rrule(&pool, "r1", "p1", "FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2").await;

    let csv = build_export_csv(&pool, false).await.unwrap();

    // Verbatim and bare: no `RRULE:` prefix, no DTSTART — the anchor is the
    // page's own Start Date column, which is how the importer pairs them.
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

    // `PT0S` for at-start, negative minute durations for "before" — the three
    // shapes `parseDurationToMinutes`'s own doc comment names. Semicolon-joined
    // so the cell needs no quoting.
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
    // The two empty cells sit between End Date and Created At, so a plain page's
    // row still lines up with the header.
    assert_eq!(csv.lines().nth(1).unwrap().split(',').count(), 13);
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

// ── nullable columns ──────────────────────────────────────────────────────────
//
// SQLite is dynamically typed, and sqlx decodes a NULL into `Ok("")` rather than
// an error — so `try_get::<String, _>(col).ok()` yields `Some("")` for every
// absent value and its `None` arm never runs. Both exports read nullable columns
// that way until this was found, and both had a visible symptom.

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

/// Why the `Uncategorized` fallback cannot be reached, recorded so nobody
/// deletes it as dead code without knowing what is holding it up.
///
/// It fires for a page whose `folder_id` names a folder that is not there, and
/// the schema does not allow that: the foreign key refuses a dangling id, and
/// deleting a folder sets the column to NULL rather than leaving it pointing at
/// nothing. So the arm is a guard against a future schema change, not a case
/// the export sees — which is exactly why the *real* unfiled page used to land
/// in it and nobody noticed.
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
