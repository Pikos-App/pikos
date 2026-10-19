//! End-to-end test of `pikos mcp`: spawn the real binary, speak newline-delimited
//! JSON-RPC at it over stdio, and check the round trip.
//!
//! Deliberately not a unit test of the handler — the point is that a client that
//! knows nothing about this crate can initialize, discover the tools, and drive a
//! temp workspace through them.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
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

// qa: CLI-04:2
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

// qa: CLOUD-94
#[tokio::test]
async fn a_page_created_edited_and_completed_through_the_tools_reaches_the_other_device() {
    let (mac, phone) = (unique_db(), unique_db());
    let (mac, phone) = (mac.to_str().unwrap(), phone.to_str().unwrap());
    for db in [mac, phone] {
        pikos_db::replica::start(&open_pool(db).await.unwrap())
            .await
            .unwrap();
    }

    let mut server = Server::start(mac);
    handshake(&mut server);
    let created = server.call(2, "create_page", json!({ "text": "Water the plants" }));
    let id = created["created"][0]["id"].as_str().unwrap().to_string();
    server.call(
        3,
        "update_page",
        json!({ "id": id, "title": "Water the ferns", "priority": 2 }),
    );
    server.call(4, "complete_page", json!({ "id": id }));
    server.shutdown();

    let (mac, phone) = (
        open_pool(mac).await.unwrap(),
        open_pool(phone).await.unwrap(),
    );
    let names = pikos_db::replica::build::pending(&mac, 1000).await.unwrap();
    let built = pikos_db::replica::build::build(&mac, &names).await.unwrap();
    let records: Vec<_> = built
        .iter()
        .map(|b| (b.name.clone(), b.fields.clone()))
        .collect();
    pikos_db::replica::apply::apply(&phone, &records)
        .await
        .unwrap();

    let arrived = pikos_db::get_page(&phone, &id).await.unwrap().unwrap();
    assert_eq!(
        (
            arrived.title.as_str(),
            arrived.priority,
            arrived.status.as_str()
        ),
        ("Water the ferns", 2, "done")
    );
}

/// A failing tool must not end the session: the agent reads the error and keeps
/// going, so the same connection has to answer the next call.
// qa: CLI-04:2
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

/// Listening TCP sockets held by one pid, lsof's own tabular output. `None` when
/// lsof isn't installed; lsof exits 1 on no match, so the status is not an error.
///
/// `-a` is load-bearing: lsof ORs its selection flags by default, so without it
/// the answer is every file the process has open and nothing is ever empty.
fn listening_tcp(pid: u32) -> Option<String> {
    let out = match Command::new("lsof")
        .args([
            "-a",
            "-p",
            &pid.to_string(),
            "-iTCP",
            "-sTCP:LISTEN",
            "-n",
            "-P",
        ])
        .output()
    {
        Ok(out) => out,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => panic!("lsof is installed but would not run: {e}"),
    };
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Pikos reaches the network only for a calendar the user connected; `mcp` is a
/// stdio server and must hold no socket at all, which is otherwise a manual QA row.
// qa: CLI-05
#[tokio::test]
async fn the_server_opens_no_listening_socket() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![base_page("Alive")]).await;

    let mut server = Server::start(dbs);
    handshake(&mut server);
    server.call(2, "list_pages", json!({})); // past the lazy workspace open

    // A listener of this process's own, so an lsof that is broken or blind to the
    // pid fails here rather than clearing the child on silence.
    let canary = TcpListener::bind("127.0.0.1:0").unwrap();
    match listening_tcp(std::process::id()) {
        Some(own) => {
            assert!(
                own.contains("LISTEN"),
                "lsof found no listener on this test process, which is holding one: {own:?}"
            );
            let child = listening_tcp(server.child.id()).expect("lsof ran a moment ago");
            assert!(
                child.trim().is_empty(),
                "pikos mcp is listening on a socket:\n{child}"
            );
        }
        // Not eprintln!: the harness captures the print macros, so a skip written
        // that way is invisible on a green run — which is how a check goes vacuous.
        None => {
            let _ = std::io::stderr().write_all(
                b"WARNING: pikos mcp listening-socket check SKIPPED, lsof not on PATH\n",
            );
        }
    }
    drop(canary);

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

