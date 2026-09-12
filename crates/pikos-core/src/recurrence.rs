//! Recurrence math — port of the three functions in
//! `packages/core/src/utils/recurrence.ts` that `pikos-cli` currently reaches
//! for by shelling out to a Node subprocess (`packages/pikos-bridge`).
//!
//! ## The wall-clock contract
//!
//! Pikos stores local wall-clock strings, not instants (see [`crate::dates`]).
//! "09:00 every day" must stay 09:00 across a DST transition rather than
//! drifting to 08:00 or 10:00. The TypeScript original achieves this with a
//! trick it calls *fake UTC*: take the local wall-clock fields, reinterpret
//! them as if they were UTC, run the recurrence expansion in that space, then
//! read the fields back out as local. Because the expansion never sees a real
//! timezone, no offset is ever applied and the wall-clock time survives intact.
//!
//! This port does the same thing for the same reason, and it must — the parity
//! corpus contains a `daily_across_dst` fixture that pins 09:00 on both sides
//! of the 2026 EU transition. Expanding in a real zone would pass every other
//! fixture and fail that one.
//!
//! ## Deliberate behaviours worth not "fixing"
//!
//! `FREQ=MONTHLY;BYMONTHDAY=31` *skips* months with no 31st rather than
//! clamping to the 30th or 28th. That is RFC 5545 behaviour and the corpus
//! pins it (Jan, Mar, May, Jul, Aug, Oct — February and the 30-day months are
//! absent). A port that clamps looks more helpful and is wrong.

use chrono::{Duration, NaiveDateTime, Timelike};
use rrule::{RRuleSet, Tz};

use crate::dates::{format_date_only, format_local_iso, is_all_day_iso, parse_local_iso};

/// Upper bound on occurrences pulled from a rule in one call.
///
/// The TS original caps its skip loop at 500 steps to bound a pathological
/// exdate list that covers every future occurrence. The same reasoning applies
/// here, and the limit doubles as the guard `rrule` requires against
/// unbounded (`COUNT`-less, `UNTIL`-less) rules.
const OCCURRENCE_LIMIT: u16 = 500;

/// One expanded occurrence, in the same wall-clock string form the DB stores.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Occurrence {
    /// The rule's own occurrence date (`YYYY-MM-DD`), used for skip/override
    /// matching. Always date-only, even for a timed series.
    pub original_date: String,
    pub scheduled_start: String,
    pub scheduled_end: Option<String>,
}

/// Reinterpret a naive wall-clock datetime as UTC — the *fake UTC* mapping
/// described in the module docs.
fn to_fake_utc(dt: &NaiveDateTime) -> Option<chrono::DateTime<Tz>> {
    dt.and_local_timezone(Tz::UTC).single()
}

/// Read fake-UTC fields back out as a naive wall-clock datetime.
fn from_fake_utc(dt: &chrono::DateTime<Tz>) -> NaiveDateTime {
    dt.naive_utc()
}

/// Build an `RRuleSet` anchored at a wall-clock DTSTART.
///
/// Constructed through the string form rather than the builder because the
/// string form is what the DB stores and what the TS side parses, so a
/// malformed rule fails at the same boundary on both sides.
fn build_set(rrule_str: &str, dtstart: &NaiveDateTime) -> Option<RRuleSet> {
    let anchor = to_fake_utc(dtstart)?;
    let spec = format!(
        "DTSTART:{}\nRRULE:{}",
        anchor.format("%Y%m%dT%H%M%SZ"),
        rrule_str.trim()
    );
    spec.parse::<RRuleSet>().ok()
}

/// Apply a base occurrence's wall-clock time-of-day to another date.
fn with_time_of_day(date: NaiveDateTime, base: &NaiveDateTime) -> Option<NaiveDateTime> {
    date.date()
        .and_hms_opt(base.hour(), base.minute(), base.second())
}

