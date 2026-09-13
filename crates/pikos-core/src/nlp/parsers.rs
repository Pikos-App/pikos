//! The pattern families, one parser each.
//!
//! Each parser recognises one way of writing a date and fills in the fields
//! that way of writing settles. Nothing here decides between them: parsers all
//! run, all claim whatever they match, and the refiners sort it out. That is
//! why "april 18 at 3pm" works without a parser that knows about both — the
//! month-day parser claims "april 18", the time parser claims "3pm", and a
//! refiner merges them.
//!
//! Ported from chrono-node's `en` locale (MIT, Wanasit Tanakitrungruang).

use std::sync::OnceLock;

use fancy_regex::Regex;

use super::components::{
    meridiem_of, Component, Duration, ParsingComponents, ParsingResult, Reference, MERIDIEM_AM,
    MERIDIEM_PM,
};
use super::dict::{
    find_year_closest_to_ref, match_any_pattern, month_dictionary, month_of,
    ordinal_number_pattern, parse_duration, parse_ordinal_number_pattern, parse_year,
    time_unit_dictionary, time_units_pattern, weekday_dictionary, weekday_of, YEAR_PATTERN,
};
use super::engine::{extract_bounded, with_left_boundary, Context, Extracted, MatchData, Parser};
use super::jsdate::JsDate;

/// Case-insensitive by default: every pattern in the reference carries the `i`
/// flag.
fn compile(source: &str) -> Regex {
    Regex::new(&format!("(?i){source}")).expect("static pattern")
}

fn matches(pattern: &str, text: &str) -> bool {
    Regex::new(pattern)
        .expect("static pattern")
        .is_match(text)
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Casual references — the fixed points "today", "noon" and friends resolve to.
// ---------------------------------------------------------------------------

fn reference_now(reference: Reference) -> ParsingComponents {
    let mut components = ParsingComponents::new(reference);
    components.assign_similar_date(reference.instant);
    components.assign_similar_time(reference.instant);
    components
}

fn reference_today(reference: Reference) -> ParsingComponents {
    let mut components = ParsingComponents::new(reference);
    components.assign_similar_date(reference.instant);
    components.imply_similar_time(reference.instant);
    // The meridiem is dropped so a time merged in later ("today at 6") is free
    // to decide morning or evening for itself.
    components.delete(Component::Meridiem);
    components
}

fn reference_day_after(reference: Reference, days: i64) -> Option<ParsingComponents> {
    let target = reference.instant.add_days(days)?;
    let mut components = ParsingComponents::new(reference);
    components.assign_similar_date(target);
    components.imply_similar_time(target);
    components.delete(Component::Meridiem);
    Some(components)
}

fn reference_tonight(reference: Reference) -> ParsingComponents {
    let mut components = ParsingComponents::new(reference);
    components.assign_similar_date(reference.instant);
    components.imply(Component::Hour, 22);
    components.imply(Component::Meridiem, MERIDIEM_PM);
    components
}

fn reference_evening(reference: Reference) -> ParsingComponents {
    let mut components = ParsingComponents::new(reference);
    components.imply(Component::Meridiem, MERIDIEM_PM);
    components.imply(Component::Hour, 20);
    components.imply(Component::Minute, 0);
    components.imply(Component::Second, 0);
    components.imply(Component::Millisecond, 0);
    components
}

fn reference_morning(reference: Reference) -> ParsingComponents {
    let mut components = ParsingComponents::new(reference);
    components.imply(Component::Meridiem, MERIDIEM_AM);
    components.imply(Component::Hour, 6);
    components.imply(Component::Minute, 0);
    components.imply(Component::Second, 0);
    components.imply(Component::Millisecond, 0);
    components
}

fn reference_afternoon(reference: Reference) -> ParsingComponents {
    let mut components = ParsingComponents::new(reference);
    components.imply(Component::Meridiem, MERIDIEM_PM);
    components.imply(Component::Hour, 15);
    components.imply(Component::Minute, 0);
    components.imply(Component::Second, 0);
    components.imply(Component::Millisecond, 0);
    components
}

fn reference_noon(reference: Reference) -> ParsingComponents {
    let mut components = ParsingComponents::new(reference);
    components.imply(Component::Meridiem, MERIDIEM_AM);
    components.assign(Component::Hour, 12);
    components.imply(Component::Minute, 0);
    components.imply(Component::Second, 0);
    components.imply(Component::Millisecond, 0);
    components
}

fn reference_midnight(reference: Reference) -> Option<ParsingComponents> {
    let mut components = ParsingComponents::new(reference);
    if reference.instant.hour() > 2 {
        // Past the small hours, "midnight" means the coming one.
        components.add_duration_as_implied(&Duration::days(1.0))?;
    }
    components.assign(Component::Hour, 0);
    components.imply(Component::Minute, 0);
    components.imply(Component::Second, 0);
    components.imply(Component::Millisecond, 0);
    Some(components)
}

/// Components at a weekday relative to the reference. The weekday is what the
/// text said; the calendar date it lands on is implied, which is what lets a
/// later refiner move it forward without contradicting the user.
fn components_at_weekday(
    reference: Reference,
    weekday: i64,
    modifier: Option<&str>,
) -> Option<ParsingComponents> {
    let days = days_to_weekday(reference.instant, weekday, modifier);
    let mut components = ParsingComponents::new(reference);
    components.add_duration_as_implied(&Duration::days(days as f64))?;
    components.assign(Component::Weekday, weekday);
    Some(components)
}

fn days_forward_to_weekday(reference: JsDate, weekday: i64) -> i64 {
    let mut forward = weekday - reference.weekday();
    if forward < 0 {
        forward += 7;
    }
    forward
}

fn days_backward_to_weekday(reference: JsDate, weekday: i64) -> i64 {
    let mut backward = weekday - reference.weekday();
    if backward >= 0 {
        backward -= 7;
    }
    backward
}

fn days_to_weekday(reference: JsDate, weekday: i64, modifier: Option<&str>) -> i64 {
    const SUNDAY: i64 = 0;
    const SATURDAY: i64 = 6;
    let ref_weekday = reference.weekday();
    match modifier {
        Some("this") => days_forward_to_weekday(reference, weekday),
        Some("last") => days_backward_to_weekday(reference, weekday),
        Some("next") => {
            if ref_weekday == SUNDAY {
                return if weekday == SUNDAY { 7 } else { weekday };
            }
            if ref_weekday == SATURDAY {
                if weekday == SATURDAY {
                    return 7;
                }
                if weekday == SUNDAY {
                    return 8;
                }
                return 1 + weekday;
            }
            if weekday < ref_weekday && weekday != SUNDAY {
                days_forward_to_weekday(reference, weekday)
            } else {
                days_forward_to_weekday(reference, weekday) + 7
            }
        }
        _ => {
            // Closest in either direction, ties going backward.
            let backward = days_backward_to_weekday(reference, weekday);
            let forward = days_forward_to_weekday(reference, weekday);
            if forward < -backward {
                forward
            } else {
                backward
            }
        }
    }
}

// ---------------------------------------------------------------------------
// ISO 8601: 2026-03-08, optionally with a time.
// ---------------------------------------------------------------------------

pub struct IsoFormatParser;

impl Parser for IsoFormatParser {
    fn pattern(&self, _context: &Context) -> &'static Regex {
        static PATTERN: OnceLock<Regex> = OnceLock::new();
        PATTERN.get_or_init(|| {
            compile(&with_left_boundary(concat!(
                "([0-9]{4})\\-([0-9]{1,2})\\-([0-9]{1,2})",
                "(?:T([0-9]{1,2}):([0-9]{1,2})",
                "(?::([0-9]{1,2})(?:\\.([0-9]{1,4}))?)?",
                "(Z|([+-][0-9]{2}):?([0-9]{2})?)?",
                ")?",
                "(?=[^0-9A-Za-z_]|$)"
            )))
        })
    }

    fn extract(&self, context: &Context, matched: &mut MatchData) -> Extracted {
        extract_bounded(context, matched, |context, m| {
            let Some(year) = m.group(1).and_then(|g| g.parse::<i64>().ok()) else {
                return Extracted::None;
            };
            let Some(month) = m.group(2).and_then(|g| g.parse::<i64>().ok()) else {
                return Extracted::None;
            };
            let Some(day) = m.group(3).and_then(|g| g.parse::<i64>().ok()) else {
                return Extracted::None;
            };
            let mut components = ParsingComponents::new(context.reference);
            components.assign(Component::Year, year);
            components.assign(Component::Month, month);
            components.assign(Component::Day, day);

            if let Some(hour) = m.group(4).and_then(|g| g.parse::<i64>().ok()) {
                components.assign(Component::Hour, hour);
                if let Some(minute) = m.group(5).and_then(|g| g.parse::<i64>().ok()) {
                    components.assign(Component::Minute, minute);
                }
                if let Some(second) = m.group(6).and_then(|g| g.parse::<i64>().ok()) {
                    components.assign(Component::Second, second);
                }
                if let Some(ms) = m.group(7).and_then(|g| g.parse::<i64>().ok()) {
                    components.assign(Component::Millisecond, ms);
                }
                // The trailing timezone designator is matched so it lands
                // inside the claimed span, but not applied — see `nlp`'s note
                // on why this engine has no timezone concept.
            }
            Extracted::components(components)
        })
    }
}

