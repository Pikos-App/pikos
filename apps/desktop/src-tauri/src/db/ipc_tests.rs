//! The IPC boundary — the one layer `workflows_tests.rs` deliberately tests below.
//!
//! Those tests enter at `*_impl`, which is right for data logic and blind to the
//! wire. The frontend does not call `*_impl`; it invokes a command name with a
//! **camelCase** body, and Tauri deserializes that into snake_case parameters. That
//! conversion is by convention and checked by nothing: rename a parameter and every
//! call site keeps compiling, the TypeScript keeps type-checking, and the command
//! fails at runtime with an argument error the user meets as a dead button.
//!
//! So this asserts one thing per command — the body the adapter really sends
//! deserializes into the signature. A command whose handler then fails on its own
//! terms (no such page, no such account) still passes: reaching the handler at all
//! is the proof the wire agreed. Only an argument error fails the test.
//!
//! Being able to invoke for real also settles a question the TypeScript cannot: the
//! adapter's read/write classification is a claim about what each handler *does*,
//! and the probe below holds it to a live database.
//!
//! Debug-only, because `RuntimeAuthority::new` takes the ACL manifest argument
//! solely under `debug_assertions`. `cargo test` builds debug; a release test build
//! skips the module rather than failing to compile.
#![cfg(debug_assertions)]

use std::collections::BTreeMap;

use serde_json::json;
use tauri::ipc::RuntimeAuthority;
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::utils::acl::{
    resolved::{Resolved, ResolvedCommand},
    ExecutionContext,
};
use tauri::webview::InvokeRequest;
use tauri::{Manager, WebviewWindowBuilder};

use pikos_db::test_pool;

/// The exact bodies `TauriSQLiteAdapter.ts` sends, for every command whose
/// parameters are multi-word — the only ones where the camelCase⇄snake_case
/// conversion has anything to disagree about. Single-word parameters (`id`,
/// `data`, `updates`, `filter`) are spelled identically on both sides.
fn wire_cases() -> Vec<(&'static str, serde_json::Value)> {
    vec![
        (
            "reorder_pages",
            json!({ "folderId": null, "orderedIds": [] }),
        ),
        (
            "set_pages_status",
            json!({ "completedAt": null, "ids": [], "status": "done" }),
        ),
        (
            "search_pages",
            json!({ "includeCompleted": false, "query": "x" }),
        ),
        ("reorder_folders", json!({ "orderedIds": [] })),
        ("list_page_schedules", json!({ "pageId": "p1" })),
        ("list_page_schedules_for_rules", json!({ "ruleIds": [] })),
        ("get_recurrence_rule", json!({ "pageId": "p1" })),
        ("list_page_reminders", json!({ "pageId": "p1" })),
        ("delete_page_reminders", json!({ "pageId": "p1" })),
        ("list_sync_calendars", json!({ "accountId": "a1" })),
        (
            "set_sync_calendar_color",
            json!({ "color": "#ffffff", "syncCalendarId": "c1" }),
        ),
        // Disabling, not enabling: the enable arm pokes the sync loop through managed
        // state this app never registers, and `state()` panics on an unmanaged type.
        // Either arm proves the arguments deserialized, which is all this asks.
        (
            "toggle_sync_calendar",
            json!({ "color": null, "enabled": false, "syncCalendarId": "c1" }),
        ),
        (
            "skip_occurrence",
            json!({ "data": { "pageId": "p1", "occurrenceDate": "2026-06-01" } }),
        ),
        (
            "undo_skip_occurrence",
            json!({ "data": { "pageId": "p1", "occurrenceDate": "2026-06-01" } }),
        ),
        (
            "uncomplete_recurring_occurrence",
            json!({ "data": { "pageId": "p1", "occurrenceDate": "2026-06-01" } }),
        ),
        (
            "complete_recurring_page",
            json!({ "data": { "pageId": "p1" } }),
        ),
        (
            "expand_recurrence_range",
            json!({ "rules": [], "rangeStart": "2026-06-01", "rangeEnd": "2026-06-30" }),
        ),
        ("export_csv", json!({ "includeSynced": false })),
        ("export_markdown", json!({ "includeSynced": false })),
    ]
}

