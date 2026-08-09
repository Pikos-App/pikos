//! Typed RRULE options — the simplified subset the Pikos recurrence editor
//! and NL parser produce. Parsing tolerates unknown RRULE parts (they are
//! ignored, matching the historical rrule.js-based `parseRrule`), but building
//! only ever emits the subset.
//!
//! Weekday indexing follows the rrule.js convention used throughout the data
//! model and UI: 0 = Monday … 6 = Sunday.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Freq {
    #[serde(rename = "DAILY")]
    Daily,
    #[serde(rename = "WEEKLY")]
    Weekly,
    #[serde(rename = "MONTHLY")]
    Monthly,
    #[serde(rename = "YEARLY")]
    Yearly,
}

impl Freq {
    fn as_str(self) -> &'static str {
        match self {
            Freq::Daily => "DAILY",
            Freq::Weekly => "WEEKLY",
            Freq::Monthly => "MONTHLY",
            Freq::Yearly => "YEARLY",
        }
    }
}

/// Weekday codes in rrule index order (0 = Monday … 6 = Sunday).
pub const WEEKDAY_CODES: [&str; 7] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecurrenceOptions {
    pub freq: Freq,
    /// Positive integer ≥ 1. Default 1.
    pub interval: u32,
    /// Weekdays for FREQ=WEEKLY (0 = Monday … 6 = Sunday).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byweekday: Option<Vec<u8>>,
    /// End condition — at most one of `count` or `until` is set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
    /// End condition as YYYY-MM-DD (date-only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
}

/// Strips an optional leading "RRULE:" prefix.
pub fn strip_prefix(rrule: &str) -> &str {
    rrule.strip_prefix("RRULE:").unwrap_or(rrule)
}

/// Parses an RRULE string (with or without "RRULE:" prefix) into typed
/// options. Returns None when the string is unparseable or FREQ is missing or
/// unsupported. Unknown parts (BYMONTHDAY, WKST, …) are ignored.
pub fn parse_options(rrule: &str) -> Option<RecurrenceOptions> {
    let body = strip_prefix(rrule.trim());
    if body.is_empty() {
        return None;
    }

    let mut freq: Option<Freq> = None;
    let mut interval: u32 = 1;
    let mut byweekday: Option<Vec<u8>> = None;
    let mut count: Option<u32> = None;
    let mut until: Option<String> = None;

    for part in body.split(';') {
        if part.is_empty() {
            continue;
        }
        let (key, value) = part.split_once('=')?;
        match key.to_ascii_uppercase().as_str() {
            "FREQ" => {
                freq = Some(match value.to_ascii_uppercase().as_str() {
                    "DAILY" => Freq::Daily,
                    "WEEKLY" => Freq::Weekly,
                    "MONTHLY" => Freq::Monthly,
                    "YEARLY" => Freq::Yearly,
                    _ => return None,
                });
            }
            "INTERVAL" => {
                interval = value.parse::<u32>().ok()?.max(1);
            }
            "BYDAY" => {
                // Ordinal prefixes (e.g. "2MO", "-1FR") reduce to the bare
                // weekday — matching the historical behavior of reading only
                // `weekday` off rrule.js Weekday objects. Unknown codes are
                // dropped rather than failing the whole parse.
                let days: Vec<u8> = value
                    .split(',')
                    .filter_map(|d| {
                        let code =
                            d.trim_start_matches(|c: char| c == '+' || c == '-' || c.is_ascii_digit());
                        WEEKDAY_CODES
                            .iter()
                            .position(|c| code.eq_ignore_ascii_case(c))
                            .map(|i| i as u8)
                    })
                    .collect();
                if !days.is_empty() {
                    byweekday = Some(days);
                }
            }
            "COUNT" => {
                count = Some(value.parse::<u32>().ok()?);
            }
            "UNTIL" => {
                // UNTIL is 'YYYYMMDD' or 'YYYYMMDDTHHMMSS[Z]' — reduce to the
                // date part as YYYY-MM-DD.
                let digits = &value[..value.len().min(8)];
                if digits.len() != 8 || !digits.bytes().all(|b| b.is_ascii_digit()) {
                    return None;
                }
                until = Some(format!("{}-{}-{}", &digits[0..4], &digits[4..6], &digits[6..8]));
            }
            _ => {} // tolerated, not represented in the simplified options
        }
    }

    Some(RecurrenceOptions {
        freq: freq?,
        interval,
        byweekday,
        count,
        until,
    })
}

/// Builds an RRULE string (no "RRULE:" prefix, no DTSTART — the anchor lives
/// on the page separately). Field order matches the historical rrule.js
/// serialization: FREQ, INTERVAL (always emitted), BYDAY, COUNT/UNTIL.
/// When both end conditions are set, COUNT wins.
pub fn build_rrule(options: &RecurrenceOptions) -> String {
    let mut out = format!(
        "FREQ={};INTERVAL={}",
        options.freq.as_str(),
        options.interval.max(1)
    );

    if let Some(days) = &options.byweekday {
        if !days.is_empty() {
            let codes: Vec<&str> = days
                .iter()
                .filter_map(|&d| WEEKDAY_CODES.get(d as usize).copied())
                .collect();
            if !codes.is_empty() {
                out.push_str(";BYDAY=");
                out.push_str(&codes.join(","));
            }
        }
    }

    if let Some(count) = options.count {
        out.push_str(&format!(";COUNT={count}"));
    } else if let Some(until) = &options.until {
        // UNTIL is end-of-day so the final occurrence on that date is included.
        let compact: String = until.chars().filter(|c| c.is_ascii_digit()).collect();
        out.push_str(&format!(";UNTIL={compact}T235959Z"));
    }

    out
}
