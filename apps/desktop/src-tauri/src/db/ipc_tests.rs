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
    ]
}

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