fn titles(listed: &Value) -> Vec<String> {
    listed
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["title"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn a_search_no_page_matches_in_full_falls_back_to_any_word() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(
        dbs,
        vec![
            base_page("Annual checkup"),
            base_page("Dentist appointment"),
        ],
    )
    .await;

    let mut server = Server::start(dbs);
    handshake(&mut server);

    let found = server.call(
        2,
        "search_pages",
        json!({ "query": "checkup dentist visits" }),
    );
    assert_eq!(found["anyWord"], true);
    assert_eq!(found["results"].as_array().unwrap().len(), 2, "{found}");

    let exact = server.call(3, "search_pages", json!({ "query": "annual checkup" }));
    assert_eq!(exact["anyWord"], false);
    assert_eq!(exact["results"].as_array().unwrap().len(), 1, "{exact}");

    server.shutdown();
}

#[tokio::test]
async fn a_missing_page_says_where_ids_come_from() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![]).await;

    let mut server = Server::start(dbs);
    handshake(&mut server);

    let missing = server.call_expecting_error(
        2,
        "update_page",
        json!({ "id": "Trip ideas", "priority": 2 }),
    );
    let message = missing["error"]["message"].as_str().unwrap();
    assert!(message.contains("search_pages"), "{message}");
    assert!(message.contains("list_pages"), "{message}");

    server.shutdown();
}

#[tokio::test]
async fn a_date_range_that_ends_before_it_starts_is_refused() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![base_page("Overdue")]).await;

    let mut server = Server::start(dbs);
    handshake(&mut server);

    let refused =
        server.call_expecting_error(2, "list_pages", json!({ "due": "2026-10-11..2026-10-10" }));
    assert_eq!(refused["error"]["kind"], "Usage");

    server.shutdown();
}

#[tokio::test]
async fn list_pages_selects_by_creation_completion_repeat_and_reminder() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let pool = open_pool(dbs).await.unwrap();
    let page = |title: &str, created: &str, completed: Option<&str>| NewPage {
        status: if completed.is_some() {
            "done"
        } else {
            "not_started"
        }
        .into(),
        completed_at: completed.map(str::to_string),
        created_at: Some(created.into()),
        ..base_page(title)
    };
    let mut ids = Vec::new();
    for p in [
        page("Learn Spanish", "2024-01-01T12:00:00.000Z", None),
        page(
            "Pay electricity",
            "2026-01-02T12:00:00.000Z",
            Some("2026-02-03T09:00:00"),
        ),
        page("Water the plants", "2026-01-03T12:00:00.000Z", None),
        page("Dentist", "2026-01-04T12:00:00.000Z", None),
    ] {
        ids.push(create_page_impl(&pool, p).await.unwrap().id);
    }
    pikos_db::create_recurrence_rule_impl(
        &pool,
        pikos_db::NewRecurrenceRule {
            page_id: ids[2].clone(),
            rrule: "FREQ=WEEKLY;BYDAY=SU".into(),
            rrule_exdates: vec![],
            scheduled_start: "2026-01-04T09:00:00".into(),
            scheduled_end: None,
            timezone: "UTC".into(),
        },
    )
    .await
    .unwrap();
    pikos_db::create_page_reminder(&pool, &ids[3], 30)
        .await
        .unwrap();
    pool.close().await;

    let mut server = Server::start(dbs);
    handshake(&mut server);

    let oldest = server.call(
        2,
        "list_pages",
        json!({ "oldestFirst": true, "status": "not_started" }),
    );
    assert_eq!(titles(&oldest)[0], "Learn Spanish");

    let created = server.call(
        3,
        "list_pages",
        json!({ "created": "2026-01-02..2026-01-03" }),
    );
    assert_eq!(titles(&created), ["Pay electricity", "Water the plants"]);

    let completed = server.call(
        4,
        "list_pages",
        json!({ "completed": "2026-02-01..2026-02-28" }),
    );
    assert_eq!(titles(&completed), ["Pay electricity"]);

    let repeating = server.call(5, "list_pages", json!({ "repeating": true }));
    assert_eq!(titles(&repeating), ["Water the plants"]);
    assert_eq!(repeating[0]["repeats"], "FREQ=WEEKLY;BYDAY=SU");

    let reminded = server.call(6, "list_pages", json!({ "hasReminders": true }));
    assert_eq!(titles(&reminded), ["Dentist"]);
    assert_eq!(reminded[0]["reminders"], json!([30]));

    server.shutdown();
}

