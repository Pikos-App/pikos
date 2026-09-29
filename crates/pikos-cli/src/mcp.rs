//! `pikos mcp` — a Model Context Protocol server on stdio, so an agent can drive
//! a real workspace through the same code the subcommands use.
//!
//! The protocol is hand-rolled rather than taken from a crate. What MCP asks of a
//! stdio server is four methods of newline-delimited JSON-RPC 2.0 — `initialize`,
//! `notifications/initialized`, `tools/list`, `tools/call` — which is less code
//! than the shim around an SDK would be, and it keeps the CLI's dependency set to
//! what it already had. Every tool is a thin arm over [`crate::ops`]; nothing here
//! reaches pikos-db directly, so the tool and the subcommand cannot drift.
//!
//! Two invariants the transport imposes:
//!
//! - **stdout carries protocol only.** Payloads and errors alike travel inside
//!   JSON-RPC frames; nothing may `println!` past them.
//! - **the workspace is never migrated.** The schema upgrade is one-way and locks
//!   the installed app out until it is updated too, so it stays a decision a
//!   person makes at a prompt — an agent gets a clear error instead.

use std::io::{BufRead, Write};

use serde_json::{json, Value};
use sqlx::SqlitePool;

use crate::error::CliError;
use crate::ops::{
    add_reminder, cmd_add, list_folders, list_pages, list_reminders, mark_done, parse_only,
    remove_reminder, require_page, restore, search, set_status, trash, update_page, ListQuery,
    PageEdit,
};
use crate::workspace::open_workspace;

/// The revision we speak. A client asking for another known revision gets its own
/// back — the frames this server uses are identical across all three.
const PROTOCOL_VERSION: &str = "2025-06-18";
const KNOWN_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/// Serve MCP on stdin/stdout until the client closes the stream.
///
/// `migrate` is refused rather than honoured: consenting to a one-way schema
/// upgrade is not something to do behind an agent's back, and the flag is global
/// so it can arrive here by habit.
pub async fn serve(db_override: Option<String>, migrate: bool) -> Result<(), CliError> {
    if migrate {
        return Err(CliError::usage(
            "the MCP server will not migrate a workspace — run any other pikos command \
             with --migrate once, then start the server.",
        ));
    }
    // Opened on the first tool call, not here: a client that connects before the
    // desktop app has ever run should still complete `initialize` and be told what
    // is wrong in a frame it can read, rather than watch the process exit.
    let mut pool: Option<SqlitePool> = None;

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line =
            line.map_err(|e| CliError::internal(format!("stdin closed unexpectedly: {e}")))?;
        if line.trim().is_empty() {
            continue;
        }
        let Some(response) = handle_line(&line, &mut pool, &db_override).await else {
            continue; // a notification — nothing to answer
        };
        writeln!(stdout, "{response}")
            .and_then(|()| stdout.flush())
            .map_err(|e| CliError::internal(format!("could not write to stdout: {e}")))?;
    }
    Ok(())
}

/// One line in, at most one line out. `None` means the message was a notification.
async fn handle_line(
    line: &str,
    pool: &mut Option<SqlitePool>,
    db_override: &Option<String>,
) -> Option<Value> {
    let message: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        // No id to answer under, so this is the one place a bare error frame goes out.
        Err(e) => {
            return Some(error_frame(
                Value::Null,
                -32700,
                &format!("parse error: {e}"),
            ))
        }
    };
    let method = message.get("method").and_then(Value::as_str)?;
    let id = message.get("id").cloned();
    let params = message.get("params").cloned().unwrap_or(Value::Null);

    // A response carries the request's id; a notification has none and is answered
    // with silence, which is what `notifications/initialized` expects.
    let id = id?;

    match method {
        "initialize" => Some(result_frame(id, initialize_result(&params))),
        "ping" => Some(result_frame(id, json!({}))),
        "tools/list" => Some(result_frame(id, json!({ "tools": tool_definitions() }))),
        "tools/call" => {
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            Some(result_frame(
                id,
                match call_tool(&name, &args, pool, db_override).await {
                    Ok(payload) => tool_content(&payload, false),
                    // Tool failures ride in the result, not the JSON-RPC error: the
                    // agent is meant to read them and try something else.
                    Err(e) => tool_content(
                        &json!({ "error": { "kind": e.kind, "message": e.message } }),
                        true,
                    ),
                },
            ))
        }
        other => Some(error_frame(id, -32601, &format!("unknown method: {other}"))),
    }
}

