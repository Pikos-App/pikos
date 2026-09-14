//! Quick-add: one line of text in, a page (or a series of them) out.
//!
//! "standup every weekday at 9am #work for 2 weeks" becomes a recurring page
//! titled "standup", tagged `work`, starting at 09:00 on the next weekday, with
//! `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;UNTIL=…`. This is the port of
//! `packages/core/src/nlp/parser.ts`, and the TypeScript side stays the
//! reference until it is retired — `tests/quick_add_parity.rs` grades every
//! case in the corpus.
//!
//! The shape is a pipeline, and the order within it is load-bearing:
//!
//! 1. **rewrite** the phrasings the date engine cannot resolve (`tokens::rewrite`);
//! 2. **extract** the inline markers — tags, folder, priority, duration, window
//!    (`tokens::extract`);
//! 3. **detect** the cadence (`recurrence::detect`);
//! 4. **read the date** with [`crate::nlp`], and cut it out of the text;
//! 5. whatever survives is the **title**.
//!
//! Cadence has to be read before the date, because "every tuesday" would
//! otherwise be consumed as the date "tuesday" and the recurrence lost.

mod recurrence;
mod text;
mod tokens;

use std::sync::OnceLock;

use chrono::{NaiveDateTime, Timelike};

use crate::dates::{format_date_only, format_local_iso, is_all_day_iso, parse_local_iso};
use crate::nlp::{parse_first, Granularity};

pub use recurrence::Weekday;
pub use tokens::Priority;

use recurrence::{Bound, Cadence, Frequency, Window, WEEKDAY_DAYS};
use text::{
    add_days, add_minutes, compile, difference_in_minutes, group, replace_all_with, with_time,
};

/// One page's worth of parsed input. Every field beyond the title is optional
/// because quick-add is a single line — most of them are usually absent.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ParsedInput {
    pub title: String,
    /// `YYYY-MM-DD` for an all-day page, `YYYY-MM-DDTHH:MM:SS` for a timed one.
    pub scheduled_start: Option<String>,
    pub scheduled_end: Option<String>,
    pub duration_minutes: Option<i64>,
    pub tags: Vec<String>,
    pub folder_query: Option<String>,
    /// `None` when no priority was written; `Some(None)` when `!0` cleared one.
    /// The two are different edits, so they cannot collapse into one `Option`.
    pub priority: Option<Option<Priority>>,
    /// Reminder rows to write, as `minutes_before` values: ascending, deduped,
    /// and already resolved against the schedule's shape. `None` when nothing
    /// was asked for — or when what was asked for has no schedule to anchor
    /// to, in which case the words stay in the title.
    pub reminder_minutes: Option<Vec<i64>>,
    /// The page body, from everything after the first whitespace-delimited
    /// `//`. Kept verbatim: no tag, folder, date or cadence is read out of it.
    pub content: Option<String>,
}

/// The `minutes_before` value that means "the day before, at 09:00 local"
/// rather than a lead time in minutes. The same sentinel as
/// `pikos_db::DAY_BEFORE_MINUTES`, which this crate cannot name; the FFI
/// crate, which depends on both, pins the two equal.
pub const DAY_BEFORE_MINUTES: i64 = -2;

/// What the line asked for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParseResult {
    /// One page.
    Single { input: ParsedInput },
    /// Several concrete pages — the user named specific days rather than a
    /// rule ("m/w/f", "weekdays").
    Finite { inputs: Vec<ParsedInput> },
    /// One page plus a rule; occurrences are expanded at render time.
    Recurring { input: ParsedInput, rrule: String },
}

/// A finite series is capped so a mistyped line cannot allocate without bound.
///
/// The reference has no cap at all: it hands whatever number it read straight
/// to the expander, so "99999 times" tries to build 99,999 pages. And the
/// number need not even have been typed — "mon/wed/fri 10 times" resolves
/// "fri 10" to a concrete date, leaving "2026  times" behind, which the window
/// rule then reads as a count of 2026. A typo becomes two thousand pages.
///
/// Ten thousand is far above any real use and far above that accident, so the
/// cap is a memory bound rather than a behaviour difference — but it *is* a
/// difference above it, where the reference would keep going and this stops.
/// Deliberate: an unbounded allocation driven by parsed text is not something
/// to reproduce faithfully.
const MAX_FINITE_OCCURRENCES: usize = 10_000;

