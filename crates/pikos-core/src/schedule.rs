//! All-day ↔ timed schedule transitions.
//!
//! Port of `apps/desktop/src/shared/utils/schedule.ts`. These decide what
//! happens to an event's *end* when the user picks a new start in a date
//! picker. A mobile date picker faces exactly the same four transitions, and
//! disagreeing about them would mean the same edit produces different events
//! depending on which device made it.

use chrono::Duration;

use crate::dates::{format_local_iso, is_all_day_iso, is_timed_iso, parse_local_iso};

/// The resulting schedule. `end` of `None` means a single occurrence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduleTransition {
    pub start: String,
    pub end: Option<String>,
}

/// Decide the new end when the start moves to `iso`.
///
/// Four transitions, in the order the original tests them:
///
/// - all-day → timed: collapse to a single occurrence
/// - timed → all-day: keep the date extent, drop the time
/// - timed → timed: preserve duration
/// - all-day → all-day: keep the end unless it now precedes the start
pub fn compute_schedule_transition(
    current_start: Option<&str>,
    current_end: Option<&str>,
    iso: &str,
) -> ScheduleTransition {
    let was_all_day = current_start.is_some_and(is_all_day_iso);
    let now_all_day = is_all_day_iso(iso);

    // all-day → timed.
    if was_all_day && !now_all_day {
        return ScheduleTransition {
            start: iso.to_string(),
            end: None,
        };
    }

    // timed → all-day.
    if current_start.is_some() && !was_all_day && now_all_day {
        if let Some(end) = current_end.filter(|e| is_timed_iso(e)) {
            let date_only = &end[..10.min(end.len())];
            return ScheduleTransition {
                start: iso.to_string(),
                end: (date_only > iso).then(|| date_only.to_string()),
            };
        }
        return ScheduleTransition {
            start: iso.to_string(),
            end: current_end
                .filter(|e| !e.is_empty() && *e > iso)
                .map(str::to_string),
        };
    }

    // timed → timed.
    if !now_all_day {
        if let (Some(start), Some(end)) = (current_start, current_end) {
            if is_timed_iso(start) && is_timed_iso(end) {
                if let (Some(s), Some(e), Some(new_start)) = (
                    parse_local_iso(start),
                    parse_local_iso(end),
                    parse_local_iso(iso),
                ) {
                    let duration = e - s;
                    if duration > Duration::zero() {
                        return ScheduleTransition {
                            start: iso.to_string(),
                            end: Some(format_local_iso(&(new_start + duration))),
                        };
                    }
                }
                // Zero or negative duration keeps the existing end verbatim,
                // matching the original's fall-through.
                return ScheduleTransition {
                    start: iso.to_string(),
                    end: Some(end.to_string()),
                };
            }
        }
    }

    // all-day → all-day.
    ScheduleTransition {
        start: iso.to_string(),
        end: current_end
            .filter(|e| !e.is_empty() && *e >= iso)
            .map(str::to_string),
    }
}

/// Normalise an end-date picker result.
///
/// `None` when the picker cleared the end, or when the end would not be after
/// the start — both mean a single-day event. An all-day start strips a timed
/// end back to its date.
pub fn normalize_end_input(current_start: &str, end_iso: Option<&str>) -> Option<String> {
    let end = end_iso?;
    let mut next = end.to_string();
    if is_all_day_iso(current_start) && is_timed_iso(&next) {
        next.truncate(10);
    }
    if next.as_str() <= current_start {
        return None;
    }
    Some(next)
}