// ---------------------------------------------------------------------------
// Slashed numbers: 3/16, 7/12/2020.
// ---------------------------------------------------------------------------

pub struct SlashDateFormatParser;

impl Parser for SlashDateFormatParser {
    fn pattern(&self, _context: &Context) -> &'static Regex {
        static PATTERN: OnceLock<Regex> = OnceLock::new();
        PATTERN.get_or_init(|| {
            compile(concat!(
                "([^0-9]|^)",
                "([0-3]{0,1}[0-9]{1})[\\/\\.\\-]([0-3]{0,1}[0-9]{1})",
                "(?:[\\/\\.\\-]([0-9]{4}|[0-9]{2}))?",
                "([^0-9A-Za-z_]|$)"
            ))
        })
    }

    fn extract(&self, context: &Context, m: &mut MatchData) -> Extracted {
        let opening = m.group(1).unwrap_or_default().len();
        let ending = m.group(5).unwrap_or_default().len();
        let index = m.index + opening;
        let index_end = m.index + m.whole().len() - ending;

        // The pattern runs against the remaining text, so the character before
        // the match can still be a digit — "1[2/3/45]". Reject those.
        if index > 0 && matches("[0-9]/?$", &context.text[..index]) {
            return Extracted::None;
        }
        if index_end < context.text.len() && matches("^/?[0-9]", &context.text[index_end..]) {
            return Extracted::None;
        }

        let text = &context.text[index..index_end];
        // "1.12" and "1.12.12" read as version numbers far more often.
        if matches("^[0-9]\\.[0-9]$", text)
            || matches("^[0-9]\\.[0-9]{1,2}\\.[0-9]{1,2}\\s*$", text)
        {
            return Extracted::None;
        }
        // Without a year, only slashes are a date: "11.5" is not 11 May.
        if m.group(4).is_none() && !text.contains('/') {
            return Extracted::None;
        }

        let Some(mut month) = m.group(2).and_then(|g| g.parse::<i64>().ok()) else {
            return Extracted::None;
        };
        let Some(mut day) = m.group(3).and_then(|g| g.parse::<i64>().ok()) else {
            return Extracted::None;
        };
        if month > 12 {
            if (1..=12).contains(&day) && month <= 31 {
                std::mem::swap(&mut day, &mut month);
            } else {
                return Extracted::None;
            }
        }
        if month < 1 || !(1..=31).contains(&day) {
            return Extracted::None;
        }

        let mut components = ParsingComponents::new(context.reference);
        components.assign(Component::Day, day);
        components.assign(Component::Month, month);
        match m.group(4).and_then(|g| g.parse::<i64>().ok()) {
            Some(raw) => {
                components.assign(Component::Year, super::dict::find_most_likely_ad_year(raw));
            }
            None => {
                let year = find_year_closest_to_ref(context.reference.instant, day, month);
                components.imply(Component::Year, year);
            }
        }
        Extracted::result(ParsingResult::new(index, text.to_string(), components))
    }
}

// ---------------------------------------------------------------------------
// Year-first numbers: 2026/03/08. Distinct from ISO in accepting a month name.
// ---------------------------------------------------------------------------

pub struct YearMonthDayParser;

