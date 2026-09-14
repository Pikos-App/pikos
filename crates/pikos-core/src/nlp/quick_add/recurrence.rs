//! Cadence: reading it out of the text, writing it back as an RRULE, and
//! expanding the finite forms into concrete dates.
//!
//! Two shapes come out of quick-add, and the difference is what the user typed:
//!
//! - **infinite** — "every monday", "daily", "every other week". One page with
//!   an RRULE; occurrences are expanded at render time.
//! - **finite** — bare "m/w/f" or bare "weekdays", with no "every". N concrete
//!   pages, because the user named a handful of days rather than a rule.
//!
//! An infinite cadence plus a window ("for 2 weeks", "10 times", "through
//! march 31") stays one page, with COUNT or UNTIL on the rule.

use std::sync::OnceLock;

use chrono::{Datelike, NaiveDateTime};
use fancy_regex::Regex;

use super::text::{add_days, compile, group, replace_all_with};

/// Weekday numbering is RRULE's: Monday is 0, Sunday is 6. Deliberately not
/// JavaScript's Sunday-first numbering, which the date engine uses — the two
/// meet only at the conversion in `quick_add::mod`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Weekday {
    Mo = 0,
    Tu = 1,
    We = 2,
    Th = 3,
    Fr = 4,
    Sa = 5,
    Su = 6,
}

impl Weekday {
    pub fn code(self) -> &'static str {
        match self {
            Weekday::Mo => "MO",
            Weekday::Tu => "TU",
            Weekday::We => "WE",
            Weekday::Th => "TH",
            Weekday::Fr => "FR",
            Weekday::Sa => "SA",
            Weekday::Su => "SU",
        }
    }

    /// Sunday-zero numbering, as `Date.prototype.getDay` and the date engine
    /// report it.
    pub fn sunday_zero(self) -> i64 {
        match self {
            Weekday::Su => 0,
            Weekday::Mo => 1,
            Weekday::Tu => 2,
            Weekday::We => 3,
            Weekday::Th => 4,
            Weekday::Fr => 5,
            Weekday::Sa => 6,
        }
    }

    pub fn from_sunday_zero(day: i64) -> Option<Self> {
        Some(match day {
            0 => Weekday::Su,
            1 => Weekday::Mo,
            2 => Weekday::Tu,
            3 => Weekday::We,
            4 => Weekday::Th,
            5 => Weekday::Fr,
            6 => Weekday::Sa,
            _ => return None,
        })
    }

    fn of(date: NaiveDateTime) -> Self {
        Self::from_sunday_zero(i64::from(date.weekday().num_days_from_sunday()))
            .expect("0..=6 from chrono")
    }
}

pub const WEEKDAY_DAYS: [Weekday; 5] = [
    Weekday::Mo,
    Weekday::Tu,
    Weekday::We,
    Weekday::Th,
    Weekday::Fr,
];
pub const WEEKEND_DAYS: [Weekday; 2] = [Weekday::Sa, Weekday::Su];

