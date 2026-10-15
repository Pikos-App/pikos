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

use pikos_db::SearchCursor;
use serde_json::{json, Value};
use sqlx::SqlitePool;

use crate::error::CliError;
use crate::occurrences;
use crate::ops::{
    add_reminder, cmd_add, create_folder, list_folders, list_pages, list_reminders, list_tags,
    list_trash, mark_done, parse_only, read_page, remove_reminder, rename_folder, restore,
    restore_folder, search, set_status, trash, trash_folder, update_page, ListQuery, PageEdit,
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
            "Full-text search across every page, ranked by relevance. A page must hold every word; \
             when none does, the search falls back to pages holding any of them and says so with \
             anyWord. Results show a short preview; read_page returns the whole page.",
            json!({
                "query": string_prop("Words to search for. One or two distinctive words work best."),
                "anyWord": { "type": "boolean", "description": "Match pages holding any of the words rather than all. Pass it with a cursor from an anyWord result." },
                "includeCompleted": { "type": "boolean", "description": "Include done pages (default false)." },
                "limit": { "type": "integer", "description": "Results per page (default 20)." },
                "cursor": string_prop("The `next` of a previous result, for the page after it."),
            }),
            &["query"],
        ),
        tool(
            "read_page",
            "Read one page's metadata and its body as markdown, by id. Edit the markdown and pass \
             it to update_page's content to change the body.",
            json!({ "id": string_prop("The page id.") }),
            &["id"],
        ),
        tool(
            "list_pages",
            "List pages, filtered by folder, status, priority, text, tags, due date, when they were \
             created or completed, whether they repeat or have reminders, or whether they are scheduled.",
            json!({
                "created": string_prop("Created on a day (YYYY-MM-DD) or in an inclusive range (YYYY-MM-DD..YYYY-MM-DD)."),
                "completed": string_prop("Completed on a day or in an inclusive range, same forms as created."),
                "repeating": { "type": "boolean", "description": "Only pages that repeat; each result carries its rule in `repeats`." },
                "hasReminders": { "type": "boolean", "description": "Only pages with a reminder; each result carries minutes before the start in `reminders` (-2 is 9am the day before, for an all-day page)." },
                "oldestFirst": { "type": "boolean", "description": "Sort by when the page was created, oldest first: what has waited longest." },
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
                "text": string_prop("What to create, e.g. \"Email Sam tomorrow 2pm #work !high ~projects remind 30m before // what to ask him\" — everything after \" // \" becomes the page body, as markdown."),
                "dryRun": { "type": "boolean", "description": "Return the parse for review and write nothing." },
            }),
            &["text"],
        ),
        tool(
            "update_page",
            "Change a page's title, subtitle, body, status, priority, tags, schedule or folder.",
            json!({
                "id": string_prop("The page id."),
                "title": string_prop("New title."),
                "content": string_prop("New body, as markdown: headings, lists, - [ ] tasks, links, **bold**, `code`, quotes, tables. It replaces the whole body. Raw HTML is refused."),
                "status": { "type": "string", "enum": ["not_started", "done"], "description": "New state." },
                "due": string_prop("Move the page: YYYY-MM-DDTHH:MM:SS, or YYYY-MM-DD if it is not already timed."),
                "allDay": string_prop("Make the page all-day on YYYY-MM-DD — the only way to drop an existing time."),
                "end": string_prop("When the page ends, in the page's own shape. Valid on its own."),
                "priority": { "type": "integer", "description": "0 none, 1 urgent, 2 high, 3 medium, 4 low." },
                "folder": string_prop("Move the page to this folder, by name or id; \"inbox\" for unfiled."),
                "addTags": { "type": "array", "items": { "type": "string" }, "description": "Tags to add." },
                "removeTags": { "type": "array", "items": { "type": "string" }, "description": "Tags to remove." },
                "subtitle": string_prop("The line under the title; an empty string clears it."),
                "unschedule": { "type": "boolean", "description": "Remove the page's date and time." },
                "noEnd": { "type": "boolean", "description": "Drop the end, keeping the start." },
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
            "Mark a page done. On a repeating page this ticks off one occurrence, the oldest \
             open one unless date names another, and the page moves on to the next.",
            json!({
                "id": string_prop("The page id."),
                "date": string_prop("On a repeating page, the occurrence to tick off, YYYY-MM-DD. A series made in Pikos takes only its oldest open one; a calendar's takes any since it was connected."),
            }),
            &["id"],
        ),
        tool(
            "skip_occurrence",
            "Skip one occurrence of a repeating page, named by its date. unskip_occurrence brings it back.",
            json!({
                "id": string_prop("The repeating page's id."),
                "date": string_prop("The occurrence's date, YYYY-MM-DD."),
            }),
            &["id", "date"],
        ),
        tool(
            "unskip_occurrence",
            "Bring back an occurrence skip_occurrence skipped.",
            json!({
                "id": string_prop("The repeating page's id."),
                "date": string_prop("The skipped occurrence's date, YYYY-MM-DD."),
            }),
            &["id", "date"],
        ),
        tool(
            "move_occurrence",
            "Move one occurrence of a repeating page, keeping its length unless end says otherwise. \
             The rest of the series stays put. To reopen a ticked-off occurrence, set_status its \
             done page to not_started.",
            json!({
                "id": string_prop("The repeating page's id."),
                "date": string_prop("The occurrence's date, YYYY-MM-DD."),
                "due": string_prop("Where it goes: YYYY-MM-DDTHH:MM:SS, or YYYY-MM-DD if it is not timed."),
                "allDay": string_prop("Make it all-day on YYYY-MM-DD instead."),
                "end": string_prop("When it ends, in its own shape."),
            }),
            &["id", "date"],
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
            "list_trash",
            "List trashed pages, newest first, with their ids for restore_page.",
            json!({}),
            &[],
        ),
        tool(
            "list_tags",
            "List the tags on open pages, most used first, with how many pages carry each.",
            json!({}),
            &[],
        ),
        tool(
            "list_folders",
            "List the workspace's folders with their page counts.",
            json!({}),
            &[],
        ),
        tool(
            "create_folder",
            "Create a folder. Pages are filed into it with create_page's ~folder or update_page's folder.",
            json!({ "name": string_prop("The folder's name.") }),
            &["name"],
        ),
        tool(
            "rename_folder",
            "Rename a folder. A folder that mirrors a connected calendar follows its calendar's name and is refused.",
            json!({
                "folder": string_prop("The folder's id or its whole current name."),
                "name": string_prop("The new name."),
            }),
            &["folder", "name"],
        ),
        tool(
            "delete_folder",
            "Move a folder and every page in it to the trash. restore_folder brings both back; never destroys anything.",
            json!({ "folder": string_prop("The folder's id or its whole name.") }),
            &["folder"],
        ),
        tool(
            "restore_folder",
            "Bring a trashed folder back, with the pages that were trashed along with it.",
            json!({ "id": string_prop("The folder id delete_folder returned.") }),
            &["id"],
        ),
        tool(
            "list_reminders",
            "List one page's reminders. To find which pages have reminders, use list_pages with hasReminders.",
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
                flag(args, "anyWord"),
                flag(args, "includeCompleted"),
                count(args, "limit"),
                match text(args, "cursor") {
                    Some(cursor) => Some(SearchCursor::parse(&cursor).ok_or_else(|| {
                        CliError::usage(format!("\"{cursor}\" isn't a cursor search returned"))
                    })?),
                    None => None,
                },
            )
            .await?;
            to_value(&resp)
        }
        "read_page" => {
            // The editor's JSON and its plain-text shadow are both the body again, and
            // neither can be written back; markdown alone is what update_page takes.
            let mut read = to_value(&read_page(pool, &require_str(args, "id")?).await?)?;
            if let Some(fields) = read.as_object_mut() {
                fields.remove("content");
                fields.remove("contentText");
            }
            Ok(read)
        }
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
                    created: text(args, "created"),
                    completed: text(args, "completed"),
                    repeating: flag(args, "repeating"),
                    has_reminders: flag(args, "hasReminders"),
                    tags: strings(args, "tags"),
                    modified: flag(args, "modified"),
                    oldest_first: flag(args, "oldestFirst"),
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
                    folder: text(args, "folder"),
                    add_tags: strings(args, "addTags"),
                    remove_tags: strings(args, "removeTags"),
                    subtitle: args
                        .get("subtitle")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    unschedule: flag(args, "unschedule"),
                    no_end: flag(args, "noEnd"),
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
        "complete_page" => to_value(
            &mark_done(
                pool,
                &require_str(args, "id")?,
                text(args, "date").as_deref(),
            )
            .await?,
        ),
        "delete_page" => {
            let id = require_str(args, "id")?;
            trash(pool, &id).await?;
            Ok(json!({ "id": id, "trashed": true }))
        }
        "restore_page" => to_value(&restore(pool, &require_str(args, "id")?).await?),
        "skip_occurrence" => to_value(
            &occurrences::skip(pool, &require_str(args, "id")?, &require_str(args, "date")?)
                .await?,
        ),
        "unskip_occurrence" => to_value(
            &occurrences::unskip(pool, &require_str(args, "id")?, &require_str(args, "date")?)
                .await?,
        ),
        "move_occurrence" => {
            let (due, all_day, end) = (text(args, "due"), text(args, "allDay"), text(args, "end"));
            if due.is_some() && all_day.is_some() {
                return Err(CliError::usage(
                    "due and allDay name the same field in different shapes — pass one.",
                ));
            }
            to_value(
                &occurrences::move_occurrence(
                    pool,
                    &require_str(args, "id")?,
                    &require_str(args, "date")?,
                    due.as_deref(),
                    all_day.as_deref(),
                    end.as_deref(),
                )
                .await?,
            )
        }
        "list_trash" => to_value(&list_trash(pool).await?),
        "list_tags" => to_value(&list_tags(pool).await?),
        "list_folders" => to_value(&list_folders(pool).await?),
        "create_folder" => to_value(&create_folder(pool, &require_str(args, "name")?).await?),
        "rename_folder" => to_value(
            &rename_folder(
                pool,
                &require_str(args, "folder")?,
                &require_str(args, "name")?,
            )
            .await?,
        ),
        "delete_folder" => {
            let folder = trash_folder(pool, &require_str(args, "folder")?).await?;
            Ok(json!({ "id": folder.id, "name": folder.name, "trashed": true }))
        }
        "restore_folder" => to_value(&restore_folder(pool, &require_str(args, "id")?).await?),
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
            "skip_occurrence",
            "unskip_occurrence",
            "move_occurrence",
            "list_trash",
            "list_tags",
            "list_folders",
            "create_folder",
            "rename_folder",
            "delete_folder",
            "restore_folder",
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