impl Parser for YearMonthDayParser {
    fn pattern(&self, _context: &Context) -> &'static Regex {
        static PATTERN: OnceLock<Regex> = OnceLock::new();
        PATTERN.get_or_init(|| {
            compile(&with_left_boundary(&format!(
                "([0-9]{{4}})[-\\.\\/\\s](?:({})|([0-9]{{1,2}}))[-\\.\\/\\s]([0-9]{{1,2}})(?=[^0-9A-Za-z_]|$)",
                match_any_pattern(month_dictionary())
            )))
        })
    }

    fn extract(&self, context: &Context, matched: &mut MatchData) -> Extracted {
        extract_bounded(context, matched, |context, m| {
            let Some(year) = m.group(1).and_then(|g| g.parse::<i64>().ok()) else {
                return Extracted::None;
            };
            let Some(mut day) = m.group(4).and_then(|g| g.parse::<i64>().ok()) else {
                return Extracted::None;
            };
            let Some(mut month) = m
                .group(3)
                .and_then(|g| g.parse::<i64>().ok())
                .or_else(|| m.group(2).and_then(month_of))
            else {
                return Extracted::None;
            };

            if !(1..=12).contains(&month) {
                // Not strict: a swapped day and month is the likelier reading.
                if (1..=12).contains(&day) {
                    std::mem::swap(&mut month, &mut day);
                }
            }
            if !(1..=31).contains(&day) {
                return Extracted::None;
            }

            let mut components = ParsingComponents::new(context.reference);
            components.assign(Component::Day, day);
            components.assign(Component::Month, month);
            components.assign(Component::Year, year);
            Extracted::components(components)
        })
    }
}

// ---------------------------------------------------------------------------
// Month name first: "april 18", "march 20 - 25, 2026".
// ---------------------------------------------------------------------------

pub struct MonthNameMiddleEndianParser;

impl Parser for MonthNameMiddleEndianParser {
    fn pattern(&self, _context: &Context) -> &'static Regex {
        static PATTERN: OnceLock<Regex> = OnceLock::new();
        PATTERN.get_or_init(|| {
            compile(&with_left_boundary(&format!(
                concat!(
                    "({month})",
                    "(?:-|/|\\s*,?\\s*)",
                    "({ordinal})(?!\\s*(?:am|pm))\\s*",
                    "(?:(?:to|\\-)\\s*({ordinal})\\s*)?",
                    "(?:(?:-|/|\\s*,\\s*|\\s+)({year}))?",
                    "(?=[^0-9A-Za-z_]|$)(?!\\:[0-9])"
                ),
                month = match_any_pattern(month_dictionary()),
                ordinal = ordinal_number_pattern(),
                year = YEAR_PATTERN
            )))
        })
    }

    fn extract(&self, context: &Context, matched: &mut MatchData) -> Extracted {
        extract_bounded(context, matched, |context, m| {
            let Some(month) = m.group(1).and_then(month_of) else {
                return Extracted::None;
            };
            let Some(day) = m.group(2).and_then(parse_ordinal_number_pattern) else {
                return Extracted::None;
            };
            if day > 31 {
                return Extracted::None;
            }

            let mut components = ParsingComponents::new(context.reference);
            components.assign(Component::Day, day);
            components.assign(Component::Month, month);
            match m.group(4).and_then(parse_year) {
                Some(year) => {
                    components.assign(Component::Year, year);
                }
                None => {
                    let year = find_year_closest_to_ref(context.reference.instant, day, month);
                    components.imply(Component::Year, year);
                }
            }

            let Some(end_day) = m.group(3).and_then(parse_ordinal_number_pattern) else {
                return Extracted::components(components);
            };
            // "January 12 - 13, 2012": the range end differs only in its day.
            let mut end = components.clone();
            end.assign(Component::Day, end_day);
            let mut result = ParsingResult::new(m.index, m.whole().to_string(), components);
            result.end = Some(end);
            Extracted::result(result)
        })
    }
}

// ---------------------------------------------------------------------------
// Day first: "18 april", "18 - 25 april 2026".
// ---------------------------------------------------------------------------

pub struct MonthNameLittleEndianParser;

impl Parser for MonthNameLittleEndianParser {
    fn pattern(&self, _context: &Context) -> &'static Regex {
        static PATTERN: OnceLock<Regex> = OnceLock::new();
        PATTERN.get_or_init(|| {
            compile(&with_left_boundary(&format!(
                concat!(
                    "(?:on\\s{{0,3}})?",
                    "({ordinal})",
                    "(?:\\s{{0,3}}(?:to|\\-|\\–|until|through|till)?\\s{{0,3}}({ordinal}))?",
                    "(?:-|/|\\s{{0,3}}(?:of)?\\s{{0,3}})",
                    "({month})",
                    "(?:(?:-|/|,?\\s{{0,3}})({year}(?![0-9A-Za-z_])))?",
                    "(?=[^0-9A-Za-z_]|$)"
                ),
                ordinal = ordinal_number_pattern(),
                month = match_any_pattern(month_dictionary()),
                year = YEAR_PATTERN
            )))
        })
    }

    fn extract(&self, context: &Context, matched: &mut MatchData) -> Extracted {
        extract_bounded(context, matched, |context, m| {
            let Some(month) = m.group(3).and_then(month_of) else {
                return Extracted::None;
            };
            let Some(day) = m.group(1).and_then(parse_ordinal_number_pattern) else {
                return Extracted::None;
            };
            if day > 31 {
                // "[96 Aug]" is really "9[6 Aug]" — resume past the number
                // rather than one character on, so the shorter reading gets
                // its turn.
                m.index += m.group(1).unwrap_or_default().len();
                return Extracted::None;
            }

            let mut components = ParsingComponents::new(context.reference);
            components.assign(Component::Month, month);
            components.assign(Component::Day, day);
            match m.group(4).and_then(parse_year) {
                Some(year) => {
                    components.assign(Component::Year, year);
                }
                None => {
                    let year = find_year_closest_to_ref(context.reference.instant, day, month);
                    components.imply(Component::Year, year);
                }
            }

            let mut result = ParsingResult::new(m.index, m.whole().to_string(), components);
            if let Some(end_day) = m.group(2).and_then(parse_ordinal_number_pattern) {
                let mut end = result.start.clone();
                end.assign(Component::Day, end_day);
                result.end = Some(end);
            }
            Extracted::result(result)
        })
    }
}

// ---------------------------------------------------------------------------
// A bare month name: "march", "in december 2026".
// ---------------------------------------------------------------------------

pub struct MonthNameParser;

