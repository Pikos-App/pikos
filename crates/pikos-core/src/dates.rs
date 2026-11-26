//! Local wall-clock date helpers.
//!
//! Every date is a local wall-clock string with no zone suffix and no UTC conversion:
//! `YYYY-MM-DD` (all-day) or `YYYY-MM-DDTHH:MM:SS` (timed). These helpers produce
//! byte-identical strings to the TypeScript side, which the parity corpus checks.
//!
//! `NaiveDateTime` is deliberate: a wall-clock time is not an instant, so "09:00 every day"
//! stays 09:00 across DST. A zone-aware type would reintroduce instant semantics.

use chrono::{NaiveDate, NaiveDateTime, NaiveTime};

/// True for date-only strings (`YYYY-MM-DD`), which are all-day events.
///
/// Route every all-day check through here so a format change has one site to update.
pub fn is_all_day_iso(iso: &str) -> bool {
    !iso.contains('T')
}

/// True for datetime strings (`YYYY-MM-DDTHH:MM:SS`) representing timed events.
pub fn is_timed_iso(iso: &str) -> bool {
    iso.contains('T')
}

/// Parse a Pikos ISO string as a naive local datetime.
///
/// Date-only strings resolve to local midnight.
pub fn parse_local_iso(iso: &str) -> Option<NaiveDateTime> {
    if is_all_day_iso(iso) {
        NaiveDate::parse_from_str(iso, "%Y-%m-%d")
            .ok()
            .map(|d| d.and_time(NaiveTime::MIN))
    } else {
        NaiveDateTime::parse_from_str(iso, "%Y-%m-%dT%H:%M:%S").ok()
    }
}

/// Format as a local wall-clock ISO datetime (`YYYY-MM-DDTHH:MM:SS`), with no `Z` or offset.
pub fn format_local_iso(dt: &NaiveDateTime) -> String {
    dt.format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// Format as a local `YYYY-MM-DD` string for all-day events.
pub fn format_date_only(dt: &NaiveDateTime) -> String {
    dt.format("%Y-%m-%d").to_string()
}

/// Midnight on the day after `dt`.
///
/// Uses the date's own successor rather than adding 86,400 seconds, since a wall-clock day is
/// not always that long. Saturates at the representable maximum.
pub fn next_day(dt: NaiveDateTime) -> NaiveDateTime {
    match dt.date().succ_opt().and_then(|d| d.and_hms_opt(0, 0, 0)) {
        Some(next) => next,
        None => dt,
    }
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
        assert!(parse_local_iso("2026-02-30").is_none());
    }
}