/// Parse one line of quick-add input.
pub fn parse_input(raw: &str, reference: NaiveDateTime) -> ParseResult {
    if raw.trim().is_empty() {
        return ParseResult::Single {
            input: ParsedInput::default(),
        };
    }

    // Body split: "buy a gift // she likes the blue one". Everything after
    // the first whitespace-delimited "//" is the page body and sees none of
    // the pipeline below, so a "#word" in a note stays literal text.
    let (head, content) = split_body(raw);

    let text = tokens::rewrite(head, reference);
    let (text, tokens) = tokens::extract(&text, reference);
    let (text, mut cadence) = recurrence::detect(&text);

    // `@` is a prefix marker in the input box; the date engine should see the
    // word without it.
    static AT_PREFIX: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let at_prefix = AT_PREFIX.get_or_init(|| compile("@(\\S+)"));
    let mut text = replace_all_with(&text, at_prefix, |captures| {
        group(captures, 1).unwrap_or_default().to_string()
    });

    let matched = parse_first(&text, reference);

    let mut scheduled_start: Option<String> = None;
    let mut has_time = false;
    // A time range's end ("3pm to 5pm") and a date range's end ("april 18-25")
    // are applied differently, so they are kept apart.
    let mut range_end_time: Option<NaiveDateTime> = None;
    let mut range_end_date: Option<NaiveDateTime> = None;

    if let Some(matched) = &matched {
        if let Some(end) = &matched.end {
            if end.is_certain(Granularity::Hour) || end.is_certain(Granularity::Minute) {
                range_end_time = Some(end.at);
            } else if end.is_certain(Granularity::Day) {
                range_end_date = Some(end.at);
            }
        }

        has_time = matched.start.is_certain(Granularity::Hour)
            || matched.start.is_certain(Granularity::Minute);
        // A bare weekday is certain about the weekday but not the day, which
        // still counts as having named a date.
        let has_date = matched.start.is_certain(Granularity::Day)
            || matched.start.is_certain(Granularity::Month)
            || matched.start.is_certain(Granularity::Year)
            || matched.start.is_certain(Granularity::Weekday);

        let parsed = matched.start.at;
        if has_time && !has_date {
            // A time with no date. When the cadence names a weekday, anchor to
            // that weekday rather than defaulting to today or tomorrow —
            // "every monday at 9am" means Monday, not tomorrow.
            let anchor = match &cadence {
                Some(Cadence::Infinite {
                    byday: Some(days), ..
                }) if !days.is_empty() => next_weekday_occurrence(reference, days[0]),
                _ => None,
            };
            scheduled_start = match anchor {
                Some(anchor) => with_time(anchor, parsed.hour(), parsed.minute())
                    .map(|at| format_local_iso(&at)),
                None => {
                    let today = with_time(reference, parsed.hour(), parsed.minute());
                    today.and_then(|today| {
                        if today <= reference {
                            add_days(today, 1).map(|at| format_local_iso(&at))
                        } else {
                            Some(format_local_iso(&today))
                        }
                    })
                }
            };
        } else if has_date && has_time {
            scheduled_start = Some(format_local_iso(&parsed));
        } else if has_date {
            scheduled_start = Some(format_date_only(&parsed));
        }

        // Cut the date out of the title. The engine's match sometimes absorbs
        // a leading connector ("on friday", "at 9am") and sometimes does not
        // ("on May 24", "from <date>"), so a dangling one is swallowed here —
        // otherwise it leaks into the title.
        let mut consume_start = matched.index;
        static CONNECTOR: OnceLock<fancy_regex::Regex> = OnceLock::new();
        let connector = CONNECTOR.get_or_init(|| compile("\\b(?:from|on|at|by|for)\\s+$"));
        if let Ok(Some(found)) = connector.find(&text[..matched.index]) {
            consume_start = found.start();
        }
        text = format!(
            "{} {}",
            &text[..consume_start],
            &text[matched.end_index()..]
        );
    }

    // "every week" plus a weekday read as a date ("every week on monday")
    // becomes a self-documenting rule rather than a bare weekly one.
    if let (
        Some(Cadence::Infinite {
            freq: Frequency::Weekly,
            byday: byday @ None,
            ..
        }),
        Some(matched),
    ) = (cadence.as_mut(), &matched)
    {
        // The weekday the text named, not the one the resolved date falls on.
        // "every 2 weeks on friday dec 28" states Friday over a Monday, and the
        // rule repeats on the stated day.
        if let Some(day) = matched
            .start
            .stated_weekday
            .and_then(|weekday| Weekday::from_sunday_zero(i64::from(weekday)))
        {
            *byday = Some(vec![day]);
        }
    }

    // A cadence that names weekdays but no date at all starts on the next such
    // weekday.
    if scheduled_start.is_none() {
        if let Some(Cadence::Infinite {
            byday: Some(days), ..
        }) = &cadence
        {
            if let Some(first) = days.first() {
                scheduled_start =
                    next_weekday_occurrence(reference, *first).map(|at| format_date_only(&at));
            }
        }
    }

    // Reminder resolution. Every reminder arm of the scheduler joins the
    // schedule table, so a lead on an unscheduled page could never fire:
    // without a schedule the words go back into the title verbatim rather
    // than becoming a row that never rings. With one, the schedule's own
    // shape decides what the row holds — an all-day page has no start time to
    // count minutes back from, so every lead collapses onto the one anchor
    // such a page can carry; a timed page keeps the minutes as typed.
    let mut reminder_minutes: Option<Vec<i64>> = None;
    if !tokens.reminder_tokens.is_empty() {
        if let Some(start) = &scheduled_start {
            let leads = if is_all_day_iso(start) {
                vec![DAY_BEFORE_MINUTES]
            } else {
                tokens.reminder_leads.clone()
            };
            let mut unique: Vec<i64> = Vec::new();
            for lead in leads {
                if !unique.contains(&lead) {
                    unique.push(lead);
                }
            }
            unique.sort_unstable();
            reminder_minutes = Some(unique);
        }
        for (index, token) in tokens.reminder_tokens.iter().enumerate() {
            let restored = if reminder_minutes.is_some() {
                " ".to_string()
            } else {
                format!(" {token} ")
            };
            text = text.replacen(&tokens::reminder_placeholder(index), &restored, 1);
        }
    }

    let title = clean_title(&text);
    let mut base = ParsedInput {
        title,
        tags: tokens.tags.clone(),
        folder_query: tokens.folder_query.clone(),
        priority: tokens.priority,
        duration_minutes: tokens.duration_minutes,
        reminder_minutes,
        content: content.clone(),
        ..Default::default()
    };

    if let Some(start) = &scheduled_start {
        base.scheduled_start = Some(start.clone());
        let start_at = parse_local_iso(start);

        if let (Some(duration), true, Some(start_at)) =
            (tokens.duration_minutes, has_time, start_at)
        {
            base.scheduled_end = add_minutes(start_at, duration).map(|at| format_local_iso(&at));
        } else if let (Some(end_time), true, Some(start_at)) = (range_end_time, has_time, start_at)
        {
            // A time range on the start's own date. One that crosses midnight
            // ("9pm to 5am") lands before the start, so it belongs to the next
            // day and the duration needs the missing 24 hours back.
            if let Some(mut end_at) = with_time(start_at, end_time.hour(), end_time.minute()) {
                let mut minutes = difference_in_minutes(end_at, start_at);
                if minutes < 0 {
                    if let Some(next_day) = add_days(end_at, 1) {
                        end_at = next_day;
                        minutes += 24 * 60;
                    }
                }
                base.scheduled_end = Some(format_local_iso(&end_at));
                if minutes > 0 {
                    base.duration_minutes = Some(minutes);
                }
            }
        } else if let (Some(end_date), false, true) =
            (range_end_date, has_time, is_all_day_iso(start))
        {
            // A multi-day all-day span. Timed multi-day ranges are deliberately
            // unsupported — their semantics are ambiguous.
            let end = format_date_only(&end_date);
            if end.as_str() > start.as_str() {
                base.scheduled_end = Some(end);
            }
        }
    }

    // A window with no cadence ("10 times", "for 2 weeks") means daily — the
    // count the user typed is a signal worth keeping rather than stripping.
    if tokens.window.is_some() && cadence.is_none() {
        cadence = Some(Cadence::Infinite {
            freq: Frequency::Daily,
            byday: None,
            interval: None,
        });
    }

    match (cadence, tokens.window) {
        (
            Some(Cadence::Infinite {
                freq,
                byday,
                interval,
            }),
            window,
        ) => {
            let bound =
                window.map(|window| bound_for(window, scheduled_start.as_deref(), reference));
            let rrule = recurrence::to_rrule(freq, byday.as_deref(), interval, bound.as_ref());
            ParseResult::Recurring { input: base, rrule }
        }
        (Some(finite), window) => {
            let days: Vec<Weekday> = match &finite {
                Cadence::FiniteWeekdays => WEEKDAY_DAYS.to_vec(),
                Cadence::FiniteSlash { days } => days.clone(),
                Cadence::Infinite { .. } => unreachable!("matched above"),
            };
            let window_start = scheduled_start
                .as_deref()
                .and_then(parse_local_iso)
                .unwrap_or(reference);

            let bound = match window {
                Some(Window::Count(count)) => Bound::Count(count),
                Some(Window::Until(until)) => Bound::Until(until),
                Some(Window::Days(count)) => {
                    match add_days(window_start, i64::from(count).saturating_sub(1)) {
                        Some(until) => Bound::Until(until),
                        None => Bound::Count(0),
                    }
                }
                None if matches!(finite, Cadence::FiniteWeekdays) => Bound::Count(5),
                None => Bound::Count(days.len() as u32),
            };

            let occurrences =
                recurrence::expand_weekly(window_start, &days, &bound, MAX_FINITE_OCCURRENCES);
            let timed_start = scheduled_start.as_deref().and_then(parse_local_iso);
            let inputs = occurrences
                .into_iter()
                .map(|at| {
                    let mut input = base.clone();
                    match timed_start.filter(|_| has_time) {
                        Some(start_at) => {
                            let dated = with_time(at, start_at.hour(), start_at.minute());
                            input.scheduled_start = dated.map(|at| format_local_iso(&at));
                            // Only an *explicitly written* duration ("for 2h")
                            // re-derives the end for each occurrence. A duration
                            // that came from a time range instead leaves the end
                            // exactly as the single-page path computed it — the
                            // same end, on the first occurrence's date, for every
                            // page in the series.
                            //
                            // That is the reference's behaviour and almost
                            // certainly a bug in it: `parseInput` tests its local
                            // `durationMinutes`, which a range never sets, while
                            // writing the range's own duration onto the page. It
                            // is reproduced rather than fixed because the
                            // TypeScript side is the reference until it is
                            // retired; fixing it belongs there, where the change
                            // shows up in one diff for both platforms.
                            if let Some(duration) = tokens.duration_minutes {
                                input.scheduled_end = dated
                                    .and_then(|at| add_minutes(at, duration))
                                    .map(|at| format_local_iso(&at));
                            }
                        }
                        None => {
                            input.scheduled_start = Some(format_date_only(&at));
                            input.scheduled_end = None;
                        }
                    }
                    input
                })
                .collect();
            ParseResult::Finite { inputs }
        }
        (None, _) => ParseResult::Single { input: base },
    }
}

