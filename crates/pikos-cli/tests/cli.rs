//! End-to-end tests: drive the built `pikos` binary against a temp workspace.
//!
//! The DB-only commands run unconditionally (the binary links pikos-db, no GTK,
//! no Node). The `add` / recurring-`done` paths need the @pikos/bridge bundle +
//! Node; they run when packages/pikos-bridge/dist/bridge.mjs exists (built via
//! `pnpm --filter @pikos/bridge build`) and are skipped with a note otherwise.

use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

use chrono::{Datelike, NaiveDate, Weekday};
use pikos_db::{create_page_impl, open_pool, NewPage};
use serde_json::Value;

const BIN: &str = env!("CARGO_BIN_EXE_pikos");

// Per-process monotonic counter so parallel tests never collide on a path.
// (macOS truncates SystemTime to microsecond resolution, so a nanos-only
// suffix produced ~95% duplicates between threads — flaked the suite.)
static SEQ: AtomicU64 = AtomicU64::new(0);

fn unique_db() -> PathBuf {
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("pikos-cli-it-{}-{}", std::process::id(), n));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("w.sqlite")
}

fn base_page(title: &str) -> NewPage {
    NewPage {
        id: None,
        folder_id: None,
        title: title.into(),
        subtitle: None,
        content: String::new(),
        status: "not_started".into(),
        priority: 0,
        tags: Vec::new(),
        scheduled_start: None,
        scheduled_end: None,
        completed_at: None,
        parent_id: None,
        last_opened_at: None,
        created_at: None,
        updated_at: None,
    }
}

/// Open (creating + migrating) the DB and insert the given pages; returns ids.
async fn seed(db: &str, pages: Vec<NewPage>) -> Vec<String> {
    let pool = open_pool(db).await.unwrap();
    let mut ids = Vec::new();
    for p in pages {
        ids.push(create_page_impl(&pool, p).await.unwrap().id);
    }
    ids
}

/// Link a page to a synced calendar, creating a throwaway account on first use.
/// `sync_state` ∈ active | detached | tombstoned.
async fn mark_synced(db: &str, page_id: &str, sync_state: &str) {
    mark_synced_at(db, page_id, sync_state, "2026-01-01T00:00:00Z").await;
}

/// [`mark_synced`], connected at `connected` (UTC), which sets the page's synced-since day.
async fn mark_synced_at(db: &str, page_id: &str, sync_state: &str, connected: &str) {
    let pool = open_pool(db).await.unwrap();
    sqlx::query(
        "INSERT OR IGNORE INTO sync_account (id, provider, display_name, auth_kind, created_at, updated_at)
         VALUES ('acct', 'caldav', 'Test', 'basic', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO page_sync
         (id, page_id, account_id, provider, calendar_id, external_id, ical_uid, sync_state, created_at)
         VALUES (?, ?, 'acct', 'caldav', 'cal', ?, ?, ?, ?)",
    )
    .bind(format!("ps-{page_id}"))
    .bind(page_id)
    .bind(format!("href-{page_id}"))
    .bind(format!("uid-{page_id}"))
    .bind(sync_state)
    .bind(connected)
    .execute(&pool)
    .await
    .unwrap();
}

/// Read one value straight from the workspace file. Deliberately not `open_pool`:
/// that runs the migrator, which would repair the behind-the-CLI schema the
/// migration-consent test is asserting stayed untouched.
async fn scalar<T>(db: &str, sql: &str) -> T
where
    T: for<'r> sqlx::Decode<'r, sqlx::Sqlite> + sqlx::Type<sqlx::Sqlite> + Send + Unpin,
{
    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new()
            .filename(db)
            .create_if_missing(false),
    )
    .await
    .unwrap();
    sqlx::query_scalar::<_, T>(sql)
        .fetch_one(&pool)
        .await
        .unwrap()
}

async fn stamp_version(db: &str, version: i64) {
    let pool = open_pool(db).await.unwrap();
    sqlx::query(
        "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) \
         VALUES (?, 'future', 1, X'00', 0)",
    )
    .bind(version)
    .execute(&pool)
    .await
    .unwrap();
}

fn cli(db: &str, args: &[&str]) -> Output {
    Command::new(BIN)
        .args(args)
        .arg("--db")
        .arg(db)
        .output()
        .unwrap()
}

fn bridge_js() -> Option<String> {
    let p = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/pikos-bridge/dist/bridge.mjs"
    ));
    p.exists().then(|| p.to_string_lossy().into_owned())
}

/// Run a command that needs the parser bridge; None when the bridge isn't built.
fn cli_bridge(db: &str, args: &[&str]) -> Option<Output> {
    let js = bridge_js()?;
    Some(
        Command::new(BIN)
            .args(args)
            .arg("--db")
            .arg(db)
            .env("PIKOS_BRIDGE_JS", js)
            .output()
            .unwrap(),
    )
}

/// Run a bridge-needing command with PATH cleared so the inner `node` spawn
/// fails ENOENT — simulates a user who hasn't installed Node.js. The CLI binary
/// itself is invoked by absolute path (BIN), so clearing PATH only affects what
/// the CLI subprocess can find.
fn cli_bridge_without_node(db: &str, args: &[&str]) -> Option<Output> {
    let js = bridge_js()?;
    Some(
        Command::new(BIN)
            .args(args)
            .arg("--db")
            .arg(db)
            .env("PIKOS_BRIDGE_JS", js)
            .env("PATH", "")
            .output()
            .unwrap(),
    )
}

fn json(out: &Output) -> Value {
    serde_json::from_slice(&out.stdout).expect("stdout is JSON")
}

fn code(out: &Output) -> i32 {
    out.status.code().unwrap_or(-1)
}

// ─── DB-only commands (always run) ─────────────────────────────────────────────

#[tokio::test]
async fn read_returns_page_json() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Hello world")]).await;
    let out = cli(dbs, &["read", &ids[0], "--json"]);
    assert!(out.status.success());
    assert_eq!(json(&out)["title"], "Hello world");
}

#[tokio::test]
async fn a_page_link_round_trips_through_read_and_update_by_title() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Plans"), base_page("Journal")]).await;
    let (plans, journal) = (&ids[0], &ids[1]);

    let linked = cli(
        dbs,
        &["update", journal, "--content", "See [[Plans]]", "--json"],
    );
    assert!(
        linked.status.success(),
        "{}",
        String::from_utf8_lossy(&linked.stderr)
    );
    assert_eq!(json(&linked)["links"], serde_json::json!([plans]));

    cli(dbs, &["update", plans, "--title", "Spring plans"]);
    let markdown = json(&cli(dbs, &["read", journal, "--json"]))["markdown"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(markdown, "See [[Spring plans]]\n");

    let written_back = cli(dbs, &["update", journal, "--content", &markdown, "--json"]);
    assert_eq!(json(&written_back)["links"], serde_json::json!([plans]));
}

#[tokio::test]
async fn read_missing_exits_3() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![]).await; // migrate empty
    let out = cli(dbs, &["read", "00000000-0000-0000-0000-000000000000"]);
    assert_eq!(code(&out), 3);
}

#[tokio::test]
async fn list_json_and_status_filter() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let mut done = base_page("Done one");
    done.status = "done".into();
    seed(dbs, vec![base_page("Open one"), done]).await;

    let all = cli(dbs, &["list", "--json"]);
    assert_eq!(json(&all).as_array().unwrap().len(), 2);

    let done_only = cli(dbs, &["list", "--status", "done", "--json"]);
    let arr = json(&done_only);
    assert_eq!(arr.as_array().unwrap().len(), 1);
    assert_eq!(arr[0]["title"], "Done one");
}

#[tokio::test]
async fn list_rejects_bad_status_exit_2() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![]).await;
    let out = cli(dbs, &["list", "--status", "bogus"]);
    assert_eq!(code(&out), 2);
}

#[tokio::test]
async fn a_write_from_another_process_counts_as_someone_elses() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Groceries")]).await;
    let pool = open_pool(dbs).await.unwrap();
    let before = pikos_db::changes::change_state(&pool).await.unwrap();

    let out = cli(
        dbs,
        &[
            "update",
            &ids[0],
            "--title",
            "Groceries, Saturday",
            "--json",
        ],
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );

    let after = pikos_db::changes::change_state(&pool).await.unwrap();
    assert!(after.seq > before.seq);
    assert_eq!(after.own_changes, before.own_changes);
}

#[tokio::test]
async fn stress_seed_writes_bodies_the_editor_can_open() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let out = cli(
        dbs,
        &[
            "stress",
            "seed",
            "--pages",
            "30",
            "--large-pages",
            "1",
            "--large-words",
            "20",
            "--json",
        ],
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let not_documents: i64 = scalar(
        dbs,
        "SELECT (SELECT COUNT(*) FROM page_chunks \
                 WHERE NOT json_valid(body) OR json_type(body) <> 'array') \
              + (SELECT COUNT(*) FROM pages WHERE content_text LIKE '{%')",
    )
    .await;
    assert_eq!(not_documents, 0);
}

#[tokio::test]
async fn search_finds_body_text() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let mut p = base_page("Groceries");
    p.content = pikos_db::build_tiptap_doc("remember the avocado");
    seed(dbs, vec![p]).await;
    let out = cli(dbs, &["search", "avocado", "--json"]);
    assert!(out.status.success());
    assert_eq!(json(&out)["results"][0]["title"], "Groceries");
}