/// Every spelling of a weekday the parser accepts, including the single
/// letters that only appear in slash lists ("m/w/f").
pub fn weekday_from_word(word: &str) -> Option<Weekday> {
    Some(match word.to_lowercase().as_str() {
        "f" | "fr" | "fri" | "friday" => Weekday::Fr,
        "m" | "mo" | "mon" | "monday" => Weekday::Mo,
        "sa" | "sat" | "saturday" => Weekday::Sa,
        "su" | "sun" | "sunday" => Weekday::Su,
        "t" | "tu" | "tue" | "tues" | "tuesday" => Weekday::Tu,
        "th" | "thu" | "thur" | "thurs" | "thursday" => Weekday::Th,
        "w" | "we" | "wed" | "wednesday" => Weekday::We,
        _ => return None,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Frequency {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

impl Frequency {
    fn code(self) -> &'static str {
        match self {
            Frequency::Daily => "DAILY",
            Frequency::Weekly => "WEEKLY",
            Frequency::Monthly => "MONTHLY",
            Frequency::Yearly => "YEARLY",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Cadence {
    /// A rule with no end: "every monday", "daily", "every other week".
    Infinite {
        freq: Frequency,
        byday: Option<Vec<Weekday>>,
        interval: Option<u32>,
    },
    /// A bare slash list — "m/w/f" with no "every".
    FiniteSlash { days: Vec<Weekday> },
    /// A bare "weekdays" with no "every".
    FiniteWeekdays,
}

/// How far a cadence runs: "10 times", "through march 31", "for 2 weeks".
#[derive(Clone, Debug, PartialEq)]
pub enum Window {
    Count(u32),
    Until(NaiveDateTime),
    Days(u32),
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/// Day words the bare "every <day>" rule accepts. No single letters: those
/// belong to the slash list, and letting them in here would make "every m"
/// swallow the "m" of "every morning".
const DAY_WORD: &str = "(?:weekday|weekend|day|week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|mo|tu|we|th|fr|sa|su)";
/// Comma, "and", or ", and" — the separators a day list is written with.
const SEP: &str = "(?:\\s*,\\s*|\\s+and\\s+|\\s*,\\s*and\\s+)";
const SLASH_DAY: &str = "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|mo|tu|we|th|fr|sa|su|m|t|w|f)";
const PLURAL_DAY: &str = "(?:mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)";

fn pattern(cell: &'static OnceLock<Regex>, build: impl FnOnce() -> String) -> &'static Regex {
    cell.get_or_init(|| compile(&build()))
}

/// Split a day list on its separators, the way the reference splits it.
fn split_day_list(list: &str) -> Vec<String> {
    static SPLIT: OnceLock<Regex> = OnceLock::new();
    let splitter = SPLIT.get_or_init(|| compile("\\s*,?\\s*and\\s+|\\s*,\\s*"));
    let mut parts = Vec::new();
    let lowered = list.to_lowercase();
    let mut cursor = 0usize;
    let mut search_from = 0usize;
    while search_from <= lowered.len() {
        let Ok(Some(captures)) = splitter.captures(&lowered[search_from..]) else {
            break;
        };
        let whole = captures.get(0).expect("group 0");
        let (start, end) = (search_from + whole.start(), search_from + whole.end());
        parts.push(lowered[cursor..start].to_string());
        cursor = end;
        search_from = if end == start { end + 1 } else { end };
    }
    parts.push(lowered[cursor.min(lowered.len())..].to_string());
    parts
}

/// Read the cadence out of the text, stripping what it consumes.
///
/// Order matters throughout, and each ordering constraint is a bug that was
/// fixed by it: intervals before bare day words, "biweekly" before "weekly",
/// slash lists after the plain forms.
pub fn detect(text: &str) -> (String, Option<Cadence>) {
    let mut cadence: Option<Cadence> = None;
    let mut text = text.to_string();

    // "every N days" / "every other week". Before the day-word rule, so
    // "every 2 weeks" does not fall through to it and lose the interval.
    static INTERVAL_UNIT: OnceLock<Regex> = OnceLock::new();
    let interval_unit = pattern(&INTERVAL_UNIT, || {
        "\\bevery\\s+(other|\\d+)\\s+(day|week|month|year)s?\\b".to_string()
    });
    text = replace_all_with(&text, interval_unit, |captures| {
        let interval = read_interval(group(captures, 1).unwrap_or_default());
        let freq = match group(captures, 2)
            .unwrap_or_default()
            .to_lowercase()
            .as_str()
        {
            "day" => Frequency::Daily,
            "week" => Frequency::Weekly,
            "month" => Frequency::Monthly,
            _ => Frequency::Yearly,
        };
        cadence = Some(Cadence::Infinite {
            freq,
            byday: None,
            interval: Some(interval),
        });
        " ".to_string()
    });

    // "every other tuesday" — an interval anchored to a weekday. Before the
    // bare "every <weekday>" rule, which would drop the interval.
    static INTERVAL_WEEKDAY: OnceLock<Regex> = OnceLock::new();
    let interval_weekday = pattern(&INTERVAL_WEEKDAY, || {
        "\\bevery\\s+(other|\\d+)\\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\\b".to_string()
    });
    text = replace_all_with(&text, interval_weekday, |captures| {
        let interval = read_interval(group(captures, 1).unwrap_or_default());
        match group(captures, 2).and_then(weekday_from_word) {
            Some(day) => {
                cadence = Some(Cadence::Infinite {
                    freq: Frequency::Weekly,
                    byday: Some(vec![day]),
                    interval: Some(interval),
                });
            }
            None => return " ".to_string(),
        }
        " ".to_string()
    });

    // "every monday and wednesday", "every mon, wed, and fri", "every weekday".
    // The trailing (?!/) leaves a slash list alone — otherwise this eats
    // "every mon" and strands "/wed/fri", collapsing an infinite rule into a
    // finite two-day series.
    static EVERY_DAY: OnceLock<Regex> = OnceLock::new();
    let every_day = pattern(&EVERY_DAY, || {
        format!("\\bevery\\s+({DAY_WORD}(?:{SEP}{DAY_WORD})*)\\b(?!/)")
    });
    text = replace_all_with(&text, every_day, |captures| {
        let mut days: Vec<Weekday> = Vec::new();
        let mut freq: Option<Frequency> = None;
        for part in split_day_list(group(captures, 1).unwrap_or_default()) {
            match part.trim() {
                "" => continue,
                "day" => freq = Some(Frequency::Daily),
                "week" => freq = Some(Frequency::Weekly),
                "month" => freq = Some(Frequency::Monthly),
                "year" => freq = Some(Frequency::Yearly),
                "weekday" => days.extend(WEEKDAY_DAYS),
                "weekend" => days.extend(WEEKEND_DAYS),
                other => {
                    if let Some(day) = weekday_from_word(other) {
                        days.push(day);
                    }
                }
            }
        }
        if let Some(freq) = freq {
            cadence = Some(Cadence::Infinite {
                freq,
                byday: None,
                interval: None,
            });
        } else if !days.is_empty() {
            cadence = Some(Cadence::Infinite {
                freq: Frequency::Weekly,
                byday: Some(days),
                interval: None,
            });
        }
        " ".to_string()
    });

    // The single-word cadences, each only consumed when nothing has claimed
    // one yet — so "daily standup every monday" keeps "every monday" as the
    // rule and leaves "daily" in the title. Longer words first: "biweekly"
    // before "weekly", "bimonthly" before "monthly".
    for (source, freq, interval) in [
        (
            "\\b(?:biweekly|fortnightly)\\b",
            Frequency::Weekly,
            Some(2u32),
        ),
        ("\\bbimonthly\\b", Frequency::Monthly, Some(2)),
        ("\\bdaily\\b", Frequency::Daily, None),
        ("\\bweekly\\b", Frequency::Weekly, None),
        ("\\bmonthly\\b", Frequency::Monthly, None),
        ("\\b(?:yearly|annually)\\b", Frequency::Yearly, None),
    ] {
        if cadence.is_some() {
            continue;
        }
        let word = compile(source);
        text = replace_all_with(&text, &word, |_| {
            cadence = Some(Cadence::Infinite {
                freq,
                byday: None,
                interval,
            });
            " ".to_string()
        });
    }

    // Slash-separated days: "m/w/f", "mon/wed/fri". A leading "every", or an
    // infinite weekly rule already in hand, promotes the list to BYDAY;
    // otherwise the user named specific days and means a finite series.
    static SLASH_DAYS: OnceLock<Regex> = OnceLock::new();
    let slash_days = pattern(&SLASH_DAYS, || {
        format!("(\\bevery\\s+)?\\b((?:{SLASH_DAY}/)+{SLASH_DAY})\\b")
    });
    text = replace_all_with(&text, slash_days, |captures| {
        let days: Vec<Weekday> = group(captures, 2)
            .unwrap_or_default()
            .to_lowercase()
            .split('/')
            .filter_map(weekday_from_word)
            .collect();
        if days.is_empty() {
            return " ".to_string();
        }
        if group(captures, 1).is_some() || is_weekly_without_days(&cadence) {
            cadence = Some(Cadence::Infinite {
                freq: Frequency::Weekly,
                byday: Some(days),
                interval: None,
            });
        } else {
            cadence = Some(Cadence::FiniteSlash { days });
        }
        " ".to_string()
    });

    // Plural day names mean recurrence on their own: "mondays", "on tuesdays
    // and thursdays". Before the bare "weekdays" rule, and before the date
    // engine, which would otherwise read "tuesdays" as a date.
    static PLURAL_DAYS: OnceLock<Regex> = OnceLock::new();
    let plural_days = pattern(&PLURAL_DAYS, || {
        format!("(?:\\bon\\s+)?({PLURAL_DAY}(?:{SEP}{PLURAL_DAY})*)\\b")
    });
    text = replace_all_with(&text, plural_days, |captures| {
        let days: Vec<Weekday> = split_day_list(group(captures, 1).unwrap_or_default())
            .iter()
            .filter_map(|part| {
                let part = part.trim();
                weekday_from_word(part.strip_suffix('s').unwrap_or(part))
            })
            .collect();
        let whole = captures.get(0).expect("group 0").as_str().to_string();
        if days.is_empty() {
            return whole;
        }
        if cadence.is_none() || is_weekly_without_days(&cadence) {
            cadence = Some(Cadence::Infinite {
                freq: Frequency::Weekly,
                byday: Some(days),
                interval: None,
            });
            return " ".to_string();
        }
        // Something else already claimed the cadence — leave the plural in
        // the title rather than silently overriding it.
        whole
    });

    // Bare "weekdays", with no "every" — five concrete pages.
    static WEEKDAYS: OnceLock<Regex> = OnceLock::new();
    let weekdays = pattern(&WEEKDAYS, || "\\bweekdays\\b".to_string());
    text = replace_all_with(&text, weekdays, |_| {
        if cadence.is_none() {
            cadence = Some(Cadence::FiniteWeekdays);
        }
        " ".to_string()
    });

    (text, cadence)
}

fn read_interval(word: &str) -> u32 {
    if word.eq_ignore_ascii_case("other") {
        return 2;
    }
    word.parse().unwrap_or(1)
}

fn is_weekly_without_days(cadence: &Option<Cadence>) -> bool {
    matches!(
        cadence,
        Some(Cadence::Infinite {
            freq: Frequency::Weekly,
            byday: None,
            ..
        })
    )
}

// ---------------------------------------------------------------------------
// RRULE strings
// ---------------------------------------------------------------------------

/// Serialise an infinite cadence as the RRULE body — no `RRULE:` prefix and no
/// `DTSTART`, because the anchor lives on the page, not in the rule.
///
/// Field order is the reference's: FREQ, INTERVAL, BYDAY, then COUNT or UNTIL.
/// An interval of 1 is left out, being the default.
///
/// The order is not cosmetic. Two rules that differ only in field order mean
/// the same thing to every parser, and are different strings to anything that
/// compares them as text — a sync reconciler deciding whether a series
/// changed, a test diffing a fixture, a human reading two databases. A rule
/// written on the phone has to be byte-equal to the one the desktop would
/// have written for the same line, which is why the reference's serialiser
/// (`serializeRrule` in `packages/core/src/nlp/parser.ts`) is followed field
/// for field rather than approximated.
pub fn to_rrule(
    freq: Frequency,
    byday: Option<&[Weekday]>,
    interval: Option<u32>,
    bound: Option<&Bound>,
) -> String {
    let mut parts = vec![format!("FREQ={}", freq.code())];
    if let Some(interval) = interval.filter(|n| *n > 1) {
        parts.push(format!("INTERVAL={interval}"));
    }
    if let Some(days) = byday {
        let codes: Vec<&str> = days.iter().map(|day| day.code()).collect();
        parts.push(format!("BYDAY={}", codes.join(",")));
    }
    match bound {
        Some(Bound::Count(count)) => parts.push(format!("COUNT={count}")),
        Some(Bound::Until(until)) => parts.push(format!("UNTIL={}", format_until(*until))),
        None => {}
    }
    parts.join(";")
}

pub enum Bound {
    Count(u32),
    Until(NaiveDateTime),
}

/// UNTIL is written as a *floating* timestamp at the end of the boundary day —
/// `YYYYMMDDT235959`, no `Z`. The data model is timezone-naive and RFC 5545
/// asks for a floating UNTIL beside the floating DTSTART these rules anchor
/// to; the reference's `untilFromLocalDate` writes exactly this, and so does
/// the editor's own rule builder, so a rule parsed here and a rule built there
/// round-trip to the same string. An earlier version stamped `Z`, which every
/// parser accepted and no other writer produced.
fn format_until(boundary: NaiveDateTime) -> String {
    format!("{}T235959", boundary.format("%Y%m%d"))
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

/// Expand a weekly-by-weekday rule into concrete occurrences.
///
/// Weeks start on Monday, and within a week the days come out in Monday-first
/// order regardless of how they were typed — so "run t/th/f" starting on a
/// Sunday yields Tuesday, Thursday, Friday of the following week. Each
/// occurrence keeps `start`'s time of day, which is what makes an `until`
/// boundary compare the way the reference compares it.
pub fn expand_weekly(
    start: NaiveDateTime,
    days: &[Weekday],
    bound: &Bound,
    limit: usize,
) -> Vec<NaiveDateTime> {
    let mut ordered: Vec<Weekday> = days.to_vec();
    ordered.sort();
    ordered.dedup();
    if ordered.is_empty() {
        return Vec::new();
    }

    // Monday of the week `start` falls in.
    let offset_to_monday = -(Weekday::of(start) as i64);
    let Some(mut week) = add_days(start, offset_to_monday) else {
        return Vec::new();
    };

    let mut occurrences = Vec::new();
    // Weeks to scan before giving up. Derived from `limit` rather than fixed,
    // because a fixed number is a second, invisible cap: at 520 weeks a series
    // of 2,000 occurrences quietly stopped at 1,038 while `limit` still had
    // room. Every week yields at least one candidate, so `limit + 2` weeks
    // always reaches `limit` occurrences — the extra two cover a first week
    // whose days all fall before `start`.
    let max_weeks = limit.saturating_add(2);

    for _ in 0..max_weeks {
        for day in &ordered {
            let Some(at) = add_days(week, *day as i64) else {
                return occurrences;
            };
            if at < start {
                continue;
            }
            match bound {
                Bound::Count(count) => {
                    if occurrences.len() >= *count as usize {
                        return occurrences;
                    }
                }
                Bound::Until(until) => {
                    if at > *until {
                        return occurrences;
                    }
                }
            }
            occurrences.push(at);
            if occurrences.len() >= limit {
                return occurrences;
            }
        }
        let Some(next) = add_days(week, 7) else {
            return occurrences;
        };
        week = next;
    }
    occurrences
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> NaiveDateTime {
        text.parse().expect("valid")
    }

    #[test]
    fn an_interval_is_read_before_a_bare_day_word() {
        let (_, cadence) = detect("gym every 2 weeks");
        assert_eq!(
            cadence,
            Some(Cadence::Infinite {
                freq: Frequency::Weekly,
                byday: None,
                interval: Some(2),
            })
        );
    }

    #[test]
    fn every_other_weekday_keeps_both_the_interval_and_the_day() {
        let (_, cadence) = detect("gym every other tuesday");
        assert_eq!(
            cadence,
            Some(Cadence::Infinite {
                freq: Frequency::Weekly,
                byday: Some(vec![Weekday::Tu]),
                interval: Some(2),
            })
        );
    }

    #[test]
    fn a_day_list_keeps_the_order_it_was_typed() {
        let (_, cadence) = detect("every friday and monday");
        assert_eq!(
            cadence,
            Some(Cadence::Infinite {
                freq: Frequency::Weekly,
                byday: Some(vec![Weekday::Fr, Weekday::Mo]),
                interval: None,
            })
        );
    }

    #[test]
    fn a_slash_list_is_finite_without_every_and_infinite_with_it() {
        let (_, finite) = detect("run m/w/f");
        assert_eq!(
            finite,
            Some(Cadence::FiniteSlash {
                days: vec![Weekday::Mo, Weekday::We, Weekday::Fr]
            })
        );

        let (_, infinite) = detect("run every m/w/f");
        assert_eq!(
            infinite,
            Some(Cadence::Infinite {
                freq: Frequency::Weekly,
                byday: Some(vec![Weekday::Mo, Weekday::We, Weekday::Fr]),
                interval: None,
            })
        );
    }

    #[test]
    fn an_explicit_cadence_beats_a_single_word_one() {
        // "daily" must stay in the title when "every monday" is the rule.
        let (rest, cadence) = detect("daily standup every monday");
        assert_eq!(
            cadence,
            Some(Cadence::Infinite {
                freq: Frequency::Weekly,
                byday: Some(vec![Weekday::Mo]),
                interval: None,
            })
        );
        assert!(rest.contains("daily"), "got {rest:?}");
    }

    #[test]
    fn a_plural_day_defers_to_a_cadence_that_is_already_set() {
        // "m/w/f" has already claimed a finite series, so "tuesdays" is left
        // in the text and ends up in the title rather than overriding it.
        let (rest, cadence) = detect("run m/w/f tuesdays");
        assert_eq!(
            cadence,
            Some(Cadence::FiniteSlash {
                days: vec![Weekday::Mo, Weekday::We, Weekday::Fr]
            })
        );
        assert!(rest.contains("tuesdays"), "got {rest:?}");
    }

    #[test]
    fn a_plural_day_replaces_a_bare_weekly_rule_interval_and_all() {
        // Faithful to the reference, quirk included: the plural day list
        // rebuilds the cadence from scratch, so "every 2 weeks mondays" comes
        // out as a plain weekly rule on Monday and the interval is lost.
        let (_, cadence) = detect("gym every 2 weeks mondays");
        assert_eq!(
            cadence,
            Some(Cadence::Infinite {
                freq: Frequency::Weekly,
                byday: Some(vec![Weekday::Mo]),
                interval: None,
            })
        );
    }

    #[test]
    fn biweekly_wins_over_weekly() {
        let (_, cadence) = detect("sync biweekly");
        assert_eq!(
            cadence,
            Some(Cadence::Infinite {
                freq: Frequency::Weekly,
                byday: None,
                interval: Some(2),
            })
        );
    }

    #[test]
    fn an_interval_of_one_is_left_out_of_the_rule() {
        assert_eq!(
            to_rrule(Frequency::Weekly, None, Some(1), None),
            "FREQ=WEEKLY"
        );
        assert_eq!(
            to_rrule(Frequency::Weekly, None, Some(2), None),
            "FREQ=WEEKLY;INTERVAL=2"
        );
    }

    #[test]
    fn rrule_fields_come_out_in_the_reference_order() {
        assert_eq!(
            to_rrule(
                Frequency::Weekly,
                Some(&[Weekday::Tu]),
                Some(2),
                Some(&Bound::Until(at("2026-04-13T00:00:00")))
            ),
            "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;UNTIL=20260413T235959"
        );
        assert_eq!(
            to_rrule(Frequency::Daily, None, Some(3), Some(&Bound::Count(5))),
            "FREQ=DAILY;INTERVAL=3;COUNT=5"
        );
    }

    #[test]
    fn expansion_runs_monday_first_within_each_week() {
        // From a Sunday, t/th/f has no days left in the current week, so all
        // three come from the following one.
        let occurrences = expand_weekly(
            at("2026-03-15T15:00:00"),
            &[Weekday::Tu, Weekday::Th, Weekday::Fr],
            &Bound::Count(3),
            100,
        );
        assert_eq!(
            occurrences,
            [
                at("2026-03-17T15:00:00"),
                at("2026-03-19T15:00:00"),
                at("2026-03-20T15:00:00"),
            ]
        );
    }

    #[test]
    fn expansion_stops_at_an_inclusive_until() {
        let occurrences = expand_weekly(
            at("2026-03-15T12:00:00"),
            &[Weekday::Mo, Weekday::We, Weekday::Fr],
            &Bound::Until(at("2026-03-20T12:00:00")),
            100,
        );
        // Friday the 20th is exactly the boundary, so it is included.
        assert_eq!(
            occurrences,
            [
                at("2026-03-16T12:00:00"),
                at("2026-03-18T12:00:00"),
                at("2026-03-20T12:00:00"),
            ]
        );
    }

    #[test]
    fn an_until_already_in_the_past_yields_nothing() {
        let occurrences = expand_weekly(
            at("2026-03-15T12:00:00"),
            &[Weekday::Mo],
            &Bound::Until(at("2026-03-01T12:00:00")),
            100,
        );
        assert!(occurrences.is_empty());
    }
}