impl Parser for MonthNameParser {
    fn pattern(&self, _context: &Context) -> &'static Regex {
        static PATTERN: OnceLock<Regex> = OnceLock::new();
        PATTERN.get_or_init(|| {
            compile(&with_left_boundary(&format!(
                concat!(
                    "((?:in)\\s*)?",
                    "({month})",
                    "\\s*",
                    "(?:(?:,|-|of)?\\s*({year})?)?",
                    "(?=[^\\s0-9A-Za-z_]|\\s+[^0-9]|\\s+$|$)"
                ),
                month = match_any_pattern(month_dictionary()),
                year = YEAR_PATTERN
            )))
        })
    }

    fn extract(&self, context: &Context, matched: &mut MatchData) -> Extracted {
        extract_bounded(context, matched, |context, m| {
            let Some(month_word) = m.group(2) else {
                return Extracted::None;
            };
            let Some(month) = month_of(month_word) else {
                return Extracted::None;
            };
            // A three-letter match is far more likely to be an ordinary word
            // ("mar", "jan") than a month, unless it is a full month name.
            if m.whole().len() <= 3 && super::dict::full_month_of(month_word).is_none() {
                return Extracted::None;
            }

            let prefix_len = m.group(1).unwrap_or_default().len();
            let index = m.index + prefix_len;
            let end = m.index + m.whole().len();
            let text = context.text[index..end].to_string();

            let mut components = ParsingComponents::new(context.reference);
            components.imply(Component::Day, 1);
            components.assign(Component::Month, month);
            match m.group(3).and_then(parse_year) {
                Some(year) => {
                    components.assign(Component::Year, year);
                }
                None => {
                    let year = find_year_closest_to_ref(context.reference.instant, 1, month);
                    components.imply(Component::Year, year);
                }
            }
            Extracted::result(ParsingResult::new(index, text, components))
        })
    }
}

// ---------------------------------------------------------------------------
// Month and year only: "06/2026".
// ---------------------------------------------------------------------------

pub struct SlashMonthFormatParser;

impl Parser for SlashMonthFormatParser {
    fn pattern(&self, _context: &Context) -> &'static Regex {
        static PATTERN: OnceLock<Regex> = OnceLock::new();
        PATTERN.get_or_init(|| compile(&with_left_boundary("([0-9]|0[1-9]|1[012])/([0-9]{4})")))
    }

    fn extract(&self, context: &Context, matched: &mut MatchData) -> Extracted {
        extract_bounded(context, matched, |context, m| {
            let (Some(month), Some(year)) = (
                m.group(1).and_then(|g| g.parse::<i64>().ok()),
                m.group(2).and_then(|g| g.parse::<i64>().ok()),
            ) else {
                return Extracted::None;
            };
            let mut components = ParsingComponents::new(context.reference);
            components.imply(Component::Day, 1);
            components.assign(Component::Month, month);
            components.assign(Component::Year, year);
            Extracted::components(components)
        })
    }
}

// ---------------------------------------------------------------------------
// Weekdays: "monday", "on friday", "next wednesday", "this weekend".
// ---------------------------------------------------------------------------

pub struct WeekdayParser;

impl Parser for WeekdayParser {
    fn pattern(&self, _context: &Context) -> &'static Regex {
        static PATTERN: OnceLock<Regex> = OnceLock::new();
        PATTERN.get_or_init(|| {
            compile(&with_left_boundary(&format!(
                concat!(
                    "(?:(?:\\,|\\(|\\（)\\s*)?",
                    "(?:on\\s*?)?",
                    "(?:(this|last|past|next)\\s*)?",
                    "({weekday}|weekend|weekday)",
                    "(?:\\s*(?:\\,|\\)|\\）))?",
                    "(?:\\s*(this|last|past|next)\\s*week)?",
                    "(?=[^0-9A-Za-z_]|$)"
                ),
                weekday = match_any_pattern(weekday_dictionary())
            )))
        })
    }

    fn extract(&self, context: &Context, matched: &mut MatchData) -> Extracted {
        extract_bounded(context, matched, |context, m| {
            const SUNDAY: i64 = 0;
            const FRIDAY: i64 = 5;
            const SATURDAY: i64 = 6;

            let modifier_word = m
                .group(1)
                .or_else(|| m.group(3))
                .unwrap_or_default()
                .to_lowercase();
            let modifier = match modifier_word.as_str() {
                "last" | "past" => Some("last"),
                "next" => Some("next"),
                "this" => Some("this"),
                _ => None,
            };

            let Some(word) = m.group(2).map(str::to_lowercase) else {
                return Extracted::None;
            };
            let weekday = if let Some(weekday) = weekday_of(&word) {
                weekday
            } else if word == "weekend" {
                if modifier == Some("last") {
                    SUNDAY
                } else {
                    SATURDAY
                }
            } else if word == "weekday" {
                let reference_weekday = context.reference.instant.weekday();
                if reference_weekday == SUNDAY || reference_weekday == SATURDAY {
                    if modifier == Some("last") {
                        FRIDAY
                    } else {
                        1
                    }
                } else {
                    let shifted = reference_weekday - 1;
                    let shifted = if modifier == Some("last") {
                        shifted - 1
                    } else {
                        shifted + 1
                    };
                    // Wraps within Monday-Friday; the reference relies on JS
                    // `%` keeping the sign of the dividend.
                    (shifted % 5) + 1
                }
            } else {
                return Extracted::None;
            };

            match components_at_weekday(context.reference, weekday, modifier) {
                Some(components) => Extracted::components(components),
                None => Extracted::None,
            }
        })
    }
}

// ---------------------------------------------------------------------------
// "today", "tomorrow", "tonight".
// ---------------------------------------------------------------------------

pub struct CasualDateParser;

impl Parser for CasualDateParser {
    fn pattern(&self, _context: &Context) -> &'static Regex {
        static PATTERN: OnceLock<Regex> = OnceLock::new();
        PATTERN.get_or_init(|| {
            compile(&with_left_boundary(
                "(now|today|tonight|tomorrow|overmorrow|tmr|tmrw|yesterday|last\\s*night)(?=[^0-9A-Za-z_]|$)",
            ))
        })
    }

    fn extract(&self, context: &Context, matched: &mut MatchData) -> Extracted {
        extract_bounded(context, matched, |context, m| {
            let word = m.whole().to_lowercase();
            let reference = context.reference;
            let components = match word.as_str() {
                "now" => Some(reference_now(reference)),
                "today" => Some(reference_today(reference)),
                "yesterday" => reference_day_after(reference, -1),
                "tomorrow" | "tmr" | "tmrw" => reference_day_after(reference, 1),
                "tonight" => Some(reference_tonight(reference)),
                "overmorrow" => reference_day_after(reference, 2),
                _ => {
                    // "last night" — before 6am that is still tonight.
                    let mut target = reference.instant;
                    if target.hour() > 6 {
                        match target.add_days(-1) {
                            Some(previous) => target = previous,
                            None => return Extracted::None,
                        }
                    }
                    let mut components = ParsingComponents::new(reference);
                    components.assign_similar_date(target);
                    components.imply(Component::Hour, 0);
                    Some(components)
                }
            };
            match components {
                Some(components) => Extracted::components(components),
                None => Extracted::None,
            }
        })
    }
}

