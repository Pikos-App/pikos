//! The operations themselves — the layer between a parsed command and pikos-db.
//!
//! Everything here takes a pool and plain values and returns pikos-db types, so
//! the subcommand bodies and the MCP tools drive one implementation rather than
//! two that drift.

use std::collections::HashMap;

use chrono::{Local, NaiveDate, NaiveTime, TimeZone, Utc};
use pikos_db::{
    complete_recurring_page_impl, create_folder_impl, create_page_impl, create_page_reminder,
    create_recurrence_rule_impl, delete_page_reminder, delete_page_schedule_impl, fts_tokens,
    fuzzy_match_folder, get_folder_impl, get_page, get_recurrence_rule_impl, list_folders_impl,
    list_page_reminders, list_page_schedules_impl, list_pages_impl, list_pages_window,
    list_trashed_pages_impl, now_local_iso, restore_folder_impl, restore_page_impl, search_page,
    soft_delete_folder_impl, soft_delete_page_impl, today_local, update_folder_impl,
    update_page_impl, CompleteRecurringInput, Folder, FolderUpdate, ListExtras, NewFolder,
    NewRecurrenceRule, Page, PageFilter, PageOrder, PageReminder, PageSummary, PageUpdate,
    SearchCursor, SearchPage, Terms, TrashedPage,
};
use serde::Serialize;
use serde_json::Value;
use sqlx::SqlitePool;

use crate::bridge::{run_bridge, ParseResult};
use crate::error::{classify, CliError};
use crate::schedule::{parse_day_range, parse_due, resolve_schedule_change, ScheduleChange};
use crate::write::{
    apply_patch, local_tz, markdown_to_doc, markdown_to_tiptap, page_with_body, priority_num,
    resolve_folder, schedule_once, write_reminders,
};

/// A page as `read` shows it: everything the writer stores, plus the body as markdown,
/// the one form an edit can hand back to `update --content` without losing structure.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRead {
    #[serde(flatten)]
    pub page: Page,
    pub markdown: String,
}

pub async fn read_page(pool: &SqlitePool, id: &str) -> Result<PageRead, CliError> {
    let page = require_page(pool, id).await?;
    let markdown = match serde_json::from_str::<Value>(&page.content) {
        Ok(mut doc) => {
            pikos_db::page_links::refresh_titles(pool, &mut doc)
                .await
                .map_err(classify)?;
            pikos_core::prosemirror_to_markdown(&doc)
        }
        Err(_) => page.content_text.clone().unwrap_or_default(),
    };
    Ok(PageRead { page, markdown })
}

pub async fn require_page(pool: &SqlitePool, id: &str) -> Result<Page, CliError> {
    get_page(pool, id).await.map_err(classify)?.ok_or_else(|| {
        CliError::not_found(format!(
            "No page with id: {id}. A page id is a long string that search and list return \
                 (search_pages or list_pages over MCP); a title is not an id."
        ))
    })
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
/// arguments) arrive in. Translated to a [`PageFilter`] and [`ListExtras`] by [`list_pages`].
#[derive(Default)]
pub struct ListQuery {
    pub folder: Option<String>,
    pub status: Option<String>,
    pub priority: Option<i64>,
    pub query: Option<String>,
    pub has_schedule: bool,
    pub due: Option<String>,
    pub created: Option<String>,
    pub completed: Option<String>,
    pub repeating: bool,
    pub has_reminders: bool,
    pub tags: Vec<String>,
    pub modified: bool,
    pub oldest_first: bool,
    pub limit: Option<usize>,
}

/// A listed page, with its repeat rule or reminders when the query asked about them.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListEntry {
    #[serde(flatten)]
    pub page: PageSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repeats: Option<String>,
    /// Minutes before the start; see `pikos_db::DAY_BEFORE_MINUTES` for the all-day anchor.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reminders: Option<Vec<i64>>,
}

