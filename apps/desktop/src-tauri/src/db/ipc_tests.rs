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

/// `mock_context` resolves an empty ACL, so every invoke is refused before it
/// reaches a handler. Tauri's own `__allow_command` grants windows but leaves
/// webviews empty, and the authority requires a match on both — hence the entries
/// are built here rather than through it.
fn permissive_authority() -> RuntimeAuthority {
    let allowed_commands: BTreeMap<_, _> = wire_cases()
        .into_iter()
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