// ---------------------------------------------------------------------------
// "morning", "noon", "midnight".
// ---------------------------------------------------------------------------

pub struct CasualTimeParser;

impl Parser for CasualTimeParser {
    fn pattern(&self, _context: &Context) -> &'static Regex {
        static PATTERN: OnceLock<Regex> = OnceLock::new();
        PATTERN.get_or_init(|| {
            compile(&with_left_boundary(
                "(?:this)?\\s{0,3}(morning|afternoon|evening|night|midnight|midday|noon)(?=[^0-9A-Za-z_]|$)",
            ))
        })
    }

    fn extract(&self, context: &Context, matched: &mut MatchData) -> Extracted {
        extract_bounded(context, matched, |context, m| {
            let Some(word) = m.group(1).map(str::to_lowercase) else {
                return Extracted::None;
            };
            let reference = context.reference;
            let components = match word.as_str() {
                "afternoon" => Some(reference_afternoon(reference)),
                "evening" | "night" => Some(reference_evening(reference)),
                "midnight" => reference_midnight(reference),
                "morning" => Some(reference_morning(reference)),
                "noon" | "midday" => Some(reference_noon(reference)),
                _ => None,
            };
            match components {
                Some(components) => Extracted::components(components),
                None => Extracted::None,
            }
        })
    }
}

// ---------------------------------------------------------------------------
// "next week", "this month", "last year".
// ---------------------------------------------------------------------------

pub struct RelativeDateFormatParser;

impl Parser for RelativeDateFormatParser {
    fn pattern(&self, _context: &Context) -> &'static Regex {
        static PATTERN: OnceLock<Regex> = OnceLock::new();
        PATTERN.get_or_init(|| {
            compile(&with_left_boundary(&format!(
                "(this|last|past|next|after\\s*this)\\s*({unit})(?=\\s*)(?=[^0-9A-Za-z_]|$)",
                unit = match_any_pattern(time_unit_dictionary())
            )))
        })
    }

    fn extract(&self, context: &Context, matched: &mut MatchData) -> Extracted {
        extract_bounded(context, matched, |context, m| {
            let modifier = m.group(1).unwrap_or_default().to_lowercase();
            let unit_word = m.group(2).unwrap_or_default().to_lowercase();
            let Some(unit) = super::dict::timeunit_of(&unit_word) else {
                return Extracted::None;
            };

            let signed = |sign: f64| {
                let mut duration = Duration::default();
                match unit {
                    super::dict::Timeunit::Second => duration.second = Some(sign),
                    super::dict::Timeunit::Minute => duration.minute = Some(sign),
                    super::dict::Timeunit::Hour => duration.hour = Some(sign),
                    super::dict::Timeunit::Day => duration.day = Some(sign),
                    super::dict::Timeunit::Week => duration.week = Some(sign),
                    super::dict::Timeunit::Month => duration.month = Some(sign),
                    super::dict::Timeunit::Quarter => duration.quarter = Some(sign),
                    super::dict::Timeunit::Year => duration.year = Some(sign),
                }
                duration
            };

            if modifier == "next" || modifier.starts_with("after") {
                return match ParsingComponents::relative_from_reference(
                    context.reference,
                    &signed(1.0),
                ) {
                    Some(components) => Extracted::components(components),
                    None => Extracted::None,
                };
            }
            if modifier == "last" || modifier == "past" {
                return match ParsingComponents::relative_from_reference(
                    context.reference,
                    &signed(-1.0),
                ) {
                    Some(components) => Extracted::components(components),
                    None => Extracted::None,
                };
            }

            // "this <unit>": the start of the current week, month or year.
            let mut components = ParsingComponents::new(context.reference);
            let reference = context.reference.instant;
            if unit_word.contains("week") {
                let Some(date) = reference.set_day(reference.day() - reference.weekday()) else {
                    return Extracted::None;
                };
                components.imply(Component::Day, date.day());
                components.imply(Component::Month, date.month0() + 1);
                components.imply(Component::Year, date.year());
            } else if unit_word.contains("month") {
                let Some(date) = reference.set_day(1) else {
                    return Extracted::None;
                };
                components.imply(Component::Day, date.day());
                components.assign(Component::Year, date.year());
                components.assign(Component::Month, date.month0() + 1);
            } else if unit_word.contains("year") {
                let Some(date) = reference.set_day(1).and_then(|d| d.set_month0(0)) else {
                    return Extracted::None;
                };
                components.imply(Component::Day, date.day());
                components.imply(Component::Month, date.month0() + 1);
                components.assign(Component::Year, date.year());
            }
            Extracted::components(components)
        })
    }
}

// ---------------------------------------------------------------------------
// Durations: "in 3 days", "2 weeks ago", "3 days later", "next 2 weeks".
// ---------------------------------------------------------------------------

/// `in 3 days`. With `forwardDate` set the prefix becomes optional, so a bare
/// "3 days" is read as a future offset — chrono-node's own behaviour, and the
/// reason the quick-add parser strips recurrence phrasing before this runs.
pub struct TimeUnitWithinFormatParser;

impl Parser for TimeUnitWithinFormatParser {
    fn pattern(&self, context: &Context) -> &'static Regex {
        static OPTIONAL_PREFIX: OnceLock<Regex> = OnceLock::new();
        static REQUIRED_PREFIX: OnceLock<Regex> = OnceLock::new();
        let modifiers = "(?:(?:about|around|roughly|approximately|just)\\s*(?:~\\s*)?)?";
        if context.forward_date {
            OPTIONAL_PREFIX.get_or_init(|| {
                compile(&with_left_boundary(&format!(
                    "(?:(?:within|in|for)\\s*)?{modifiers}({})(?=[^0-9A-Za-z_]|$)",
                    time_units_pattern()
                )))
            })
        } else {
            REQUIRED_PREFIX.get_or_init(|| {
                compile(&with_left_boundary(&format!(
                    "(?:within|in|for)\\s*{modifiers}({})(?=[^0-9A-Za-z_]|$)",
                    time_units_pattern()
                )))
            })
        }
    }

    fn extract(&self, context: &Context, matched: &mut MatchData) -> Extracted {
        extract_bounded(context, matched, |context, m| {
            // "for the year" is a span, not an offset.
            if matches("(?i)^for\\s*the\\s*[0-9A-Za-z_]+", m.whole()) {
                return Extracted::None;
            }
            relative_or_none(context.reference, m.group(1), false)
        })
    }
}