fn initialize_result(params: &Value) -> Value {
    let requested = params.get("protocolVersion").and_then(Value::as_str);
    let version = requested
        .filter(|v| KNOWN_VERSIONS.contains(v))
        .unwrap_or(PROTOCOL_VERSION);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "pikos", "version": env!("CARGO_PKG_VERSION") },
        "instructions": "Reads and writes the local Pikos workspace. Pages are tasks and \
                         notes; create_page takes natural language (\"Email Sam tomorrow 2pm \
                         #work !high\") and parses dates, tags, priority and folder out of it. \
                         delete_page only trashes — restore_page undoes it."
    })
}

fn result_frame(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error_frame(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// A tool result: the payload as pretty JSON in one text block, which every client
/// renders and every model can parse.
fn tool_content(payload: &Value, is_error: bool) -> Value {
    let text = serde_json::to_string_pretty(payload).unwrap_or_else(|_| payload.to_string());
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

// ─── Tool definitions ────────────────────────────────────────────────────────

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required,
        }
    })
}

fn string_prop(description: &str) -> Value {
    json!({ "type": "string", "description": description })
}

fn tool_definitions() -> Vec<Value> {
    vec![
        tool(
            "search_pages",
            "Full-text search across every page, ranked by relevance.",
            json!({
                "query": string_prop("Words to search for."),
                "includeCompleted": { "type": "boolean", "description": "Include done pages (default false)." },
                "limit": { "type": "integer", "description": "Keep at most this many results." },
            }),
            &["query"],
        ),
        tool(
            "read_page",
            "Read one page's full body and metadata by id.",
            json!({ "id": string_prop("The page id.") }),
            &["id"],
        ),
        tool(
            "list_pages",
            "List pages, filtered by folder, status, priority, text, tags, due date or whether they are scheduled.",
            json!({
                "folder": string_prop("Folder name or id; \"inbox\" for unfiled pages."),
                "status": { "type": "string", "enum": ["not_started", "done"], "description": "Only pages in this state." },
                "priority": { "type": "integer", "description": "Only pages at this priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low." },
                "query": string_prop("Only pages whose title or body contains this text."),
                "hasSchedule": { "type": "boolean", "description": "Only pages that are scheduled at all." },
                "due": string_prop("A day (YYYY-MM-DD) or an inclusive range (YYYY-MM-DD..YYYY-MM-DD)."),
                "tags": { "type": "array", "items": { "type": "string" }, "description": "Only pages carrying every one of these tags." },
                "modified": { "type": "boolean", "description": "Sort most-recently-edited first." },
                "limit": { "type": "integer", "description": "Keep at most this many pages." },
            }),
            &[],
        ),
        tool(
            "create_page",
            "Create pages from natural language, parsing dates, tags, priority, folder, repetition and reminders out of the text.",
            json!({
                "text": string_prop("What to create, e.g. \"Email Sam tomorrow 2pm #work !high ~projects remind 30m before // what to ask him\" — everything after \" // \" becomes the page body, verbatim."),
                "dryRun": { "type": "boolean", "description": "Return the parse for review and write nothing." },
            }),
            &["text"],
        ),
        tool(
            "update_page",
            "Change a page's title, body, status, priority or schedule.",
            json!({
                "id": string_prop("The page id."),
                "title": string_prop("New title."),
                "content": string_prop("New body, as plain text."),
                "status": { "type": "string", "enum": ["not_started", "done"], "description": "New state." },
                "due": string_prop("Move the page: YYYY-MM-DDTHH:MM:SS, or YYYY-MM-DD if it is not already timed."),
                "allDay": string_prop("Make the page all-day on YYYY-MM-DD — the only way to drop an existing time."),
                "end": string_prop("When the page ends, in the page's own shape. Valid on its own."),
                "priority": { "type": "integer", "description": "0 none, 1 urgent, 2 high, 3 medium, 4 low." },
            }),
            &["id"],
        ),
        tool(
            "set_status",
            "Set a page to done or not_started.",
            json!({
                "id": string_prop("The page id."),
                "status": { "type": "string", "enum": ["not_started", "done"], "description": "The state to set." },
            }),
            &["id", "status"],
        ),
        tool(
            "complete_page",
            "Mark a page done, advancing a repeating page to its next occurrence.",
            json!({ "id": string_prop("The page id.") }),
            &["id"],
        ),
        tool(
            "delete_page",
            "Move a page to the trash, where restore_page can bring it back. Never destroys anything.",
            json!({ "id": string_prop("The page id.") }),
            &["id"],
        ),
        tool(
            "restore_page",
            "Bring a trashed page back.",
            json!({ "id": string_prop("The page id.") }),
            &["id"],
        ),
        tool(
            "list_folders",
            "List the workspace's folders with their page counts.",
            json!({}),
            &[],
        ),
        tool(
            "list_reminders",
            "List a page's reminders.",
            json!({ "pageId": string_prop("The page id.") }),
            &["pageId"],
        ),
        tool(
            "add_reminder",
            "Add a reminder a given number of minutes before a page's scheduled start.",
            json!({
                "pageId": string_prop("The page id."),
                "minutes": { "type": "integer", "description": "Minutes before the start; 0 fires at the start." },
            }),
            &["pageId", "minutes"],
        ),
        tool(
            "remove_reminder",
            "Remove one reminder by its own id.",
            json!({ "reminderId": string_prop("The reminder id.") }),
            &["reminderId"],
        ),
    ]
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

/// Open the workspace on demand, reusing the pool once it exists.
async fn workspace<'a>(
    cache: &'a mut Option<SqlitePool>,
    db_override: &Option<String>,
) -> Result<&'a SqlitePool, CliError> {
    if cache.is_none() {
        *cache = Some(open_workspace(db_override, false).await?);
    }
    Ok(cache.as_ref().expect("just opened"))
}

