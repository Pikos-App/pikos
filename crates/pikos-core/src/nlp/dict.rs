//! Vocabulary and the regex fragments built from it.
//!
//! The word lists are chrono-node's, kept in its order because
//! `match_any_pattern` sorts by length descending so that "september" wins over
//! "sep" — an alternation in the wrong order silently truncates matches.
//!
//! Character classes are spelled out (`[0-9]` rather than `\d`) because
//! JavaScript's are ASCII-only and Rust's are Unicode by default; a Devanagari
//! digit matching `\d` here but not in the reference would be a parity bug
//! nobody would think to look for.

use std::collections::HashMap;
use std::sync::OnceLock;

use super::components::Duration;

pub fn weekday_dictionary() -> &'static [(&'static str, i64)] {
    &[
        ("sunday", 0),
        ("sun", 0),
        ("sun.", 0),
        ("monday", 1),
        ("mon", 1),
        ("mon.", 1),
        ("tuesday", 2),
        ("tue", 2),
        ("tue.", 2),
        ("wednesday", 3),
        ("wed", 3),
        ("wed.", 3),
        ("thursday", 4),
        ("thurs", 4),
        ("thurs.", 4),
        ("thur", 4),
        ("thur.", 4),
        ("thu", 4),
        ("thu.", 4),
        ("friday", 5),
        ("fri", 5),
        ("fri.", 5),
        ("saturday", 6),
        ("sat", 6),
        ("sat.", 6),
    ]
}

pub fn full_month_name_dictionary() -> &'static [(&'static str, i64)] {
    &[
        ("january", 1),
        ("february", 2),
        ("march", 3),
        ("april", 4),
        ("may", 5),
        ("june", 6),
        ("july", 7),
        ("august", 8),
        ("september", 9),
        ("october", 10),
        ("november", 11),
        ("december", 12),
    ]
}

pub fn month_dictionary() -> &'static [(&'static str, i64)] {
    &[
        ("january", 1),
        ("february", 2),
        ("march", 3),
        ("april", 4),
        ("may", 5),
        ("june", 6),
        ("july", 7),
        ("august", 8),
        ("september", 9),
        ("october", 10),
        ("november", 11),
        ("december", 12),
        ("jan", 1),
        ("jan.", 1),
        ("feb", 2),
        ("feb.", 2),
        ("mar", 3),
        ("mar.", 3),
        ("apr", 4),
        ("apr.", 4),
        ("jun", 6),
        ("jun.", 6),
        ("jul", 7),
        ("jul.", 7),
        ("aug", 8),
        ("aug.", 8),
        ("sep", 9),
        ("sep.", 9),
        ("sept", 9),
        ("sept.", 9),
        ("oct", 10),
        ("oct.", 10),
        ("nov", 11),
        ("nov.", 11),
        ("dec", 12),
        ("dec.", 12),
    ]
}

pub fn integer_word_dictionary() -> &'static [(&'static str, i64)] {
    &[
        ("one", 1),
        ("two", 2),
        ("three", 3),
        ("four", 4),
        ("five", 5),
        ("six", 6),
        ("seven", 7),
        ("eight", 8),
        ("nine", 9),
        ("ten", 10),
        ("eleven", 11),
        ("twelve", 12),
    ]
}

pub fn ordinal_word_dictionary() -> &'static [(&'static str, i64)] {
    &[
        ("first", 1),
        ("second", 2),
        ("third", 3),
        ("fourth", 4),
        ("fifth", 5),
        ("sixth", 6),
        ("seventh", 7),
        ("eighth", 8),
        ("ninth", 9),
        ("tenth", 10),
        ("eleventh", 11),
        ("twelfth", 12),
        ("thirteenth", 13),
        ("fourteenth", 14),
        ("fifteenth", 15),
        ("sixteenth", 16),
        ("seventeenth", 17),
        ("eighteenth", 18),
        ("nineteenth", 19),
        ("twentieth", 20),
        ("twenty first", 21),
        ("twenty-first", 21),
        ("twenty second", 22),
        ("twenty-second", 22),
        ("twenty third", 23),
        ("twenty-third", 23),
        ("twenty fourth", 24),
        ("twenty-fourth", 24),
        ("twenty fifth", 25),
        ("twenty-fifth", 25),
        ("twenty sixth", 26),
        ("twenty-sixth", 26),
        ("twenty seventh", 27),
        ("twenty-seventh", 27),
        ("twenty eighth", 28),
        ("twenty-eighth", 28),
        ("twenty ninth", 29),
        ("twenty-ninth", 29),
        ("thirtieth", 30),
        ("thirty first", 31),
        ("thirty-first", 31),
    ]
}

