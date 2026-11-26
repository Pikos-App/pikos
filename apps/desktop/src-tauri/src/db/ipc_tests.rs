//! The IPC boundary — the one layer `workflows_tests.rs` deliberately tests below.
//!
//! Those tests enter at `*_impl`, blind to the wire. The frontend invokes a command name with
//! a **camelCase** body that Tauri deserializes into snake_case parameters, a convention
//! checked by nothing: rename a parameter and every call site still compiles, while the
//! command fails at runtime with an argument error the user meets as a dead button.
//!
//! So this asserts that the body the adapter really sends deserializes into each signature.
//! A handler that then fails on its own terms still passes: reaching it is the proof.
//!
//! The probe below also holds the adapter's read/write classification, a claim about what
//! each handler *does*, to a live database.
//!
//! Debug-only: `RuntimeAuthority::new` takes the ACL manifest argument solely under
//! `debug_assertions`.
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

/// The bodies `TauriSQLiteAdapter.ts` sends for every command with multi-word parameters,
/// the only ones where camelCase⇄snake_case can disagree.
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
        (
            "list_range",
            json!({ "end": "2026-06-22T04:00:00Z", "openOnly": true, "start": null, "zone": "UTC" }),
        ),
        (
            "list_series_heads",
            json!({ "openOnly": true, "since": null }),
        ),
        ("list_page_schedules", json!({ "pageId": "p1" })),
        ("list_page_schedules_for_rules", json!({ "ruleIds": [] })),
        ("get_recurrence_rule", json!({ "pageId": "p1" })),
        ("list_page_reminders", json!({ "pageId": "p1" })),
        ("delete_page_reminders", json!({ "pageId": "p1" })),
        ("list_sync_calendars", json!({ "accountId": "a1" })),
        ("get_usage_stats", json!({ "weekStart": 1 })),
        (
            "set_sync_calendar_color",
            json!({ "color": "#ffffff", "syncCalendarId": "c1" }),
        ),
        // Disabling: the enable arm pokes the sync loop through managed state this app never
        // registers, and `state()` panics on an unmanaged type.
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
        ("purge_trashed_pages", json!({ "olderThanDays": 30 })),
        ("export_csv", json!({ "includeSynced": false })),
        ("export_ics", json!({ "includeSynced": false })),
        ("export_markdown", json!({ "includeSynced": false })),
        ("export_page_markdown", json!({ "pageId": "missing" })),
        (
            "create_focus_session",
            json!({
                "pageId": PROBE_PAGE,
                "startedAt": "2026-06-01T09:00:00",
                "endedAt": "2026-06-01T09:25:00",
                "durationS": 1500,
            }),
        ),
    ]
}

/// Commands the wire test does not drive: each goes out to the network, the login keychain,
/// or the user's disk before it can refuse.
const NOT_DRIVEN: &[(&str, &str)] = &[
    ("connect_caldav_account", "performs CalDAV discovery"),
    ("reconnect_caldav_account", "performs CalDAV discovery"),
    ("refresh_sync_account", "polls the provider"),
    ("resync_sync_account", "polls the provider"),
    ("disconnect_sync_account", "opens the login keychain"),
    ("save_asset", "copies a file into the app data dir"),
    (
        "restore_backup",
        "replaces the workspace file and re-execs the process — driving it would \
         end the test run, and pikos_db::backups covers the swap directly",
    ),
];

