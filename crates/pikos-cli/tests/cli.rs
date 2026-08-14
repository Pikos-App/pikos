//! End-to-end tests: drive the built `pikos` binary against a temp workspace.
//!
//! The DB-only commands run unconditionally (the binary links pikos-db, no GTK,
//! no Node). The `add` / recurring-`done` paths need the @pikos/bridge bundle +
//! Node; they run when packages/pikos-bridge/dist/bridge.mjs exists (built via
//! `pnpm --filter @pikos/bridge build`) and are skipped with a note otherwise.

use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

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
        folder_id: None,
        title: title.into(),
        subtitle: None,
        content: String::new(),
        content_text: Some(String::new()),
        status: "not_started".into(),
        priority: 0,
        tags: Vec::new(),
        scheduled_start: None,
        scheduled_end: None,
        completed_at: None,
        links: Vec::new(),
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
         VALUES (?, ?, 'acct', 'caldav', 'cal', ?, ?, ?, '2026-01-01T00:00:00Z')",
    )
    .bind(format!("ps-{page_id}"))
    .bind(page_id)
    .bind(format!("href-{page_id}"))
    .bind(format!("uid-{page_id}"))
    .bind(sync_state)
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
async fn search_finds_body_text() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let mut p = base_page("Groceries");
    p.content_text = Some("remember the avocado".into());
    seed(dbs, vec![p]).await;
    let out = cli(dbs, &["search", "avocado", "--json"]);
    assert!(out.status.success());
    assert_eq!(json(&out)["results"][0]["title"], "Groceries");
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

#[tokio::test]
async fn update_due_refuses_on_a_synced_page() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Standup")]).await;
    mark_synced(dbs, &ids[0], "active").await;

    let out = cli(dbs, &["update", &ids[0], "--due", "2026-09-01", "--json"]);
    assert_eq!(code(&out), 4);
    assert_eq!(scheduled_start(dbs, &ids[0]).await, None);
}

#[tokio::test]
async fn update_due_refuses_on_a_recurring_page() {
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

    let out = cli(dbs, &["update", &id, "--due", "2026-09-01", "--json"]);
    assert_eq!(code(&out), 4);
    assert_eq!(scheduled_start(dbs, &id).await, head, "head unmoved");
    assert_eq!(
        scalar::<String>(
            dbs,
            &format!("SELECT scheduled_start FROM page_recurrence_rules WHERE page_id = '{id}'")
        )
        .await,
        rule_base,
        "rule base unmoved"
    );
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

/// The CLI has no expansion engine, so it can't name which occurrence a tick means
/// — for a live mirror it refuses and says where to do it. The refusal is on the
/// *pair* (synced **and** recurring): a synced one-off has exactly one occurrence,
/// so completing it needs no engine and must still work. Guard the placement from
/// both sides, since widening it to all synced pages would quietly make `pikos done`
/// useless against a calendar, and narrowing it would complete the wrong week.
#[tokio::test]
async fn done_refuses_a_synced_series_but_not_a_synced_one_off() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Standup"), base_page("Review")]).await;
    // The rule goes on before the mirror locks — the order the reconciler writes in.
    mark_recurring(dbs, &ids[0], "2026-06-01T09:00:00").await;
    mark_synced(dbs, &ids[0], "active").await;
    mark_synced(dbs, &ids[1], "active").await;

    let refused = cli(dbs, &["done", &ids[0], "--json"]);
    assert_eq!(code(&refused), 4);
    // Errors are JSON-on-stderr; stdout is reserved for successful payloads.
    let body: Value = serde_json::from_slice(&refused.stderr).expect("stderr JSON");
    let msg = body["error"]["message"]
        .as_str()
        .unwrap_or("")
        .to_lowercase();
    assert!(
        msg.contains("pikos app"),
        "message points at the app: {msg}"
    );

    let allowed = cli(dbs, &["done", &ids[1], "--json"]);
    assert!(
        allowed.status.success(),
        "a synced one-off completes: {}",
        String::from_utf8_lossy(&allowed.stderr)
    );
    assert_eq!(json(&allowed)["status"], "done");
}