// qa: CLI-07:2
#[tokio::test]
async fn search_pages_through_every_match_with_its_cursor() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let pages = (0..5)
        .map(|i| {
            let mut p = base_page(&format!("Note {i}"));
            p.content = pikos_db::build_tiptap_doc("remember the avocado");
            p
        })
        .collect();
    let ids = seed(dbs, pages).await;

    let mut seen = Vec::new();
    let mut after: Option<String> = None;
    for _ in 0..ids.len() {
        let mut args = vec!["search", "avocado", "--limit", "2", "--json"];
        if let Some(cursor) = &after {
            args.extend(["--after", cursor]);
        }
        let page = json(&cli(dbs, &args));
        for r in page["results"].as_array().unwrap() {
            seen.push(r["id"].as_str().unwrap().to_string());
        }
        match page["next"].as_str() {
            Some(next) => after = Some(next.to_string()),
            None => break,
        }
    }
    seen.sort();
    let mut expected = ids.clone();
    expected.sort();
    assert_eq!(seen, expected);
}

// qa: CLI-07:2
#[tokio::test]
async fn search_refuses_a_cursor_it_never_printed() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![base_page("Groceries")]).await;
    let out = cli(dbs, &["search", "avocado", "--after", "soon", "--json"]);
    assert_eq!(code(&out), 2);
}

#[tokio::test]
async fn status_and_delete_roundtrip() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Task")]).await;
    let id = &ids[0];

    assert!(cli(dbs, &["status", id, "done", "--json"]).status.success());
    assert_eq!(json(&cli(dbs, &["read", id, "--json"]))["status"], "done");

    assert!(cli(dbs, &["delete", id, "--hard", "--yes", "--json"])
        .status
        .success());
    assert_eq!(code(&cli(dbs, &["read", id])), 3); // gone
}

#[tokio::test]
async fn completing_stamps_local_wall_clock() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Task")]).await;
    assert!(cli(dbs, &["done", &ids[0], "--json"]).status.success());

    let stamped = json(&cli(dbs, &["read", &ids[0], "--json"]))["completedAt"]
        .as_str()
        .unwrap()
        .to_string();
    // A UTC stamp files an evening completion under tomorrow for anyone west of
    // UTC, because the Completed view date-compares this against the local day.
    assert!(
        !stamped.ends_with('Z'),
        "expected local wall-clock: {stamped}"
    );
    assert_eq!(
        &stamped[..10],
        chrono::Local::now().format("%Y-%m-%d").to_string()
    );
}

// ─── delete: origin × --hard ─────────────────────────────────────────────────

/// Soft-deleted rows keep their `pages` row (so `read` still resolves) but drop
/// out of every list; only a hard delete removes the row.
async fn page_row_count(db: &str, id: &str) -> i64 {
    scalar(db, &format!("SELECT COUNT(*) FROM pages WHERE id = '{id}'")).await
}

async fn sync_state(db: &str, id: &str) -> Option<String> {
    scalar(
        db,
        &format!("SELECT sync_state FROM page_sync WHERE page_id = '{id}'"),
    )
    .await
}

#[tokio::test]
async fn delete_soft_deletes_a_native_page() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Task")]).await;

    assert!(cli(dbs, &["delete", &ids[0], "--yes", "--json"])
        .status
        .success());
    assert_eq!(
        page_row_count(dbs, &ids[0]).await,
        1,
        "recoverable from trash"
    );
    assert!(json(&cli(dbs, &["list", "--json"]))
        .as_array()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn delete_soft_deletes_and_tombstones_a_synced_page() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Standup")]).await;
    mark_synced(dbs, &ids[0], "active").await;

    assert!(cli(dbs, &["delete", &ids[0], "--yes", "--json"])
        .status
        .success());
    assert_eq!(page_row_count(dbs, &ids[0]).await, 1);
    assert_eq!(
        sync_state(dbs, &ids[0]).await.as_deref(),
        Some("tombstoned")
    );
}

#[tokio::test]
async fn hard_delete_refuses_on_an_active_synced_page() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Standup")]).await;
    mark_synced(dbs, &ids[0], "active").await;

    // Destroying a live mirror is theatre — the next poll recreates it.
    let out = cli(dbs, &["delete", &ids[0], "--hard", "--yes", "--json"]);
    assert_eq!(code(&out), 4);
    assert_eq!(page_row_count(dbs, &ids[0]).await, 1);
}

#[tokio::test]
async fn hard_delete_refuses_on_a_tombstoned_synced_page() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Standup")]).await;
    mark_synced(dbs, &ids[0], "tombstoned").await;

    // The tombstone is what suppresses the mirror; cascading it away un-suppresses it.
    let out = cli(dbs, &["delete", &ids[0], "--hard", "--yes", "--json"]);
    assert_eq!(code(&out), 4);
    assert_eq!(page_row_count(dbs, &ids[0]).await, 1);
    assert_eq!(
        sync_state(dbs, &ids[0]).await.as_deref(),
        Some("tombstoned")
    );
}

#[tokio::test]
async fn hard_delete_destroys_a_detached_page() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Was synced")]).await;
    mark_synced(dbs, &ids[0], "detached").await;

    // The link is severed and the page is user-owned; nothing upstream restores it.
    assert!(cli(dbs, &["delete", &ids[0], "--hard", "--yes", "--json"])
        .status
        .success());
    assert_eq!(page_row_count(dbs, &ids[0]).await, 0);
}

#[tokio::test]
async fn delete_soft_deletes_a_detached_page() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Was synced")]).await;
    mark_synced(dbs, &ids[0], "detached").await;

    assert!(cli(dbs, &["delete", &ids[0], "--yes", "--json"])
        .status
        .success());
    assert_eq!(page_row_count(dbs, &ids[0]).await, 1);
    // A detached link stays detached through trash → restore.
    assert_eq!(sync_state(dbs, &ids[0]).await.as_deref(), Some("detached"));
}

#[tokio::test]
async fn update_title_and_priority() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Draft")]).await;
    let out = cli(
        dbs,
        &[
            "update",
            &ids[0],
            "--title",
            "Final",
            "--priority",
            "1",
            "--json",
        ],
    );
    assert!(out.status.success());
    let v = json(&out);
    assert_eq!(v["title"], "Final");
    assert_eq!(v["priority"], 1);
}

#[tokio::test]
async fn delete_in_json_mode_without_yes_refuses_exit_2() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Keep")]).await;
    let out = cli(dbs, &["delete", &ids[0], "--json"]);
    assert_eq!(code(&out), 2); // refuses without --yes in --json mode
}

// ─── update --due ────────────────────────────────────────────────────────────

async fn scheduled_start(db: &str, id: &str) -> Option<String> {
    scalar(
        db,
        &format!("SELECT scheduled_start FROM pages WHERE id = '{id}'"),
    )
    .await
}

#[tokio::test]
async fn update_due_accepts_a_date_and_a_local_timed_iso() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Task")]).await;

    assert!(
        cli(dbs, &["update", &ids[0], "--due", "2026-09-01", "--json"])
            .status
            .success()
    );
    assert_eq!(
        scheduled_start(dbs, &ids[0]).await.as_deref(),
        Some("2026-09-01")
    );

    assert!(cli(
        dbs,
        &["update", &ids[0], "--due", "2026-09-01T14:00:00", "--json"]
    )
    .status
    .success());
    assert_eq!(
        scheduled_start(dbs, &ids[0]).await.as_deref(),
        Some("2026-09-01T14:00:00")
    );
}

async fn scheduled_end(db: &str, id: &str) -> Option<String> {
    scalar(
        db,
        &format!("SELECT scheduled_end FROM pages WHERE id = '{id}'"),
    )
    .await
}

/// A two-hour meeting, through the flags a user would actually type.
async fn seed_timed_meeting(db: &str) -> String {
    let ids = seed(db, vec![base_page("Review")]).await;
    assert!(cli(
        db,
        &[
            "update",
            &ids[0],
            "--due",
            "2026-09-01T14:00:00",
            "--end",
            "2026-09-01T16:00:00",
            "--json",
        ],
    )
    .status
    .success());
    ids.into_iter().next().unwrap()
}

#[tokio::test]
async fn update_moves_a_timed_page_and_keeps_its_length() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let id = seed_timed_meeting(dbs).await;

    assert!(cli(
        dbs,
        &["update", &id, "--due", "2026-09-02T09:00:00", "--json"]
    )
    .status
    .success());
    assert_eq!(
        scheduled_start(dbs, &id).await.as_deref(),
        Some("2026-09-02T09:00:00")
    );
    assert_eq!(
        scheduled_end(dbs, &id).await.as_deref(),
        Some("2026-09-02T11:00:00"),
        "still two hours long"
    );
}

// qa: CLI-03
#[tokio::test]
async fn update_refuses_a_bare_date_against_a_timed_page() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let id = seed_timed_meeting(dbs).await;

    let out = cli(dbs, &["update", &id, "--due", "2026-09-02", "--json"]);
    assert_eq!(code(&out), 2);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("--all-day 2026-09-02"), "{stderr}");
    assert!(stderr.contains("--due 2026-09-02THH:MM:SS"), "{stderr}");
    assert_eq!(
        scheduled_start(dbs, &id).await.as_deref(),
        Some("2026-09-01T14:00:00"),
        "the refusal landed before any write"
    );
}

#[tokio::test]
async fn update_all_day_is_how_a_timed_page_converts() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let id = seed_timed_meeting(dbs).await;

    assert!(
        cli(dbs, &["update", &id, "--all-day", "2026-09-02", "--json"])
            .status
            .success()
    );
    assert_eq!(
        scheduled_start(dbs, &id).await.as_deref(),
        Some("2026-09-02")
    );
    assert_eq!(scheduled_end(dbs, &id).await, None);
}