/// Time units, in chrono-node's order — abbreviations after the full words so
/// the length sort is the only thing deciding alternation order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Timeunit {
    Second,
    Minute,
    Hour,
    Day,
    Week,
    Month,
    Quarter,
    Year,
}

/// Used only by the strict configuration's patterns, which this port keeps so
/// the two pattern builders stay a matched pair.
#[allow(dead_code)]
pub fn time_unit_dictionary_no_abbr() -> &'static [(&'static str, Timeunit)] {
    &[
        ("second", Timeunit::Second),
        ("seconds", Timeunit::Second),
        ("minute", Timeunit::Minute),
        ("minutes", Timeunit::Minute),
        ("hour", Timeunit::Hour),
        ("hours", Timeunit::Hour),
        ("day", Timeunit::Day),
        ("days", Timeunit::Day),
        ("week", Timeunit::Week),
        ("weeks", Timeunit::Week),
        ("month", Timeunit::Month),
        ("months", Timeunit::Month),
        ("quarter", Timeunit::Quarter),
        ("quarters", Timeunit::Quarter),
        ("year", Timeunit::Year),
        ("years", Timeunit::Year),
    ]
}

pub fn time_unit_dictionary() -> &'static [(&'static str, Timeunit)] {
    &[
        ("s", Timeunit::Second),
        ("sec", Timeunit::Second),
        ("second", Timeunit::Second),
        ("seconds", Timeunit::Second),
        ("m", Timeunit::Minute),
        ("min", Timeunit::Minute),
        ("mins", Timeunit::Minute),
        ("minute", Timeunit::Minute),
        ("minutes", Timeunit::Minute),
        ("h", Timeunit::Hour),
        ("hr", Timeunit::Hour),
        ("hrs", Timeunit::Hour),
        ("hour", Timeunit::Hour),
        ("hours", Timeunit::Hour),
        ("d", Timeunit::Day),
        ("day", Timeunit::Day),
        ("days", Timeunit::Day),
        ("w", Timeunit::Week),
        ("week", Timeunit::Week),
        ("weeks", Timeunit::Week),
        ("mo", Timeunit::Month),
        ("mon", Timeunit::Month),
        ("mos", Timeunit::Month),
        ("month", Timeunit::Month),
        ("months", Timeunit::Month),
        ("qtr", Timeunit::Quarter),
        ("quarter", Timeunit::Quarter),
        ("quarters", Timeunit::Quarter),
        ("y", Timeunit::Year),
        ("yr", Timeunit::Year),
        ("year", Timeunit::Year),
        ("years", Timeunit::Year),
    ]
}

/// An alternation over a word list, longest first — so "september" is tried
/// before "sep" and the match covers the whole word.
pub fn match_any_pattern<T: Copy>(dictionary: &[(&str, T)]) -> String {
    let mut terms: Vec<&str> = dictionary.iter().map(|(word, _)| *word).collect();
    // A stable sort by descending length reproduces JS's sort, which is
    // stable too: equal-length terms keep dictionary order.
    terms.sort_by_key(|term| std::cmp::Reverse(term.len()));
    let joined = terms
        .iter()
        .map(|term| term.replace('.', "\\."))
        .collect::<Vec<_>>()
        .join("|");
    format!("(?:{joined})")
}

fn lookup<T: Copy>(dictionary: &'static [(&'static str, T)], word: &str) -> Option<T> {
    let lowered = word.to_lowercase();
    dictionary
        .iter()
        .find(|(candidate, _)| *candidate == lowered)
        .map(|(_, value)| *value)
}

pub fn month_of(word: &str) -> Option<i64> {
    lookup(month_dictionary(), word)
}

pub fn full_month_of(word: &str) -> Option<i64> {
    lookup(full_month_name_dictionary(), word)
}

