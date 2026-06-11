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
    Command::new(BIN).args(args).arg("--db").arg(db).output().unwrap()
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
async fn status_and_rm_roundtrip() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Task")]).await;
    let id = &ids[0];

    assert!(cli(dbs, &["status", id, "done", "--json"]).status.success());
    assert_eq!(json(&cli(dbs, &["read", id, "--json"]))["status"], "done");

    assert!(cli(dbs, &["rm", id, "--yes", "--json"]).status.success());
    assert_eq!(code(&cli(dbs, &["read", id])), 3); // gone
}

#[tokio::test]
async fn update_title_and_priority() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Draft")]).await;
    let out = cli(dbs, &["update", &ids[0], "--title", "Final", "--priority", "1", "--json"]);
    assert!(out.status.success());
    let v = json(&out);
    assert_eq!(v["title"], "Final");
    assert_eq!(v["priority"], 1);
}

#[tokio::test]
async fn rm_in_json_mode_without_yes_refuses_exit_2() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Keep")]).await;
    let out = cli(dbs, &["rm", &ids[0], "--json"]);
    assert_eq!(code(&out), 2); // refuses without --yes in --json mode
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
    assert!(msg.contains("Node.js"), "message should name Node.js: {msg}");
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
    assert!(out.status.success(), "stderr: {}", String::from_utf8_lossy(&out.stderr));
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
    assert!(done.status.success(), "stderr: {}", String::from_utf8_lossy(&done.stderr));
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