/// Midnight starting a local day, as the UTC instant `created_at` is stored in.
fn local_day_start_utc(day: &str) -> Result<String, CliError> {
    let date = NaiveDate::parse_from_str(day, "%Y-%m-%d")
        .map_err(|_| CliError::usage(format!("not a date: \"{day}\"")))?;
    let midnight = date.and_time(NaiveTime::MIN);
    let instant = Local.from_local_datetime(&midnight).earliest().map_or_else(
        || Utc.from_utc_datetime(&midnight),
        |t| t.with_timezone(&Utc),
    );
    Ok(instant.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

fn next_day(day: &str) -> String {
    NaiveDate::parse_from_str(day, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.succ_opt())
        .map_or_else(|| day.to_string(), |d| d.format("%Y-%m-%d").to_string())
}

pub async fn list_pages(pool: &SqlitePool, q: ListQuery) -> Result<Vec<ListEntry>, CliError> {
    let mut extras = ListExtras {
        recurring: q.repeating,
        has_reminders: q.has_reminders,
        ..Default::default()
    };
    if let Some(range) = &q.created {
        let (from, to) = parse_day_range("created", range)?;
        extras.created_from_utc = Some(local_day_start_utc(&from)?);
        extras.created_until_utc = Some(local_day_start_utc(&next_day(&to))?);
    }
    if let Some(range) = &q.completed {
        let (from, to) = parse_day_range("completed", range)?;
        extras.completed_from = Some(from);
        extras.completed_to = Some(to);
    }
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
    let order = if q.oldest_first {
        PageOrder::Created
    } else if q.modified {
        PageOrder::RecentlyUpdated
    } else {
        PageOrder::SortOrder
    };
    let pages = list_pages_window(pool, Some(filter), &extras, order, q.limit)
        .await
        .map_err(classify)?;

    let mut entries = Vec::with_capacity(pages.len());
    for page in pages {
        let repeats = if q.repeating {
            get_recurrence_rule_impl(pool, &page.id)
                .await
                .map_err(classify)?
                .map(|r| r.rrule)
        } else {
            None
        };
        let reminders = if q.has_reminders {
            Some(
                list_page_reminders(pool, &page.id)
                    .await
                    .map_err(classify)?
                    .into_iter()
                    .map(|r| r.minutes_before)
                    .filter(|m| *m != -1)
                    .collect(),
            )
        } else {
            None
        };
        entries.push(ListEntry {
            page,
            repeats,
            reminders,
        });
    }
    Ok(entries)
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

/// The live folder a rename or delete names, by id or by its whole name.
///
/// Exact, unlike [`resolve_folder_ref`]: deleting a folder trashes every page in it, so
/// "proj" must not reach "Projects" the way it may when only filtering a list.
pub async fn require_folder(pool: &SqlitePool, needle: &str) -> Result<Folder, CliError> {
    let folders = list_folders_impl(pool).await.map_err(classify)?;
    let mut by_name = folders
        .into_iter()
        .filter(|f| f.id == needle || f.name.eq_ignore_ascii_case(needle));
    match (by_name.next(), by_name.next()) {
        (Some(f), None) => Ok(f),
        (Some(_), Some(_)) => Err(CliError::conflict(format!(
            "More than one folder is named \"{needle}\" — pass its id from `pikos folders list`."
        ))),
        (None, _) => Err(CliError::not_found(format!(
            "No folder is named \"{needle}\" — run `pikos folders list` to see them."
        ))),
    }
}

/// Calendar folders follow their calendar: sync renames one back on its next pass and
/// trashing one would orphan the link, so the app offers neither.
fn refuse_calendar_folder(folder: &Folder) -> Result<(), CliError> {
    if folder.is_external_calendar {
        return Err(CliError::conflict(format!(
            "\"{}\" mirrors a connected calendar — rename or remove it in the calendar, or \
             disconnect it in the Pikos app's Calendar Sync settings.",
            folder.name
        )));
    }
    Ok(())
}

pub async fn rename_folder(
    pool: &SqlitePool,
    needle: &str,
    name: &str,
) -> Result<Folder, CliError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CliError::usage("a folder needs a name"));
    }
    let folder = require_folder(pool, needle).await?;
    refuse_calendar_folder(&folder)?;
    update_folder_impl(
        pool,
        folder.id,
        FolderUpdate {
            name: Some(name.to_string()),
            ..Default::default()
        },
    )
    .await
    .map_err(classify)
}

/// Trash a folder with every page in it, as the sidebar's delete does; [`restore_folder`]
/// brings both back.
pub async fn trash_folder(pool: &SqlitePool, needle: &str) -> Result<Folder, CliError> {
    let folder = require_folder(pool, needle).await?;
    refuse_calendar_folder(&folder)?;
    soft_delete_folder_impl(pool, folder.id.clone())
        .await
        .map_err(classify)?;
    Ok(folder)
}