pub struct TimeUnitAgoFormatParser;

impl Parser for TimeUnitAgoFormatParser {
    fn pattern(&self, _context: &Context) -> &'static Regex {
        static PATTERN: OnceLock<Regex> = OnceLock::new();
        PATTERN.get_or_init(|| {
            compile(&with_left_boundary(&format!(
                "({})\\s{{0,5}}(?:ago|before|earlier)(?=[^0-9A-Za-z_]|$)",
                time_units_pattern()
            )))
        })
    }

    fn extract(&self, context: &Context, matched: &mut MatchData) -> Extracted {
        extract_bounded(context, matched, |context, m| {
            relative_or_none(context.reference, m.group(1), true)
        })
    }
}

pub struct TimeUnitLaterFormatParser;

impl Parser for TimeUnitLaterFormatParser {
    fn pattern(&self, _context: &Context) -> &'static Regex {
        static PATTERN: OnceLock<Regex> = OnceLock::new();
        PATTERN.get_or_init(|| {
            compile(&with_left_boundary(&format!(
                "({})\\s{{0,5}}(?:later|after|from now|henceforth|forward|out)(?=(?:[^0-9A-Za-z_]|$))",
                time_units_pattern()
            )))
        })
    }

    fn extract(&self, context: &Context, matched: &mut MatchData) -> Extracted {
        extract_bounded(context, matched, |context, m| {
            relative_or_none(context.reference, m.group(1), false)
        })
    }
}

pub struct TimeUnitCasualRelativeFormatParser;

impl Parser for TimeUnitCasualRelativeFormatParser {
    fn pattern(&self, _context: &Context) -> &'static Regex {
        static PATTERN: OnceLock<Regex> = OnceLock::new();
        PATTERN.get_or_init(|| {
            compile(&with_left_boundary(&format!(
                "(this|last|past|next|after|\\+|-)\\s*({})(?=[^0-9A-Za-z_]|$)",
                time_units_pattern()
            )))
        })
    }

    fn extract(&self, context: &Context, matched: &mut MatchData) -> Extracted {
        extract_bounded(context, matched, |context, m| {
            let prefix = m.group(1).unwrap_or_default().to_lowercase();
            let backward = matches!(prefix.as_str(), "last" | "past" | "-");
            relative_or_none(context.reference, m.group(2), backward)
        })
    }
}

fn relative_or_none(reference: Reference, text: Option<&str>, backward: bool) -> Extracted {
    let Some(duration) = text.and_then(parse_duration) else {
        return Extracted::None;
    };
    let duration = if backward {
        duration.reversed()
    } else {
        duration
    };
    match ParsingComponents::relative_from_reference(reference, &duration) {
        Some(components) => Extracted::components(components),
        None => Extracted::None,
    }
}

// ---------------------------------------------------------------------------
// Clock times, including ranges: "3pm", "14:00", "at 9am", "3pm to 5pm".
// ---------------------------------------------------------------------------

pub struct TimeExpressionParser;

const HOUR_GROUP: usize = 2;
const MINUTE_GROUP: usize = 3;
const SECOND_GROUP: usize = 4;
const MILLISECOND_GROUP: usize = 5;
const AM_PM_GROUP: usize = 6;

fn primary_time_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        compile(concat!(
            "(^|\\s|T|\\b)",
            "(?:(?:at|from)\\s*)??",
            "([0-9]{1,4})",
            "(?:(?:\\.|:|：)([0-9]{1,2})(?:(?::|：)([0-9]{2})(?:\\.([0-9]{1,6}))?)?)?",
            "(?:\\s*(a\\.m\\.|p\\.m\\.|am?|pm?))?",
            "(?:\\s*(?:o[^0-9A-Za-z_]*clock|at\\s*night|in\\s*the\\s*(?:morning|afternoon)))?",
            "(?!/)(?=[^0-9A-Za-z_]|$)"
        ))
    })
}

fn following_time_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        compile(concat!(
            "^(\\s*(?:\\-|\\–|\\~|\\〜|to|until|through|till|\\?)\\s*)",
            "([0-9]{1,4})",
            "(?:(?:\\.|\\:|\\：)([0-9]{1,2})(?:(?:\\.|\\:|\\：)([0-9]{1,2})(?:\\.([0-9]{1,6}))?)?)?",
            "(?:\\s*(a\\.m\\.|p\\.m\\.|am?|pm?))?",
            "(?!/)(?=[^0-9A-Za-z_]|$)"
        ))
    })
}

impl Parser for TimeExpressionParser {
    fn pattern(&self, _context: &Context) -> &'static Regex {
        primary_time_pattern()
    }

    fn extract(&self, context: &Context, m: &mut MatchData) -> Extracted {
        let Some(start) = extract_primary_time(context, m) else {
            // A four-digit lead is probably a year, so step over it whole
            // rather than re-matching its tail as an hour.
            if matches("^[0-9]{4}", m.whole()) {
                m.index += 4;
            } else {
                m.index += m.whole().len();
            }
            return Extracted::None;
        };

        let header_len = m.group(1).unwrap_or_default().len();
        let index = m.index + header_len;
        let text = m.whole()[header_len..].to_string();
        let mut result = ParsingResult::new(index, text, start);
        m.index += m.whole().len();

        let remaining = &context.text[m.index.min(context.text.len())..];
        let following = following_time_pattern()
            .captures(remaining)
            .ok()
            .flatten()
            .map(|captures| MatchData::from_captures(&captures, 0));

        if let Some(following) = &following {
            // "2022-12" and "456-12" are not time ranges without more context.
            if matches("^[0-9]{3,4}", &result.text) {
                let whole = following.whole();
                if matches("^\\s*([+-])\\s*[0-9]{2,4}$", whole)
                    || matches("^\\s*([+-])\\s*[0-9]{2}[^0-9A-Za-z_][0-9]{2}", whole)
                {
                    return Extracted::None;
                }
            }
        }

        let following = match following {
            // "YY.YY -XXXX" reads as a timezone offset, not a range.
            Some(ref f) if matches("^\\s*([+-])\\s*[0-9]{3,4}$", f.whole()) => None,
            other => other,
        };

        let Some(following) = following else {
            return match check_without_following(result) {
                Some(result) => Extracted::result(result),
                None => Extracted::None,
            };
        };

        if let Some(end) = extract_following_time(context, &following, &mut result) {
            result.text.push_str(following.whole());
            result.end = Some(end);
        }

        match check_with_following(result) {
            Some(result) => Extracted::result(result),
            None => Extracted::None,
        }
    }
}