/// The bound an RRULE carries for a given window.
fn bound_for(window: Window, scheduled_start: Option<&str>, reference: NaiveDateTime) -> Bound {
    match window {
        Window::Count(count) => Bound::Count(count),
        Window::Until(until) => Bound::Until(until),
        Window::Days(count) => {
            let start = scheduled_start
                .and_then(parse_local_iso)
                .unwrap_or(reference);
            match add_days(start, i64::from(count).saturating_sub(1)) {
                Some(boundary) => Bound::Until(boundary),
                None => Bound::Until(start),
            }
        }
    }
}

fn weekday_of(date: NaiveDateTime) -> i64 {
    i64::from(chrono::Datelike::weekday(&date).num_days_from_sunday())
}

/// The next date falling on `weekday`. Today never counts — "every monday"
/// written on a Monday means the one coming, matching how a bare weekday reads
/// once the day is under way.
fn next_weekday_occurrence(reference: NaiveDateTime, weekday: Weekday) -> Option<NaiveDateTime> {
    let mut ahead = weekday.sunday_zero() - weekday_of(reference);
    if ahead < 0 {
        ahead += 7;
    }
    if ahead == 0 {
        ahead = 7;
    }
    add_days(reference, ahead)
}

/// Collapse whitespace and tidy the punctuation left stranded when an inline
/// marker was cut out of the middle of a sentence.
///
/// Sentence punctuation keeps its place but loses the gap before it ("call ."
/// becomes "call."); separators that were only there to divide tokens are
/// dropped entirely ("note ," becomes "note"). Punctuation inside a word is
/// never touched — only whitespace-isolated orphans.
/// Split a line at its first `//` that sits on a whitespace boundary (or a
/// string edge) on both sides.
///
/// The boundary rule is what keeps `https://example.com` a URL and a later
/// `//` part of the body it belongs to. The head excludes the whitespace
/// before the separator; the body is trimmed, and an empty body is no body.
fn split_body(raw: &str) -> (&str, Option<String>) {
    let mut from = 0usize;
    while let Some(found) = raw[from..].find("//") {
        let at = from + found;
        let before = raw[..at].chars().next_back();
        let after = raw[at + 2..].chars().next();
        let boundary_before = before.is_none_or(char::is_whitespace);
        let boundary_after = after.is_none_or(char::is_whitespace);
        if boundary_before && boundary_after {
            let head_end = at - before.map_or(0, char::len_utf8);
            let body = raw[at + 2..].trim();
            let content = (!body.is_empty()).then(|| body.to_string());
            return (&raw[..head_end], content);
        }
        from = at + 2;
    }
    (raw, None)
}