pub fn weekday_of(word: &str) -> Option<i64> {
    lookup(weekday_dictionary(), word)
}

pub fn timeunit_of(word: &str) -> Option<Timeunit> {
    lookup(time_unit_dictionary(), word)
}

pub fn number_pattern() -> &'static str {
    static PATTERN: OnceLock<String> = OnceLock::new();
    PATTERN.get_or_init(|| {
        format!(
            "(?:{}|[0-9]+|[0-9]+\\.[0-9]+|half(?:\\s{{0,2}}an?)?|an?\\b(?:\\s{{0,2}}few)?|few|several|the|a?\\s{{0,2}}couple\\s{{0,2}}(?:of)?)",
            match_any_pattern(integer_word_dictionary())
        )
    })
}

pub fn parse_number_pattern(text: &str) -> Option<f64> {
    let lowered = text.to_lowercase();
    if let Some(value) = lookup(integer_word_dictionary(), &lowered) {
        return Some(value as f64);
    }
    if lowered == "a" || lowered == "an" || lowered == "the" {
        return Some(1.0);
    }
    if lowered.contains("few") {
        return Some(3.0);
    }
    if lowered.contains("half") {
        return Some(0.5);
    }
    if lowered.contains("couple") {
        return Some(2.0);
    }
    if lowered.contains("several") {
        return Some(7.0);
    }
    // JS `parseFloat` reads a leading numeric prefix and ignores the rest;
    // Rust's `parse` rejects trailing characters, so take the prefix first.
    let end = lowered
        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '+' || c == '-'))
        .unwrap_or(lowered.len());
    lowered[..end].parse::<f64>().ok()
}

pub fn ordinal_number_pattern() -> &'static str {
    static PATTERN: OnceLock<String> = OnceLock::new();
    PATTERN.get_or_init(|| {
        format!(
            "(?:{}|[0-9]{{1,2}}(?:st|nd|rd|th)?)",
            match_any_pattern(ordinal_word_dictionary())
        )
    })
}

pub fn parse_ordinal_number_pattern(text: &str) -> Option<i64> {
    let lowered = text.to_lowercase();
    if let Some(value) = lookup(ordinal_word_dictionary(), &lowered) {
        return Some(value);
    }
    let trimmed = ["st", "nd", "rd", "th"]
        .iter()
        .find_map(|suffix| lowered.strip_suffix(suffix))
        .unwrap_or(&lowered);
    trimmed.parse::<i64>().ok()
}

pub const YEAR_PATTERN: &str =
    "(?:[1-9][0-9]{0,3}\\s{0,2}(?:BE|AD|BC|BCE|CE)|[1-2][0-9]{3}|[5-9][0-9]|2[0-5])";

/// Turn a two-digit year into the century it most likely meant: 97 is 1997,
/// 12 is 2012.
pub fn find_most_likely_ad_year(year: i64) -> i64 {
    if year < 100 {
        if year > 50 {
            return year + 1900;
        }
        return year + 2000;
    }
    year
}

pub fn parse_year(text: &str) -> Option<i64> {
    let upper = text.to_uppercase();
    let digits = |s: &str| -> Option<i64> {
        let filtered: String = s.chars().filter(|c| c.is_ascii_digit()).collect();
        filtered.parse::<i64>().ok()
    };
    if upper.contains("BE") {
        // Buddhist Era.
        return Some(digits(&upper)? - 543);
    }
    if upper.contains("BC") {
        return Some(-digits(&upper)?);
    }
    if upper.contains("AD") || upper.contains("CE") {
        return digits(&upper);
    }
    Some(find_most_likely_ad_year(digits(&upper)?))
}

fn single_time_unit_pattern(units: &[(&str, Timeunit)]) -> String {
    format!(
        "({})\\s{{0,3}}({})",
        number_pattern(),
        match_any_pattern(units)
    )
}

/// One or more "<number> <unit>" fragments joined by commas or "and", with the
/// inner capture groups stripped — the outer parser captures the whole run and
/// re-scans it, so nested groups would shift every index after it.
fn repeated_timeunit_pattern(prefix: &str, single: &str, connector: &str) -> String {
    let no_capture = strip_capture_groups(single);
    format!("{prefix}{no_capture}(?:{connector}{no_capture}){{0,10}}")
}

