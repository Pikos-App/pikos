//! Natural-language date parsing, ported from chrono-node.
//!
//! # Why this exists
//!
//! Quick-add lets you type "call the plumber tomorrow at 3pm" and get a page
//! scheduled for tomorrow at 15:00, with "call the plumber" as its title. On
//! desktop the date part of that is chrono-node's work. iOS has no JavaScript
//! runtime in the path where quick-add runs, and shelling out to the editor
//! webview for it would be absurd — so it is here, in Rust, shared by both.
//!
//! # What the caller needs back
//!
//! Four things, and they are why no Rust date crate fit:
//!
//! - **the resolved instant** — every library does this;
//! - **per-field certainty** — did the text give a time, or is midday a guess?
//!   Quick-add branches on it to decide between an all-day page and a timed
//!   one;
//! - **the match extent** — the date has to be cut out of the title, so the
//!   exact span matters, not just that a date was found;
//! - **the range end** — "3pm to 5pm" and "april 18-25" both carry one.
//!
//! # How it is graded
//!
//! The TypeScript path is the reference until this reaches parity with it.
//! `tests/date_parity.rs` runs both corpora generated from it:
//! `date-expressions.json` (each pattern on its own) and `date-calls.json`
//! (what chrono-node was actually asked, recorded through the real parser, so
//! the text is a whole title and the extents are the ones quick-add cuts).
//!
//! # Deliberate differences from the reference
//!
//! - **No timezones.** chrono-node can read "3pm EST" and "+09:00" and shift
//!   the result. Pikos parses wall-clock text against a wall-clock reference
//!   and stores wall-clock values — a timed page at 09:00 stays at 09:00
//!   across a DST boundary — so an offset would have nothing to apply to.
//!   Practically: a trailing timezone is left in the title rather than being
//!   absorbed into the match.
//! - **English only.** The reference ships German, French, Japanese, Dutch,
//!   Portuguese, Russian, Ukrainian and Chinese. Quick-add is English-only and
//!   never reaches them.
//! - **Casual mode only.** The strict configuration is not built here, because
//!   nothing asks for it.
//!
//! Indices are **byte offsets** into the UTF-8 input, not character or UTF-16
//! offsets. Slice the input with them directly; do not hand them to a caller
//! that counts differently.
//!
//! Ported from chrono-node 2.9.0 (MIT, Copyright (c) 2014 Wanasit
//! Tanakitrungruang).

mod components;
mod dict;
mod engine;
mod jsdate;
mod parsers;
mod refiners;

use chrono::NaiveDateTime;

use components::{Component, Reference};
use engine::{execute_parser, Context};
use jsdate::JsDate;

/// A field a parse can be certain about. Deliberately narrower than the
/// internal component set: milliseconds and meridiem are bookkeeping, never
/// something the caller branches on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Granularity {
    Hour,
    Minute,
    Second,
    Day,
    Month,
    Year,
    Weekday,
}

impl Granularity {
    pub const ALL: [Granularity; 7] = [
        Granularity::Hour,
        Granularity::Minute,
        Granularity::Second,
        Granularity::Day,
        Granularity::Month,
        Granularity::Year,
        Granularity::Weekday,
    ];

    fn component(self) -> Component {
        match self {
            Granularity::Hour => Component::Hour,
            Granularity::Minute => Component::Minute,
            Granularity::Second => Component::Second,
            Granularity::Day => Component::Day,
            Granularity::Month => Component::Month,
            Granularity::Year => Component::Year,
            Granularity::Weekday => Component::Weekday,
        }
    }

    /// The name the TypeScript side uses, so corpora and logs line up.
    pub fn as_str(self) -> &'static str {
        match self {
            Granularity::Hour => "hour",
            Granularity::Minute => "minute",
            Granularity::Second => "second",
            Granularity::Day => "day",
            Granularity::Month => "month",
            Granularity::Year => "year",
            Granularity::Weekday => "weekday",
        }
    }
}

/// One end of a parse: when it lands, and which fields the text settled.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MatchedDate {
    pub at: NaiveDateTime,
    /// In `Granularity::ALL` order, so two of these compare directly.
    pub certain: Vec<Granularity>,
}

impl MatchedDate {
    pub fn is_certain(&self, granularity: Granularity) -> bool {
        self.certain.contains(&granularity)
    }
}