#[tokio::test]
async fn update_end_alone_extends_without_moving() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let id = seed_timed_meeting(dbs).await;

    assert!(cli(
        dbs,
        &["update", &id, "--end", "2026-09-01T17:00:00", "--json"]
    )
    .status
    .success());
    assert_eq!(
        scheduled_start(dbs, &id).await.as_deref(),
        Some("2026-09-01T14:00:00")
    );
    assert_eq!(
        scheduled_end(dbs, &id).await.as_deref(),
        Some("2026-09-01T17:00:00")
    );
}

#[tokio::test]
async fn update_rejects_due_and_all_day_together() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Task")]).await;

    let out = cli(
        dbs,
        &[
            "update",
            &ids[0],
            "--due",
            "2026-09-01T14:00:00",
            "--all-day",
            "2026-09-01",
            "--json",
        ],
    );
    assert_eq!(code(&out), 2);
    assert_eq!(scheduled_start(dbs, &ids[0]).await, None);
}

#[tokio::test]
async fn update_due_rejects_freeform_without_touching_the_row() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Task")]).await;

    for bad in ["tomorrow", "2026-9-1", "2026-13-45", "2026-09-01T14:00"] {
        // --title rides along to prove nothing lands when the flag is rejected.
        let out = cli(
            dbs,
            &[
                "update", &ids[0], "--due", bad, "--title", "Renamed", "--json",
            ],
        );
        assert_eq!(code(&out), 2, "should reject --due {bad}");
        assert_eq!(scheduled_start(dbs, &ids[0]).await, None);
        assert_eq!(
            json(&cli(dbs, &["read", &ids[0], "--json"]))["title"],
            "Task"
        );
    }
}

/// Each flag that moves a schedule, with a value that would move it.
const SCHEDULE_FLAGS: [[&str; 2]; 3] = [
    ["--due", "2026-09-02T10:00:00"],
    ["--all-day", "2026-09-02"],
    ["--end", "2026-09-01T18:00:00"],
];

/// The flags that change a schedule without taking a value.
const BARE_SCHEDULE_FLAGS: [&str; 2] = ["--unschedule", "--no-end"];

// qa: CLI-10:6
#[tokio::test]
async fn schedule_flags_refuse_on_a_synced_page() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Standup")]).await;
    // A schedule to hold still: --end on an unscheduled page fails validation, not the lock.
    assert!(cli(
        dbs,
        &["update", &ids[0], "--due", "2026-09-01T14:00:00", "--json"]
    )
    .status
    .success());
    mark_synced(dbs, &ids[0], "active").await;

    for [flag, value] in SCHEDULE_FLAGS {
        let out = cli(dbs, &["update", &ids[0], flag, value, "--json"]);
        assert_eq!(code(&out), 4, "{flag} should refuse");
        assert_eq!(
            scheduled_start(dbs, &ids[0]).await.as_deref(),
            Some("2026-09-01T14:00:00"),
            "{flag} moved the start"
        );
        assert_eq!(scheduled_end(dbs, &ids[0]).await, None, "{flag} set an end");
    }
    for flag in BARE_SCHEDULE_FLAGS {
        let out = cli(dbs, &["update", &ids[0], flag, "--json"]);
        assert_eq!(code(&out), 4, "{flag} should refuse");
        assert_eq!(
            scheduled_start(dbs, &ids[0]).await.as_deref(),
            Some("2026-09-01T14:00:00"),
            "{flag} touched the start"
        );
    }
}

#[tokio::test]
async fn schedule_flags_refuse_on_a_recurring_page() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![]).await;
    let Some(add) = cli_bridge(dbs, &["add", "Standup every weekday at 9am", "--json"]) else {
        eprintln!("skipped: @pikos/bridge not built");
        return;
    };
    assert!(add.status.success());
    let id = json(&add)["created"][0]["id"].as_str().unwrap().to_string();
    let head = scheduled_start(dbs, &id).await;
    let rule_base: String = scalar(
        dbs,
        &format!("SELECT scheduled_start FROM page_recurrence_rules WHERE page_id = '{id}'"),
    )
    .await;

    let end = scheduled_end(dbs, &id).await;

    for [flag, value] in SCHEDULE_FLAGS {
        let out = cli(dbs, &["update", &id, flag, value, "--json"]);
        assert_eq!(code(&out), 4, "{flag} should refuse");
        assert_eq!(
            scheduled_start(dbs, &id).await,
            head,
            "{flag} moved the head"
        );
        assert_eq!(
            scheduled_end(dbs, &id).await,
            end,
            "{flag} moved the head's end"
        );
        assert_eq!(
            scalar::<String>(
                dbs,
                &format!(
                    "SELECT scheduled_start FROM page_recurrence_rules WHERE page_id = '{id}'"
                )
            )
            .await,
            rule_base,
            "{flag} moved the rule's base"
        );
    }
    for flag in BARE_SCHEDULE_FLAGS {
        let out = cli(dbs, &["update", &id, flag, "--json"]);
        assert_eq!(code(&out), 4, "{flag} should refuse");
        assert_eq!(
            scheduled_start(dbs, &id).await,
            head,
            "{flag} moved the head"
        );
        assert_eq!(
            scheduled_end(dbs, &id).await,
            end,
            "{flag} moved the head's end"
        );
    }
}

// qa: CLI-10:6
#[tokio::test]
async fn update_unschedule_removes_the_date_and_no_end_keeps_the_start() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let id = seed_timed_meeting(dbs).await;

    let trimmed = cli(dbs, &["update", &id, "--no-end", "--json"]);
    assert!(trimmed.status.success());
    assert_eq!(
        scheduled_start(dbs, &id).await.as_deref(),
        Some("2026-09-01T14:00:00")
    );
    assert_eq!(scheduled_end(dbs, &id).await, None);

    let cleared = cli(dbs, &["update", &id, "--unschedule", "--json"]);
    assert!(cleared.status.success());
    assert!(json(&cleared)["scheduledStart"].is_null());
    let rows: i64 = scalar(
        dbs,
        &format!("SELECT COUNT(*) FROM page_schedules WHERE page_id = '{id}'"),
    )
    .await;
    assert_eq!(rows, 0);

    let again = cli(dbs, &["update", &id, "--unschedule", "--json"]);
    assert!(again.status.success(), "unscheduling twice is harmless");
    let nothing_to_trim = cli(dbs, &["update", &id, "--no-end", "--json"]);
    assert_eq!(code(&nothing_to_trim), 2);
}

#[tokio::test]
async fn update_unschedule_refuses_a_flag_that_would_reschedule() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let id = seed_timed_meeting(dbs).await;
    let out = cli(
        dbs,
        &[
            "update",
            &id,
            "--unschedule",
            "--due",
            "2026-09-03",
            "--json",
        ],
    );
    assert_eq!(code(&out), 2);
    assert_eq!(
        scheduled_start(dbs, &id).await.as_deref(),
        Some("2026-09-01T14:00:00")
    );
}

// qa: CLI-10:6
#[tokio::test]
async fn update_tags_add_and_remove_as_the_writer_stores_them() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let mut page = base_page("Plan");
    page.tags = vec!["work".into(), "q3".into()];
    let ids = seed(dbs, vec![page]).await;

    let out = cli(
        dbs,
        &[
            "update", &ids[0], "--tag", "#Errands", "--tag", "work", "--untag", "Q3", "--json",
        ],
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(json(&out)["tags"], serde_json::json!(["work", "errands"]));

    let tagged = json(&cli(dbs, &["list", "--tag", "errands", "--json"]));
    assert_eq!(
        tagged.as_array().unwrap().len(),
        1,
        "the tag index follows the edit"
    );
    let dropped = json(&cli(dbs, &["list", "--tag", "q3", "--json"]));
    assert!(dropped.as_array().unwrap().is_empty());

    let both = cli(
        dbs,
        &["update", &ids[0], "--tag", "x", "--untag", "X", "--json"],
    );
    assert_eq!(code(&both), 2);
    let blank = cli(dbs, &["update", &ids[0], "--tag", "#", "--json"]);
    assert_eq!(code(&blank), 2);
}

// qa: CLI-10:6
#[tokio::test]
async fn update_subtitle_sets_and_clears_the_line_under_the_title() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Plan")]).await;

    let set = cli(
        dbs,
        &["update", &ids[0], "--subtitle", "For Monday", "--json"],
    );
    assert_eq!(json(&set)["subtitle"], "For Monday");
    let cleared = cli(dbs, &["update", &ids[0], "--subtitle", "", "--json"]);
    assert_eq!(json(&cleared)["subtitle"], "");
}

// ─── workspace targeting + migration consent ─────────────────────────────────