fn extract_primary_time(context: &Context, m: &MatchData) -> Option<ParsingComponents> {
    let mut components = ParsingComponents::new(context.reference);
    let mut minute = 0i64;
    let mut meridiem: Option<i64> = None;

    let mut hour = m.group(HOUR_GROUP)?.parse::<i64>().ok()?;
    if hour > 100 {
        // "2019" is a year, not 20:19 — unless something else says otherwise.
        if m.group(HOUR_GROUP)?.len() == 4
            && m.group(MINUTE_GROUP).is_none()
            && m.group(AM_PM_GROUP).is_none()
        {
            return None;
        }
        if m.group(MINUTE_GROUP).is_some() {
            return None;
        }
        minute = hour % 100;
        hour /= 100;
    }
    if hour > 24 {
        return None;
    }

    if let Some(raw) = m.group(MINUTE_GROUP) {
        // "at 1.1" is not 1:01.
        if raw.len() == 1 && m.group(AM_PM_GROUP).is_none() {
            return None;
        }
        minute = raw.parse::<i64>().ok()?;
    }
    if minute >= 60 {
        return None;
    }
    if hour > 12 {
        meridiem = Some(MERIDIEM_PM);
    }

    if let Some(am_pm) = m.group(AM_PM_GROUP) {
        if hour > 12 {
            return None;
        }
        match am_pm.to_lowercase().chars().next() {
            Some('a') => {
                meridiem = Some(MERIDIEM_AM);
                if hour == 12 {
                    hour = 0;
                }
            }
            Some('p') => {
                meridiem = Some(MERIDIEM_PM);
                if hour != 12 {
                    hour += 12;
                }
            }
            _ => {}
        }
    }

    components.assign(Component::Hour, hour);
    components.assign(Component::Minute, minute);
    match meridiem {
        Some(value) => {
            components.assign(Component::Meridiem, value);
        }
        None => {
            components.imply(Component::Meridiem, meridiem_of(hour));
        }
    }

    if let Some(raw) = m.group(MILLISECOND_GROUP) {
        let millisecond = raw
            .chars()
            .take(3)
            .collect::<String>()
            .parse::<i64>()
            .ok()?;
        if millisecond >= 1000 {
            return None;
        }
        components.assign(Component::Millisecond, millisecond);
    }
    if let Some(raw) = m.group(SECOND_GROUP) {
        let second = raw.parse::<i64>().ok()?;
        if second >= 60 {
            return None;
        }
        components.assign(Component::Second, second);
    }

    // Trailing "at night" / "in the afternoon" pushes a bare hour into the
    // half of the day it names.
    let whole = m.whole().to_lowercase();
    if whole.ends_with("night") {
        let hour = components.get(Component::Hour).unwrap_or(0);
        if (6..12).contains(&hour) {
            components.assign(Component::Hour, hour + 12);
            components.assign(Component::Meridiem, MERIDIEM_PM);
        } else if hour < 6 {
            components.assign(Component::Meridiem, MERIDIEM_AM);
        }
    }
    if whole.ends_with("afternoon") {
        components.assign(Component::Meridiem, MERIDIEM_PM);
        let hour = components.get(Component::Hour).unwrap_or(0);
        if (0..=6).contains(&hour) {
            components.assign(Component::Hour, hour + 12);
        }
    }
    if whole.ends_with("morning") {
        components.assign(Component::Meridiem, MERIDIEM_AM);
    }

    Some(components)
}

fn extract_following_time(
    context: &Context,
    m: &MatchData,
    result: &mut ParsingResult,
) -> Option<ParsingComponents> {
    let mut components = ParsingComponents::new(context.reference);

    if let Some(raw) = m.group(MILLISECOND_GROUP) {
        let millisecond = raw
            .chars()
            .take(3)
            .collect::<String>()
            .parse::<i64>()
            .ok()?;
        if millisecond >= 1000 {
            return None;
        }
        components.assign(Component::Millisecond, millisecond);
    }
    if let Some(raw) = m.group(SECOND_GROUP) {
        let second = raw.parse::<i64>().ok()?;
        if second >= 60 {
            return None;
        }
        components.assign(Component::Second, second);
    }

    let mut hour = m.group(HOUR_GROUP)?.parse::<i64>().ok()?;
    let mut minute = 0i64;
    let mut meridiem: Option<i64> = None;

    if let Some(raw) = m.group(MINUTE_GROUP) {
        minute = raw.parse::<i64>().ok()?;
    } else if hour > 100 {
        minute = hour % 100;
        hour /= 100;
    }
    if minute >= 60 || hour > 24 {
        return None;
    }
    if hour >= 12 {
        meridiem = Some(MERIDIEM_PM);
    }

    if let Some(am_pm) = m.group(AM_PM_GROUP) {
        if hour > 12 {
            return None;
        }
        match am_pm.to_lowercase().chars().next() {
            Some('a') => {
                meridiem = Some(MERIDIEM_AM);
                if hour == 12 {
                    hour = 0;
                    if !components.is_certain(Component::Day) {
                        let day = components.get(Component::Day)?;
                        components.imply(Component::Day, day + 1);
                    }
                }
            }
            Some('p') => {
                meridiem = Some(MERIDIEM_PM);
                if hour != 12 {
                    hour += 12;
                }
            }
            _ => {}
        }
        // A meridiem on the range's end settles the start too: "9-5pm" is an
        // afternoon finish, so the 9 is a morning start.
        if !result.start.is_certain(Component::Meridiem) {
            if meridiem == Some(MERIDIEM_AM) {
                result.start.imply(Component::Meridiem, MERIDIEM_AM);
                if result.start.get(Component::Hour) == Some(12) {
                    result.start.assign(Component::Hour, 0);
                }
            } else {
                result.start.imply(Component::Meridiem, MERIDIEM_PM);
                let start_hour = result.start.get(Component::Hour)?;
                if start_hour != 12 {
                    result.start.assign(Component::Hour, start_hour + 12);
                }
            }
        }
    }

    components.assign(Component::Hour, hour);
    components.assign(Component::Minute, minute);

    match meridiem {
        Some(value) => {
            components.assign(Component::Meridiem, value);
        }
        None => {
            let start_at_pm = result.start.is_certain(Component::Meridiem)
                && result.start.get(Component::Hour).is_some_and(|h| h > 12);
            if start_at_pm {
                let start_hour = result.start.get(Component::Hour)?;
                if start_hour - 12 > hour {
                    // "10pm - 1" finishes at 1am.
                    components.imply(Component::Meridiem, MERIDIEM_AM);
                } else if hour <= 12 {
                    components.assign(Component::Hour, hour + 12);
                    components.assign(Component::Meridiem, MERIDIEM_PM);
                }
            } else if hour > 12 {
                components.imply(Component::Meridiem, MERIDIEM_PM);
            } else {
                components.imply(Component::Meridiem, MERIDIEM_AM);
            }
        }
    }

    // A range that finishes before it starts runs past midnight.
    if components.date()? < result.start.date()? {
        let day = components.get(Component::Day)?;
        components.imply(Component::Day, day + 1);
    }

    Some(components)
}