/// Multi-word commands the wire test deliberately does not drive. Reaching the
/// handler is the whole assertion, so anything whose handler leaves the process
/// on the way to failing is worse than untested — these each go out to the
/// network, the login keychain, or the user's disk before they can refuse.
const NOT_DRIVEN: &[(&str, &str)] = &[
    ("connect_caldav_account", "performs CalDAV discovery"),
    ("reconnect_caldav_account", "performs CalDAV discovery"),
    ("refresh_sync_account", "polls the provider"),
    ("resync_sync_account", "polls the provider"),
    ("disconnect_sync_account", "opens the login keychain"),
    ("save_asset", "copies a file into the app data dir"),
];

/// Bodies for the read commands `wire_cases` does not already carry. Split that
/// way so a command reachable from both tests has one body, not two that drift.
///
/// These name the ids [`seed_probe_workspace`] plants, unlike the wire cases, whose
/// ids deliberately match nothing. The probe measures whether a handler wrote, so a
/// body that resolves to no row would let a misfiled writer pass by finding nothing
/// to write to.
fn extra_read_bodies() -> Vec<(&'static str, serde_json::Value)> {
    vec![
        ("get_page", json!({ "id": PROBE_PAGE })),
        ("list_pages", json!({ "filter": null })),
        ("list_pages_today", json!({})),
        (
            "list_completed_pages",
            json!({ "filter": { "limit": 10, "offset": 0 } }),
        ),
        ("search_tags", json!({ "query": "work" })),
        ("get_folder", json!({ "id": PROBE_FOLDER })),
        ("list_folders", json!({})),
        ("list_recurrence_rules", json!({})),
        ("get_sync_status", json!({})),
        ("google_sync_available", json!({})),
    ]
}

const PROBE_PAGE: &str = "probe-page";
const PROBE_FOLDER: &str = "probe-folder";

/// One row in each table a read command can reach, so the reads do real work and a
/// misfiled writer has something to destroy.
async fn seed_probe_workspace(pool: &sqlx::SqlitePool) {
    pikos_db::insert_test_folder(pool, PROBE_FOLDER, "Work")
        .await
        .unwrap();
    let mut page = pikos_db::TestPage::new(PROBE_PAGE, "Weekly review");
    page.folder_id = Some(PROBE_FOLDER);
    page.tags_json = r#"["work"]"#;
    page.scheduled_start = Some("2026-06-01T09:00:00");
    pikos_db::insert_test_page(pool, page).await.unwrap();
}

/// Read commands the probe below cannot drive, with the reason.
const NOT_PROBED: &[(&str, &str)] = &[(
    "connect_db",
    "opens a pool and migrates it — writing is the whole point, and it would \
     swap the pool the probe measures",
)];

fn probe_body(cmd: &str) -> Option<serde_json::Value> {
    wire_cases()
        .into_iter()
        .chain(extra_read_bodies())
        .find(|(name, _)| *name == cmd)
        .map(|(_, body)| body)
}

/// `mock_context` resolves an empty ACL, so every invoke is refused before it
/// reaches a handler. Tauri's own `__allow_command` grants windows but leaves
/// webviews empty, and the authority requires a match on both — hence the entries
/// are built here rather than through it.
fn permissive_authority() -> RuntimeAuthority {
    let allowed_commands: BTreeMap<_, _> = wire_cases()
        .into_iter()
        .chain(extra_read_bodies())
        .map(|(cmd, _)| {
            (
                cmd.to_string(),
                vec![ResolvedCommand {
                    context: ExecutionContext::Local,
                    windows: vec!["*".parse().unwrap()],
                    webviews: vec!["*".parse().unwrap()],
                    ..Default::default()
                }],
            )
        })
        .collect();
    RuntimeAuthority::new(
        Default::default(),
        Resolved {
            allowed_commands,
            ..Default::default()
        },
    )
}

