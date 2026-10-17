//! Clearing the backlog: what moving the Overdue section onto today means.
//!
//! Port of `packages/core/src/pages/moveOverdueToToday.ts`, graded against it
//! by `tests/overdue_parity.rs`.
//!
//! Deciding *what* moves and *where it lands* is date arithmetic with no I/O in
//! it, which is why it is here rather than in the layer that writes. The caller
//! runs the resulting list through the ordinary one-page schedule write, so a
//! bulk move behaves exactly as a hundred single reschedules would — the same
//! validation, the same refusals.
//!
//! Two kinds of overdue page are deliberately left where they are, and both are
//! reported rather than silently skipped:
//!
//!   - **A recurring occurrence.** Overdue here means the series has a gap, and
//!     closing it is a decision — skip the missed occurrences, or complete
//!     them. Dragging the anchor forward would erase the gap instead of
//!     resolving it, and nothing would say so.
//!   - **A synced mirror.** The calendar owns its schedule; the write is
//!     refused and the row snaps back.
//!
//! Everything else keeps its wall-clock shape. The schedule shifts by a whole
//! number of days, so a 9:00–10:00 from last week is 9:00–10:00 today and a
//! two-day all-day span is still two days.
//!
//! That last property costs the reference real work and costs this nothing, and
//! the difference is worth knowing before someone "fixes" one to match the
//! other. A JavaScript `Date` is an absolute instant, so shifting one by
//! 7 × 86,400 seconds across a DST change moves the wall clock an hour; the
//! TypeScript reaches for `addDays` to avoid exactly that. These values are
//! `NaiveDateTime` — wall clock with no zone attached — so the two forms are
//! identical here, and the corpus says so: mutating `Duration::days(n)` to
//! `Duration::seconds(n * 86_400)` changes no case, including the fixture
//! placed astride the EU change. `days` stays because it says what is meant.

use chrono::Duration;

use crate::dates::{format_date_only, format_local_iso, is_all_day_iso, parse_local_iso};
use crate::views::day_key;

/// What the planner needs to know about one page.
///
/// Borrowed rather than owned, and declared here rather than taken as a concrete
/// page type, for the reason [`crate::views::group_today`] gives: this crate
/// sits below the one that defines a page.
#[derive(Debug, Clone, Copy)]
pub struct OverdueRow<'a> {
    pub id: &'a str,
    pub scheduled_start: Option<&'a str>,
    pub scheduled_end: Option<&'a str>,
    pub is_recurring: bool,
    /// A calendar owns this page's schedule.
    pub schedule_locked: bool,
}

/// One page's move, and what it was before.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverdueMove {
    pub page_id: String,
    /// Where the page lands.
    pub start: String,
    pub end: Option<String>,
    /// What it was, so one undo puts the whole batch back.
    pub previous_start: String,
    pub previous_end: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OverdueMovePlan {
    pub moves: Vec<OverdueMove>,
    /// Left in place — see the module note.
    pub recurring_kept: u32,
    pub synced_kept: u32,
}

/// Shift an ISO schedule string by whole days, keeping its all-day/timed shape.
///
/// Preserving the shape is the load-bearing half: an all-day page shifted into
/// `format_local_iso` comes back as midnight, which is a *timed* page at 00:00
/// and sorts, renders and syncs as one. See the module note for why the
/// `Duration::days` form is legibility rather than DST safety here.
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
/// A page already dated *today* — a timed 9:00 read at 14:00 is overdue without
/// being from an earlier day — is neither moved nor counted as kept. There is
/// nowhere for it to go, and reporting it as left behind would read as a
/// refusal.
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
        // Calendar days between the two dates, not elapsed hours: both sides
        // were parsed from a day key, so this is a whole number by construction.
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

/// The sentence shown after the move.
///
/// Shared rather than written twice, because it is the only place the user is
/// told that something stayed behind — and the two apps disagreeing about *how*
/// they were told is how "2 recurring left" becomes a support question.
///
/// The clean case names the destination ("Moved 4 to today"); once something
/// stayed behind the destination is dropped, so the sentence still fits one
/// line.
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
