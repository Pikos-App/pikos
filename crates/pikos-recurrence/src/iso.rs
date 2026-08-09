//! Pikos ISO string helpers.
//!
//! All dates in Pikos are naive local wall-clock strings — no Z suffix, no
//! UTC conversion. Date-only strings ('YYYY-MM-DD') represent all-day events;
//! datetime strings ('YYYY-MM-DDTHH:MM:SS') represent timed events. This
//! mirrors `packages/core/src/utils/dates.ts`, which is the canonical
//! statement of the convention.

use chrono::{NaiveDate, NaiveDateTime};

/// True for date-only ISO strings ('YYYY-MM-DD') used for all-day events.
pub fn is_all_day(iso: &str) -> bool {
    !iso.contains('T')
}

/// Parses a Pikos ISO string (date-only or datetime, seconds optional) into a
/// naive wall-clock datetime. All-day strings parse as local midnight.
pub fn parse_naive(iso: &str) -> Option<NaiveDateTime> {
    if is_all_day(iso) {
        let date = NaiveDate::parse_from_str(iso, "%Y-%m-%d").ok()?;
        date.and_hms_opt(0, 0, 0)
    } else {
        NaiveDateTime::parse_from_str(iso, "%Y-%m-%dT%H:%M:%S")
            .or_else(|_| NaiveDateTime::parse_from_str(iso, "%Y-%m-%dT%H:%M"))
            .ok()
    }
}

/// Formats a naive datetime as 'YYYY-MM-DDTHH:MM:SS'.
pub fn format_datetime(dt: NaiveDateTime) -> String {
    dt.format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// Formats the date part as 'YYYY-MM-DD'.
pub fn format_date(dt: NaiveDateTime) -> String {
    dt.format("%Y-%m-%d").to_string()
}
