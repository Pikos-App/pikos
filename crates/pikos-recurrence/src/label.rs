//! Human-readable rule labels — a faithful port of rrule.js `toText()` for
//! the subset of RRULE parts Pikos produces (FREQ / INTERVAL / BYDAY / COUNT
//! / UNTIL). Callers fall back to the raw RRULE string when a rule can't be
//! parsed, matching the historical behavior.

use crate::options::{parse_options, Freq, RecurrenceOptions};

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

/// Converts an RRULE string to a label like "every week on Monday". Returns
/// None when the rule can't be reduced to the supported subset.
pub fn rrule_to_label(rrule: &str) -> Option<String> {
    let opts = parse_options(rrule)?;
    Some(label_for(&opts))
}

fn label_for(opts: &RecurrenceOptions) -> String {
    let plural = opts.interval != 1;
    let mut words: Vec<String> = vec!["every".to_string()];
    if plural {
        words.push(opts.interval.to_string());
    }

    // MO–FR reads as "weekday(s)" instead of an enumerated list.
    let is_weekdays = matches!(
        (opts.freq, opts.byweekday.as_deref()),
        (Freq::Weekly, Some(days)) if {
            let mut sorted = days.to_vec();
            sorted.sort_unstable();
            sorted.dedup();
            sorted == [0, 1, 2, 3, 4]
        }
    );

    match opts.freq {
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
    } else if let Some(until) = &opts.until {
        // until is YYYY-MM-DD; render as "June 28, 2026".
        let parts: Vec<&str> = until.split('-').collect();
        if let [y, m, d] = parts.as_slice() {
            if let (Ok(month), Ok(day)) = (m.parse::<usize>(), d.parse::<u32>()) {
                if (1..=12).contains(&month) {
                    words.push("until".to_string());
                    words.push(format!("{} {day}, {y}", MONTH_NAMES[month - 1]));
                }
            }
        }
    }

    words.join(" ")
}