#[tokio::test]
async fn a_debug_build_resolves_the_dev_workspace() {
    // The CLI opens the same file as the installed app and migrates on connect, so
    // a branch build pointed at the release identifier can lock the app out.
    let home = std::env::temp_dir().join(format!("pikos-cli-home-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let out = Command::new(BIN)
        .arg("list")
        .env("HOME", &home)
        .env("XDG_DATA_HOME", home.join("share"))
        .env("APPDATA", home.join("AppData"))
        .output()
        .unwrap();

    assert_eq!(code(&out), 5); // no workspace there — the message names the path
    let msg = String::from_utf8_lossy(&out.stderr);
    assert!(
        msg.contains("app.pikos.desktop.dev"),
        "a debug build must target the dev workspace: {msg}"
    );
}

#[tokio::test]
async fn a_cli_ahead_of_the_workspace_refuses_to_migrate() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![base_page("Keep")]).await;
    // Rewind the recorded schema so this CLI's embedded set is ahead of it.
    let pool = open_pool(dbs).await.unwrap();
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version > 1")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;

    let out = cli(dbs, &["list", "--json"]);
    assert_eq!(code(&out), 8);
    assert_eq!(
        scalar::<i64>(dbs, "SELECT MAX(version) FROM _sqlx_migrations").await,
        1,
        "refusing must not have written the migration table"
    );
    let msg = String::from_utf8_lossy(&out.stderr);
    assert!(msg.contains("--migrate"), "must name the opt-in: {msg}");
}

#[test]
fn missing_workspace_exits_5() {
    let out = cli("/nonexistent/dir/workspace.sqlite", &["list"]);
    assert_eq!(code(&out), 5);
}

#[tokio::test]
async fn add_without_node_exits_7_with_actionable_error() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![]).await;
    let Some(out) = cli_bridge_without_node(dbs, &["add", "anything", "--json"]) else {
        eprintln!("skipped: @pikos/bridge not built");
        return;
    };
    assert_eq!(code(&out), 7);
    // Errors are JSON-on-stderr (stdout reserved for successful payloads).
    let body: Value = serde_json::from_slice(&out.stderr).expect("stderr JSON");
    assert_eq!(body["error"]["kind"], "MissingNode");
    let msg = body["error"]["message"].as_str().unwrap_or("");
    assert!(
        msg.contains("Node.js"),
        "message should name Node.js: {msg}"
    );
    assert!(
        msg.contains("nodejs.org") || msg.contains("brew install node"),
        "message should hint at install path: {msg}",
    );
    // Reassure the user that DB-only commands still work — that's the whole point
    // of distinguishing this error from a generic Internal failure.
    assert!(
        msg.contains("DB-only") || msg.contains("list") || msg.contains("today"),
        "message should mention DB-only commands as a fallback: {msg}",
    );
}

#[tokio::test]
async fn schema_newer_than_cli_exits_6() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![base_page("seed")]).await;
    stamp_version(dbs, 9999).await; // pretend the app advanced the schema
    let out = cli(dbs, &["status", "whatever", "done"]);
    assert_eq!(code(&out), 6);
}

// ─── Bridge-backed commands (run when the bridge bundle is built) ───────────────

#[tokio::test]
async fn add_single_parses_via_bridge() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![]).await; // migrate empty so the file exists
    let Some(out) = cli_bridge(dbs, &["add", "Buy milk tomorrow #errands !high", "--json"]) else {
        eprintln!("skipped: @pikos/bridge not built (pnpm --filter @pikos/bridge build)");
        return;
    };
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v = json(&out);
    assert_eq!(v["created"][0]["title"], "Buy milk");
    assert_eq!(v["created"][0]["priority"], 2); // !high
    assert_eq!(v["created"][0]["tags"][0], "errands");
    assert!(v["created"][0]["scheduledStart"].is_string()); // "tomorrow" parsed
}

// qa: CLI-02
#[tokio::test]
async fn add_creates_the_page_with_its_note_and_reminder() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![]).await;
    let Some(out) = cli_bridge(
        dbs,
        &[
            "add",
            "Dentist tomorrow 3pm remind 30m before // ask about the crown",
            "--json",
        ],
    ) else {
        eprintln!("skipped: @pikos/bridge not built (pnpm --filter @pikos/bridge build)");
        return;
    };
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let created = &json(&out)["created"][0];
    assert_eq!(created["title"], "Dentist");
    let id = created["id"].as_str().unwrap().to_string();

    let start = scheduled_start(dbs, &id).await.unwrap();
    assert!(start.ends_with("T15:00:00"), "not at 3pm: {start}");
    let lead: i64 = scalar(
        dbs,
        &format!("SELECT minutes_before FROM page_reminders WHERE page_id = '{id}'"),
    )
    .await;
    assert_eq!(lead, 30);
    let body: String = scalar(
        dbs,
        &format!("SELECT content_text FROM pages WHERE id = '{id}'"),
    )
    .await;
    assert!(
        body.contains("ask about the crown"),
        "note missing: {body:?}"
    );
}

#[tokio::test]
async fn done_recurring_advances_and_clones() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![]).await;
    let Some(add) = cli_bridge(dbs, &["add", "Standup every weekday at 9am", "--json"]) else {
        eprintln!("skipped: @pikos/bridge not built");
        return;
    };
    assert!(add.status.success());
    let id = json(&add)["created"][0]["id"].as_str().unwrap().to_string();
    let before = json(&cli(dbs, &["read", &id, "--json"]))["scheduledStart"]
        .as_str()
        .unwrap()
        .to_string();

    let done = cli_bridge(dbs, &["done", &id, "--json"]).unwrap();
    assert!(
        done.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&done.stderr)
    );
    let head = json(&done);
    assert_eq!(head["status"], "not_started"); // head advanced, not completed
    assert_ne!(head["scheduledStart"].as_str().unwrap(), before);

    // A completed clone now exists.
    let search = cli(dbs, &["search", "Standup", "--include-completed", "--json"]);
    let results = json(&search);
    let has_done = results["results"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["status"] == "done");
    assert!(has_done, "expected a completed Standup clone");
}

/// An explicit date *plus* a weekday cadence is the only input that reaches the
/// CLI off-pattern — a bare "every monday" is resolved to a Monday by the parser
/// itself, and a cadence with no weekday (`FREQ=DAILY`, `FREQ=MONTHLY`) yields
/// whatever day it is anchored on. Naming both is what disagrees, and the app
/// snaps it before writing the rule.
#[tokio::test]
async fn add_recurring_snaps_an_off_pattern_anchor_onto_the_rule() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![]).await;

    let Some(add) = cli_bridge(
        dbs,
        &[
            "add",
            "Gym on wednesday every monday from 9am to 11am",
            "--json",
        ],
    ) else {
        eprintln!("skipped: @pikos/bridge not built");
        return;
    };
    assert!(
        add.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&add.stderr)
    );
    let id = json(&add)["created"][0]["id"].as_str().unwrap().to_string();
    let base: String = scalar(
        dbs,
        &format!("SELECT scheduled_start FROM page_recurrence_rules WHERE page_id = '{id}'"),
    )
    .await;

    let date = NaiveDate::parse_from_str(&base[..10], "%Y-%m-%d").unwrap();
    assert_eq!(date.weekday(), Weekday::Mon, "rule anchored off-pattern");
    // The end has to travel with the start, or it lands days before it.
    let end: String = scalar(
        dbs,
        &format!("SELECT scheduled_end FROM page_recurrence_rules WHERE page_id = '{id}'"),
    )
    .await;
    assert_eq!(&end[..10], &base[..10], "end left behind on the parsed day");
    assert!(end > base, "end precedes start");
    // The head is the derivation's to write once the rule exists — a CLI-side
    // denorm write on top of it is what put the parsed Wednesday back.
    assert_eq!(
        scheduled_start(dbs, &id).await.as_deref(),
        Some(base.as_str()),
        "head disagrees with the rule it was derived from"
    );
}

async fn make_folder(db: &str, name: &str) -> String {
    let pool = open_pool(db).await.unwrap();
    pikos_db::create_folder_impl(
        &pool,
        pikos_db::NewFolder {
            name: name.to_string(),
            parent_id: None,
            color: None,
            icon: None,
        },
    )
    .await
    .unwrap()
    .id
}

/// `~proj` used to reach only an exact "proj" folder and fall through to Inbox,
/// while Quick Add prefix-matched it — the same string filing two ways depending
/// on the binary.
#[tokio::test]
async fn add_files_into_a_prefix_matched_folder() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![]).await;
    let projects = make_folder(dbs, "Projects").await;

    let Some(add) = cli_bridge(dbs, &["add", "Ship the thing ~proj", "--json"]) else {
        eprintln!("skipped: @pikos/bridge not built");
        return;
    };
    assert!(
        add.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&add.stderr)
    );
    assert_eq!(json(&add)["created"][0]["folderId"], projects.as_str());
}

/// The word carries no privilege: it resolves to a folder named for it, and only
/// falls through to the Inbox view when nothing is.
#[tokio::test]
async fn add_prefers_a_real_inbox_folder_over_the_inbox_view() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![]).await;
    let inbox = make_folder(dbs, "Inbox Zero").await;

    let Some(add) = cli_bridge(dbs, &["add", "Sort mail ~inbox", "--json"]) else {
        eprintln!("skipped: @pikos/bridge not built");
        return;
    };
    assert!(add.status.success());
    assert_eq!(json(&add)["created"][0]["folderId"], inbox.as_str());

    let db2 = unique_db();
    let dbs2 = db2.to_str().unwrap();
    seed(dbs2, vec![]).await;
    let Some(bare) = cli_bridge(dbs2, &["add", "Sort mail ~inbox", "--json"]) else {
        return;
    };
    assert!(bare.status.success());
    assert!(json(&bare)["created"][0]["folderId"].is_null());
}

// ─── done: the synced guard sits on the series, not the origin ─────────────────

