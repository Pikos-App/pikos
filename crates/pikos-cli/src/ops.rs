//! The operations themselves — the layer between a parsed command and pikos-db.
//!
//! Everything here takes a pool and plain values and returns pikos-db types, so
//! the subcommand bodies and the MCP tools drive one implementation rather than
//! two that drift.

use std::collections::HashMap;

use pikos_db::{
    complete_recurring_page_impl, create_folder_impl, create_page_impl, create_page_reminder,
    create_recurrence_rule_impl, delete_page_reminder, fuzzy_match_folder, get_page,
    get_recurrence_rule_impl, list_folders_impl, list_page_reminders, list_pages_impl,
    now_local_iso, restore_page_impl, today_local, CompleteRecurringInput, Folder, NewFolder,
    NewRecurrenceRule, Page, PageFilter, PageReminder, PageSummary, PageUpdate,
};
use serde::Serialize;
use serde_json::Value;
use sqlx::SqlitePool;

use crate::bridge::{run_bridge, ParseResult};
use crate::error::{classify, CliError};
use crate::schedule::parse_due;
use crate::write::{apply_patch, base_page, local_tz, priority_num, resolve_folder, schedule_once};

pub async fn require_page(pool: &SqlitePool, id: &str) -> Result<Page, CliError> {
    get_page(pool, id)
        .await
        .map_err(classify)?
        .ok_or_else(|| CliError::not_found(format!("No page with id: {id}")))
}

/// The two words `status` may hold, checked before anything is written.
pub fn validate_status(s: &str) -> Result<(), CliError> {
    if s != "not_started" && s != "done" {
        return Err(CliError::usage(format!(
            "status must be \"not_started\" or \"done\" (got \"{s}\")"
        )));
    }
    Ok(())
}

/// Priorities are the five the app offers — 0 (none) through 4 (low).
pub fn validate_priority(p: i64) -> Result<(), CliError> {
    if !(0..=4).contains(&p) {
        return Err(CliError::usage(format!("priority must be 0–4 (got {p})")));
    }
    Ok(())
}

// ─── Listing ────────────────────────────────────────────────────────────────

/// Every filter `list` can express, in the shape the flags (and the MCP tool
/// arguments) arrive in. Translated to a [`PageFilter`] by [`list_pages`].
#[derive(Default)]
pub struct ListQuery {
    pub folder: Option<String>,
    pub status: Option<String>,
    pub priority: Option<i64>,
    pub query: Option<String>,
    pub has_schedule: bool,
    pub due: Option<String>,
    pub tags: Vec<String>,
    pub modified: bool,
    pub limit: Option<usize>,
}

pub async fn list_pages(pool: &SqlitePool, q: ListQuery) -> Result<Vec<PageSummary>, CliError> {
    let mut filter = PageFilter::default();
    if let Some(s) = &q.status {
        validate_status(s)?;
        filter.status = Some(s.clone());
    }
    if let Some(p) = q.priority {
        validate_priority(p)?;
        filter.priority = Some(p);
    }
    if let Some(name) = &q.folder {
        filter.folder_id = Some(resolve_folder_ref(pool, name).await?);
    }
    if let Some(d) = &q.due {
        let (after, before) = parse_due(d)?;
        filter.scheduled_after = Some(after);
        filter.scheduled_before = Some(before);
    }
    if q.has_schedule {
        filter.has_schedule = Some(true);
    }
    if let Some(text) = &q.query {
        filter.query = Some(text.clone());
    }
    if !q.tags.is_empty() {
        filter.tags = Some(q.tags.clone());
    }
    let mut pages = list_pages_impl(pool, Some(filter))
        .await
        .map_err(classify)?;
    if q.modified {
        pages.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    }
    if let Some(n) = q.limit {
        pages.truncate(n);
    }
    Ok(pages)
}

// ─── Folders ────────────────────────────────────────────────────────────────

/// A folder plus how many live pages sit in it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    #[serde(flatten)]
    pub folder: Folder,
    pub page_count: usize,
}

/// Folders with their page counts. The tally comes from one page listing rather
/// than a per-folder query, so the whole command is two round trips regardless
/// of how many folders exist.
pub async fn list_folders(pool: &SqlitePool) -> Result<Vec<FolderEntry>, CliError> {
    let folders = list_folders_impl(pool).await.map_err(classify)?;
    let pages = list_pages_impl(pool, None).await.map_err(classify)?;
    let mut counts: HashMap<String, usize> = HashMap::new();
    for p in &pages {
        if let Some(id) = &p.folder_id {
            *counts.entry(id.clone()).or_default() += 1;
        }
    }
    Ok(folders
        .into_iter()
        .map(|folder| FolderEntry {
            page_count: counts.get(&folder.id).copied().unwrap_or(0),
            folder,
        })
        .collect())
}