#[tokio::test]
async fn update_page_refiles_a_page_into_a_folder_and_back_to_the_inbox() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Plan")]).await;
    let pool = open_pool(dbs).await.unwrap();
    let projects = pikos_db::create_folder_impl(
        &pool,
        pikos_db::NewFolder {
            name: "Projects".into(),
            parent_id: None,
            color: None,
            icon: None,
        },
    )
    .await
    .unwrap()
    .id;
    pool.close().await;

    let mut server = Server::start(dbs);
    handshake(&mut server);

    let filed = server.call(
        2,
        "update_page",
        json!({ "id": ids[0], "folder": "Projects" }),
    );
    assert_eq!(filed["folderId"], projects.as_str());
    let unfiled = server.call(3, "update_page", json!({ "id": ids[0], "folder": "inbox" }));
    assert!(unfiled["folderId"].is_null());

    server.shutdown();
}

#[tokio::test]
async fn update_page_edits_tags_subtitle_and_clears_the_schedule() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let mut page = base_page("Plan");
    page.tags = vec!["work".into()];
    let ids = seed(dbs, vec![page]).await;

    let mut server = Server::start(dbs);
    handshake(&mut server);

    let edited = server.call(
        2,
        "update_page",
        json!({
            "id": ids[0],
            "addTags": ["errands"],
            "removeTags": ["work"],
            "subtitle": "For Monday",
            "due": "2026-09-01",
        }),
    );
    assert_eq!(edited["tags"], json!(["errands"]));
    assert_eq!(edited["subtitle"], "For Monday");
    assert_eq!(edited["scheduledStart"], "2026-09-01");

    let cleared = server.call(
        3,
        "update_page",
        json!({ "id": ids[0], "subtitle": "", "unschedule": true }),
    );
    assert_eq!(cleared["subtitle"], "");
    assert!(cleared["scheduledStart"].is_null());

    server.shutdown();
}

#[tokio::test]
async fn folder_tools_create_rename_trash_and_restore() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    seed(dbs, vec![base_page("Dune")]).await;

    let mut server = Server::start(dbs);
    handshake(&mut server);

    let made = server.call(2, "create_folder", json!({ "name": "Reading" }));
    let id = made["id"].as_str().unwrap().to_string();
    let page = server.call(3, "list_pages", json!({}))[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    server.call(4, "update_page", json!({ "id": page, "folder": id }));

    let renamed = server.call(
        5,
        "rename_folder",
        json!({ "folder": "Reading", "name": "Books" }),
    );
    assert_eq!(renamed["name"], "Books");

    let trashed = server.call(6, "delete_folder", json!({ "folder": "Books" }));
    assert_eq!(trashed["trashed"], true);
    assert!(server
        .call(7, "list_pages", json!({}))
        .as_array()
        .unwrap()
        .is_empty());

    server.call(8, "restore_folder", json!({ "id": id }));
    assert_eq!(
        server.call(9, "list_pages", json!({ "folder": "Books" }))[0]["title"],
        "Dune"
    );

    server.shutdown();
}

#[tokio::test]
async fn list_trash_and_list_tags_answer_what_an_agent_cannot_guess() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let mut page = base_page("Plan");
    page.tags = vec!["work".into()];
    let ids = seed(dbs, vec![page, base_page("Gone")]).await;

    let mut server = Server::start(dbs);
    handshake(&mut server);

    let tags = server.call(2, "list_tags", json!({}));
    assert_eq!(tags, json!([{ "name": "work", "pageCount": 1 }]));

    server.call(3, "delete_page", json!({ "id": ids[1] }));
    let trash = server.call(4, "list_trash", json!({}));
    assert_eq!(trash[0]["id"], ids[1].as_str());
    assert_eq!(trash[0]["title"], "Gone");

    server.shutdown();
}