/// Turn every capturing `(` into `(?:`, leaving `(?:`, `(?=`, `(?!` alone.
fn strip_capture_groups(pattern: &str) -> String {
    let mut out = String::with_capacity(pattern.len());
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '(' && chars.peek() != Some(&'?') {
            out.push_str("(?:");
        } else {
            out.push(c);
        }
    }
    out
}

const TIME_UNIT_CONNECTOR_PATTERN: &str = "\\s{0,5},?(?:\\s*and)?\\s{0,5}";

pub fn time_units_pattern() -> &'static str {
    static PATTERN: OnceLock<String> = OnceLock::new();
    PATTERN.get_or_init(|| {
        repeated_timeunit_pattern(
            "(?:(?:about|around)\\s{0,3})?",
            &single_time_unit_pattern(time_unit_dictionary()),
            TIME_UNIT_CONNECTOR_PATTERN,
        )
    })
}

#[allow(dead_code)]
pub fn time_units_no_abbr_pattern() -> &'static str {
    static PATTERN: OnceLock<String> = OnceLock::new();
    PATTERN.get_or_init(|| {
        repeated_timeunit_pattern(
            "(?:(?:about|around)\\s{0,3})?",
            &single_time_unit_pattern(time_unit_dictionary_no_abbr()),
            TIME_UNIT_CONNECTOR_PATTERN,
        )
    })
}

fn single_time_unit_regex() -> &'static fancy_regex::Regex {
    static REGEX: OnceLock<fancy_regex::Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        fancy_regex::Regex::new(&format!(
            "(?i){}",
            single_time_unit_pattern(time_unit_dictionary())
        ))
        .expect("static pattern")
    })
}

/// Read a run of "<number> <unit>" fragments into a duration. A later fragment
/// naming the same unit replaces the earlier one, matching the reference.
pub fn parse_duration(text: &str) -> Option<Duration> {
    let mut fragments: HashMap<&'static str, f64> = HashMap::new();
    let mut remaining = text.to_string();
    while let Ok(Some(captures)) = single_time_unit_regex().captures(&remaining) {
        let whole = captures.get(0).expect("group 0").as_str().to_string();
        // A bare word with no number ("day") carries no duration.
        if whole.is_empty() || !whole.chars().all(|c| c.is_ascii_alphabetic()) {
            let number = captures
                .get(1)
                .and_then(|m| parse_number_pattern(m.as_str()));
            let unit = captures.get(2).and_then(|m| timeunit_of(m.as_str()));
            if let (Some(number), Some(unit)) = (number, unit) {
                fragments.insert(unit_key(unit), number);
            }
        }
        // The reference drops the match's *length* from the front of the
        // string rather than the match itself, so a leading fragment that did
        // not match is consumed too. Reproduced deliberately.
        let Some(rest) = split_off_prefix(&remaining, whole.len()) else {
            break;
        };
        remaining = rest.trim().to_string();
    }
    if fragments.is_empty() {
        return None;
    }
    Some(Duration {
        second: fragments.get("second").copied(),
        minute: fragments.get("minute").copied(),
        hour: fragments.get("hour").copied(),
        day: fragments.get("day").copied(),
        week: fragments.get("week").copied(),
        month: fragments.get("month").copied(),
        quarter: fragments.get("quarter").copied(),
        year: fragments.get("year").copied(),
        millisecond: None,
    })
}

/// Drop `len` bytes from the front, rounding up to the next character
/// boundary. `None` when nothing would be consumed, which would spin forever.
fn split_off_prefix(text: &str, len: usize) -> Option<String> {
    if len == 0 {
        return None;
    }
    if len >= text.len() {
        return Some(String::new());
    }
    let mut boundary = len;
    while !text.is_char_boundary(boundary) {
        boundary += 1;
    }
    Some(text[boundary..].to_string())
}

fn unit_key(unit: Timeunit) -> &'static str {
    match unit {
        Timeunit::Second => "second",
        Timeunit::Minute => "minute",
        Timeunit::Hour => "hour",
        Timeunit::Day => "day",
        Timeunit::Week => "week",
        Timeunit::Month => "month",
        Timeunit::Quarter => "quarter",
        Timeunit::Year => "year",
    }
}