fn build_app(pool: sqlx::SqlitePool) -> tauri::App<tauri::test::MockRuntime> {
    let mut ctx = mock_context(noop_assets());
    *ctx.runtime_authority_mut() = permissive_authority();
    let app = mock_builder()
        .invoke_handler(tauri::generate_handler![
            super::pages::reorder_pages,
            super::pages::set_pages_status,
            super::pages::complete_recurring_page,
            super::pages::skip_occurrence,
            super::pages::undo_skip_occurrence,
            super::pages::uncomplete_recurring_occurrence,
            super::search::search_pages,
            super::folders::reorder_folders,
            super::schedules::list_page_schedules,
            super::schedules::list_page_schedules_for_rules,
            super::schedules::get_recurrence_rule,
            super::notifications::list_page_reminders,
            super::notifications::delete_page_reminders,
            super::sync::list_sync_calendars,
            super::sync::set_sync_calendar_color,
            super::sync::toggle_sync_calendar,
            super::schedules::expand_recurrence_range,
            super::dev::export_csv,
            super::dev::export_markdown,
            super::pages::get_page,
            super::pages::list_pages,
            super::pages::list_pages_today,
            super::pages::list_completed_pages,
            super::tags::search_tags,
            super::folders::get_folder,
            super::folders::list_folders,
            super::schedules::list_recurrence_rules,
            super::sync::get_sync_status,
            super::sync::google_sync_available,
        ])
        .build(ctx)
        .unwrap();
    app.manage(super::DbState::with_pool(pool));
    app
}

fn invoke(
    webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    cmd: &str,
    body: serde_json::Value,
) -> Result<tauri::ipc::InvokeResponseBody, serde_json::Value> {
    get_ipc_response(
        webview,
        InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            // Any other origin resolves as `Remote`, which no entry above matches —
            // the refusal then reads as a command/window problem rather than a URL one.
            url: "tauri://localhost".parse().unwrap(),
            body: body.into(),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
}

#[test]
fn every_command_accepts_the_body_the_adapter_sends() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let pool = rt.block_on(test_pool());
    let app = build_app(pool);
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    for (cmd, body) in wire_cases() {
        if let Err(e) = invoke(&webview, cmd, body) {
            let msg = format!("{e:?}");
            assert!(
                !msg.contains("invalid args") && !msg.contains("not allowed"),
                "{cmd}: the adapter's body never reached the handler — {msg}"
            );
        }
    }
}

/// `TauriSQLiteAdapter` splits every command into `WRITE_COMMANDS` and
/// `READ_COMMANDS`, and issuing a write opens a window that tells the DB watcher to
/// ignore the change event it is about to see. Misfile a mutating command as a read
/// and the watcher takes the app's own echo for somebody else's write and refetches
/// the workspace on top of what the user just did — a flicker after a bulk complete
/// or a drag, with nothing failing and nothing logged. Six commands were missing
/// from the write set once already.
///
/// The adapter's own test pins that every command is classified; it cannot pin that
/// the classification is *true*, because that fact lives in the Rust handler. So
/// this drives each declared read against a real single-connection pool and asserts
/// SQLite counted no row changes. A writer sitting in `READ_COMMANDS` fails here.
///
/// The opposite misfiling — a read declared a write — costs only a needless
/// suppression window, so it is not worth the seed data it would take to detect.
#[test]
fn a_command_the_adapter_calls_a_read_changes_no_rows() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let pool = rt.block_on(test_pool());
    rt.block_on(seed_probe_workspace(&pool));
    let app = build_app(pool.clone());
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let excused: BTreeMap<_, _> = NOT_PROBED.iter().copied().collect();
    let mut unprobed = Vec::new();

    for cmd in declared_read_commands() {
        if excused.contains_key(cmd.as_str()) {
            continue;
        }
        let Some(body) = probe_body(&cmd) else {
            unprobed.push(cmd);
            continue;
        };

        let before = rt.block_on(total_changes(&pool));
        let _ = invoke(&webview, &cmd, body);
        let after = rt.block_on(total_changes(&pool));

        assert_eq!(
            before,
            after,
            "{cmd} is in READ_COMMANDS but changed {} row(s). Either it belongs in \
             WRITE_COMMANDS, or the watcher will refetch the workspace on top of the \
             user's own action every time it runs.",
            after - before
        );
    }

    assert!(
        unprobed.is_empty(),
        "these commands are declared reads and nothing proves they read: {}\n\
         Add a body to `extra_read_bodies`, or record it in NOT_PROBED with why it \
         cannot be driven.",
        unprobed.join(", ")
    );
}