/// Attach a weekly rule so the page reads as a series to the `done` guard.
async fn mark_recurring(db: &str, page_id: &str, start: &str) {
    let pool = open_pool(db).await.unwrap();
    pikos_db::create_recurrence_rule_impl(
        &pool,
        pikos_db::NewRecurrenceRule {
            page_id: page_id.to_string(),
            rrule: "FREQ=WEEKLY".into(),
            rrule_exdates: Vec::new(),
            scheduled_start: start.to_string(),
            scheduled_end: None,
            timezone: "America/New_York".into(),
        },
    )
    .await
    .unwrap();
}

/// A weekly Monday 9am in London from 2026-10-19, mirrored from a connected calendar.
/// London leaves summer time on 25 October and the US a week later, so the two
/// Mondays sit on different offsets for any viewer outside London.
async fn seed_london_standup(db: &str, connected: &str) -> String {
    let ids = seed(db, vec![base_page("Standup")]).await;
    let pool = open_pool(db).await.unwrap();
    // The rule goes on before the mirror locks — the order the reconciler writes in.
    pikos_db::create_recurrence_rule_impl(
        &pool,
        pikos_db::NewRecurrenceRule {
            page_id: ids[0].clone(),
            rrule: "FREQ=WEEKLY;BYDAY=MO".into(),
            rrule_exdates: Vec::new(),
            scheduled_start: "2026-10-19T09:00:00".into(),
            scheduled_end: Some("2026-10-19T09:15:00".into()),
            timezone: "Europe/London".into(),
        },
    )
    .await
    .unwrap();
    mark_synced_at(db, &ids[0], "active", connected).await;
    ids.into_iter().next().unwrap()
}

/// London wall-clock → this machine's, computed apart from the code under test.
fn on_this_machine(london: &str) -> String {
    let wall = chrono::NaiveDateTime::parse_from_str(london, "%Y-%m-%dT%H:%M:%S").unwrap();
    let utc = pikos_recurrence::zoned::wall_clock_to_utc("Europe/London", wall).unwrap();
    pikos_recurrence::zoned::utc_to_wall_clock(pikos_db::device_zone().name(), utc)
        .unwrap()
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string()
}

async fn ticked_clone_start(db: &str, series: &str, day: &str) -> String {
    let page = json(&cli(db, &["read", series, "--json"]));
    let clone = page["completedOccurrences"][day]
        .as_str()
        .unwrap_or_else(|| panic!("{day} was ticked off: {page}"))
        .to_string();
    json(&cli(db, &["read", &clone, "--json"]))["scheduledStart"]
        .as_str()
        .unwrap()
        .to_string()
}

// qa: CLI-15
#[tokio::test]
async fn done_ticks_off_a_calendar_series_at_the_time_the_app_shows() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let id = seed_london_standup(dbs, "2026-01-01T00:00:00Z").await;

    let oldest = cli(dbs, &["done", &id, "--json"]);
    assert!(
        oldest.status.success(),
        "{}",
        String::from_utf8_lossy(&oldest.stderr)
    );
    assert_eq!(
        ticked_clone_start(dbs, &id, "2026-10-19").await,
        on_this_machine("2026-10-19T09:00:00")
    );

    let named = cli(dbs, &["done", &id, "--date", "2026-10-26", "--json"]);
    assert!(
        named.status.success(),
        "{}",
        String::from_utf8_lossy(&named.stderr)
    );
    assert_eq!(
        ticked_clone_start(dbs, &id, "2026-10-26").await,
        on_this_machine("2026-10-26T09:00:00"),
        "the week London's clocks changed converts at London's new offset"
    );

    let again = cli(dbs, &["done", &id, "--date", "2026-10-26", "--json"]);
    assert!(again.status.success(), "ticking it twice is harmless");
}

#[tokio::test]
async fn done_with_a_date_refuses_what_the_calendar_series_cannot_tick() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let id = seed_london_standup(dbs, "2026-10-20T12:00:00Z").await;

    let tuesday = cli(dbs, &["done", &id, "--date", "2026-10-27", "--json"]);
    assert_eq!(code(&tuesday), 2, "the rule never gives a Tuesday");
    let before = cli(dbs, &["done", &id, "--date", "2026-10-19", "--json"]);
    assert_eq!(code(&before), 4, "before the calendar was connected");

    assert!(
        cli(dbs, &["occurrence", "skip", &id, "2026-11-02", "--json"])
            .status
            .success()
    );
    let skipped = cli(dbs, &["done", &id, "--date", "2026-11-02", "--json"]);
    assert_eq!(code(&skipped), 4);
}

#[tokio::test]
async fn done_with_a_date_takes_only_the_head_of_a_native_series_and_no_one_off() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let id = seed_weekly_meeting(dbs).await;
    let once = seed(dbs, vec![base_page("Once")]).await;

    let later = cli(dbs, &["done", &id, "--date", "2026-06-08", "--json"]);
    assert_eq!(code(&later), 4);
    let head = cli(dbs, &["done", &id, "--date", "2026-06-01", "--json"]);
    assert!(
        head.status.success(),
        "{}",
        String::from_utf8_lossy(&head.stderr)
    );
    let one_off = cli(dbs, &["done", &once[0], "--date", "2026-06-01", "--json"]);
    assert_eq!(code(&one_off), 2);
}

#[tokio::test]
async fn done_still_completes_a_synced_one_off() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Review")]).await;
    mark_synced(dbs, &ids[0], "active").await;
    let out = cli(dbs, &["done", &ids[0], "--json"]);
    assert_eq!(json(&out)["status"], "done");
}

// ─── one occurrence of a series ──────────────────────────────────────────────

/// A weekly hour-long meeting on Mondays from 2026-06-01, so every listed date is past.
async fn seed_weekly_meeting(db: &str) -> String {
    let ids = seed(db, vec![base_page("Review")]).await;
    let pool = open_pool(db).await.unwrap();
    pikos_db::create_recurrence_rule_impl(
        &pool,
        pikos_db::NewRecurrenceRule {
            page_id: ids[0].clone(),
            rrule: "FREQ=WEEKLY;BYDAY=MO".into(),
            rrule_exdates: Vec::new(),
            scheduled_start: "2026-06-01T09:00:00".into(),
            scheduled_end: Some("2026-06-01T10:00:00".into()),
            timezone: "America/New_York".into(),
        },
    )
    .await
    .unwrap();
    ids.into_iter().next().unwrap()
}

// qa: CLI-13:3
#[tokio::test]
async fn occurrence_skip_and_unskip_round_trip_on_a_date_the_rule_gives() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let id = seed_weekly_meeting(dbs).await;

    let skipped = cli(dbs, &["occurrence", "skip", &id, "2026-06-08", "--json"]);
    assert!(
        skipped.status.success(),
        "{}",
        String::from_utf8_lossy(&skipped.stderr)
    );
    assert_eq!(
        json(&skipped)["skippedOccurrences"],
        serde_json::json!(["2026-06-08"])
    );

    let tuesday = cli(dbs, &["occurrence", "skip", &id, "2026-06-09", "--json"]);
    assert_eq!(code(&tuesday), 2, "the rule never gives a Tuesday");
    let shapeless = cli(dbs, &["occurrence", "skip", &id, "next monday", "--json"]);
    assert_eq!(code(&shapeless), 2);

    let back = cli(dbs, &["occurrence", "unskip", &id, "2026-06-08", "--json"]);
    assert!(json(&back)["skippedOccurrences"]
        .as_array()
        .is_none_or(Vec::is_empty));
    let again = cli(dbs, &["occurrence", "unskip", &id, "2026-06-08", "--json"]);
    assert_eq!(code(&again), 2);
}

// qa: CLI-13:3
#[tokio::test]
async fn occurrence_move_gives_it_its_own_page_and_keeps_its_length() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let id = seed_weekly_meeting(dbs).await;

    let moved = cli(
        dbs,
        &[
            "occurrence",
            "move",
            &id,
            "2026-06-15",
            "--due",
            "2026-06-16T14:00:00",
            "--json",
        ],
    );
    assert!(
        moved.status.success(),
        "{}",
        String::from_utf8_lossy(&moved.stderr)
    );
    let out = json(&moved);
    assert_eq!(out["clone"]["scheduledStart"], "2026-06-16T14:00:00");
    assert_eq!(
        out["clone"]["scheduledEnd"], "2026-06-16T15:00:00",
        "still an hour"
    );
    assert_eq!(
        out["ruleExdates"],
        serde_json::json!(["2026-06-15"]),
        "only that date left"
    );

    let twice = cli(
        dbs,
        &[
            "occurrence",
            "move",
            &id,
            "2026-06-15",
            "--due",
            "2026-06-17T14:00:00",
            "--json",
        ],
    );
    assert_eq!(code(&twice), 2, "a moved date is no longer the series'");
    let bare = cli(
        dbs,
        &[
            "occurrence",
            "move",
            &id,
            "2026-06-22",
            "--due",
            "2026-06-23",
            "--json",
        ],
    );
    assert_eq!(code(&bare), 2, "a bare date can't silently drop the time");
}

#[tokio::test]
async fn occurrence_writes_refuse_a_page_that_does_not_repeat_and_a_synced_move() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Once")]).await;
    let one_off = cli(
        dbs,
        &["occurrence", "skip", &ids[0], "2026-06-08", "--json"],
    );
    assert_eq!(code(&one_off), 4);

    let series = seed_weekly_meeting(dbs).await;
    mark_synced(dbs, &series, "active").await;
    let synced = cli(
        dbs,
        &[
            "occurrence",
            "move",
            &series,
            "2026-06-15",
            "--due",
            "2026-06-16T14:00:00",
            "--json",
        ],
    );
    assert_eq!(code(&synced), 4);
    let skip = cli(
        dbs,
        &["occurrence", "skip", &series, "2026-06-15", "--json"],
    );
    assert!(
        skip.status.success(),
        "a synced skip stays local, as in the app"
    );
}

