//! Clearing the backlog: what moving the Overdue section onto today means.
//!
//! Deciding what moves and where it lands is date arithmetic with no I/O, so it lives here.
//! The caller runs the resulting list through the ordinary one-page schedule write, so a bulk
//! move gets the same validation and refusals as single reschedules.
//!
//! Two kinds of overdue page stay where they are, and both are reported rather than skipped:
//!
//!   - **A recurring occurrence.** Overdue means the series has a gap, and closing it is a
//!     decision (skip or complete the missed occurrences). Dragging the anchor forward would
//!     erase the gap silently.
//!   - **A synced mirror.** The calendar owns its schedule; the write is refused and the row
//!     snaps back.
//!
//! Everything else shifts by a whole number of days, keeping its wall-clock shape. The
//! TypeScript needs `addDays` because a JavaScript `Date` is an instant, so adding
//! 7 × 86,400 seconds across a DST change moves the wall clock. `NaiveDateTime` has no zone,
//! so `Duration::days` is for legibility here, not DST safety.

use chrono::Duration;

use crate::dates::{format_date_only, format_local_iso, is_all_day_iso, parse_local_iso};
use crate::views::day_key;

/// What the planner needs to know about one page, borrowed. See
/// [`crate::views::group_today`] for why it is not a page type.
#[derive(Debug, Clone, Copy)]
pub struct OverdueRow<'a> {
    pub id: &'a str,
    pub scheduled_start: Option<&'a str>,
    pub scheduled_end: Option<&'a str>,
    pub is_recurring: bool,
    pub schedule_locked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverdueMove {
    pub page_id: String,
    pub start: String,
    pub end: Option<String>,
    /// What it was, so one undo puts the whole batch back.
    pub previous_start: String,
    pub previous_end: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OverdueMovePlan {
    pub moves: Vec<OverdueMove>,
    pub recurring_kept: u32,
    pub synced_kept: u32,
}

/// Shift an ISO schedule string by whole days, keeping its all-day/timed shape.
///
/// An all-day page formatted through `format_local_iso` would come back as a timed page at 00:00.
fn shift_by_days(iso: &str, days: i64) -> Option<String> {
    let shifted = parse_local_iso(iso)? + Duration::days(days);
    Some(if is_all_day_iso(iso) {
        format_date_only(&shifted)
    } else {
        format_local_iso(&shifted)
    })
}

/// Plan the move for the pages currently in the Overdue section.
///
/// A page already dated today (a timed 9:00 read at 14:00) is neither moved nor counted as
/// kept: reporting it as left behind would read as a refusal.
pub fn plan_move_overdue_to_today(pages: &[OverdueRow<'_>], today: &str) -> OverdueMovePlan {
    let mut plan = OverdueMovePlan::default();
    let Some(today_date) = parse_local_iso(today) else {
        return plan;
    };

    for page in pages {
        let Some(start) = page.scheduled_start else {
            continue;
        };
        if page.is_recurring {
            plan.recurring_kept += 1;
            continue;
        }
        if page.schedule_locked {
            plan.synced_kept += 1;
            continue;
        }
        let Some(from) = parse_local_iso(day_key(start)) else {
            continue;
        };
        let shift = (today_date.date() - from.date()).num_days();
        if shift <= 0 {
            continue;
        }
        let (Some(moved_start), moved_end) = (
            shift_by_days(start, shift),
            page.scheduled_end.and_then(|end| shift_by_days(end, shift)),
        ) else {
            continue;
        };
        plan.moves.push(OverdueMove {
            page_id: page.id.to_string(),
            start: moved_start,
            end: moved_end,
            previous_start: start.to_string(),
            previous_end: page.scheduled_end.map(str::to_string),
        });
    }

    plan
}

/// The sentence shown after the move, shared so both apps tell the user the same way that
/// something stayed behind.
///
/// The clean case names the destination ("Moved 4 to today"); once something stayed it is
/// dropped so the sentence fits one line.
pub fn move_overdue_to_today_label(plan: &OverdueMovePlan) -> String {
    let mut kept: Vec<String> = Vec::new();
    if plan.recurring_kept > 0 {
        kept.push(format!("{} recurring", plan.recurring_kept));
    }
    if plan.synced_kept > 0 {
        kept.push(format!("{} synced", plan.synced_kept));
    }
    if plan.moves.is_empty() {
        return if kept.is_empty() {
            "Nothing to move".to_string()
        } else {
            format!("Nothing to move · {} left", kept.join(", "))
        };
    }
    if kept.is_empty() {
        return format!("Moved {} to today", plan.moves.len());
    }
    format!("Moved {} · {} left", plan.moves.len(), kept.join(", "))
}