#[tokio::test]
async fn occurrence_tools_skip_and_move_one_date_of_a_series() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Review")]).await;
    let pool = open_pool(dbs).await.unwrap();
    pikos_db::create_recurrence_rule_impl(
        &pool,
        pikos_db::NewRecurrenceRule {
            page_id: ids[0].clone(),
            rrule: "FREQ=WEEKLY;BYDAY=MO".into(),
            rrule_exdates: vec![],
            scheduled_start: "2026-06-01T09:00:00".into(),
            scheduled_end: Some("2026-06-01T10:00:00".into()),
            timezone: "UTC".into(),
        },
    )
    .await
    .unwrap();
    pool.close().await;

    let mut server = Server::start(dbs);
    handshake(&mut server);

    let skipped = server.call(
        2,
        "skip_occurrence",
        json!({ "id": ids[0], "date": "2026-06-08" }),
    );
    assert_eq!(skipped["skippedOccurrences"], json!(["2026-06-08"]));
    server.call(
        3,
        "unskip_occurrence",
        json!({ "id": ids[0], "date": "2026-06-08" }),
    );

    let moved = server.call(
        4,
        "move_occurrence",
        json!({ "id": ids[0], "date": "2026-06-15", "due": "2026-06-16T14:00:00" }),
    );
    assert_eq!(moved["clone"]["scheduledEnd"], "2026-06-16T15:00:00");

    let refused = server.call_expecting_error(
        5,
        "skip_occurrence",
        json!({ "id": ids[0], "date": "2026-06-09" }),
    );
    assert_eq!(refused["error"]["kind"], "Usage");

    server.shutdown();
}

#[tokio::test]
async fn read_page_hands_back_markdown_that_update_page_takes_unchanged() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let corpus: Value = serde_json::from_str(include_str!(
        "../../pikos-core/tests/corpus/markdown-import.json"
    ))
    .unwrap();
    let doc = corpus["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "a page an agent edits")
        .unwrap()["doc"]
        .clone();
    let ids = seed(
        dbs,
        vec![NewPage {
            content: doc.to_string(),
            ..base_page("Trip")
        }],
    )
    .await;

    let mut server = Server::start(dbs);
    handshake(&mut server);

    let read = server.call(2, "read_page", json!({ "id": ids[0] }));
    assert!(
        read.get("content").is_none(),
        "the editor JSON stays out of an agent's way"
    );
    let markdown = read["markdown"].as_str().unwrap().to_string();

    let updated = server.call(
        3,
        "update_page",
        json!({ "id": ids[0], "content": markdown }),
    );
    let after: Value = serde_json::from_str(updated["content"].as_str().unwrap()).unwrap();
    assert_eq!(after, doc);

    server.shutdown();
}

#[tokio::test]
async fn complete_page_ticks_off_a_named_occurrence_of_a_calendar_series() {
    let db = unique_db();
    let dbs = db.to_str().unwrap();
    let ids = seed(dbs, vec![base_page("Standup")]).await;
    let pool = open_pool(dbs).await.unwrap();
    pikos_db::create_recurrence_rule_impl(
        &pool,
        pikos_db::NewRecurrenceRule {
            page_id: ids[0].clone(),
            rrule: "FREQ=WEEKLY;BYDAY=MO".into(),
            rrule_exdates: vec![],
            scheduled_start: "2026-10-19T09:00:00".into(),
            scheduled_end: None,
            timezone: "Europe/London".into(),
        },
    )
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO sync_account (id, provider, display_name, auth_kind, created_at, updated_at)
         VALUES ('acct', 'caldav', 'Test', 'basic', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO page_sync
         (id, page_id, account_id, provider, calendar_id, external_id, ical_uid, sync_state, created_at)
         VALUES ('ps', ?, 'acct', 'caldav', 'cal', 'href', 'uid', 'active', '2026-01-01T00:00:00Z')",
    )
    .bind(&ids[0])
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;

    let mut server = Server::start(dbs);
    handshake(&mut server);

    let series = server.call(
        2,
        "complete_page",
        json!({ "id": ids[0], "date": "2026-10-26" }),
    );
    assert!(
        series["completedOccurrences"]["2026-10-26"].is_string(),
        "{series}"
    );

    server.shutdown();
}
