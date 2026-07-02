//! Compact recurrence labels. Mirrors `rruleToShortLabel` in `recurrence.ts`.
//!
//! Note: the wrapper's `rruleToLabel` (rrule.js `.toText()` natural language) is
//! intentionally NOT ported — it stays in rrule.js for display until the U9 IPC
//! swap, so byte-parity there buys nothing.

use chrono::{Datelike, NaiveDate};

use crate::rule::{parse_rrule, Freq};

const MONTH_ABBR: [&str; 12] =
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// Compact label for space-constrained bylines (e.g. the quick-add dialog).
/// Returns the raw RRULE on parse failure, matching the wrapper's fallback.
pub fn rrule_to_short_label(rrule: &str) -> String {
    let Some(opts) = parse_rrule(rrule) else {
        return rrule.to_string();
    };
    let Some(freq) = opts.freq else {
        return rrule.to_string();
    };
    let base = if opts.interval > 1 {
        format!("Every {} {}", opts.interval, interval_unit(freq))
    } else {
        freq_label(freq).to_string()
    };
    if let Some(count) = opts.count {
        return format!("{base} × {count}");
    }
    if let Some(until) = opts.until.as_deref().and_then(parse_ymd) {
        return format!("{base} thru {} {}", MONTH_ABBR[(until.month() - 1) as usize], until.day());
    }
    base
}

fn freq_label(freq: Freq) -> &'static str {
    match freq {
        Freq::Daily => "Daily",
        Freq::Weekly => "Weekly",
        Freq::Monthly => "Monthly",
        Freq::Yearly => "Yearly",
    }
}

fn interval_unit(freq: Freq) -> &'static str {
    match freq {
        Freq::Daily => "days",
        Freq::Weekly => "weeks",
        Freq::Monthly => "months",
        Freq::Yearly => "years",
    }
}

fn parse_ymd(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}