/// Rows changed on this connection since it opened. Meaningful only because
/// `test_pool` caps the pool at one connection — `total_changes()` is per-connection,
/// so a multi-connection pool would report whichever one the probe happened to get.
async fn total_changes(pool: &sqlx::SqlitePool) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT total_changes()")
        .fetch_one(pool)
        .await
        .expect("total_changes()")
}

/// `READ_COMMANDS` as the adapter declares it. Read out of the TypeScript rather
/// than restated here, since a copy would agree with itself while the real list
/// moved on — the same reason the guard-message check reads the Rust source.
fn declared_read_commands() -> Vec<String> {
    let adapter = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../src/shared/adapters/TauriSQLiteAdapter.ts");
    let source = std::fs::read_to_string(&adapter)
        .unwrap_or_else(|e| panic!("read {}: {e}", adapter.display()));

    const ANCHOR: &str = "READ_COMMANDS = new Set([";
    let start = source.find(ANCHOR).expect("adapter declares READ_COMMANDS") + ANCHOR.len();
    let len = source[start..]
        .find("]);")
        .expect("unterminated READ_COMMANDS");

    let commands: Vec<String> = source[start..start + len]
        .split(',')
        .filter_map(|entry| {
            let open = entry.find('"')?;
            let rest = &entry[open + 1..];
            Some(rest[..rest.find('"')?].to_string())
        })
        .collect();
    assert!(
        commands.len() > 10,
        "only parsed {} read commands — the extraction has drifted from how the \
         adapter declares them",
        commands.len()
    );
    commands
}

/// `wire_cases` is written by hand, and a command added tomorrow with a multi-word
/// parameter is precisely what it exists to catch — but its own absence from the
/// list is not something any test notices. The table then narrows as the command
/// surface grows, while still reading as "every command".
///
/// So the set to check is read out of the source, not listed: the registrations in
/// `lib.rs` intersected with the `#[tauri::command]` signatures, minus the
/// parameters Tauri injects rather than deserializes.
#[test]
fn every_multi_word_command_has_a_wire_case() {
    let covered: BTreeMap<_, _> = wire_cases().into_iter().collect();
    let excused: BTreeMap<_, _> = NOT_DRIVEN.iter().copied().collect();

    let missing: Vec<String> = registered_commands()
        .into_iter()
        .filter(|(cmd, params)| {
            params.iter().any(|p| p.contains('_'))
                && !covered.contains_key(cmd.as_str())
                && !excused.contains_key(cmd.as_str())
        })
        .map(|(cmd, params)| format!("{cmd}({})", params.join(", ")))
        .collect();

    assert!(
        missing.is_empty(),
        "these commands take a multi-word parameter and no wire case covers them, so a \
         camelCase⇄snake_case rename in either would go unnoticed:\n  {}\n\
         Add a case to `wire_cases` (and the handler list in `build_app`), or record it \
         in NOT_DRIVEN with the reason its handler can't be reached in a test.",
        missing.join("\n  ")
    );
}

/// Every command `lib.rs` registers, mapped to the parameters Tauri deserializes
/// out of the invoke body.
fn registered_commands() -> BTreeMap<String, Vec<String>> {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let lib = std::fs::read_to_string(src.join("lib.rs")).expect("read lib.rs");
    let registered = registered_names(&lib);

    let mut sources = Vec::new();
    collect_sources(&src, &mut sources);

    let mut out = BTreeMap::new();
    for text in &sources {
        for (name, params) in command_signatures(text) {
            if registered.contains(&name) {
                out.insert(name, params);
            }
        }
    }
    assert!(
        out.len() >= registered.len(),
        "{} registered commands but only {} signatures found — the source scan has \
         drifted from how commands are written, not the commands themselves",
        registered.len(),
        out.len()
    );
    out
}

