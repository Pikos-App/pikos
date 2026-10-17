//! Regex plumbing and calendar arithmetic the quick-add parser leans on.
//!
//! `parseInput` is written as a chain of `String.replace(/…/g, callback)` calls
//! that both *extract* something and *remove* it from the text, so what is left
//! at the end is the title. Rust's `replace_all` takes a replacer without side
//! effects, so the extracting form lives here instead.
//!
//! The date arithmetic is `date-fns`, not JavaScript `Date`: `addMonths` on
//! 31 January gives 28 February, where `setMonth` would give 3 March. The date
//! engine's `JsDate` deliberately does the latter, so mixing the two up would
//! be a quiet off-by-a-few-days. Both live here side by side to make the
//! distinction hard to miss.

use chrono::{Datelike, NaiveDateTime, TimeDelta, Timelike};
use fancy_regex::{Captures, Regex};

/// Replace every match, letting the replacement close over mutable state — the
/// extract-and-strip shape every step of `parseInput` is written in.
///
/// Matches are found left to right and never overlap, and the replacement is
/// not rescanned, matching `String.replace` with a global regex.
pub fn replace_all_with(
    text: &str,
    pattern: &Regex,
    mut replacement: impl FnMut(&Captures<'_, str>) -> String,
) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    let mut search_from = 0usize;

    while search_from <= text.len() {
        let Ok(Some(captures)) = pattern.captures(&text[search_from..]) else {
            break;
        };
        let whole = captures.get(0).expect("group 0");
        let start = search_from + whole.start();
        let end = search_from + whole.end();

        out.push_str(&text[cursor..start]);
        out.push_str(&replacement(&captures));
        cursor = end;

        // A zero-width match would otherwise spin on the spot.
        search_from = if end == start { end + 1 } else { end };
        while search_from < text.len() && !text.is_char_boundary(search_from) {
            search_from += 1;
        }
    }

    out.push_str(&text[cursor.min(text.len())..]);
    out
}

/// Compile a case-insensitive pattern. Every pattern in `parseInput` carries
/// the `i` flag except the numeric-priority one, which does not need it.
pub fn compile(source: &str) -> Regex {
    Regex::new(&format!("(?i){source}")).expect("static pattern")
}

pub fn group<'t>(captures: &Captures<'t, str>, index: usize) -> Option<&'t str> {
    captures.get(index).map(|m| m.as_str())
}

// ---------------------------------------------------------------------------
// date-fns arithmetic
// ---------------------------------------------------------------------------

pub fn add_days(date: NaiveDateTime, days: i64) -> Option<NaiveDateTime> {
    date.checked_add_signed(TimeDelta::try_days(days)?)
}

pub fn add_minutes(date: NaiveDateTime, minutes: i64) -> Option<NaiveDateTime> {
    date.checked_add_signed(TimeDelta::try_minutes(minutes)?)
}

pub fn difference_in_minutes(later: NaiveDateTime, earlier: NaiveDateTime) -> i64 {
    // date-fns truncates toward zero; whole minutes are all this ever sees.
    (later - earlier).num_minutes()
}