async fn call_tool(
    name: &str,
    args: &Value,
    cache: &mut Option<SqlitePool>,
    db_override: &Option<String>,
) -> Result<Value, CliError> {
    // The one tool that touches no workspace: parsing is the bridge's job alone.
    if name == "create_page" && flag(args, "dryRun") {
        return parse_only(&require_str(args, "text")?);
    }
    let pool = workspace(cache, db_override).await?;

    match name {
        "search_pages" => {
            let resp = search(
                pool,
                &require_str(args, "query")?,
                flag(args, "includeCompleted"),
                count(args, "limit"),
            )
            .await?;
            to_value(&resp)
        }
        "read_page" => to_value(&require_page(pool, &require_str(args, "id")?).await?),
        "list_pages" => {
            let pages = list_pages(
                pool,
                ListQuery {
                    folder: text(args, "folder"),
                    status: text(args, "status"),
                    priority: args.get("priority").and_then(Value::as_i64),
                    query: text(args, "query"),
                    has_schedule: flag(args, "hasSchedule"),
                    due: text(args, "due"),
                    tags: strings(args, "tags"),
                    modified: flag(args, "modified"),
                    limit: count(args, "limit"),
                },
            )
            .await?;
            to_value(&pages)
        }
        "create_page" => {
            let created = cmd_add(pool, &require_str(args, "text")?).await?;
            to_value(&json!({ "created": created }))
        }
        "update_page" => {
            let page = update_page(
                pool,
                &require_str(args, "id")?,
                PageEdit {
                    title: text(args, "title"),
                    content: text(args, "content"),
                    status: text(args, "status"),
                    due: text(args, "due"),
                    all_day: text(args, "allDay"),
                    end: text(args, "end"),
                    priority: args.get("priority").and_then(Value::as_i64),
                },
            )
            .await?;
            to_value(&page)
        }
        "set_status" => {
            let page = set_status(
                pool,
                &require_str(args, "id")?,
                &require_str(args, "status")?,
            )
            .await?;
            to_value(&page)
        }
        "complete_page" => to_value(&mark_done(pool, &require_str(args, "id")?).await?),
        "delete_page" => {
            let id = require_str(args, "id")?;
            trash(pool, &id).await?;
            Ok(json!({ "id": id, "trashed": true }))
        }
        "restore_page" => to_value(&restore(pool, &require_str(args, "id")?).await?),
        "list_folders" => to_value(&list_folders(pool).await?),
        "list_reminders" => to_value(&list_reminders(pool, &require_str(args, "pageId")?).await?),
        "add_reminder" => {
            let minutes = args
                .get("minutes")
                .and_then(Value::as_i64)
                .ok_or_else(|| CliError::usage("add_reminder needs \"minutes\""))?;
            to_value(&add_reminder(pool, &require_str(args, "pageId")?, minutes).await?)
        }
        "remove_reminder" => {
            let id = require_str(args, "reminderId")?;
            remove_reminder(pool, &id).await?;
            Ok(json!({ "id": id, "removed": true }))
        }
        other => Err(CliError::usage(format!("unknown tool: {other}"))),
    }
}

