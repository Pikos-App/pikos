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

pub use engine::{
    align_weekly_rule_to_anchor, compute_next_end, expand_range, missed_occurrences_between,
    next_occurrence_after, occurrences_in_window, oldest_open_occurrence, snap_anchor_to_rule,
    Occurrence,
};
pub use label::rrule_to_short_label;
pub use rule::{build_rrule, extract_until, parse_rrule, Freq, RecurrenceOptions, RecurrenceError};

/// A naive wall-clock value: a date, optionally with a time. Time-less values are
/// all-day (rendered `YYYY-MM-DD`); timed values render `YYYY-MM-DDTHH:MM:SS`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WallClock {
    pub date: NaiveDate,
    pub time: Option<NaiveTime>,
}

impl WallClock {
    /// Parses `YYYY-MM-DD` (all-day) or `YYYY-MM-DDTHH:MM:SS` (timed). Returns
    /// `None` on any malformed input, mirroring the wrapper's `null` fallbacks.
    pub fn parse(s: &str) -> Option<Self> {
        if s.len() <= 10 {
            NaiveDate::parse_from_str(s, "%Y-%m-%d")
                .ok()
                .map(|date| WallClock { date, time: None })
        } else {
            NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S")
                .ok()
                .map(|dt| WallClock { date: dt.date(), time: Some(dt.time()) })
        }
    }

    pub fn is_all_day(&self) -> bool {
        self.time.is_none()
    }

    /// The instant used for ordering/range comparisons; all-day sorts at midnight.
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