/// A date found in some text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DateMatch {
    /// Byte offset of the match in the input.
    pub index: usize,
    /// Exactly the text claimed — `input[index..index + text.len()]`.
    pub text: String,
    pub start: MatchedDate,
    /// Present only for ranges ("3pm to 5pm", "april 18-25").
    pub end: Option<MatchedDate>,
}

impl DateMatch {
    /// Byte offset just past the match.
    pub fn end_index(&self) -> usize {
        self.index + self.text.len()
    }
}

/// Find every date in `text`, read against `reference`.
///
/// Ambiguous, incomplete dates resolve forward: a weekday that has passed means
/// the coming one, a time that has passed means tomorrow. That matches how
/// quick-add is used — you write down things you intend to do.
///
/// Results are ordered by position, and never overlap.
pub fn parse(text: &str, reference: NaiveDateTime) -> Vec<DateMatch> {
    let context = Context {
        text,
        reference: Reference::new(JsDate::from_naive(reference)),
        forward_date: true,
    };

    let mut results = Vec::new();
    for parser in parsers::all_parsers() {
        results.extend(execute_parser(&context, parser.as_ref()));
    }
    // A stable sort, so two parsers claiming the same offset keep the order
    // they were run in — which is what decides ties in the refiners.
    results.sort_by_key(|result| result.index);

    for refiner in refiners::all_refiners() {
        results = refiner.refine(&context, results);
    }

    results.into_iter().filter_map(into_match).collect()
}

/// The first date in `text`, which is what quick-add uses.
pub fn parse_first(text: &str, reference: NaiveDateTime) -> Option<DateMatch> {
    parse(text, reference).into_iter().next()
}

fn into_match(result: components::ParsingResult) -> Option<DateMatch> {
    Some(DateMatch {
        index: result.index,
        text: result.text,
        start: into_matched_date(&result.start)?,
        end: result.end.as_ref().and_then(into_matched_date),
    })
}

