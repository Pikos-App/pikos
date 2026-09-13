//! End-to-end test of `pikos mcp`: spawn the real binary, speak newline-delimited
//! JSON-RPC at it over stdio, and check the round trip.
//!
//! Deliberately not a unit test of the handler — the point is that a client that
//! knows nothing about this crate can initialize, discover the tools, and drive a
//! temp workspace through them.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use pikos_db::{create_page_impl, open_pool, NewPage};
use serde_json::{json, Value};

const BIN: &str = env!("CARGO_BIN_EXE_pikos");

static SEQ: AtomicU64 = AtomicU64::new(0);

fn unique_db() -> PathBuf {
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("pikos-mcp-it-{}-{}", std::process::id(), n));
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

/// Create + migrate the workspace file and seed it, returning the page ids.
async fn seed(db: &str, pages: Vec<NewPage>) -> Vec<String> {
    let pool = open_pool(db).await.unwrap();
    let mut ids = Vec::new();
    for p in pages {
        ids.push(create_page_impl(&pool, p).await.unwrap().id);
    }
    ids
}

fn bridge_js() -> Option<String> {
    let p = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/pikos-bridge/dist/bridge.mjs"
    ));
    p.exists().then(|| p.to_string_lossy().into_owned())
}

/// A live `pikos mcp` process, plus its pipes.
struct Server {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Server {
    fn start(db: &str) -> Self {
        let mut cmd = Command::new(BIN);
        cmd.arg("mcp").arg("--db").arg(db);
        if let Some(js) = bridge_js() {
            cmd.env("PIKOS_BRIDGE_JS", js);
        }
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Server {
            child,
            stdin,
            stdout,
        }
    }

    fn send(&mut self, message: &Value) {
        writeln!(self.stdin, "{message}").unwrap();
        self.stdin.flush().unwrap();
    }

    /// Send a request and read the one frame that answers it.
    fn request(&mut self, id: u64, method: &str, params: Value) -> Value {
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        let mut line = String::new();
        self.stdout.read_line(&mut line).expect("a response line");
        let frame: Value =
            serde_json::from_str(line.trim()).unwrap_or_else(|_| panic!("not JSON: {line}"));
        assert_eq!(frame["jsonrpc"], "2.0");
        assert_eq!(frame["id"], id, "answered the wrong request: {frame}");
        frame
    }

    /// Call a tool and parse the JSON payload back out of its text content.
    fn call(&mut self, id: u64, name: &str, arguments: Value) -> Value {
        let frame = self.request(
            id,
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        );
        let result = &frame["result"];
        assert_eq!(result["isError"], false, "{name} failed: {result}");
        payload(result)
    }

    fn call_expecting_error(&mut self, id: u64, name: &str, arguments: Value) -> Value {
        let frame = self.request(
            id,
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        );
        assert_eq!(frame["result"]["isError"], true, "{name} unexpectedly ok");
        payload(&frame["result"])
    }

    fn shutdown(mut self) {
        drop(self.stdin);
        let status = self.child.wait().unwrap();
        assert!(status.success(), "server exited with {status}");
    }
}

fn payload(result: &Value) -> Value {
    let text = result["content"][0]["text"]
        .as_str()
        .expect("a text content block");
    serde_json::from_str(text).unwrap_or_else(|_| panic!("tool text is not JSON: {text}"))
}

fn handshake(server: &mut Server) -> Value {
    let init = server.request(
        1,
        "initialize",
        json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "pikos-cli-test", "version": "0" },
        }),
    );
    // The notification carries no id, so nothing comes back for it.
    server.send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
    init
}

#[tokio::test]
async fn initialize_lists_tools_and_round_trips_a_page() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![]).await; // create + migrate an empty workspace

    let mut server = Server::start(dbs);

    let init = handshake(&mut server);
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    assert!(
        init["result"]["capabilities"]["tools"].is_object(),
        "must advertise tools: {init}"
    );
    assert_eq!(init["result"]["serverInfo"]["name"], "pikos");

    let listed = server.request(2, "tools/list", json!({}));
    let names: Vec<&str> = listed["result"]["tools"]
        .as_array()
        .expect("a tools array")
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    for expected in ["create_page", "read_page", "list_pages", "delete_page"] {
        assert!(names.contains(&expected), "missing {expected} in {names:?}");
    }

    // Create through the tool, then read the same page back through another.
    let Some(_) = bridge_js() else {
        eprintln!("skipped the write half: @pikos/bridge not built");
        server.shutdown();
        return;
    };
    let created = server.call(3, "create_page", json!({ "text": "Water the plants" }));
    let id = created["created"][0]["id"]
        .as_str()
        .expect("a created id")
        .to_string();
    assert_eq!(created["created"][0]["title"], "Water the plants");

    let read = server.call(4, "read_page", json!({ "id": id }));
    assert_eq!(read["id"], id.as_str());
    assert_eq!(read["title"], "Water the plants");

    let listed = server.call(5, "list_pages", json!({ "status": "not_started" }));
    assert_eq!(listed.as_array().unwrap().len(), 1);

    server.shutdown();
}