/// These name the ids [`seed_probe_workspace`] plants, unlike the wire cases: a body that
/// resolves to no row would let a misfiled writer pass by finding nothing to write to.
fn extra_read_bodies() -> Vec<(&'static str, serde_json::Value)> {
    vec![
        ("get_page", json!({ "id": PROBE_PAGE })),
        ("pending_description_document", json!({ "id": PROBE_PAGE })),
        ("list_pages", json!({ "filter": null })),
        ("list_pages_today", json!({})),
        ("list_trashed_pages", json!({})),
        (
            "list_completed_pages",
            json!({ "filter": { "limit": 10, "offset": 0 } }),
        ),
        ("search_tags", json!({ "query": "work" })),
        ("get_folder", json!({ "id": PROBE_FOLDER })),
        ("list_folders", json!({})),
        ("list_recurrence_rules", json!({})),
        ("list_notification_history", json!({ "limit": 50 })),
        ("get_sync_status", json!({})),
        ("google_sync_available", json!({})),
        (
            "list_view",
            json!({ "after": null, "limit": 50, "key": { "scope": { "kind": "inbox" }, "sort": "date", "zone": "UTC" } }),
        ),
        (
            "list_view_ids",
            json!({ "after": null, "through": null, "key": { "scope": { "kind": "folder", "folderId": PROBE_FOLDER }, "sort": "title", "zone": "UTC" } }),
        ),
        (
            "list_completed_window",
            json!({ "after": null, "limit": 10, "scope": null, "since": null }),
        ),
        (
            "count_views",
            json!({ "today": "2026-06-15", "zone": "UTC" }),
        ),
        ("get_pages", json!({ "ids": [PROBE_PAGE] })),
        (
            "get_page_if_newer",
            json!({ "id": PROBE_PAGE, "known": null }),
        ),
        ("list_recent_pages", json!({ "exclude": null, "limit": 10 })),
        ("list_tags", json!({})),
        ("list_backlinks", json!({ "id": PROBE_PAGE })),
        ("change_state", json!({})),
    ]
}

const PROBE_PAGE: &str = "probe-page";
const PROBE_FOLDER: &str = "probe-folder";

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

const NOT_PROBED: &[(&str, &str)] = &[
    (
        "backup_db",
        "copies the workspace file into the app data dir — it reads no rows, but \
         driving it writes to the machine running the test",
    ),
    (
        "list_backups",
        "reads the backups directory rather than any table, so the row probe has \
         nothing to measure — pikos_db::backups covers what it returns",
    ),
    ("backup_db_before_import", "same copy, on the import path"),
    (
        "connect_db",
        "opens a pool and migrates it — writing is the whole point, and it would \
     swap the pool the probe measures",
    ),
];

fn probe_body(cmd: &str) -> Option<serde_json::Value> {
    wire_cases()
        .into_iter()
        .chain(extra_read_bodies())
        .find(|(name, _)| *name == cmd)
        .map(|(_, body)| body)
}

/// `mock_context` resolves an empty ACL, and Tauri's `__allow_command` grants windows but
/// leaves webviews empty while the authority requires both, so the entries are built here.
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
            super::focus::create_focus_session,
            super::folders::reorder_folders,
            super::windows::list_range,
            super::windows::list_series_heads,
            super::windows::list_view,
            super::windows::list_view_ids,
            super::windows::list_completed_window,
            super::windows::count_views,
            super::windows::get_pages,
            super::windows::get_page_if_newer,
            super::windows::list_recent_pages,
            super::windows::list_tags,
            super::windows::list_backlinks,
            super::windows::change_state,
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
            super::dev::export_ics,
            super::dev::export_markdown,
            super::dev::export_page_markdown,
            super::pages::get_page,
            super::pages::list_pages,
            super::pages::list_pages_today,
            super::pages::list_trashed_pages,
            super::pages::purge_trashed_pages,
            super::pages::list_completed_pages,
            super::tags::search_tags,
            super::folders::get_folder,
            super::folders::list_folders,
            super::schedules::list_recurrence_rules,
            super::sync::get_sync_status,
            super::sync::google_sync_available,
            super::dev::get_usage_stats,
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
            // Any other origin resolves as `Remote`, which no entry matches, and the refusal then
            // reads as a command/window problem.
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

