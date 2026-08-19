//! The operations themselves — the layer between a parsed command and pikos-db.
//!
//! Everything here takes a pool and plain values and returns pikos-db types, so
//! the subcommand bodies and the MCP tools drive one implementation rather than
//! two that drift.

use pikos_db::{
    complete_recurring_page_impl, create_page_impl, create_recurrence_rule_impl, get_page,
    get_recurrence_rule_impl, now_local_iso, today_local, CompleteRecurringInput,
    NewRecurrenceRule, Page, PageUpdate,
};
use serde_json::Value;
use sqlx::SqlitePool;

use crate::bridge::{run_bridge, ParseResult};
use crate::error::{classify, CliError};
use crate::write::{apply_patch, base_page, local_tz, priority_num, resolve_folder, schedule_once};

pub async fn require_page(pool: &SqlitePool, id: &str) -> Result<Page, CliError> {
    get_page(pool, id)
        .await
        .map_err(classify)?
        .ok_or_else(|| CliError::not_found(format!("No page with id: {id}")))
}

/// Parse natural-language text into pages, then write them exactly as Quick Add
/// would. Returns the created pages, re-read so the caller sees the derived
/// denormalised schedule rather than what was asked for.
pub async fn cmd_add(pool: &SqlitePool, text: &str) -> Result<Vec<Page>, CliError> {
    let parsed = run_bridge("parse", text)?;
    let result: ParseResult = serde_json::from_value(parsed["result"].clone())
        .map_err(|_| CliError::internal("could not interpret parser output"))?;

    let mut created: Vec<Page> = Vec::new();
    match result {
        ParseResult::Recurring { input, rrule } => {
            let folder = resolve_folder(pool, &input.folder_query)
                .await
                .map_err(classify)?;
            let page = create_page_impl(pool, base_page(folder, input.title.clone()))
                .await
                .map_err(classify)?;
            apply_patch(pool, &page.id, priority_num(&input.priority), &input.tags)
                .await
                .map_err(classify)?;
            let (rule_start, rule_end) = pikos_recurrence::snap_schedule_to_rule(
                &rrule,
                &input.scheduled_start.clone().unwrap_or_else(today_local),
                input.scheduled_end.as_deref(),
            );
            // No denorm write here: creating the rule hands `pages.scheduled_start`
            // to the derivation, which materialises the oldest-open occurrence in
            // the same transaction. Writing the parsed values over it is what let
            // the anchor sit off-pattern.
            create_recurrence_rule_impl(
                pool,
                NewRecurrenceRule {
                    page_id: page.id.clone(),
                    rrule,
                    rrule_exdates: Vec::new(),
                    scheduled_start: rule_start,
                    scheduled_end: rule_end,
                    timezone: local_tz(),
                },
            )
            .await
            .map_err(classify)?;
            created.push(require_page(pool, &page.id).await?);
        }
        ParseResult::Finite { inputs } => {
            for inp in inputs {
                let folder = resolve_folder(pool, &inp.folder_query)
                    .await
                    .map_err(classify)?;
                let page = create_page_impl(pool, base_page(folder, inp.title.clone()))
                    .await
                    .map_err(classify)?;
                apply_patch(pool, &page.id, priority_num(&inp.priority), &inp.tags)
                    .await
                    .map_err(classify)?;
                if let Some(start) = &inp.scheduled_start {
                    schedule_once(pool, &page.id, start, inp.scheduled_end.as_deref())
                        .await
                        .map_err(classify)?;
                }
                created.push(require_page(pool, &page.id).await?);
            }
        }
        ParseResult::Single { input } => {
            let folder = resolve_folder(pool, &input.folder_query)
                .await
                .map_err(classify)?;
            let page = create_page_impl(pool, base_page(folder, input.title.clone()))
                .await
                .map_err(classify)?;
            apply_patch(pool, &page.id, priority_num(&input.priority), &input.tags)
                .await
                .map_err(classify)?;
            if let Some(start) = &input.scheduled_start {
                schedule_once(pool, &page.id, start, input.scheduled_end.as_deref())
                    .await
                    .map_err(classify)?;
            }
            created.push(require_page(pool, &page.id).await?);
        }
    }
    Ok(created)
}

pub async fn mark_done(pool: &SqlitePool, id: &str) -> Result<Page, CliError> {
    let page = require_page(pool, id).await?;
    if page.status == "done" {
        return Ok(page);
    }
    let rule = get_recurrence_rule_impl(pool, id).await.map_err(classify)?;
    if rule.is_none() {
        let upd = PageUpdate {
            status: Some("done".to_string()),
            completed_at: Some(Value::String(now_local_iso())),
            ..Default::default()
        };
        return update_page(pool, id, upd).await;
    }

    // A synced series' head is pinned at the series base, so the occurrence being
    // completed only exists as a client-rendered virtual — which the CLI has no
    // recurrence engine to enumerate. Say so rather than let the backend reject it
    // with a message written for the desktop caller.
    if page.schedule_locked {
        return Err(CliError::conflict(
            "This event comes from a connected calendar — complete it in the Pikos app.",
        ));
    }

    // The occurrence, the exclusion and the next head are all derived server-side
    // from the occurrence-sets; the CLI supplies only which series to advance.
    complete_recurring_page_impl(
        pool,
        CompleteRecurringInput {
            page_id: id.to_string(),
            occurrence_date: None,
            scheduled_start: None,
            scheduled_end: None,
        },
    )
    .await
    .map_err(classify)?;

    require_page(pool, id).await
}

async fn update_page(pool: &SqlitePool, id: &str, upd: PageUpdate) -> Result<Page, CliError> {
    pikos_db::update_page_impl(pool, id.to_string(), upd)
        .await
        .map_err(classify)
}

pub async fn confirm(question: &str) -> bool {
    eprint!("{question} [y/N] ");
    use std::io::Write;
    let _ = std::io::stderr().flush();
    let mut line = String::new();
    if std::io::stdin().read_line(&mut line).is_err() {
        return false;
    }
    matches!(line.trim().to_lowercase().as_str(), "y" | "yes")
}