fn check_without_following(result: ParsingResult) -> Option<ParsingResult> {
    // A lone digit is not a time.
    if matches("^[0-9]$", &result.text) {
        return None;
    }
    // Neither is a run of three or more.
    if matches("^[0-9][0-9][0-9]+$", &result.text) {
        return None;
    }
    // "1a" / "123p" — a truncated meridiem is unlikely to be one.
    if matches("[0-9][apAP]$", &result.text) {
        return None;
    }
    if let Some(captures) = Regex::new("[^0-9:.]([0-9][0-9.]+)$")
        .expect("static pattern")
        .captures(&result.text)
        .ok()
        .flatten()
    {
        let ending = captures.get(1)?.as_str();
        if ending.contains('.') && !matches("[0-9](\\.[0-9]{2})+$", ending) {
            return None;
        }
        if ending.parse::<i64>().is_ok_and(|value| value > 24) {
            return None;
        }
    }
    Some(result)
}

fn check_with_following(result: ParsingResult) -> Option<ParsingResult> {
    if matches("^[0-9]+-[0-9]+$", &result.text) {
        return None;
    }
    if let Some(captures) = Regex::new("[^0-9:.]([0-9][0-9.]+)\\s*-\\s*([0-9][0-9.]+)$")
        .expect("static pattern")
        .captures(&result.text)
        .ok()
        .flatten()
    {
        let starting = captures.get(1)?.as_str();
        let ending = captures.get(2)?.as_str();
        if ending.contains('.') && !matches("[0-9](\\.[0-9]{2})+$", ending) {
            return None;
        }
        let over_24 = |text: &str| text.parse::<i64>().is_ok_and(|value| value > 24);
        if over_24(ending) || over_24(starting) {
            return None;
        }
    }
    Some(result)
}

/// Every parser, in the order chrono-node's casual English configuration runs
/// them. Order decides ties: results are sorted by index with a stable sort, so
/// two parsers claiming the same offset stay in this order, and the refiners
/// see them that way.
pub fn all_parsers() -> Vec<Box<dyn Parser>> {
    vec![
        Box::new(YearMonthDayParser),
        Box::new(IsoFormatParser),
        Box::new(SlashDateFormatParser),
        Box::new(TimeUnitWithinFormatParser),
        Box::new(MonthNameLittleEndianParser),
        Box::new(MonthNameMiddleEndianParser),
        Box::new(WeekdayParser),
        Box::new(SlashMonthFormatParser),
        Box::new(TimeExpressionParser),
        Box::new(TimeUnitAgoFormatParser),
        Box::new(TimeUnitLaterFormatParser),
        Box::new(CasualDateParser),
        Box::new(CasualTimeParser),
        Box::new(MonthNameParser),
        Box::new(RelativeDateFormatParser),
        Box::new(TimeUnitCasualRelativeFormatParser),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference() -> Reference {
        // Sunday 2026-03-15, midday.
        Reference::new(JsDate::from_parts(2026, 2, 15, 12, 0, 0, 0).expect("representable"))
    }

    #[test]
    fn next_weekday_midweek_means_the_one_already_behind_us_this_week() {
        // From Wednesday, Monday has already gone, so "next monday" and "this
        // monday" both mean the coming one — five days out. The +7 branch only
        // applies to a weekday still ahead in the current week.
        let wednesday = JsDate::from_parts(2026, 2, 18, 12, 0, 0, 0).expect("representable");
        assert_eq!(days_to_weekday(wednesday, 1, Some("next")), 5);
        assert_eq!(days_to_weekday(wednesday, 1, Some("this")), 5);
        // Friday is still ahead this week, so "next friday" skips it.
        assert_eq!(days_to_weekday(wednesday, 5, Some("next")), 9);
        assert_eq!(days_to_weekday(wednesday, 5, Some("this")), 2);
    }

    #[test]
    fn next_weekday_from_sunday_is_the_coming_one() {
        let sunday = reference().instant;
        assert_eq!(days_to_weekday(sunday, 1, Some("next")), 1);
        assert_eq!(days_to_weekday(sunday, 0, Some("next")), 7);
    }

    #[test]
    fn a_bare_weekday_takes_the_closest_in_either_direction() {
        let sunday = reference().instant;
        // Monday is one day forward; Saturday is one day back.
        assert_eq!(days_to_weekday(sunday, 1, None), 1);
        assert_eq!(days_to_weekday(sunday, 6, None), -1);
    }

    #[test]
    fn midnight_is_the_coming_one_unless_it_is_the_small_hours() {
        let evening =
            Reference::new(JsDate::from_parts(2026, 2, 15, 22, 0, 0, 0).expect("representable"));
        let components = reference_midnight(evening).expect("representable");
        assert_eq!(components.get(Component::Day), Some(16));

        let small_hours =
            Reference::new(JsDate::from_parts(2026, 2, 15, 1, 0, 0, 0).expect("representable"));
        let components = reference_midnight(small_hours).expect("representable");
        assert_eq!(components.get(Component::Day), Some(15));
    }

    #[test]
    fn noon_is_certain_about_the_hour_and_nothing_else() {
        let components = reference_noon(reference());
        assert!(components.is_certain(Component::Hour));
        assert!(!components.is_certain(Component::Minute));
        assert!(!components.is_certain(Component::Day));
        assert_eq!(components.get(Component::Hour), Some(12));
    }

    #[test]
    fn morning_is_certain_about_nothing_at_all() {
        let components = reference_morning(reference());
        assert!(!components.is_certain(Component::Hour));
        assert_eq!(components.get(Component::Hour), Some(6));
    }
}