fn into_matched_date(components: &components::ParsingComponents) -> Option<MatchedDate> {
    Some(MatchedDate {
        at: components.date()?.naive(),
        certain: Granularity::ALL
            .into_iter()
            .filter(|granularity| components.is_certain(granularity.component()))
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sunday 2026-03-15 at midday — the parity corpus's first reference.
    fn sunday_noon() -> NaiveDateTime {
        "2026-03-15T12:00:00".parse().expect("valid")
    }

    fn at(text: &str) -> DateMatch {
        parse_first(text, sunday_noon()).expect("a date")
    }

    #[test]
    fn a_bare_time_keeps_the_day_when_it_is_still_ahead() {
        let matched = at("3pm");
        assert_eq!(matched.start.at.to_string(), "2026-03-15 15:00:00");
        assert_eq!(
            matched.start.certain,
            vec![Granularity::Hour, Granularity::Minute]
        );
    }

    #[test]
    fn a_bare_time_that_has_passed_means_tomorrow() {
        let matched = at("9am");
        assert_eq!(matched.start.at.to_string(), "2026-03-16 09:00:00");
    }

    #[test]
    fn the_match_extent_covers_only_the_date() {
        let matched = at("call the plumber tomorrow at 3pm");
        assert_eq!(matched.text, "tomorrow at 3pm");
        assert_eq!(
            &"call the plumber tomorrow at 3pm"[matched.index..],
            "tomorrow at 3pm"
        );
        assert_eq!(matched.start.at.to_string(), "2026-03-16 15:00:00");
    }

    #[test]
    fn a_time_range_carries_an_end() {
        let matched = at("standup 3pm to 5pm");
        let end = matched.end.expect("a range");
        assert_eq!(matched.start.at.to_string(), "2026-03-15 15:00:00");
        assert_eq!(end.at.to_string(), "2026-03-15 17:00:00");
    }

    #[test]
    fn a_date_range_carries_an_end_and_no_time() {
        let matched = at("trip april 18-25");
        let end = matched.end.expect("a range");
        assert_eq!(matched.start.at.to_string(), "2026-04-18 12:00:00");
        assert_eq!(end.at.to_string(), "2026-04-25 12:00:00");
        assert!(!matched.start.is_certain(Granularity::Hour));
    }

    #[test]
    fn a_bare_weekday_is_certain_about_the_weekday_alone() {
        let matched = at("monday");
        assert_eq!(matched.start.certain, vec![Granularity::Weekday]);
        assert_eq!(matched.start.at.to_string(), "2026-03-16 12:00:00");
    }

    #[test]
    fn a_month_name_inside_a_sentence_is_not_a_date_when_it_is_a_verb() {
        // "may" is a modal verb far more often than a month.
        assert!(parse_first("this may take a while", sunday_noon()).is_none());
        // On its own, it is the month.
        assert_eq!(at("may").start.at.to_string(), "2026-05-01 12:00:00");
    }

    #[test]
    fn ordinary_text_with_no_date_finds_nothing() {
        for text in [
            "daily standup",
            "review section 24",
            "every word counts in the report",
            "12345",
        ] {
            assert!(
                parse_first(text, sunday_noon()).is_none(),
                "{text:?} should not parse as a date"
            );
        }
    }

    #[test]
    fn indices_are_byte_offsets_into_the_input() {
        let text = "🎉 birthday party tomorrow at 7pm";
        let matched = parse_first(text, sunday_noon()).expect("a date");
        assert_eq!(&text[matched.index..matched.end_index()], "tomorrow at 7pm");
    }

    #[test]
    fn an_impossible_date_is_not_a_date() {
        assert!(parse_first("deadline february 30", sunday_noon()).is_none());
    }

    // The cases below cover behaviour the parity corpora do not reach — found
    // by mutating the engine and watching the corpora stay green. Every
    // expectation here was read off the TypeScript reference (see
    // `pnpm --filter @pikos/core probe:chrono`), not reasoned out.

    #[test]
    fn a_weekday_written_before_a_date_joins_it() {
        let matched = at("meeting tuesday, january 13");
        assert_eq!(matched.text, "tuesday, january 13");
        assert_eq!(matched.start.at.to_string(), "2027-01-13 12:00:00");
        assert_eq!(
            matched.start.certain,
            vec![Granularity::Day, Granularity::Month, Granularity::Weekday]
        );
    }

    #[test]
    fn a_year_written_after_a_date_is_pulled_into_it() {
        let matched = at("trip 14/4 2026");
        assert_eq!(matched.text, "14/4 2026");
        assert_eq!(matched.start.at.to_string(), "2026-04-14 12:00:00");
        assert!(matched.start.is_certain(Granularity::Year));
    }

    #[test]
    fn a_three_letter_month_abbreviation_alone_is_a_word_not_a_month() {
        // "sep" and "jun" read as ordinary words far too often to risk; the
        // four-letter "sept" does not.
        assert!(parse_first("note sep", sunday_noon()).is_none());
        assert!(parse_first("note jun", sunday_noon()).is_none());
        let matched = at("plan sept");
        assert_eq!(matched.text, "sept");
        assert_eq!(matched.start.at.to_string(), "2026-09-01 12:00:00");
    }

    #[test]
    fn slashed_numbers_read_month_first() {
        // Both digits are plausible months, so nothing disambiguates but the
        // convention — and the convention here is American.
        let matched = at("meet 3/4");
        assert_eq!(matched.text, "3/4");
        assert_eq!(matched.start.at.to_string(), "2027-03-04 12:00:00");

        // Above twelve, the only possible reading wins whichever side it is on.
        assert_eq!(at("16/3").start.at.to_string(), "2026-03-16 12:00:00");
        assert_eq!(at("3/16").start.at.to_string(), "2026-03-16 12:00:00");
    }

    #[test]
    fn a_weekday_naming_today_turns_on_midday() {
        // A bare weekday lands at midday, and the forward rule is applied to
        // that, not to the moment of asking. So on a Monday morning "monday"
        // is still today; by the afternoon the same word means next week.
        let monday_morning: NaiveDateTime = "2026-03-16T08:00:00".parse().expect("valid");
        let matched = parse_first("call monday", monday_morning).expect("a date");
        assert_eq!(matched.start.at.to_string(), "2026-03-16 12:00:00");

        let monday_afternoon: NaiveDateTime = "2026-03-16T14:00:00".parse().expect("valid");
        let matched = parse_first("call monday", monday_afternoon).expect("a date");
        assert_eq!(matched.start.at.to_string(), "2026-03-23 12:00:00");
    }
}