fn collect_sources(dir: &std::path::Path, out: &mut Vec<String>) {
    for entry in std::fs::read_dir(dir).expect("read src dir") {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            collect_sources(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs")
            && !path.to_string_lossy().contains("_tests")
        {
            out.push(std::fs::read_to_string(&path).expect("read source"));
        }
    }
}

/// The names inside `generate_handler![…]`, last path segment only.
fn registered_names(lib: &str) -> std::collections::BTreeSet<String> {
    let start = lib
        .find("generate_handler![")
        .expect("lib.rs registers commands")
        + "generate_handler![".len();
    let len = lib[start..].find(']').expect("unterminated handler list");
    lib[start..start + len]
        .lines()
        .map(|line| line.split("//").next().unwrap_or_default())
        .flat_map(|line| line.split(','))
        .map(|name| name.trim().rsplit("::").next().unwrap_or_default().trim())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect()
}

/// `(name, body-deserialized parameter names)` for each `#[tauri::command]`.
/// `State`, `AppHandle` and the window types are injected by Tauri and never
/// appear in the body, so they are dropped by type rather than by name.
fn command_signatures(text: &str) -> Vec<(String, Vec<String>)> {
    const MARKER: &str = "#[tauri::command]";
    const INJECTED: &[&str] = &["State<", "AppHandle", "Window", "Webview"];

    let mut out = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find(MARKER) {
        rest = &rest[at + MARKER.len()..];
        let Some(fk) = rest.find("fn ") else { break };
        let after = &rest[fk + "fn ".len()..];
        let Some(open) = after.find('(') else { break };
        let name = after[..open]
            .split('<')
            .next()
            .unwrap_or_default()
            .trim()
            .to_string();

        let mut depth = 0i32;
        let mut close = open;
        for (i, c) in after[open..].char_indices() {
            match c {
                '(' | '<' | '[' => depth += 1,
                ')' | '>' | ']' => depth -= 1,
                _ => {}
            }
            if depth == 0 {
                close = open + i;
                break;
            }
        }

        let params = split_top_level(&after[open + 1..close])
            .into_iter()
            .filter(|p| !INJECTED.iter().any(|marker| p.contains(marker)))
            .filter_map(|p| Some(p.split(':').next()?.trim().to_string()))
            .filter(|p| !p.is_empty())
            .collect();
        out.push((name, params));
        rest = &after[close..];
    }
    out
}

fn split_top_level(params: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut current = String::new();
    for c in params.chars() {
        match c {
            '(' | '<' | '[' => depth += 1,
            ')' | '>' | ']' => depth -= 1,
            ',' if depth == 0 => {
                parts.push(std::mem::take(&mut current));
                continue;
            }
            _ => {}
        }
        current.push(c);
    }
    parts.push(current);
    parts.into_iter().filter(|p| !p.trim().is_empty()).collect()
}

/// The other half of the boundary: a command reached with no pool must surface the
/// connect-first error rather than panicking or hanging. Every shim opens with
/// `state.get_pool().await?`, so one command stands for all of them.
#[test]
fn a_command_without_a_connected_database_reports_it() {
    let mut ctx = mock_context(noop_assets());
    *ctx.runtime_authority_mut() = permissive_authority();
    let app = mock_builder()
        .invoke_handler(tauri::generate_handler![
            super::schedules::list_page_schedules
        ])
        .build(ctx)
        .unwrap();
    app.manage(super::DbState::new());
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let err = invoke(&webview, "list_page_schedules", json!({ "pageId": "p1" }))
        .expect_err("no pool is connected");
    assert!(
        format!("{err:?}").contains("No database connected"),
        "unexpected error shape: {err:?}"
    );
}
