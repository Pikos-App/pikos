//! Recurrence labels: the compact byline form (`rruleToShortLabel`) and the
//! long natural-language form (`rruleToLabel`, replacing rrule.js `.toText()`).

use chrono::{Datelike, NaiveDate};

use crate::rule::{parse_rrule, Freq};

const MONTH_ABBR: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const WEEKDAY_NAMES: [&str; 7] = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
];

const MONTH_NAMES: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

/// Long label like "every week on Monday", phrased the way rrule.js `.toText()`
/// phrased it. `None` when the rule can't be reduced to the phrased subset —
/// callers fall back to the raw RRULE string.
pub fn rrule_to_label(rrule: &str) -> Option<String> {
    let opts = parse_rrule(rrule)?;
    let freq = opts.freq?;
    let plural = opts.interval != 1;
    let mut words: Vec<String> = vec!["every".to_string()];
    if plural {
        words.push(opts.interval.to_string());
    }

    // MO–FR reads as "weekday(s)" instead of an enumerated list.
    let is_weekdays = matches!(
        (freq, opts.byweekday.as_deref()),
        (Freq::Weekly, Some(days)) if {
            let mut sorted = days.to_vec();
            sorted.sort_unstable();
            sorted.dedup();
            sorted == [0, 1, 2, 3, 4]
        }
    );

    match freq {
        Freq::Daily => words.push(if plural { "days" } else { "day" }.to_string()),
        Freq::Monthly => words.push(if plural { "months" } else { "month" }.to_string()),
        Freq::Yearly => words.push(if plural { "years" } else { "year" }.to_string()),
        Freq::Weekly => {
            if is_weekdays && !plural {
                words.push("weekday".to_string());
            } else {
                words.push(if plural { "weeks" } else { "week" }.to_string());
                if is_weekdays {
                    words.push("on".to_string());
                    words.push("weekdays".to_string());
                } else if let Some(days) = &opts.byweekday {
                    let names: Vec<&str> = days
                        .iter()
                        .filter_map(|&d| WEEKDAY_NAMES.get(d as usize).copied())
                        .collect();
                    if !names.is_empty() {
                        words.push("on".to_string());
                        words.push(names.join(", "));
                    }
                }
            }
        }
    }

    if let Some(count) = opts.count {
        words.push("for".to_string());
        words.push(count.to_string());
        words.push(if count == 1 { "time" } else { "times" }.to_string());
    } else if let Some(until) = opts.until.as_deref().and_then(parse_ymd) {
        words.push("until".to_string());
        words.push(format!(
            "{} {}, {}",
            MONTH_NAMES[(until.month() - 1) as usize],
            until.day(),
            until.year()
        ));
    }

    Some(words.join(" "))
}

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
        return format!(
            "{base} thru {} {}",
            MONTH_ABBR[(until.month() - 1) as usize],
            until.day()
        );
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