// qa: CLI-13:3
#[tokio::test]
async fn status_not_started_on_a_ticked_off_occurrence_gives_the_date_back_to_the_series() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let id = seed_weekly_meeting(dbs).await;

    assert!(cli(dbs, &["done", &id, "--json"]).status.success());
    let series = json(&cli(dbs, &["read", &id, "--json"]));
    let clone = series["completedOccurrences"]["2026-06-01"]
        .as_str()
        .expect("the first Monday was ticked off")
        .to_string();
    assert_eq!(series["scheduledStart"], "2026-06-08T09:00:00");

    let reopened = cli(dbs, &["status", &clone, "not_started", "--json"]);
    assert!(
        reopened.status.success(),
        "{}",
        String::from_utf8_lossy(&reopened.stderr)
    );
    let series = json(&reopened);
    assert_eq!(series["id"], id.as_str());
    assert_eq!(
        series["scheduledStart"], "2026-06-01T09:00:00",
        "the series has it back"
    );
    assert_eq!(
        code(&cli(dbs, &["read", &clone, "--json"])),
        3,
        "the done copy is gone"
    );

    let skip = cli(dbs, &["occurrence", "skip", &id, "2026-06-01", "--json"]);
    assert!(skip.status.success(), "a reopened date can be skipped");
}

// ─── list: the rest of the PageFilter ────────────────────────────────────────

#[tokio::test]
async fn list_filters_by_folder_name_id_and_inbox() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let projects = {
        seed(dbs, vec![]).await;
        make_folder(dbs, "Projects").await
    };
    let mut filed = base_page("Filed");
    filed.folder_id = Some(projects.clone());
    seed(dbs, vec![filed, base_page("Unfiled")]).await;

    // A prefix of the name resolves the same way `add ~proj` does.
    let by_name = json(&cli(dbs, &["list", "--folder", "proj", "--json"]));
    assert_eq!(by_name.as_array().unwrap().len(), 1);
    assert_eq!(by_name[0]["title"], "Filed");

    let by_id = json(&cli(dbs, &["list", "--folder", &projects, "--json"]));
    assert_eq!(by_id[0]["title"], "Filed");

    // "inbox" names the unfiled view when no folder answers to it.
    let inbox = json(&cli(dbs, &["list", "--folder", "inbox", "--json"]));
    assert_eq!(inbox.as_array().unwrap().len(), 1);
    assert_eq!(inbox[0]["title"], "Unfiled");
}

async fn make_calendar_folder(db: &str, name: &str) -> String {
    let id = make_folder(db, name).await;
    let pool = open_pool(db).await.unwrap();
    sqlx::query("UPDATE folders SET is_external_calendar = 1 WHERE id = ?")
        .bind(&id)
        .execute(&pool)
        .await
        .unwrap();
    id
}

// qa: CLI-10:6
#[tokio::test]
async fn update_folder_moves_a_page_between_folders_and_the_inbox() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Plan")]).await;
    let projects = make_folder(dbs, "Projects").await;
    let archive = make_folder(dbs, "Archive").await;

    let by_name = cli(dbs, &["update", &ids[0], "--folder", "proj", "--json"]);
    assert!(by_name.status.success());
    assert_eq!(json(&by_name)["folderId"], projects.as_str());

    let by_id = cli(dbs, &["update", &ids[0], "--folder", &archive, "--json"]);
    assert_eq!(json(&by_id)["folderId"], archive.as_str());

    let unfiled = cli(dbs, &["update", &ids[0], "--folder", "inbox", "--json"]);
    assert!(json(&unfiled)["folderId"].is_null());
}

// qa: CLI-10:6
#[tokio::test]
async fn update_folder_refuses_a_calendar_folder_and_a_synced_page() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Plan"), base_page("Standup")]).await;
    let calendar = make_calendar_folder(dbs, "Work calendar").await;
    let projects = make_folder(dbs, "Projects").await;
    mark_synced(dbs, &ids[1], "active").await;

    let into_calendar = cli(dbs, &["update", &ids[0], "--folder", &calendar, "--json"]);
    assert_eq!(code(&into_calendar), 4);
    let by_name = cli(dbs, &["update", &ids[0], "--folder", "work", "--json"]);
    assert_eq!(
        code(&by_name),
        3,
        "a calendar folder is no candidate by name"
    );

    let synced_out = cli(dbs, &["update", &ids[1], "--folder", &projects, "--json"]);
    assert_eq!(code(&synced_out), 4);

    let pool = open_pool(dbs).await.unwrap();
    for id in &ids {
        let page = pikos_db::get_page(&pool, id).await.unwrap().unwrap();
        assert!(page.folder_id.is_none(), "{} stayed put", page.title);
    }
}

#[tokio::test]
async fn list_folder_that_matches_nothing_exits_3() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![base_page("Task")]).await;
    let out = cli(dbs, &["list", "--folder", "nowhere", "--json"]);
    assert_eq!(code(&out), 3);
}

#[tokio::test]
async fn list_filters_by_priority_query_and_schedule() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let mut urgent = base_page("Urgent thing");
    urgent.priority = 1;
    let mut noted = base_page("Notes");
    noted.content = pikos_db::build_tiptap_doc("mentions an avocado");
    let ids = seed(dbs, vec![urgent, noted, base_page("Plain")]).await;

    let by_priority = json(&cli(dbs, &["list", "--priority", "1", "--json"]));
    assert_eq!(by_priority.as_array().unwrap().len(), 1);
    assert_eq!(by_priority[0]["title"], "Urgent thing");

    // --query reaches the body, not just the title.
    let by_query = json(&cli(dbs, &["list", "--query", "avocado", "--json"]));
    assert_eq!(by_query.as_array().unwrap().len(), 1);
    assert_eq!(by_query[0]["title"], "Notes");

    assert!(json(&cli(dbs, &["list", "--has-schedule", "--json"]))
        .as_array()
        .unwrap()
        .is_empty());
    assert!(
        cli(dbs, &["update", &ids[2], "--due", "2026-09-01", "--json"])
            .status
            .success()
    );
    let scheduled = json(&cli(dbs, &["list", "--has-schedule", "--json"]));
    assert_eq!(scheduled.as_array().unwrap().len(), 1);
    assert_eq!(scheduled[0]["title"], "Plain");
}

#[tokio::test]
async fn list_rejects_a_priority_outside_the_scale_exit_2() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![]).await;
    assert_eq!(code(&cli(dbs, &["list", "--priority", "9", "--json"])), 2);
}

// ─── today ───────────────────────────────────────────────────────────────────

/// A local calendar day `offset` days from now. `today` reads the machine clock,
/// so a fixture for it cannot be a fixed date the way the rest of this file's are.
fn local_day(offset: i64) -> String {
    (chrono::Local::now().date_naive() + chrono::Duration::days(offset))
        .format("%Y-%m-%d")
        .to_string()
}

/// Schedule through the flag a user would type: seeding `NewPage.scheduled_start`
/// writes only the denorm, and the count cross-checked below reads `page_schedules`.
fn schedule(db: &str, id: &str, flag: &str, when: &str) {
    let out = cli(db, &["update", id, flag, when, "--json"]);
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn titles(out: &Output) -> Vec<String> {
    json(out)
        .as_array()
        .expect("today prints an array")
        .iter()
        .map(|p| p["title"].as_str().unwrap().to_string())
        .collect()
}

/// What the app's daily summary would say the same day holds.
async fn today_count(db: &str, day: &str) -> i64 {
    let pool = open_pool(db).await.unwrap();
    pikos_db::today_scheduled_count(&pool, day).await.unwrap()
}

#[tokio::test]
async fn today_lists_timed_all_day_and_synced_pages_scheduled_today() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let today = local_day(0);
    let ids = seed(
        dbs,
        vec![
            base_page("Timed today"),
            base_page("All day today"),
            base_page("Finished today"),
            base_page("Tomorrow"),
            base_page("Synced meeting"),
        ],
    )
    .await;
    schedule(dbs, &ids[0], "--due", &format!("{today}T09:00:00"));
    schedule(dbs, &ids[1], "--all-day", &today);
    schedule(dbs, &ids[2], "--due", &format!("{today}T10:00:00"));
    assert!(cli(dbs, &["done", &ids[2], "--json"]).status.success());
    schedule(dbs, &ids[3], "--due", &format!("{}T09:00:00", local_day(1)));
    // Scheduled before the mirror locks it — origin doesn't enter into what's due.
    schedule(dbs, &ids[4], "--due", &format!("{today}T11:00:00"));
    mark_synced(dbs, &ids[4], "active").await;

    assert_eq!(
        titles(&cli(dbs, &["today", "--json"])),
        ["Timed today", "All day today", "Synced meeting"]
    );
    assert_eq!(
        today_count(dbs, &today).await,
        3,
        "the app counts the same 3"
    );
}

/// A series reaches `today` through its derived head — the CLI expands nothing.
#[tokio::test]
async fn today_lists_a_recurring_series_whose_occurrence_falls_today() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let today = local_day(0);
    let ids = seed(
        dbs,
        vec![base_page("Weekly standup"), base_page("Weekly retro")],
    )
    .await;
    mark_recurring(dbs, &ids[0], &format!("{today}T09:00:00")).await;
    mark_recurring(dbs, &ids[1], &format!("{}T09:00:00", local_day(7))).await;

    assert_eq!(titles(&cli(dbs, &["today", "--json"])), ["Weekly standup"]);
    assert_eq!(today_count(dbs, &today).await, 1);
}

