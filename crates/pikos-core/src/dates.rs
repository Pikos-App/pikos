//! Local wall-clock date helpers — port of `packages/core/src/utils/dates.ts`.
//!
//! Every date in Pikos is stored as a *local wall-clock* string with no zone
//! suffix and no UTC conversion:
//!
//!   - `YYYY-MM-DD`            — all-day event
//!   - `YYYY-MM-DDTHH:MM:SS`   — timed event
//!
//! The TS original exists because `new Date('YYYY-MM-DD')` parses as UTC
//! midnight in JavaScript, shifting the displayed date a day earlier for
//! anyone west of UTC. Rust has no such trap, but the *storage contract* is
//! what matters here: these helpers exist so the Rust side produces byte-identical
//! strings to the TypeScript side, which is what the parity corpus checks.
//!
//! `NaiveDateTime` is deliberate. A wall-clock time in this system is not an
//! instant — "09:00 every day" stays 09:00 across a DST transition. Introducing
//! a timezone-aware type here would quietly re-introduce the instant semantics
//! the storage format is designed to avoid.

use chrono::{NaiveDate, NaiveDateTime, NaiveTime};

/// True for date-only strings (`YYYY-MM-DD`) representing all-day events.
///
/// Load-bearing invariant: keep every all-day check routed through here so a
/// future format change has one site to update, exactly as the TS original
/// documents.
pub fn is_all_day_iso(iso: &str) -> bool {
    !iso.contains('T')
}

/// True for datetime strings (`YYYY-MM-DDTHH:MM:SS`) representing timed events.
pub fn is_timed_iso(iso: &str) -> bool {
    iso.contains('T')
}

/// Parse a Pikos ISO string as a naive local datetime.
///
/// Date-only strings resolve to local midnight, matching the TS helper's use of
/// `date-fns.parse` rather than `new Date`.
pub fn parse_local_iso(iso: &str) -> Option<NaiveDateTime> {
    if is_all_day_iso(iso) {
        NaiveDate::parse_from_str(iso, "%Y-%m-%d")
            .ok()
            .map(|d| d.and_time(NaiveTime::MIN))
    } else {
        NaiveDateTime::parse_from_str(iso, "%Y-%m-%dT%H:%M:%S").ok()
    }
}

/// Format as a local wall-clock ISO datetime (`YYYY-MM-DDTHH:MM:SS`).
///
/// No `Z`, no offset — matches the DB storage format for timed events.
pub fn format_local_iso(dt: &NaiveDateTime) -> String {
    dt.format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// Format as a local `YYYY-MM-DD` string for all-day events.
pub fn format_date_only(dt: &NaiveDateTime) -> String {
    dt.format("%Y-%m-%d").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_all_day_and_timed() {
        assert!(is_all_day_iso("2026-03-15"));
        assert!(!is_all_day_iso("2026-03-15T09:00:00"));
        assert!(is_timed_iso("2026-03-15T09:00:00"));
        assert!(!is_timed_iso("2026-03-15"));
    }

    #[test]
    fn date_only_parses_to_local_midnight() {
        let dt = parse_local_iso("2026-03-15").unwrap();
        assert_eq!(format_local_iso(&dt), "2026-03-15T00:00:00");
    }

    #[test]
    fn round_trips_timed_values() {
        let dt = parse_local_iso("2026-03-15T09:30:45").unwrap();
        assert_eq!(format_local_iso(&dt), "2026-03-15T09:30:45");
        assert_eq!(format_date_only(&dt), "2026-03-15");
    }

    #[test]
    fn rejects_malformed_input() {
        assert!(parse_local_iso("not-a-date").is_none());
        // February 30th does not exist; the TS side yields an Invalid Date here,
        // which the caller checks for. Rust makes that an Option instead.
        assert!(parse_local_iso("2026-02-30").is_none());
    }
}