pub fn days_in_month(date: NaiveDateTime) -> u32 {
    let (year, month) = (date.year(), date.month());
    let (next_year, next_month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    let first = chrono::NaiveDate::from_ymd_opt(year, month, 1).expect("valid month");
    let next_first =
        chrono::NaiveDate::from_ymd_opt(next_year, next_month, 1).expect("valid month");
    (next_first - first).num_days() as u32
}

/// `date-fns.addMonths`: the day is **clamped** to the target month's length,
/// so 31 January plus one month is 28 February. JavaScript's `setMonth` would
/// roll over to 3 March instead — see the module note.
pub fn add_months(date: NaiveDateTime, months: i32) -> Option<NaiveDateTime> {
    let total = date.year() * 12 + date.month0() as i32 + months;
    let year = total.div_euclid(12);
    let month = total.rem_euclid(12) as u32 + 1;
    let first = chrono::NaiveDate::from_ymd_opt(year, month, 1)?;
    let last_day = days_in_month(first.and_time(date.time()));
    let day = date.day().min(last_day);
    chrono::NaiveDate::from_ymd_opt(year, month, day).map(|d| d.and_time(date.time()))
}

/// Replace the day of month and zero the time, as `set(date, { date, hours: 0,
/// … })` does.
pub fn with_day_at_midnight(date: NaiveDateTime, day: u32) -> Option<NaiveDateTime> {
    chrono::NaiveDate::from_ymd_opt(date.year(), date.month(), day)
        .map(|d| d.and_time(chrono::NaiveTime::MIN))
}

pub fn start_of_day(date: NaiveDateTime) -> NaiveDateTime {
    date.date().and_time(chrono::NaiveTime::MIN)
}

/// Replace the time of day, zeroing seconds and below — `set(date, { hours,
/// minutes, seconds: 0, milliseconds: 0 })`.
pub fn with_time(date: NaiveDateTime, hour: u32, minute: u32) -> Option<NaiveDateTime> {
    date.date()
        .and_hms_opt(hour, minute, 0)
        .map(|d| d.with_nanosecond(0).unwrap_or(d))
}

/// `format(date, "MMM d yyyy")` — the form the day-of-month rewrite hands to
/// the date engine. English month abbreviations, which is all date-fns's
/// default locale produces.
pub fn format_month_day_year(date: NaiveDateTime) -> String {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    format!(
        "{} {} {}",
        MONTHS[date.month0() as usize],
        date.day(),
        date.year()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> NaiveDateTime {
        text.parse().expect("valid")
    }

    #[test]
    fn a_replacement_can_collect_as_it_strips() {
        let pattern = compile("#([0-9A-Za-z_]+)");
        let mut tags = Vec::new();
        let stripped = replace_all_with(" call #a and #b ", &pattern, |captures| {
            tags.push(group(captures, 1).unwrap_or_default().to_string());
            " ".to_string()
        });
        assert_eq!(tags, ["a", "b"]);
        assert_eq!(stripped, " call   and   ");
    }

    #[test]
    fn a_replacement_is_not_rescanned() {
        // Replacing "a" with "aa" must not loop forever, and must not re-match
        // what it just wrote.
        let pattern = compile("a");
        assert_eq!(replace_all_with("aba", &pattern, |_| "aa".into()), "aabaa");
    }

    #[test]
    fn a_pattern_that_matches_nothing_leaves_the_text_alone() {
        let pattern = compile("zzz");
        assert_eq!(replace_all_with("hello", &pattern, |_| "!".into()), "hello");
    }

    #[test]
    fn adding_months_clamps_rather_than_rolling_over() {
        // The whole reason this is not JsDate: date-fns clamps.
        assert_eq!(
            add_months(at("2026-01-31T12:00:00"), 1).expect("valid"),
            at("2026-02-28T12:00:00")
        );
        assert_eq!(
            add_months(at("2026-03-31T12:00:00"), 1).expect("valid"),
            at("2026-04-30T12:00:00")
        );
        assert_eq!(
            add_months(at("2026-12-15T12:00:00"), 1).expect("valid"),
            at("2027-01-15T12:00:00")
        );
    }

    #[test]
    fn month_lengths_account_for_leap_years() {
        assert_eq!(days_in_month(at("2024-02-10T00:00:00")), 29);
        assert_eq!(days_in_month(at("2026-02-10T00:00:00")), 28);
        assert_eq!(days_in_month(at("2026-04-10T00:00:00")), 30);
        assert_eq!(days_in_month(at("2026-12-10T00:00:00")), 31);
    }

    #[test]
    fn the_substituted_date_format_is_what_the_engine_reads_back() {
        assert_eq!(
            format_month_day_year(at("2026-03-24T00:00:00")),
            "Mar 24 2026"
        );
        assert_eq!(
            format_month_day_year(at("2026-09-01T00:00:00")),
            "Sep 1 2026"
        );
    }
}