#[tokio::test]
async fn tools_drive_the_page_through_its_whole_life() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Standup")]).await;
    let id = ids.into_iter().next().unwrap();

    let mut server = Server::start(dbs);
    handshake(&mut server);

    let updated = server.call(
        2,
        "update_page",
        json!({ "id": id, "priority": 1, "due": "2026-09-01" }),
    );
    assert_eq!(updated["priority"], 1);
    assert_eq!(updated["scheduledStart"], "2026-09-01");

    let reminder = server.call(3, "add_reminder", json!({ "pageId": id, "minutes": 10 }));
    let reminder_id = reminder["id"].as_str().unwrap().to_string();
    let reminders = server.call(4, "list_reminders", json!({ "pageId": id }));
    assert_eq!(reminders[0]["minutesBefore"], 10);
    server.call(5, "remove_reminder", json!({ "reminderId": reminder_id }));
    assert!(server
        .call(6, "list_reminders", json!({ "pageId": id }))
        .as_array()
        .unwrap()
        .is_empty());

    assert_eq!(
        server.call(7, "set_status", json!({ "id": id, "status": "done" }))["status"],
        "done"
    );
    assert_eq!(
        server.call(
            8,
            "set_status",
            json!({ "id": id, "status": "not_started" })
        )["status"],
        "not_started"
    );
    assert_eq!(
        server.call(9, "complete_page", json!({ "id": id }))["status"],
        "done"
    );

    // Trash and untrash — the only removal the protocol offers.
    assert_eq!(
        server.call(10, "delete_page", json!({ "id": id }))["trashed"],
        true
    );
    assert!(server
        .call(11, "list_pages", json!({}))
        .as_array()
        .unwrap()
        .is_empty());
    server.call(12, "restore_page", json!({ "id": id }));
    assert_eq!(
        server
            .call(13, "list_pages", json!({}))
            .as_array()
            .unwrap()
            .len(),
        1
    );

    server.shutdown();
}

/// A failing tool must not end the session: the agent reads the error and keeps
/// going, so the same connection has to answer the next call.
#[tokio::test]
async fn a_tool_error_is_reported_in_the_result_and_the_session_survives() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![base_page("Alive")]).await;

    let mut server = Server::start(dbs);
    handshake(&mut server);

    let missing = server.call_expecting_error(
        2,
        "read_page",
        json!({ "id": "00000000-0000-0000-0000-000000000000" }),
    );
    assert_eq!(missing["error"]["kind"], "NotFound");

    let unknown = server.call_expecting_error(3, "explode", json!({}));
    assert_eq!(unknown["error"]["kind"], "Usage");

    // Still serving.
    assert_eq!(server.call(4, "list_pages", json!({}))[0]["title"], "Alive");

    server.shutdown();
}

/// The one-way schema upgrade stays a decision a person makes at a prompt.
#[tokio::test]
async fn the_server_refuses_to_migrate() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![]).await;

    let out = Command::new(BIN)
        .args(["mcp", "--migrate", "--db", dbs])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    let msg = String::from_utf8_lossy(&out.stderr);
    assert!(msg.contains("--migrate"), "{msg}");
}

/// A workspace behind this build is refused in a frame the client can read, rather
/// than by the process dying before `initialize` ever completes.
#[tokio::test]
async fn a_workspace_needing_migration_fails_the_tool_not_the_handshake() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![base_page("Keep")]).await;
    let pool = open_pool(dbs).await.unwrap();
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version > 1")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;

    let mut server = Server::start(dbs);
    let init = handshake(&mut server);
    assert_eq!(init["result"]["serverInfo"]["name"], "pikos");

    let refused = server.call_expecting_error(2, "list_pages", json!({}));
    assert_eq!(refused["error"]["kind"], "MigrationRequired");
    assert!(refused["error"]["message"]
        .as_str()
        .unwrap()
        .contains("--migrate"));

    server.shutdown();
}

/// `dryRun` is the agent-preview mode: the parse comes back for approval and the
/// workspace is untouched, so a model can show its work before committing it.
#[tokio::test]
async fn create_page_dry_run_returns_the_parse_and_writes_nothing() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![]).await;
    if bridge_js().is_none() {
        eprintln!("skipped: @pikos/bridge not built");
        return;
    }

    let mut server = Server::start(dbs);
    handshake(&mut server);

    let preview = server.call(
        2,
        "create_page",
        json!({ "text": "Buy milk tomorrow #errands !high", "dryRun": true }),
    );
    assert_eq!(preview["type"], "single");
    assert_eq!(preview["input"]["title"], "Buy milk");
    assert_eq!(preview["input"]["tags"][0], "errands");

    assert!(server
        .call(3, "list_pages", json!({}))
        .as_array()
        .unwrap()
        .is_empty());

    server.shutdown();
}