/// A write opens a window telling the DB watcher to ignore its own echo. A mutating command
/// misfiled as a read makes the watcher refetch the workspace on top of what the user just
/// did, with nothing failing and nothing logged. The adapter's own test pins that every
/// command is classified, not that the classification is *true*, so this drives each declared
/// read against a real pool and asserts SQLite counted no row changes.
///
/// The opposite misfiling costs only a needless suppression window, so it isn't detected.
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

/// Meaningful only because `test_pool` caps the pool at one connection: `total_changes()` is
/// per-connection.
async fn total_changes(pool: &sqlx::SqlitePool) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT total_changes()")
        .fetch_one(pool)
        .await
        .expect("total_changes()")
}

/// Read out of the TypeScript rather than restated, since a copy would agree with itself
/// while the real list moved on.
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

/// `wire_cases` is hand-written, and a command added later with a multi-word parameter is
/// missing from it silently. So the set to check is read out of the source: everything
/// `db::commands::register` puts on the builder, against the parameters each deserializes,
/// minus the ones Tauri injects.
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

fn registered_commands() -> BTreeMap<String, Vec<String>> {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let declarations = command_declarations(&src);
    let registered = registered_names(&declarations);

    let mut sources = Vec::new();
    collect_sources(&src, &mut sources);

    let mut out: BTreeMap<String, Vec<String>> =
        declared_signatures(&declarations).into_iter().collect();
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

/// Sliced from the invocation onward so the macro's own definition, whose pattern spells the
/// same anchors in metavariables, is never what gets read.
fn command_declarations(src: &std::path::Path) -> String {
    let path = src.join("db/commands.rs");
    let source = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path:?}: {e}"));
    let at = source
        .find("db_commands! {")
        .expect("commands.rs declares the command surface");
    source[at..].to_string()
}

/// The `extras:` commands (last path segment only) plus every command the macro declares.
fn registered_names(declarations: &str) -> std::collections::BTreeSet<String> {
    const ANCHOR: &str = "extras: [";
    let start = declarations
        .find(ANCHOR)
        .expect("the declaration names its hand-written extras")
        + ANCHOR.len();
    let len = declarations[start..]
        .find(']')
        .expect("unterminated extras list");
    declarations[start..start + len]
        .lines()
        .map(|line| line.split("//").next().unwrap_or_default())
        .flat_map(|line| line.split(','))
        .map(|name| name.trim().rsplit("::").next().unwrap_or_default().trim())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .chain(
            declared_signatures(declarations)
                .into_iter()
                .map(|(n, _)| n),
        )
        .collect()
}

/// A declaration is told from the writer call it expands into by the arrow: only the
/// parameter list is followed by `->`. The macro supplies `state`, so nothing injected needs filtering.
fn declared_signatures(declarations: &str) -> Vec<(String, Vec<String>)> {
    let bytes = declarations.as_bytes();
    let mut out = Vec::new();

    for (close, _) in declarations.match_indices(')') {
        if !declarations[close + 1..].trim_start().starts_with("->") {
            continue;
        }

        let mut depth = 0i32;
        let mut open = None;
        for i in (0..=close).rev() {
            match bytes[i] {
                b')' => depth += 1,
                b'(' => {
                    depth -= 1;
                    if depth == 0 {
                        open = Some(i);
                        break;
                    }
                }
                _ => {}
            }
        }
        let Some(open) = open else { continue };

        let name: String = declarations[..open]
            .chars()
            .rev()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        if name.is_empty() {
            continue;
        }

        let params = split_top_level(&declarations[open + 1..close])
            .into_iter()
            .filter_map(|p| Some(p.split(':').next()?.trim().to_string()))
            .filter(|p| !p.is_empty())
            .collect();
        out.push((name, params));
    }
    out
}

/// `State`, `AppHandle` and the window types are injected by Tauri and never appear in the
/// body, so they are dropped by type rather than by name.
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

/// A command reached with no pool must surface the connect-first error, not panic or hang.
/// Every shim opens with `state.get_pool().await?`, so one command stands for all.
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