pub async fn create_folder(pool: &SqlitePool, name: &str) -> Result<Folder, CliError> {
    if name.trim().is_empty() {
        return Err(CliError::usage("a folder needs a name"));
    }
    create_folder_impl(
        pool,
        NewFolder {
            name: name.to_string(),
            parent_id: None,
            color: None,
            icon: None,
        },
    )
    .await
    .map_err(classify)
}

/// Resolve a `--folder` argument to the value a [`PageFilter`] wants: an exact id
/// first, then the same fuzzy name match `add` uses for `~folder`.
///
/// `inbox` names the unfiled view (`folder_id IS NULL`), but only when no real
/// folder answers to it — the same precedence Quick Add applies, so one string
/// never means two things depending on which binary read it.
pub async fn resolve_folder_ref(pool: &SqlitePool, needle: &str) -> Result<Value, CliError> {
    let folders = list_folders_impl(pool).await.map_err(classify)?;
    if let Some(exact) = folders.iter().find(|f| f.id == needle) {
        return Ok(Value::String(exact.id.clone()));
    }
    let candidates: Vec<Folder> = folders
        .into_iter()
        .filter(|f| !f.is_external_calendar)
        .collect();
    if let Some(matched) = fuzzy_match_folder(needle, &candidates) {
        return Ok(Value::String(matched.id.clone()));
    }
    if needle.eq_ignore_ascii_case("inbox") {
        return Ok(Value::Null);
    }
    Err(CliError::not_found(format!(
        "No folder matches \"{needle}\" — run `pikos folders list` to see them."
    )))
}

// ─── Reminders ──────────────────────────────────────────────────────────────

pub async fn list_reminders(
    pool: &SqlitePool,
    page_id: &str,
) -> Result<Vec<PageReminder>, CliError> {
    require_page(pool, page_id).await?;
    list_page_reminders(pool, page_id).await.map_err(classify)
}

/// `minutes` is minutes *ahead* of the scheduled start — 0 fires at the start,
/// and -1 is pikos-db's "no reminders for this page" sentinel.
pub async fn add_reminder(
    pool: &SqlitePool,
    page_id: &str,
    minutes: i64,
) -> Result<PageReminder, CliError> {
    if minutes < -1 {
        return Err(CliError::usage(format!(
            "minutes counts backwards from the start, so it cannot be below -1 (got {minutes})"
        )));
    }
    require_page(pool, page_id).await?;
    create_page_reminder(pool, page_id, minutes)
        .await
        .map_err(classify)
}

pub async fn remove_reminder(pool: &SqlitePool, reminder_id: &str) -> Result<(), CliError> {
    delete_page_reminder(pool, reminder_id)
        .await
        .map_err(classify)
}

// ─── Trash ──────────────────────────────────────────────────────────────────

/// Un-trash a soft-deleted page — the other half of `delete`, which until now
/// could put a page in the trash and never take it out.
///
/// Idempotent: a page that was never trashed comes back unchanged, which is why
/// the result is the page rather than a verb.
pub async fn restore(pool: &SqlitePool, id: &str) -> Result<Page, CliError> {
    require_page(pool, id).await?;
    restore_page_impl(pool, id).await.map_err(classify)?;
    require_page(pool, id).await
}

/// Run the natural-language parser and hand back what it produced, verbatim,
/// without writing anything.
///
/// This is the agent-preview mode behind `add --dry-run`: the shape is exactly
/// what [`cmd_add`] would then persist, so a caller can show the parse for
/// approval and re-issue the same text to commit it.
pub fn parse_only(text: &str) -> Result<Value, CliError> {
    let parsed = run_bridge("parse", text)?;
    Ok(parsed["result"].clone())
}

/// Parse natural-language text into pages, then write them exactly as Quick Add
/// would. Returns the created pages, re-read so the caller sees the derived
/// denormalised schedule rather than what was asked for.
pub async fn cmd_add(pool: &SqlitePool, text: &str) -> Result<Vec<Page>, CliError> {
    let parsed = parse_only(text)?;
    let result: ParseResult = serde_json::from_value(parsed)
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