/// The year nearest the reference that puts this month and day closest to it —
/// so "may 1" read in March means this May, and read in December means next.
pub fn find_year_closest_to_ref(reference: super::jsdate::JsDate, day: i64, month: i64) -> i64 {
    let Some(base) = reference
        .set_month0(month - 1)
        .and_then(|date| date.set_day(day))
    else {
        return reference.year();
    };
    let distance = |date: super::jsdate::JsDate| {
        (date.naive().and_utc().timestamp_millis() - reference.naive().and_utc().timestamp_millis())
            .abs()
    };
    let next = super::components::add_duration(base, &Duration::years(1.0));
    let last = super::components::add_duration(base, &Duration::years(-1.0));
    if next.is_some_and(|date| distance(date) < distance(base)) {
        return next.expect("checked").year();
    }
    if last.is_some_and(|date| distance(date) < distance(base)) {
        return last.expect("checked").year();
    }
    base.year()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn longer_words_come_first_in_an_alternation() {
        let pattern = match_any_pattern(month_dictionary());
        let september = pattern.find("september").expect("present");
        let sep = pattern.find("|sep|").expect("present");
        assert!(
            september < sep,
            "'sep' would swallow the start of 'september'"
        );
    }

    #[test]
    fn a_dot_in_a_word_is_escaped() {
        assert!(match_any_pattern(month_dictionary()).contains("jan\\."));
    }

    #[test]
    fn two_digit_years_pick_a_century() {
        assert_eq!(find_most_likely_ad_year(97), 1997);
        assert_eq!(find_most_likely_ad_year(12), 2012);
        assert_eq!(find_most_likely_ad_year(50), 2050);
        assert_eq!(find_most_likely_ad_year(51), 1951);
        assert_eq!(find_most_likely_ad_year(1997), 1997);
    }

    #[test]
    fn eras_are_read_off_the_year() {
        assert_eq!(parse_year("2026"), Some(2026));
        assert_eq!(parse_year("2569 BE"), Some(2026));
        assert_eq!(parse_year("500 BC"), Some(-500));
        assert_eq!(parse_year("500 AD"), Some(500));
    }

    #[test]
    fn ordinals_read_as_words_or_digits() {
        assert_eq!(parse_ordinal_number_pattern("24th"), Some(24));
        assert_eq!(parse_ordinal_number_pattern("1st"), Some(1));
        assert_eq!(parse_ordinal_number_pattern("twenty-third"), Some(23));
        assert_eq!(parse_ordinal_number_pattern("7"), Some(7));
    }

    #[test]
    fn vague_quantities_have_fixed_values() {
        assert_eq!(parse_number_pattern("a few"), Some(3.0));
        assert_eq!(parse_number_pattern("half"), Some(0.5));
        assert_eq!(parse_number_pattern("a couple of"), Some(2.0));
        assert_eq!(parse_number_pattern("several"), Some(7.0));
        assert_eq!(parse_number_pattern("three"), Some(3.0));
        assert_eq!(parse_number_pattern("12"), Some(12.0));
    }

    #[test]
    fn a_duration_reads_every_unit_in_the_run() {
        let duration = parse_duration("3 days").expect("matched");
        assert_eq!(duration.day, Some(3.0));
        assert_eq!(duration.hour, None);

        let compound = parse_duration("2 weeks and 3 days").expect("matched");
        assert_eq!((compound.week, compound.day), (Some(2.0), Some(3.0)));
    }

    #[test]
    fn a_bare_unit_with_no_number_is_not_a_duration() {
        assert_eq!(parse_duration("days"), None);
    }

    #[test]
    fn the_closest_year_straddles_the_reference() {
        let march = super::super::jsdate::JsDate::from_parts(2026, 2, 15, 12, 0, 0, 0)
            .expect("representable");
        // May is two months ahead — this year.
        assert_eq!(find_year_closest_to_ref(march, 1, 5), 2026);
        // January is ten months ahead but only two behind — last year.
        assert_eq!(find_year_closest_to_ref(march, 1, 1), 2026);

        let december = super::super::jsdate::JsDate::from_parts(2026, 11, 31, 23, 0, 0, 0)
            .expect("representable");
        assert_eq!(find_year_closest_to_ref(december, 1, 1), 2027);
    }
}