fn to_value<T: serde::Serialize>(value: &T) -> Result<Value, CliError> {
    serde_json::to_value(value).map_err(|_| CliError::internal("could not serialize the result"))
}

fn require_str(args: &Value, key: &str) -> Result<String, CliError> {
    text(args, key).ok_or_else(|| CliError::usage(format!("missing required argument \"{key}\"")))
}

/// A string argument, treating empty as absent so a client that always sends every
/// key doesn't filter on nothing.
fn text(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn flag(args: &Value, key: &str) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn count(args: &Value, key: &str) -> Option<usize> {
    args.get(key)
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .filter(|n| *n > 0)
}

fn strings(args: &Value, key: &str) -> Vec<String> {
    args.get(key)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names() -> Vec<String> {
        tool_definitions()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn every_tool_is_named_described_and_schema_bearing() {
        for t in tool_definitions() {
            let name = t["name"].as_str().expect("a name");
            assert!(!name.is_empty());
            let description = t["description"].as_str().expect("a description");
            assert!(description.len() > 20, "{name} needs a real description");
            assert_eq!(t["inputSchema"]["type"], "object", "{name}");
            // Required names must exist in properties, or a client validates against
            // a key the server never reads.
            for req in t["inputSchema"]["required"].as_array().unwrap() {
                let key = req.as_str().unwrap();
                assert!(
                    t["inputSchema"]["properties"].get(key).is_some(),
                    "{name} requires \"{key}\" but does not declare it"
                );
            }
        }
    }

    #[test]
    fn the_tool_surface_covers_the_subcommands() {
        let names = names();
        for expected in [
            "search_pages",
            "read_page",
            "list_pages",
            "create_page",
            "update_page",
            "set_status",
            "complete_page",
            "delete_page",
            "restore_page",
            "list_folders",
            "list_reminders",
            "add_reminder",
            "remove_reminder",
        ] {
            assert!(names.contains(&expected.to_string()), "missing {expected}");
        }
        // Destroying a page is deliberately not reachable from here.
        assert!(!names.iter().any(|n| n.contains("hard")));
    }

    #[test]
    fn initialize_echoes_a_known_version_and_falls_back_otherwise() {
        let echoed = initialize_result(&json!({ "protocolVersion": "2024-11-05" }));
        assert_eq!(echoed["protocolVersion"], "2024-11-05");
        let fallback = initialize_result(&json!({ "protocolVersion": "1999-01-01" }));
        assert_eq!(fallback["protocolVersion"], PROTOCOL_VERSION);
        assert!(fallback["capabilities"]["tools"].is_object());
    }

    #[tokio::test]
    async fn a_notification_is_answered_with_silence() {
        let mut pool = None;
        let out = handle_line(
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            &mut pool,
            &None,
        )
        .await;
        assert!(out.is_none());
    }

    #[tokio::test]
    async fn an_unknown_method_is_a_jsonrpc_error() {
        let mut pool = None;
        let out = handle_line(
            r#"{"jsonrpc":"2.0","id":7,"method":"resources/list"}"#,
            &mut pool,
            &None,
        )
        .await
        .expect("a response");
        assert_eq!(out["id"], 7);
        assert_eq!(out["error"]["code"], -32601);
    }

    #[tokio::test]
    async fn a_workspace_that_does_not_exist_fails_the_tool_not_the_session() {
        let mut pool = None;
        let missing = Some("/nonexistent/dir/workspace.sqlite".to_string());
        let out = handle_line(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_folders","arguments":{}}}"#,
            &mut pool,
            &missing,
        )
        .await
        .expect("a response");
        assert_eq!(out["result"]["isError"], true);
        let text = out["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("Workspace"), "{text}");
    }

    #[tokio::test]
    async fn serving_refuses_to_migrate() {
        let err = serve(None, true).await.unwrap_err();
        assert_eq!(err.kind, "Usage");
        assert!(err.message.contains("--migrate"));
    }
}
