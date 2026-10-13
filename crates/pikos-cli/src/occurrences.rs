//! One occurrence of a repeating page: skip it, bring it back, move it, or reopen it once done.
//!
//! An occurrence is named by its series and the date the rule gives it. Each write checks
//! that date against the rule first, because the writers take any date: a skip for a day the
//! rule never yields lands in the skip-set and changes nothing anyone can see.

use pikos_db::{
    get_recurrence_rule_impl, list_pages_window, reschedule_virtual_occurrence_impl,
    skip_occurrence_impl, uncomplete_recurring_occurrence_impl, undo_skip_occurrence_impl, Page,
    PageOrder, PageRecurrenceRule, RescheduleVirtualInput, RescheduleVirtualResult,
    SkipOccurrenceInput, UncompleteRecurringInput,
};
use pikos_recurrence::{occurrences_in_window, Occurrence};
use sqlx::SqlitePool;

use crate::error::{classify, CliError};
use crate::ops::require_page;
use crate::schedule::{resolve_schedule_change, shape_of, Shape};
use crate::write::local_tz;

async fn require_series(
    pool: &SqlitePool,
    id: &str,
) -> Result<(Page, PageRecurrenceRule), CliError> {
    let page = require_page(pool, id).await?;
    let rule = get_recurrence_rule_impl(pool, id)
        .await
        .map_err(classify)?
        .ok_or_else(|| CliError::conflict("This page doesn't repeat — update --due moves it."))?;
    Ok((page, rule))
}

/// The occurrence the rule gives `day`. A date the series moved away or removed counts as
/// none, so a second move of the same date is refused rather than cloned twice.
fn occurrence_on(
    page: &Page,
    rule: &PageRecurrenceRule,
    day: &str,
) -> Result<Occurrence, CliError> {
    if shape_of(day) != Some(Shape::AllDay) {
        return Err(CliError::usage(format!(
            "an occurrence is named by its date, YYYY-MM-DD (got \"{day}\")"
        )));
    }
    let found = occurrences_in_window(
        &rule.rrule,
        &rule.scheduled_start,
        rule.scheduled_end.as_deref(),
        &format!("{day}T00:00:00"),
        &format!("{day}T23:59:59"),
        &rule.rrule_exdates,
    )
    .map_err(|_| {
        CliError::conflict(
            "This page's repeat rule can't be read here — change it in the Pikos app.",
        )
    })?;
    found
        .into_iter()
        .find(|o| o.original_date == day)
        .ok_or_else(|| {
            CliError::usage(format!(
                "\"{}\" doesn't repeat on {day}, or that occurrence was moved.",
                page.title
            ))
        })
}

fn is_completed(page: &Page, day: &str) -> bool {
    page.completed_occurrences
        .as_ref()
        .is_some_and(|done| done.contains_key(day))
}

fn is_skipped(page: &Page, day: &str) -> bool {
    page.skipped_occurrences
        .as_ref()
        .is_some_and(|skipped| skipped.iter().any(|d| d == day))
}

/// Skip one occurrence, as deleting it from the calendar does. Skipping it twice is harmless.
pub async fn skip(pool: &SqlitePool, id: &str, day: &str) -> Result<Page, CliError> {
    let (page, rule) = require_series(pool, id).await?;
    occurrence_on(&page, &rule, day)?;
    if is_completed(&page, day) {
        return Err(CliError::conflict(format!(
            "{day} is already done — reopen it with `pikos status <its page id> not_started` first."
        )));
    }
    skip_occurrence_impl(
        pool,
        SkipOccurrenceInput {
            page_id: id.to_string(),
            occurrence_date: day.to_string(),
        },
    )
    .await
    .map_err(classify)?;
    require_page(pool, id).await
}

pub async fn unskip(pool: &SqlitePool, id: &str, day: &str) -> Result<Page, CliError> {
    let (page, _) = require_series(pool, id).await?;
    if !is_skipped(&page, day) {
        return Err(CliError::usage(format!(
            "{day} isn't skipped on \"{}\".",
            page.title
        )));
    }
    undo_skip_occurrence_impl(
        pool,
        SkipOccurrenceInput {
            page_id: id.to_string(),
            occurrence_date: day.to_string(),
        },
    )
    .await
    .map_err(classify)?;
    require_page(pool, id).await
}

/// Move one occurrence, as dragging it on the calendar does. The flags read as `update`'s
/// do against that occurrence's own time, so a move keeps its length.
pub async fn move_occurrence(
    pool: &SqlitePool,
    id: &str,
    day: &str,
    due: Option<&str>,
    all_day: Option<&str>,
    end: Option<&str>,
) -> Result<RescheduleVirtualResult, CliError> {
    let (page, rule) = require_series(pool, id).await?;
    if page.schedule_locked {
        return Err(CliError::conflict(
            "This event comes from a connected calendar — move it in the calendar.",
        ));
    }
    let occurrence = occurrence_on(&page, &rule, day)?;
    if is_completed(&page, day) || is_skipped(&page, day) {
        return Err(CliError::conflict(format!(
            "{day} is already done or skipped, so there is nothing to move."
        )));
    }
    if due.is_none() && all_day.is_none() {
        return Err(CliError::usage(
            "say where it goes with --due or --all-day.",
        ));
    }
    let change = resolve_schedule_change(
        Some((
            occurrence.scheduled_start.as_str(),
            occurrence.scheduled_end.as_deref(),
        )),
        due,
        all_day,
        end,
    )?
    .expect("a destination was checked above");
    reschedule_virtual_occurrence_impl(
        pool,
        RescheduleVirtualInput {
            rule_id: rule.id,
            original_date: day.to_string(),
            scheduled_start: change.start,
            scheduled_end: change.end,
            timezone: local_tz(),
        },
    )
    .await
    .map_err(classify)
}

/// The series and date a done copy of an occurrence was ticked off as, if `page` is one.
async fn completed_occurrence_of(
    pool: &SqlitePool,
    page: &Page,
) -> Result<Option<(String, String)>, CliError> {
    let series = list_pages_window(
        pool,
        None,
        &pikos_db::ListExtras {
            recurring: true,
            ..Default::default()
        },
        PageOrder::SortOrder,
        None,
    )
    .await
    .map_err(classify)?;
    Ok(series.into_iter().find_map(|s| {
        let day = s
            .completed_occurrences
            .as_ref()?
            .iter()
            .find(|(_, clone)| **clone == page.id)?
            .0
            .clone();
        Some((s.id, day))
    }))
}

/// Reopen a ticked-off occurrence as unchecking it in the app does, rather than flip its
/// status, which leaves the series counting that date as done. `None`: not one.
pub async fn reopen_occurrence(pool: &SqlitePool, page: &Page) -> Result<Option<Page>, CliError> {
    let Some((series_id, day)) = completed_occurrence_of(pool, page).await? else {
        return Ok(None);
    };
    uncomplete_recurring_occurrence_impl(
        pool,
        UncompleteRecurringInput {
            page_id: series_id.clone(),
            occurrence_date: day,
        },
    )
    .await
    .map_err(classify)?;
    Ok(Some(require_page(pool, &series_id).await?))
}