/// The next occurrence strictly after `after_date`, skipping `exdates`.
///
/// Returns `None` when the series is exhausted, when the rule or start date is
/// malformed, or when every candidate within [`OCCURRENCE_LIMIT`] is excluded.
///
/// Mirrors the TS original's seeding: the search starts from the *end* of
/// `after_date`'s day, so "next after today" means the next occurrence on a
/// later calendar day, not later the same day.
pub fn next_occurrence_after(
    rrule_str: &str,
    scheduled_start: &str,
    after_date: &NaiveDateTime,
    exdates: &[String],
) -> Option<Occurrence> {
    let base_start = parse_local_iso(scheduled_start)?;
    let all_day = is_all_day_iso(scheduled_start);

    let set = build_set(rrule_str, &base_start)?;

    // End-of-day seed, matching date-fns `endOfDay`. Sub-second precision is
    // irrelevant to the comparison, so 23:59:59 stands in for 23:59:59.999.
    let cursor = after_date.date().and_hms_opt(23, 59, 59)?;
    let cursor_utc = to_fake_utc(&cursor)?;

    let occurrences = set.after(cursor_utc).all(OCCURRENCE_LIMIT).dates;

    for occ in occurrences {
        let local = from_fake_utc(&occ);
        let date_str = format_date_only(&local);
        if exdates.iter().any(|e| e == &date_str) {
            continue;
        }
        if all_day {
            return Some(Occurrence {
                original_date: date_str.clone(),
                scheduled_start: date_str,
                scheduled_end: None,
            });
        }
        let adjusted = with_time_of_day(local, &base_start)?;
        return Some(Occurrence {
            original_date: date_str,
            scheduled_start: format_local_iso(&adjusted),
            scheduled_end: None,
        });
    }
    None
}

/// Carry a series' end time onto a new start, preserving duration across the
/// day boundary.
///
/// Returns `None` when either side is all-day — an all-day series has no end
/// time to carry. An end wall-clock earlier than the start means an overnight
/// event (22:00–01:00), so the end lands on the following day.
pub fn compute_next_end(base_end: &str, next_start: &str) -> Option<String> {
    if is_all_day_iso(base_end) || is_all_day_iso(next_start) {
        return None;
    }
    let base_end_dt = parse_local_iso(base_end)?;
    let next_start_dt = parse_local_iso(next_start)?;

    let mut next_end = with_time_of_day(next_start_dt, &base_end_dt)?;
    if next_end <= next_start_dt {
        next_end += Duration::days(1);
    }
    Some(format_local_iso(&next_end))
}

/// Expand a rule into occurrences within `[range_start, range_end)`.
///
/// `range_end` is exclusive, matching the TS original, which subtracts a
/// millisecond before handing the bound to an inclusive `between()`.
pub fn expand_for_range(
    rrule_str: &str,
    scheduled_start: &str,
    scheduled_end: Option<&str>,
    exdates: &[String],
    range_start: &NaiveDateTime,
    range_end: &NaiveDateTime,
) -> Vec<Occurrence> {
    let Some(base_start) = parse_local_iso(scheduled_start) else {
        return Vec::new();
    };
    let all_day = is_all_day_iso(scheduled_start);
    let duration = scheduled_end
        .and_then(parse_local_iso)
        .map(|end| end - base_start);

    let Some(set) = build_set(rrule_str, &base_start) else {
        return Vec::new();
    };
    let (Some(after), Some(before)) = (
        to_fake_utc(range_start),
        to_fake_utc(&(*range_end - Duration::seconds(1))),
    ) else {
        return Vec::new();
    };

    let occurrences = set.after(after).before(before).all(OCCURRENCE_LIMIT).dates;

    occurrences
        .into_iter()
        .filter_map(|occ| {
            let local = from_fake_utc(&occ);
            let date_str = format_date_only(&local);
            if exdates.iter().any(|e| e == &date_str) {
                return None;
            }
            if all_day {
                return Some(Occurrence {
                    original_date: date_str.clone(),
                    scheduled_start: date_str,
                    scheduled_end: None,
                });
            }
            let start = with_time_of_day(local, &base_start)?;
            Some(Occurrence {
                original_date: date_str,
                scheduled_start: format_local_iso(&start),
                scheduled_end: duration.map(|d| format_local_iso(&(start + d))),
            })
        })
        .collect()
}