/// Takes an id only: a trashed folder is in no listing a name could be matched against.
pub async fn restore_folder(pool: &SqlitePool, id: &str) -> Result<Folder, CliError> {
    if get_folder_impl(pool, id).await.map_err(classify)?.is_none() {
        return Err(CliError::not_found(format!(
            "No folder with id: {id}. `pikos folders delete` prints the id it trashed."
        )));
    }
    restore_folder_impl(pool, id.to_string())
        .await
        .map_err(classify)?;
    get_folder_impl(pool, id)
        .await
        .map_err(classify)?
        .ok_or_else(|| CliError::internal("the folder vanished while it was restored"))
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

/// Trashed pages, newest first, so a page can be restored without already holding its id.
pub async fn list_trash(pool: &SqlitePool) -> Result<Vec<TrashedPage>, CliError> {
    list_trashed_pages_impl(pool).await.map_err(classify)
}

/// Tags on open pages, most used first, so a filter or a retag can spell one as stored.
pub async fn list_tags(pool: &SqlitePool) -> Result<Vec<pikos_db::reads::TagCount>, CliError> {
    pikos_db::reads::list_tags(pool).await.map_err(classify)
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
            let page = create_page_impl(
                pool,
                page_with_body(pool, folder, input.title.clone(), input.content.as_ref()).await?,
            )
            .await
            .map_err(classify)?;
            apply_patch(pool, &page.id, priority_num(&input.priority), &input.tags)
                .await
                .map_err(classify)?;
            write_reminders(pool, &page.id, &input.reminder_minutes)
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
            // Several pages from one line: refuse a body before the first page is written.
            for body in inputs.iter().filter_map(|i| i.content.as_deref()) {
                markdown_to_doc(body)?;
            }
            for inp in inputs {
                let folder = resolve_folder(pool, &inp.folder_query)
                    .await
                    .map_err(classify)?;
                let page = create_page_impl(
                    pool,
                    page_with_body(pool, folder, inp.title.clone(), inp.content.as_ref()).await?,
                )
                .await
                .map_err(classify)?;
                apply_patch(pool, &page.id, priority_num(&inp.priority), &inp.tags)
                    .await
                    .map_err(classify)?;
                write_reminders(pool, &page.id, &inp.reminder_minutes)
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
            let page = create_page_impl(
                pool,
                page_with_body(pool, folder, input.title.clone(), input.content.as_ref()).await?,
            )
            .await
            .map_err(classify)?;
            apply_patch(pool, &page.id, priority_num(&input.priority), &input.tags)
                .await
                .map_err(classify)?;
            write_reminders(pool, &page.id, &input.reminder_minutes)
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

/// Tick a page off. On a repeating page `date` names the occurrence; without it, the
/// oldest one still open.
pub async fn mark_done(pool: &SqlitePool, id: &str, date: Option<&str>) -> Result<Page, CliError> {
    let page = require_page(pool, id).await?;
    let rule = get_recurrence_rule_impl(pool, id).await.map_err(classify)?;
    if rule.is_none() && date.is_some() {
        return Err(CliError::usage(
            "only a repeating page takes a date — this one has a single occurrence.",
        ));
    }
    if page.status == "done" {
        return Ok(page);
    }
    if rule.is_none() {
        let upd = PageUpdate {
            status: Some("done".to_string()),
            completed_at: Some(Value::String(now_local_iso())),
            ..Default::default()
        };
        return write_patch(pool, id, upd).await;
    }
    if page.schedule_locked {
        return crate::occurrences::complete_synced(pool, &page, date).await;
    }
    let head_day = page
        .scheduled_start
        .as_deref()
        .map(|s| s[..s.len().min(10)].to_string());
    if let Some(day) = date.filter(|d| Some(*d) != head_day.as_deref()) {
        return Err(CliError::conflict(format!(
            "A series made in Pikos ticks off its oldest open occurrence, {}, first — \
             skip the ones before {day} with `pikos occurrence skip` to reach it.",
            head_day.as_deref().unwrap_or("none")
        )));
    }

    // The occurrence, the exclusion and the next head are all derived server-side
    // from the occurrence-sets; the CLI supplies only which series to advance, plus
    // the occurrence it read, so a desktop tick landing first can't make this call
    // silently consume the following one.
    complete_recurring_page_impl(
        pool,
        CompleteRecurringInput {
            page_id: id.to_string(),
            occurrence_date: None,
            scheduled_start: None,
            scheduled_end: None,
            expected_occurrence_date: head_day,
        },
    )
    .await
    .map_err(classify)?;

    require_page(pool, id).await
}

async fn write_patch(pool: &SqlitePool, id: &str, upd: PageUpdate) -> Result<Page, CliError> {
    update_page_impl(pool, id.to_string(), upd)
        .await
        .map_err(classify)
}

/// Set a page's status without inventing a third word for it. `done` goes through
/// [`mark_done`] so a recurring series still advances.
pub async fn set_status(pool: &SqlitePool, id: &str, state: &str) -> Result<Page, CliError> {
    validate_status(state)?;
    if state == "done" {
        return mark_done(pool, id, None).await;
    }
    let page = require_page(pool, id).await?;
    if page.status == "done" {
        if let Some(series) = crate::occurrences::reopen_occurrence(pool, &page).await? {
            return Ok(series);
        }
    }
    write_patch(
        pool,
        id,
        PageUpdate {
            status: Some("not_started".to_string()),
            completed_at: Some(Value::Null),
            ..Default::default()
        },
    )
    .await
}

/// Move a page to the trash — recoverable, and the only removal an agent gets.
pub async fn trash(pool: &SqlitePool, id: &str) -> Result<(), CliError> {
    require_page(pool, id).await?;
    soft_delete_page_impl(pool, id).await.map_err(classify)
}

/// Results per search page when the caller doesn't say.
const SEARCH_PAGE_SIZE: usize = 20;

/// A page of search results, and whether it needed every word or fell back to any.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutcome {
    #[serde(flatten)]
    pub page: SearchPage,
    pub any_word: bool,
}

/// Search for pages holding every word, and when none does, pages holding any of them.
///
/// The fallback runs only on a first page: a cursor belongs to one mode, so a caller paging
/// through any-word results says so with `any_word`, which the outcome hands back.
pub async fn search(
    pool: &SqlitePool,
    query: &str,
    any_word: bool,
    include_completed: bool,
    limit: Option<usize>,
    after: Option<SearchCursor>,
) -> Result<SearchOutcome, CliError> {
    let limit = limit.unwrap_or(SEARCH_PAGE_SIZE);
    let terms = if any_word { Terms::Any } else { Terms::All };
    let first = after.is_none();
    let page = search_page(pool, query, terms, include_completed, limit, after)
        .await
        .map_err(classify)?;
    let fall_back = !any_word
        && first
        && page.results.is_empty()
        && page.completed_count == 0
        && fts_tokens(query).len() > 1;
    if !fall_back {
        return Ok(SearchOutcome { page, any_word });
    }
    let page = search_page(pool, query, Terms::Any, include_completed, limit, None)
        .await
        .map_err(classify)?;
    Ok(SearchOutcome {
        page,
        any_word: true,
    })
}

// ─── Updating ───────────────────────────────────────────────────────────────

/// Everything `update` can change about a page. The three schedule fields carry
/// the same meaning they do on the command line — see [`resolve_schedule_change`].
#[derive(Default)]
pub struct PageEdit {
    pub title: Option<String>,
    pub content: Option<String>,
    pub status: Option<String>,
    pub due: Option<String>,
    pub all_day: Option<String>,
    pub end: Option<String>,
    pub priority: Option<i64>,
    /// A folder name or id, resolved as `list --folder` resolves it.
    pub folder: Option<String>,
    pub add_tags: Vec<String>,
    pub remove_tags: Vec<String>,
    /// An empty string clears it, as emptying the field in the editor does.
    pub subtitle: Option<String>,
    pub unschedule: bool,
    pub no_end: bool,
}

/// A tag as the writer stores it, so `--untag Work` finds the stored `work`. A
/// leading `#` is Quick Add's syntax for a tag, not part of its name.
fn tag_name(raw: &str) -> Result<String, CliError> {
    let name = raw.trim().trim_start_matches('#').trim().to_lowercase();
    if name.is_empty() {
        return Err(CliError::usage(format!("\"{raw}\" is not a tag name")));
    }
    Ok(name)
}

/// The page's tags after the edit, or None when the edit names no tag.
fn edited_tags(
    current: &[String],
    add: &[String],
    remove: &[String],
) -> Result<Option<Vec<String>>, CliError> {
    if add.is_empty() && remove.is_empty() {
        return Ok(None);
    }
    let add = add
        .iter()
        .map(|t| tag_name(t))
        .collect::<Result<Vec<_>, _>>()?;
    let remove = remove
        .iter()
        .map(|t| tag_name(t))
        .collect::<Result<Vec<_>, _>>()?;
    if let Some(both) = add.iter().find(|t| remove.contains(t)) {
        return Err(CliError::usage(format!(
            "\"{both}\" is both added and removed — pass it once."
        )));
    }
    let mut tags: Vec<String> = current
        .iter()
        .filter(|t| !remove.contains(&t.to_lowercase()))
        .cloned()
        .collect();
    for t in add {
        if !tags.iter().any(|existing| existing.to_lowercase() == t) {
            tags.push(t);
        }
    }
    Ok(Some(tags))
}

/// Apply an edit, settling every rejection before the first write so a bad field
/// can't leave the title and priority half-applied.
pub async fn update_page(pool: &SqlitePool, id: &str, edit: PageEdit) -> Result<Page, CliError> {
    let page = require_page(pool, id).await?;
    // clap enforces this pair for the CLI; MCP arguments arrive unguarded, and
    // silently preferring one would reshape the page the caller didn't ask for.
    if edit.due.is_some() && edit.all_day.is_some() {
        return Err(CliError::usage(
            "due and allDay name the same field in different shapes — pass one.",
        ));
    }
    let moves = edit.due.is_some() || edit.all_day.is_some() || edit.end.is_some();
    if edit.unschedule && (moves || edit.no_end) {
        return Err(CliError::usage(
            "unschedule removes the schedule, so it takes no due, allDay, end or noEnd.",
        ));
    }
    if edit.no_end && edit.end.is_some() {
        return Err(CliError::usage(
            "end and noEnd contradict each other — pass one.",
        ));
    }
    let touches_schedule = moves || edit.unschedule || edit.no_end;
    if touches_schedule {
        if page.schedule_locked {
            return Err(CliError::conflict(
                "This event comes from a connected calendar — reschedule it in the Pikos app.",
            ));
        }
        // schedule_once writes the rule-less anchor row, which a recurring page's
        // denorm deliberately ignores — the write would land and move nothing.
        if get_recurrence_rule_impl(pool, id)
            .await
            .map_err(classify)?
            .is_some()
        {
            return Err(CliError::conflict(
                "This page repeats — move the series in the Pikos app.",
            ));
        }
    }
    let one_offs: Vec<_> = if touches_schedule {
        list_page_schedules_impl(pool, id)
            .await
            .map_err(classify)?
            .into_iter()
            .filter(|s| s.rule_id.is_none())
            .collect()
    } else {
        Vec::new()
    };
    let existing = one_offs.first();
    let current = existing.map(|s| (s.scheduled_start.as_str(), s.scheduled_end.as_deref()));
    let mut change = resolve_schedule_change(
        current,
        edit.due.as_deref(),
        edit.all_day.as_deref(),
        edit.end.as_deref(),
    )?;
    if edit.no_end {
        change = Some(match (change, current) {
            (Some(c), _) => ScheduleChange { end: None, ..c },
            (None, Some((start, _))) => ScheduleChange {
                start: start.to_string(),
                end: None,
            },
            (None, None) => {
                return Err(CliError::usage(
                    "noEnd needs a page that is already scheduled.",
                ))
            }
        });
    }
    let folder_id = match &edit.folder {
        Some(name) => Some(resolve_folder_ref(pool, name).await?),
        None => None,
    };
    let tags = edited_tags(&page.tags, &edit.add_tags, &edit.remove_tags)?;

    let mut upd = PageUpdate {
        folder_id,
        tags,
        subtitle: edit.subtitle.map(Value::String),
        ..Default::default()
    };
    if let Some(t) = edit.title {
        upd.title = Some(t);
    }
    if let Some(c) = edit.content {
        let (doc, txt) = markdown_to_tiptap(pool, &c, &page.links).await?;
        upd.content = Some(doc);
        upd.content_text = Some(txt);
    }
    if let Some(s) = &edit.status {
        validate_status(s)?;
        upd.status = Some(s.clone());
        upd.completed_at = Some(if s == "done" {
            Value::String(now_local_iso())
        } else {
            Value::Null
        });
    }
    if let Some(p) = edit.priority {
        validate_priority(p)?;
        upd.priority = Some(p);
    }
    write_patch(pool, id, upd).await?;
    if let Some(change) = &change {
        schedule_once(pool, id, &change.start, change.end.as_deref())
            .await
            .map_err(classify)?;
    }
    if edit.unschedule {
        for s in one_offs {
            delete_page_schedule_impl(pool, s.id)
                .await
                .map_err(classify)?;
        }
    }
    require_page(pool, id).await
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
