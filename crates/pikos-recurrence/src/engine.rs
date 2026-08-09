//! Domain-level occurrence math on top of the rule parser and generator.
//!
//! Everything operates in naive local wall-clock space: Pikos stores dates as
//! timezone-less local ISO strings, so no timezone conversion ever happens
//! here (the historical rrule.js implementation faked this with shifted UTC
//! datetimes; the native engine is naive end to end).

use std::collections::HashSet;

use chrono::{Datelike, Duration, NaiveDateTime, Timelike};
use serde::Serialize;

use crate::generate::Occurrences;
use crate::iso::{format_date, format_datetime, is_all_day, parse_naive};
use crate::options::{build_rrule, parse_options};
use crate::rule::{parse_rule, ParsedRule};

/// Iteration cap for open-ended scans (mirrors the historical 500-step cap
/// that bounds pathological inputs like exdate lists covering every future
/// occurrence).
const MAX_SCAN: usize = 500;

/// Hard cap on occurrences yielded by a single range expansion. Calendar
/// ranges are a few weeks, so this is far above any legitimate result.
const MAX_EXPAND: usize = 10_000;

/// One expanded occurrence of a recurrence rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpandedOccurrence {
    /// The original rrule occurrence date (YYYY-MM-DD) — used for skip/override.
    pub original_date: String,
    /// Date-only for all-day rules, else local datetime preserving the base
    /// occurrence's wall-clock time.
    pub scheduled_start: String,
    /// Present when the rule has a scheduled end — start plus base duration.
    pub scheduled_end: Option<String>,
}

/// Iterates a rule's occurrences anchored at `dtstart`. The rule is parsed
/// per call — parsing is trivial next to generation, and callers never hold
/// rules across calls.
fn occurrences(rule: &ParsedRule, dtstart: NaiveDateTime) -> Occurrences<'_> {
    Occurrences::new(rule, dtstart)
}

/// Applies `base`'s wall-clock time to the date of `occurrence`.
fn with_base_time(occurrence: NaiveDateTime, base: NaiveDateTime) -> NaiveDateTime {
    occurrence
        .date()
        .and_hms_opt(base.hour(), base.minute(), base.second())
        .unwrap_or(occurrence)
}

/// Expands a recurrence rule into occurrences within `[range_start,
/// range_end)`. `scheduled_start`/`scheduled_end` are the rule's base
/// occurrence (DTSTART anchor + duration); `exdates` are YYYY-MM-DD dates to
/// exclude (user skips + materialised overrides).
pub fn expand_range(
    rrule: &str,
    scheduled_start: &str,
    scheduled_end: Option<&str>,
    range_start: &str,
    range_end: &str,
    exdates: &[String],
) -> Vec<ExpandedOccurrence> {
    let Some(base_start) = parse_naive(scheduled_start) else {
        return Vec::new();
    };
    let (Some(rs), Some(re)) = (parse_naive(range_start), parse_naive(range_end)) else {
        return Vec::new();
    };
    let Some(rule) = parse_rule(rrule) else {
        return Vec::new();
    };

    let all_day = is_all_day(scheduled_start);
    let duration = scheduled_end
        .and_then(parse_naive)
        // Whole minutes, truncated toward zero — mirrors date-fns
        // differenceInMinutes on the historical path.
        .map(|end| Duration::minutes((end - base_start).num_minutes()));

    let excluded: HashSet<&str> = exdates.iter().map(String::as_str).collect();

    let mut results = Vec::new();
    for occ in occurrences(&rule, base_start).take(MAX_EXPAND) {
        if occ >= re {
            break;
        }
        if occ < rs {
            continue;
        }

        let date_str = format_date(occ);
        if excluded.contains(date_str.as_str()) {
            continue;
        }

        if all_day {
            results.push(ExpandedOccurrence {
                original_date: date_str.clone(),
                scheduled_start: date_str,
                scheduled_end: None,
            });
        } else {
            let occ_start = with_base_time(occ, base_start);
            results.push(ExpandedOccurrence {
                original_date: date_str,
                scheduled_start: format_datetime(occ_start),
                scheduled_end: duration.map(|d| format_datetime(occ_start + d)),
            });
        }
    }
    results
}

/// Returns the next occurrence's scheduledStart strictly after the *day* of
/// `after` (completions any time on day D advance to the next occurrence on
/// day > D), skipping `exdates`. Date-only for all-day rules, else a local
/// datetime preserving the base wall-clock time. None when the rule is
/// exhausted (UNTIL passed / COUNT consumed) or invalid.
pub fn next_occurrence_after(
    rrule: &str,
    scheduled_start: &str,
    after: &str,
    exdates: &[String],
) -> Option<String> {
    let base_start = parse_naive(scheduled_start)?;
    let cursor = parse_naive(after)?.date().and_hms_opt(23, 59, 59)?;
    let rule = parse_rule(rrule)?;

    let all_day = is_all_day(scheduled_start);
    let excluded: HashSet<&str> = exdates.iter().map(String::as_str).collect();

    for occ in occurrences(&rule, base_start)
        .skip_while(|occ| *occ <= cursor)
        .take(MAX_SCAN)
    {
        let date_str = format_date(occ);
        if excluded.contains(date_str.as_str()) {
            continue;
        }
        return Some(if all_day {
            date_str
        } else {
            format_datetime(with_base_time(occ, base_start))
        });
    }
    None
}