#[tokio::test]
async fn today_says_so_when_nothing_is_due() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Tomorrow")]).await;
    schedule(dbs, &ids[0], "--due", &format!("{}T09:00:00", local_day(1)));

    assert!(titles(&cli(dbs, &["today", "--json"])).is_empty());
    let human = cli(dbs, &["today"]);
    assert!(
        String::from_utf8_lossy(&human.stdout).contains("Nothing scheduled for today."),
        "stdout: {}",
        String::from_utf8_lossy(&human.stdout)
    );
}

// ─── folders ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn folders_list_reports_names_and_page_counts() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![]).await;
    let projects = make_folder(dbs, "Projects").await;
    make_folder(dbs, "Empty").await;
    let mut filed = base_page("Filed");
    filed.folder_id = Some(projects.clone());
    seed(dbs, vec![filed]).await;

    let listing = json(&cli(dbs, &["folders", "list", "--json"]));
    let rows = listing.as_array().unwrap();
    assert_eq!(rows.len(), 2);
    let counts: Vec<(&str, u64)> = rows
        .iter()
        .map(|f| {
            (
                f["name"].as_str().unwrap(),
                f["pageCount"].as_u64().unwrap(),
            )
        })
        .collect();
    assert!(counts.contains(&("Projects", 1)), "{counts:?}");
    assert!(counts.contains(&("Empty", 0)), "{counts:?}");
}

#[tokio::test]
async fn folders_create_makes_a_folder_list_can_filter_on() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![base_page("Loose")]).await;

    let made = cli(dbs, &["folders", "create", "Reading", "--json"]);
    assert!(
        made.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&made.stderr)
    );
    let id = json(&made)["id"].as_str().unwrap().to_string();

    // The folder the CLI just made is immediately addressable as a filter.
    assert!(json(&cli(dbs, &["list", "--folder", "Reading", "--json"]))
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(json(&cli(dbs, &["folders", "list", "--json"]))[0]["id"], id);
}

// qa: CLI-11:3
#[tokio::test]
async fn folders_rename_takes_a_whole_name_or_an_id() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![]).await;
    let id = make_folder(dbs, "Projects").await;

    let prefix = cli(dbs, &["folders", "rename", "proj", "Work", "--json"]);
    assert_eq!(code(&prefix), 3, "a prefix renames nothing");

    let by_name = cli(
        dbs,
        &[
            "folders", "rename", "projects", "Side", "projects", "--json",
        ],
    );
    assert_eq!(json(&by_name)["name"], "Side projects");
    let by_id = cli(dbs, &["folders", "rename", &id, "Work", "--json"]);
    assert_eq!(json(&by_id)["name"], "Work");
}

#[tokio::test]
async fn folders_rename_refuses_a_name_two_folders_share() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![]).await;
    make_folder(dbs, "Notes").await;
    make_folder(dbs, "notes").await;
    let out = cli(dbs, &["folders", "rename", "Notes", "Journal", "--json"]);
    assert_eq!(code(&out), 4);
}

// qa: CLI-11:3
#[tokio::test]
async fn folders_delete_trashes_its_pages_and_restore_brings_them_back() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![]).await;
    let reading = make_folder(dbs, "Reading").await;
    let mut book = base_page("Dune");
    book.folder_id = Some(reading.clone());
    seed(dbs, vec![book, base_page("Loose")]).await;

    let unconfirmed = cli(dbs, &["folders", "delete", "Reading", "--json"]);
    assert_eq!(code(&unconfirmed), 2);
    assert_eq!(
        json(&cli(dbs, &["list", "--json"]))
            .as_array()
            .unwrap()
            .len(),
        2
    );

    let trashed = cli(dbs, &["folders", "delete", "Reading", "--yes", "--json"]);
    assert_eq!(json(&trashed)["id"], reading.as_str());
    assert_eq!(titles(&cli(dbs, &["list", "--json"])), ["Loose"]);
    assert!(json(&cli(dbs, &["folders", "list", "--json"]))
        .as_array()
        .unwrap()
        .is_empty());

    let restored = cli(dbs, &["folders", "restore", &reading, "--json"]);
    assert_eq!(json(&restored)["name"], "Reading");
    let back = json(&cli(dbs, &["list", "--folder", "Reading", "--json"]));
    assert_eq!(back[0]["title"], "Dune");
}

// qa: CLI-11:3
#[tokio::test]
async fn folders_rename_and_delete_refuse_a_calendar_folder() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![]).await;
    make_calendar_folder(dbs, "Work calendar").await;

    let renamed = cli(
        dbs,
        &["folders", "rename", "Work calendar", "Work", "--json"],
    );
    assert_eq!(code(&renamed), 4);
    let deleted = cli(
        dbs,
        &["folders", "delete", "Work calendar", "--yes", "--json"],
    );
    assert_eq!(code(&deleted), 4);
    assert_eq!(
        json(&cli(dbs, &["folders", "list", "--json"]))[0]["name"],
        "Work calendar"
    );
}

#[tokio::test]
async fn folders_restore_of_an_unknown_id_exits_3() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![]).await;
    let out = cli(dbs, &["folders", "restore", "nope", "--json"]);
    assert_eq!(code(&out), 3);
}

// ─── reminders ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn reminders_add_list_and_rm_round_trip() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Standup")]).await;

    let added = cli(
        dbs,
        &["reminders", "add", &ids[0], "--minutes", "15", "--json"],
    );
    assert!(
        added.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&added.stderr)
    );
    let reminder_id = json(&added)["id"].as_str().unwrap().to_string();

    let listed = json(&cli(dbs, &["reminders", "list", &ids[0], "--json"]));
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["minutesBefore"], 15);

    assert!(cli(dbs, &["reminders", "rm", &reminder_id, "--json"])
        .status
        .success());
    assert!(json(&cli(dbs, &["reminders", "list", &ids[0], "--json"]))
        .as_array()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn reminders_on_a_missing_page_exit_3() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![]).await;
    let missing = "00000000-0000-0000-0000-000000000000";
    assert_eq!(code(&cli(dbs, &["reminders", "list", missing])), 3);
    assert_eq!(
        code(&cli(dbs, &["reminders", "add", missing, "--minutes", "5"])),
        3
    );
}

#[tokio::test]
async fn reminders_reject_minutes_below_the_opt_out_sentinel_exit_2() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Standup")]).await;
    let out = cli(
        dbs,
        &["reminders", "add", &ids[0], "--minutes", "-5", "--json"],
    );
    assert_eq!(code(&out), 2);
}

// ─── restore ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn restore_brings_a_trashed_page_back_into_the_listing() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Task")]).await;

    assert!(cli(dbs, &["delete", &ids[0], "--yes", "--json"])
        .status
        .success());
    assert!(json(&cli(dbs, &["list", "--json"]))
        .as_array()
        .unwrap()
        .is_empty());

    let out = cli(dbs, &["restore", &ids[0], "--json"]);
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(json(&out)["title"], "Task");
    assert_eq!(
        json(&cli(dbs, &["list", "--json"]))
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

// qa: CLI-12:2
#[tokio::test]
async fn trash_lists_what_restore_can_bring_back() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Task"), base_page("Keep")]).await;

    let empty = cli(dbs, &["trash"]);
    assert!(String::from_utf8_lossy(&empty.stdout).contains("The trash is empty."));

    assert!(cli(dbs, &["delete", &ids[0], "--yes", "--json"])
        .status
        .success());
    let trashed = json(&cli(dbs, &["trash", "--json"]));
    assert_eq!(trashed.as_array().unwrap().len(), 1);
    assert_eq!(trashed[0]["title"], "Task");

    let id = trashed[0]["id"].as_str().unwrap();
    assert!(cli(dbs, &["restore", id, "--json"]).status.success());
    assert!(json(&cli(dbs, &["trash", "--json"]))
        .as_array()
        .unwrap()
        .is_empty());
}

// qa: CLI-12:2
#[tokio::test]
async fn tags_lists_open_pages_tags_most_used_first() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let tagged = |title: &str, tags: &[&str]| NewPage {
        tags: tags.iter().map(|t| t.to_string()).collect(),
        ..base_page(title)
    };
    let done = NewPage {
        status: "done".into(),
        ..tagged("Old", &["archive"])
    };
    seed(
        dbs,
        vec![tagged("A", &["work", "home"]), tagged("B", &["work"]), done],
    )
    .await;

    let tags = json(&cli(dbs, &["tags", "--json"]));
    assert_eq!(tags[0]["name"], "work");
    assert_eq!(tags[0]["pageCount"], 2);
    assert_eq!(tags[1]["name"], "home");
    assert_eq!(
        tags.as_array().unwrap().len(),
        2,
        "a done page's tag isn't listed"
    );
}

/// Trashing a synced page tombstones its mirror; restoring must hand it back to
/// the reconciler, or the page returns locally and stays suppressed upstream.
#[tokio::test]
async fn restore_resumes_syncing_a_tombstoned_page() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Standup")]).await;
    mark_synced(dbs, &ids[0], "active").await;
    assert!(cli(dbs, &["delete", &ids[0], "--yes", "--json"])
        .status
        .success());
    assert_eq!(
        sync_state(dbs, &ids[0]).await.as_deref(),
        Some("tombstoned")
    );

    assert!(cli(dbs, &["restore", &ids[0], "--json"]).status.success());
    assert_eq!(sync_state(dbs, &ids[0]).await.as_deref(), Some("active"));
}

