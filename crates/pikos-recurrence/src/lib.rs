//! Pure RRULE date-enumeration engine — no DB, async, Tauri, or notifications.
//!
//! Mirrors the rrule.js operations the codebase relies on
//! (`packages/core/src/utils/recurrence.ts`) so the two engines agree occurrence
//! for occurrence; parity is pinned by the committed conformance corpus
//! (`tests/fixtures/corpus.json`, generated from rrule.js) exercised in
//! `tests/conformance.rs`.
//!
//! Enumeration is pure wall-clock: inputs are naive `YYYY-MM-DD[THH:MM:SS]`
//! strings and outputs are the same. Resolving a wall-clock occurrence to an
//! absolute instant in a timezone (for synced reminders) is deliberately left to
//! the notification layer, matching the spec's two-derivation split.

use chrono::{NaiveDate, NaiveDateTime, NaiveTime};

mod engine;
mod label;
mod rule;
#[cfg(feature = "tz")]
pub mod zoned;

pub use engine::{
    align_weekly_rule_to_anchor, compute_next_end, expand_range, list_occurrences,
    missed_occurrences_between, next_occurrence_after, occurrences_in_window,
    oldest_open_occurrence, resolve_anchor_move, snap_anchor_to_rule, snap_schedule_to_rule,
    AnchorMove, Occurrence,
};
pub use label::{rrule_to_label, rrule_to_short_label};
pub use rule::{
    build_rrule, extract_until, parse_rrule, rewrite_until_with, rrule_edit_would_degrade,
    unread_parts, Freq, RecurrenceError, RecurrenceOptions,
};

/// A naive wall-clock value: a date, optionally with a time. Time-less values are
/// all-day (rendered `YYYY-MM-DD`); timed values render `YYYY-MM-DDTHH:MM:SS`.
///
/// The one home for that pair of formats and for what "all-day" means; every layer
/// parses and renders through here rather than re-typing the format strings.
///
/// Parsing is length-led, not padding-strict: chrono's `%m`/`%d` accept `2026-9-1`,
/// which [`WallClock::parse`] reads as a date. A caller that string-compares or
/// stores the value checks the length itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WallClock {
    pub date: NaiveDate,
    pub time: Option<NaiveTime>,
}

impl WallClock {
    pub fn timed(dt: NaiveDateTime) -> Self {
        WallClock {
            date: dt.date(),
            time: Some(dt.time()),
        }
    }

    pub fn all_day(date: NaiveDate) -> Self {
        WallClock { date, time: None }
    }

    pub fn parse(s: &str) -> Option<Self> {
        if s.len() <= 10 {
            NaiveDate::parse_from_str(s, "%Y-%m-%d")
                .ok()
                .map(WallClock::all_day)
        } else {
            NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S")
                .ok()
                .map(WallClock::timed)
        }
    }

    pub fn is_all_day(&self) -> bool {
        self.time.is_none()
    }

    pub fn as_datetime(&self) -> NaiveDateTime {
        self.date.and_time(self.time.unwrap_or(NaiveTime::MIN))
    }

    pub fn format(&self) -> String {
        match self.time {
            None => self.date.format("%Y-%m-%d").to_string(),
            Some(t) => format!("{}T{}", self.date.format("%Y-%m-%d"), t.format("%H:%M:%S")),
        }
    }
}