/// Snaps an anchor date to the first occurrence the rule permits on or after
/// the anchor itself, preserving the anchor's wall-clock time. Returns the
/// anchor unchanged when it already satisfies the rule, when the rule yields
/// no occurrence, or when the rrule can't be parsed.
pub fn snap_anchor_to_rule(rrule: &str, anchor: &str) -> String {
    let Some(base_start) = parse_naive(anchor) else {
        return anchor.to_string();
    };
    let Some(rule) = parse_rule(rrule) else {
        return anchor.to_string();
    };

    // DTSTART is the anchor, so the iterator's first element is the first
    // occurrence >= anchor (or the anchor itself when it satisfies the rule).
    let Some(first) = occurrences(&rule, base_start).next() else {
        return anchor.to_string();
    };

    if is_all_day(anchor) {
        format_date(first)
    } else {
        format_datetime(with_base_time(first, base_start))
    }
}

/// Returns YYYY-MM-DD strings for every occurrence strictly after `after` and
/// strictly before `before`, skipping `exdates`. Scan is capped to bound
/// pathological inputs (e.g. a multi-year gap on FREQ=DAILY).
pub fn missed_occurrences_between(
    rrule: &str,
    scheduled_start: &str,
    after: &str,
    before: &str,
    exdates: &[String],
) -> Vec<String> {
    let (Some(after_dt), Some(before_dt)) = (parse_naive(after), parse_naive(before)) else {
        return Vec::new();
    };
    if before_dt <= after_dt {
        return Vec::new();
    }
    let Some(base_start) = parse_naive(scheduled_start) else {
        return Vec::new();
    };
    let Some(rule) = parse_rule(rrule) else {
        return Vec::new();
    };

    let excluded: HashSet<&str> = exdates.iter().map(String::as_str).collect();

    let mut results = Vec::new();
    for occ in occurrences(&rule, base_start)
        .skip_while(|occ| *occ <= after_dt)
        .take(MAX_SCAN)
    {
        if occ >= before_dt {
            break;
        }
        let date_str = format_date(occ);
        if !excluded.contains(date_str.as_str()) {
            results.push(date_str);
        }
    }
    results
}

/// Realigns a single-BYDAY weekly rule's weekday to match a moved anchor.
/// Multi-day, non-weekly, no-BYDAY, and already-aligned rules are returned
/// unchanged. See the recurrence UI docs for the rationale: moving a
/// recurring head moves the whole series, so the pinned BYDAY must follow.
pub fn align_weekly_rule_to_anchor(rrule: &str, anchor_start: &str) -> String {
    let Some(opts) = parse_options(rrule) else {
        return rrule.to_string();
    };
    if opts.freq != crate::options::Freq::Weekly {
        return rrule.to_string();
    }
    let Some(days) = &opts.byweekday else {
        return rrule.to_string();
    };
    if days.len() != 1 {
        return rrule.to_string();
    }
    let Some(anchor) = parse_naive(anchor_start) else {
        return rrule.to_string();
    };

    // chrono: Monday = 0 … Sunday = 6, same as the rrule convention.
    let anchor_weekday = anchor.weekday().num_days_from_monday() as u8;
    if days[0] == anchor_weekday {
        return rrule.to_string();
    }

    let mut realigned = opts;
    realigned.byweekday = Some(vec![anchor_weekday]);
    build_rrule(&realigned)
}

/// Computes the next occurrence's scheduledEnd from the base end's wall-clock
/// time applied to the next start's date. An end earlier than the start is an
/// overnight event — it lands on the following day. None for all-day inputs.
pub fn compute_next_end(base_end: &str, next_start: &str) -> Option<String> {
    if is_all_day(base_end) || is_all_day(next_start) {
        return None;
    }
    let base_end_dt = parse_naive(base_end)?;
    let next_start_dt = parse_naive(next_start)?;
    let mut next_end = with_base_time(next_start_dt, base_end_dt);
    if next_end <= next_start_dt {
        next_end += Duration::days(1);
    }
    Some(format_datetime(next_end))
}

/// Lists the first `limit` occurrences of a rule anchored at `dtstart`, as
/// local ISO datetimes. Used for finite-recurrence expansion (e.g. the NL
/// parser's "m/w/f for 2 weeks") and test helpers.
pub fn list_occurrences(rrule: &str, dtstart: &str, limit: u32) -> Vec<String> {
    let Some(base_start) = parse_naive(dtstart) else {
        return Vec::new();
    };
    let Some(rule) = parse_rule(rrule) else {
        return Vec::new();
    };
    occurrences(&rule, base_start)
        .take(limit.min(MAX_EXPAND as u32) as usize)
        .map(format_datetime)
        .collect()
}