#[tokio::test]
async fn restore_of_a_missing_page_exits_3() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![]).await;
    let out = cli(dbs, &["restore", "00000000-0000-0000-0000-000000000000"]);
    assert_eq!(code(&out), 3);
}

// ─── add --dry-run ───────────────────────────────────────────────────────────

#[tokio::test]
async fn add_dry_run_prints_the_parse_and_writes_nothing() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![]).await;
    let Some(out) = cli_bridge(
        dbs,
        &[
            "add",
            "Buy milk tomorrow #errands !high",
            "--dry-run",
            "--json",
        ],
    ) else {
        eprintln!("skipped: @pikos/bridge not built");
        return;
    };
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    // The preview is the parser's own shape, which `add` would then persist.
    let v = json(&out);
    assert_eq!(v["type"], "single");
    assert_eq!(v["input"]["title"], "Buy milk");
    assert_eq!(v["input"]["priority"], "high");
    assert_eq!(v["input"]["tags"][0], "errands");

    assert!(
        json(&cli(dbs, &["list", "--json"]))
            .as_array()
            .unwrap()
            .is_empty(),
        "a dry run must not write"
    );
}

// ─── add: reminders and the "//" body ────────────────────────────────────────

#[tokio::test]
async fn add_writes_the_parsed_reminder_lead() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![]).await;
    let Some(add) = cli_bridge(
        dbs,
        &["add", "Dentist tomorrow at 3pm remind 30m before", "--json"],
    ) else {
        eprintln!("skipped: @pikos/bridge not built");
        return;
    };
    assert!(
        add.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&add.stderr)
    );
    let v = json(&add);
    assert_eq!(v["created"][0]["title"], "Dentist");
    let id = v["created"][0]["id"].as_str().unwrap().to_string();

    let reminders = json(&cli(dbs, &["reminders", "list", &id, "--json"]));
    let rows = reminders.as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["minutesBefore"], 30);
}

/// An all-day page takes the day-before anchor (-2), which `reminders add`
/// itself refuses — the parser resolved it, so the row is written directly.
#[tokio::test]
async fn add_writes_the_day_before_anchor_for_an_all_day_page() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![]).await;
    let Some(add) = cli_bridge(
        dbs,
        &["add", "Dentist tomorrow remind day before", "--json"],
    ) else {
        eprintln!("skipped: @pikos/bridge not built");
        return;
    };
    assert!(add.status.success());
    let id = json(&add)["created"][0]["id"].as_str().unwrap().to_string();

    let reminders = json(&cli(dbs, &["reminders", "list", &id, "--json"]));
    assert_eq!(reminders[0]["minutesBefore"], -2);
}

#[tokio::test]
async fn add_writes_the_text_after_the_separator_as_the_body() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![]).await;
    let Some(add) = cli_bridge(
        dbs,
        &[
            "add",
            "Buy a gift // she likes the #blue one\nask her sister",
            "--json",
        ],
    ) else {
        eprintln!("skipped: @pikos/bridge not built");
        return;
    };
    assert!(
        add.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&add.stderr)
    );
    let v = json(&add);
    assert_eq!(v["created"][0]["title"], "Buy a gift");
    // The body is markdown, never Quick Add — the "#blue" in it never became a tag.
    assert!(v["created"][0]["tags"].as_array().unwrap().is_empty());
    let id = v["created"][0]["id"].as_str().unwrap().to_string();

    let text: String = scalar(
        dbs,
        &format!("SELECT content_text FROM pages WHERE id = '{id}'"),
    )
    .await;
    assert_eq!(text, "she likes the #blue one\nask her sister");

    let page = json(&cli(dbs, &["read", &id, "--json"]));
    let doc: Value = serde_json::from_str(page["content"].as_str().unwrap()).unwrap();
    let line = &doc["content"][0]["content"];
    assert_eq!(line[0]["text"], "she likes the #blue one");
    assert_eq!(line[1]["type"], "hardBreak");
    assert_eq!(line[2]["text"], "ask her sister");
}

#[tokio::test]
async fn add_dry_run_previews_the_reminder_and_the_body() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![]).await;
    let Some(out) = cli_bridge(
        dbs,
        &[
            "add",
            "Dentist tomorrow at 3pm remind 1h before // bring the card",
            "--dry-run",
            "--json",
        ],
    ) else {
        eprintln!("skipped: @pikos/bridge not built");
        return;
    };
    assert!(out.status.success());
    let v = json(&out);
    assert_eq!(v["input"]["title"], "Dentist");
    assert_eq!(v["input"]["reminderMinutes"][0], 60);
    assert_eq!(v["input"]["content"], "bring the card");

    assert!(
        json(&cli(dbs, &["list", "--json"]))
            .as_array()
            .unwrap()
            .is_empty(),
        "a dry run must not write"
    );
}

// ─── markdown bodies ─────────────────────────────────────────────────────────

/// The app's own document for a page with a heading, marks, a link, a nested list,
/// tasks and a quote, from the corpus the desktop suite generates.
fn agent_edit_page() -> NewPage {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../pikos-core/tests/corpus/markdown-import.json"
    ))
    .unwrap();
    let doc = corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "a page an agent edits")
        .expect("the corpus has the agent's page")["doc"]
        .to_string();
    NewPage {
        content: doc,
        ..base_page("Trip")
    }
}

// qa: CLI-14:2
#[tokio::test]
async fn reading_a_page_and_writing_it_back_keeps_its_structure() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let page = agent_edit_page();
    let before: Value = serde_json::from_str(&page.content).unwrap();
    let ids = seed(dbs, vec![page]).await;

    let read = json(&cli(dbs, &["read", &ids[0], "--json"]));
    let markdown = read["markdown"].as_str().unwrap().to_string();
    assert!(markdown.starts_with("# Trip\n"), "{markdown}");
    assert!(markdown.contains("* [x] passport"), "{markdown}");

    let out = cli(dbs, &["update", &ids[0], "--content", &markdown, "--json"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let after: Value = serde_json::from_str(json(&out)["content"].as_str().unwrap()).unwrap();
    assert_eq!(after, before);

    let human = String::from_utf8_lossy(&cli(dbs, &["read", &ids[0]]).stdout).to_string();
    assert!(human.contains("- Day one\n  - Museum"), "{human}");
}

#[tokio::test]
async fn writing_a_page_its_own_body_back_leaves_it_unedited() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let page = agent_edit_page();
    let before = page.content.clone();
    let ids = seed(dbs, vec![page]).await;
    mark_synced(dbs, &ids[0], "active").await;
    let pool = open_pool(dbs).await.unwrap();
    sqlx::query("UPDATE pages SET content_schema_version = 1 WHERE id = ?")
        .bind(&ids[0])
        .execute(&pool)
        .await
        .unwrap();

    let read = json(&cli(dbs, &["read", &ids[0], "--json"]));
    let markdown = read["markdown"].as_str().unwrap().to_string();
    let out = cli(dbs, &["update", &ids[0], "--content", &markdown, "--json"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );

    let read = json(&cli(dbs, &["read", &ids[0], "--json"]));
    let content: Value = serde_json::from_str(read["content"].as_str().unwrap()).unwrap();
    let version: i64 = scalar(dbs, "SELECT content_schema_version FROM pages").await;
    let user_modified: i64 = scalar(dbs, "SELECT user_modified FROM page_sync").await;
    assert_eq!(content, serde_json::from_str::<Value>(&before).unwrap());
    assert_eq!(version, 1);
    assert_eq!(user_modified, 0);
}

// qa: CLI-14:2
#[tokio::test]
async fn update_content_refuses_markdown_the_editor_cannot_hold_and_writes_nothing() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let page = agent_edit_page();
    let before = page.content.clone();
    let ids = seed(dbs, vec![page]).await;

    let out = cli(
        dbs,
        &[
            "update",
            &ids[0],
            "--content",
            "a <b>bold</b> word",
            "--title",
            "X",
            "--json",
        ],
    );
    assert_eq!(code(&out), 2);
    let read = json(&cli(dbs, &["read", &ids[0], "--json"]));
    let read_doc: Value = serde_json::from_str(read["content"].as_str().unwrap()).unwrap();
    let before_doc: Value = serde_json::from_str(&before).unwrap();
    assert_eq!(read_doc, before_doc);
    assert_eq!(read["title"], "Trip");
}

// qa: CLOUD-116
#[tokio::test]
async fn sync_diff_passes_for_one_copy_and_exits_10_listing_what_two_workspaces_disagree_on() {
    let first = unique_db();
    let second = unique_db();
    let (first, second) = (first.to_str().unwrap(), second.to_str().unwrap());
    seed(first, vec![base_page("Groceries")]).await;
    seed(second, vec![base_page("Laundry")]).await;

    let same = Command::new(BIN)
        .args(["sync", "diff", first, first])
        .output()
        .unwrap();
    let apart = Command::new(BIN)
        .args(["--json", "sync", "diff", first, second])
        .output()
        .unwrap();

    assert_eq!(code(&same), 0, "{}", String::from_utf8_lossy(&same.stdout));
    assert_eq!(code(&apart), 10);
    let report = json(&apart);
    let zones: Vec<&str> = report["copies"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["zone"].as_str().unwrap())
        .collect();
    assert_ne!(zones[0], zones[1]);
    let only_one_side = report["differences"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|d| d["kind"] == "only_in")
        .count();
    assert!(only_one_side >= 2, "{report}");
}
