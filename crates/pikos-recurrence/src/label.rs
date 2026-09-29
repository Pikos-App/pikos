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

/// Ordinal wording shared by BYSETPOS, BYMONTHDAY, and BYDAY ordinals:
/// `3` → "3rd", `-1` → "last", `-2` → "2nd last". Mirrors rrule.js so labels
/// don't shift on the engine swap.
fn ordinal(n: i32) -> String {
    if n == -1 {
        return "last".to_string();
    }
    let abs = n.unsigned_abs();
    let teen = abs % 100 >= 11 && abs % 100 <= 13;
    let suffix = if teen {
        "th"
    } else {
        ["th", "st", "nd", "rd"]
            .get((abs % 10) as usize)
            .copied()
            .unwrap_or("th")
    };
    if n < 0 {
        format!("{abs}{suffix} last")
    } else {
        format!("{abs}{suffix}")
    }
}

/// "June and July", "June, July and August" — rrule.js month-list join.
fn month_list(months: &[u32]) -> Option<String> {
    let names: Vec<&str> = months
        .iter()
        .map(|&m| MONTH_NAMES.get((m as usize).checked_sub(1)?).copied())
        .collect::<Option<_>>()?;
    Some(and_join(&names))
}

fn and_join(items: &[&str]) -> String {
    match items {
        [] => String::new(),
        [one] => (*one).to_string(),
        [init @ .., last] => format!("{} and {}", init.join(", "), last),
    }
}

/// "weekday" for MO–FR, "day" for all seven, a name for one, an or-join for the
/// rest — the BYSETPOS day-set wording (`bySetPosLabel` in the historical TS).
fn day_set_phrase(days: &[u8]) -> String {
    let mut sorted = days.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    if sorted.len() == 7 {
        return "day".to_string();
    }
    if sorted == [0, 1, 2, 3, 4] {
        return "weekday".to_string();
    }
    let names: Vec<&str> = sorted
        .iter()
        .filter_map(|&d| WEEKDAY_NAMES.get(d as usize).copied())
        .collect();
    match names.as_slice() {
        [one] => (*one).to_string(),
        [init @ .., last] => format!("{} or {}", init.join(", "), last),
        [] => String::new(),
    }
}

/// Long label like "every week on Monday", phrased the way rrule.js `.toText()`
/// phrased it — plus the BYSETPOS position rrule.js drops (a BYSETPOS cadence
/// must read "the 3rd Friday", not "Friday"). `None` when the rule can't be
/// reduced to the phrased subset — callers fall back to the raw RRULE string.
///
/// One deliberate deviation: interval > 1 with BYMONTH reads "every 2 years in
/// March" where rrule.js emitted the broken "every 2 years March".
pub fn rrule_to_label(rrule: &str) -> Option<String> {
    let rule = crate::rule::ParsedRule::parse(rrule).ok()?;
    let plural = rule.interval != 1;

    // BYSETPOS without a BYDAY set has no honest phrasing (dropping it would
    // misstate the cadence — the hazard this label exists to avoid).
    if !rule.bysetpos.is_empty() && rule.byday.is_empty() {
        return None;
    }
    // DAILY with both filters stacked has no established wording.
    if rule.freq == Freq::Daily && !rule.byday.is_empty() && !rule.bymonthday.is_empty() {
        return None;
    }
    // A BYDAY∩BYMONTHDAY intersection ("Friday the 13th") has no established
    // wording either.
    if rule.freq != Freq::Daily && !rule.byday.is_empty() && !rule.bymonthday.is_empty() {
        return None;
    }

    let is_weekdays = rule.freq == Freq::Weekly && {
        let mut sorted: Vec<u8> = rule.byday.iter().map(|b| b.weekday).collect();
        sorted.sort_unstable();
        sorted.dedup();
        sorted == [0, 1, 2, 3, 4]
    };

    // Base: "every [N] <unit>" — except a month-scoped MONTHLY/YEARLY at
    // interval 1, which reads "every January and July".
    let mut out = "every".to_string();
    let month_scoped =
        !rule.bymonth.is_empty() && matches!(rule.freq, Freq::Monthly | Freq::Yearly) && !plural;
    if month_scoped {
        out.push(' ');
        out.push_str(&month_list(&rule.bymonth)?);
    } else {
        if plural {
            out.push_str(&format!(" {}", rule.interval));
        }
        let unit = match (rule.freq, plural) {
            (Freq::Daily, false) => "day",
            (Freq::Daily, true) => "days",
            (Freq::Weekly, false) => {
                if is_weekdays {
                    "weekday"
                } else {
                    "week"
                }
            }
            (Freq::Weekly, true) => "weeks",
            (Freq::Monthly, false) => "month",
            (Freq::Monthly, true) => "months",
            (Freq::Yearly, false) => "year",
            (Freq::Yearly, true) => "years",
        };
        out.push(' ');
        out.push_str(unit);
        // DAILY/WEEKLY month scope, and the interval>1 deviation: "in June and July".
        if !rule.bymonth.is_empty() {
            out.push_str(&format!(" in {}", month_list(&rule.bymonth)?));
        }
    }

    // Day clause.
    if !rule.bysetpos.is_empty() {
        let positions: Vec<String> = rule.bysetpos.iter().map(|&p| ordinal(p)).collect();
        let days: Vec<u8> = rule.byday.iter().map(|b| b.weekday).collect();
        out.push_str(&format!(
            " on the {} {}",
            positions.join(" or "),
            day_set_phrase(&days)
        ));
    } else if !rule.byday.is_empty() {
        if rule.freq == Freq::Weekly || rule.freq == Freq::Daily {
            if is_weekdays && !plural {
                // "every weekday" already says it all.
            } else if is_weekdays {
                out.push_str(" on weekdays");
            } else {
                // Weekly/daily BYDAY carries no meaningful ordinals.
                let mut sorted: Vec<u8> = rule.byday.iter().map(|b| b.weekday).collect();
                sorted.sort_unstable();
                sorted.dedup();
                let names: Vec<&str> = sorted
                    .iter()
                    .filter_map(|&d| WEEKDAY_NAMES.get(d as usize).copied())
                    .collect();
                out.push_str(&format!(" on {}", names.join(", ")));
            }
        } else {
            // MONTHLY/YEARLY: "on Monday and on the 2nd Wednesday".
            let terms: Vec<String> = rule
                .byday
                .iter()
                .map(|b| {
                    let name = WEEKDAY_NAMES.get(b.weekday as usize).copied().unwrap_or("");
                    match b.ordinal {
                        Some(n) => format!("the {} {}", ordinal(n), name),
                        None => name.to_string(),
                    }
                })
                .collect();
            out.push_str(&format!(" on {}", terms.join(" and on ")));
        }
    } else if !rule.bymonthday.is_empty() {
        let terms: Vec<String> = rule.bymonthday.iter().map(|&d| ordinal(d)).collect();
        let refs: Vec<&str> = terms.iter().map(String::as_str).collect();
        out.push_str(&format!(" on the {}", and_join(&refs)));
    }

    if let Some(count) = rule.count {
        out.push_str(&format!(
            " for {count} {}",
            if count == 1 { "time" } else { "times" }
        ));
    } else if let Some(until) = rule.until {
        out.push_str(&format!(
            " until {} {}, {}",
            MONTH_NAMES[(until.month() - 1) as usize],
            until.day(),
            until.year()
        ));
    }

    Some(out)
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