fn clean_title(text: &str) -> String {
    static WHITESPACE: OnceLock<fancy_regex::Regex> = OnceLock::new();
    static SENTENCE_ORPHAN: OnceLock<fancy_regex::Regex> = OnceLock::new();
    static SEPARATOR_ORPHAN: OnceLock<fancy_regex::Regex> = OnceLock::new();
    static LEADING: OnceLock<fancy_regex::Regex> = OnceLock::new();

    let whitespace = WHITESPACE.get_or_init(|| compile("\\s+"));
    let sentence_orphan = SENTENCE_ORPHAN.get_or_init(|| compile("\\s+([.!?])(?=\\s|$)"));
    let separator_orphan = SEPARATOR_ORPHAN.get_or_init(|| compile("\\s+[,;:]+(?=\\s|$)"));
    let leading = LEADING.get_or_init(|| compile("^[\\s,;:]+"));

    let collapsed = replace_all_with(text, whitespace, |_| " ".to_string());
    let kept = replace_all_with(&collapsed, sentence_orphan, |captures| {
        group(captures, 1).unwrap_or_default().to_string()
    });
    let dropped = replace_all_with(&kept, separator_orphan, |_| String::new());
    let trimmed = replace_all_with(&dropped, leading, |_| String::new());
    trimmed.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sunday_noon() -> NaiveDateTime {
        "2026-03-15T12:00:00".parse().expect("valid")
    }

    fn single(text: &str) -> ParsedInput {
        match parse_input(text, sunday_noon()) {
            ParseResult::Single { input } => input,
            other => panic!("expected a single page, got {other:?}"),
        }
    }

    #[test]
    fn the_body_after_a_double_slash_is_kept_verbatim() {
        let input = single("Buy a gift // remember #blue and ~folder !urgent tomorrow");
        assert_eq!(input.title, "Buy a gift");
        assert_eq!(
            input.content.as_deref(),
            Some("remember #blue and ~folder !urgent tomorrow")
        );
        // Nothing in the body is read as a marker.
        assert!(input.tags.is_empty());
        assert_eq!(input.folder_query, None);
        assert_eq!(input.priority, None);
        assert_eq!(input.scheduled_start, None);
    }

    #[test]
    fn a_double_slash_inside_a_word_is_not_a_body_split() {
        let input = single("Review PR tomorrow at 2pm // see https://example.com for #context");
        assert_eq!(input.title, "Review PR");
        assert_eq!(
            input.content.as_deref(),
            Some("see https://example.com for #context")
        );
        assert_eq!(single("open https://example.com").content, None);
    }

    #[test]
    fn a_trailing_double_slash_leaves_no_body() {
        let input = single("Task //");
        assert_eq!(input.title, "Task");
        assert_eq!(input.content, None);
        assert_eq!(
            single("// just a note").content.as_deref(),
            Some("just a note")
        );
    }

    #[test]
    fn a_reminder_on_a_timed_page_keeps_its_minutes() {
        let input = single("Dentist tomorrow at 3pm remind 30m before");
        assert_eq!(input.title, "Dentist");
        assert_eq!(
            input.scheduled_start.as_deref(),
            Some("2026-03-16T15:00:00")
        );
        assert_eq!(input.reminder_minutes, Some(vec![30]));

        let shorthand = single("Dentist tomorrow at 3pm !r1h !r1h !r15");
        assert_eq!(shorthand.reminder_minutes, Some(vec![15, 60]));
        assert_eq!(shorthand.title, "Dentist");
    }

    #[test]
    fn a_reminder_on_an_all_day_page_becomes_the_day_before_anchor() {
        let input = single("Dentist tomorrow remind 1d before");
        assert_eq!(input.scheduled_start.as_deref(), Some("2026-03-16"));
        assert_eq!(input.reminder_minutes, Some(vec![DAY_BEFORE_MINUTES]));
    }

    #[test]
    fn a_reminder_with_nothing_to_anchor_to_stays_in_the_title() {
        let input = single("Call mom remind 30m before");
        assert_eq!(input.title, "Call mom remind 30m before");
        assert_eq!(input.reminder_minutes, None);
    }

    #[test]
    fn remind_me_in_two_days_is_a_date_not_a_lead() {
        let input = single("Ping team remind me in 2 days");
        assert_eq!(input.reminder_minutes, None);
        assert_eq!(input.scheduled_start.as_deref(), Some("2026-03-17"));
    }

    #[test]
    fn an_empty_line_is_an_empty_page() {
        assert_eq!(
            parse_input("", sunday_noon()),
            ParseResult::Single {
                input: ParsedInput::default()
            }
        );
        assert_eq!(
            parse_input("   ", sunday_noon()),
            ParseResult::Single {
                input: ParsedInput::default()
            }
        );
    }

    #[test]
    fn every_marker_comes_out_and_the_title_is_what_is_left() {
        let input = single("call bob #work ~inbox !high for 2h tomorrow at 3pm");
        assert_eq!(input.title, "call bob");
        assert_eq!(input.tags, ["work"]);
        assert_eq!(input.folder_query.as_deref(), Some("inbox"));
        assert_eq!(input.priority, Some(Some(Priority::High)));
        assert_eq!(input.duration_minutes, Some(120));
        assert_eq!(
            input.scheduled_start.as_deref(),
            Some("2026-03-16T15:00:00")
        );
        assert_eq!(input.scheduled_end.as_deref(), Some("2026-03-16T17:00:00"));
    }

    #[test]
    fn a_cadence_beats_the_date_engine_for_the_same_word() {
        // "every tuesday" must not be consumed as the date "tuesday".
        let ParseResult::Recurring { input, rrule } =
            parse_input("gym every tuesday", sunday_noon())
        else {
            panic!("expected a recurring page");
        };
        assert_eq!(rrule, "FREQ=WEEKLY;BYDAY=TU");
        assert_eq!(input.title, "gym");
        assert_eq!(input.scheduled_start.as_deref(), Some("2026-03-17"));
    }

    #[test]
    fn a_bare_day_list_makes_concrete_pages() {
        let ParseResult::Finite { inputs } = parse_input("run m/w/f at 3pm", sunday_noon()) else {
            panic!("expected a finite series");
        };
        let starts: Vec<_> = inputs
            .iter()
            .map(|i| i.scheduled_start.as_deref().unwrap_or_default())
            .collect();
        assert_eq!(
            starts,
            [
                "2026-03-16T15:00:00",
                "2026-03-18T15:00:00",
                "2026-03-20T15:00:00"
            ]
        );
    }

    #[test]
    fn a_window_without_a_cadence_means_daily() {
        let ParseResult::Recurring { rrule, .. } =
            parse_input("water plants 10 times", sunday_noon())
        else {
            panic!("expected a recurring page");
        };
        assert_eq!(rrule, "FREQ=DAILY;COUNT=10");
    }

    #[test]
    fn a_time_range_sets_the_end_and_the_duration() {
        let input = single("workshop 9am-5pm");
        assert_eq!(
            input.scheduled_start.as_deref(),
            Some("2026-03-16T09:00:00")
        );
        assert_eq!(input.scheduled_end.as_deref(), Some("2026-03-16T17:00:00"));
        assert_eq!(input.duration_minutes, Some(480));
    }

    #[test]
    fn a_range_across_midnight_ends_the_next_day() {
        let input = single("shift 9pm to 5am");
        assert_eq!(
            input.scheduled_start.as_deref(),
            Some("2026-03-15T21:00:00")
        );
        assert_eq!(input.scheduled_end.as_deref(), Some("2026-03-16T05:00:00"));
        assert_eq!(input.duration_minutes, Some(480));
    }

    #[test]
    fn a_multi_day_span_stays_all_day() {
        let input = single("trip april 18-25");
        assert_eq!(input.scheduled_start.as_deref(), Some("2026-04-18"));
        assert_eq!(input.scheduled_end.as_deref(), Some("2026-04-25"));
    }

    #[test]
    fn punctuation_left_by_a_stripped_marker_is_tidied() {
        assert_eq!(single("call bob #work.").title, "call bob.");
        assert_eq!(single("note #a, #b").title, "note");
    }

    // The cases below were found by differential fuzzing, not by reading —
    // each is a class the 317-input corpus never reached. See
    // `tests/quick_add_fuzz.rs`.

    #[test]
    fn a_series_keeps_the_end_a_time_range_gave_it() {
        // The range sets the end and the duration on the page; the series then
        // inherits that end unchanged, the same end on the first occurrence's
        // date for every page. That is the reference's behaviour — see the
        // note where it is reproduced — and the port has to match it, quirk
        // and all, because the reference is the reference.
        let ParseResult::Finite { inputs } = parse_input("gym m/w/f 9pm to 5am", sunday_noon())
        else {
            panic!("expected a finite series");
        };
        assert_eq!(inputs.len(), 3);
        for input in &inputs {
            assert_eq!(input.scheduled_end.as_deref(), Some("2026-03-16T05:00:00"));
            assert_eq!(input.duration_minutes, Some(480));
        }
        // Only the starts advance.
        assert_eq!(
            inputs
                .iter()
                .map(|i| i.scheduled_start.as_deref().unwrap_or_default())
                .collect::<Vec<_>>(),
            [
                "2026-03-16T21:00:00",
                "2026-03-18T21:00:00",
                "2026-03-20T21:00:00"
            ]
        );
    }

    #[test]
    fn an_explicit_duration_re_derives_the_end_for_each_page() {
        // The other half of the rule above: a duration the user wrote out does
        // move with each occurrence.
        let ParseResult::Finite { inputs } = parse_input("gym m/w/f at 9am for 2h", sunday_noon())
        else {
            panic!("expected a finite series");
        };
        assert_eq!(
            inputs
                .iter()
                .map(|i| i.scheduled_end.as_deref().unwrap_or_default())
                .collect::<Vec<_>>(),
            [
                "2026-03-16T11:00:00",
                "2026-03-18T11:00:00",
                "2026-03-20T11:00:00"
            ]
        );
    }

    #[test]
    fn a_rule_repeats_on_the_weekday_the_text_named() {
        // 2026-12-28 is a Monday, and the line says Friday. The date wins for
        // *when this one starts*; the weekday wins for *what the rule repeats
        // on*. Deriving the rule's day from the resolved date instead — the
        // obvious shortcut — turns this into a Monday rule.
        let ParseResult::Recurring { input, rrule } =
            parse_input("every 2 weeks on friday dec 28 to jan 3", sunday_noon())
        else {
            panic!("expected a recurring page");
        };
        assert_eq!(rrule, "FREQ=WEEKLY;INTERVAL=2;BYDAY=FR");
        assert_eq!(input.scheduled_start.as_deref(), Some("2026-12-28"));
    }

    #[test]
    fn a_series_longer_than_a_few_years_is_not_silently_truncated() {
        // "fri 10" resolves to a date, leaving "2026  times" behind, which the
        // window rule reads as a count of 2026. Absurd, and exactly the
        // reference's behaviour — the point here is that the series is 2,026
        // pages and not some smaller number an internal limit chose.
        let ParseResult::Finite { inputs } = parse_input("mon/wed/fri 10 times", sunday_noon())
        else {
            panic!("expected a finite series");
        };
        assert_eq!(inputs.len(), 2026);
    }

    #[test]
    fn a_time_with_no_date_anchors_to_the_cadences_weekday() {
        let ParseResult::Recurring { input, .. } =
            parse_input("standup every monday at 9am", sunday_noon())
        else {
            panic!("expected a recurring page");
        };
        assert_eq!(
            input.scheduled_start.as_deref(),
            Some("2026-03-16T09:00:00")
        );
    }
}
