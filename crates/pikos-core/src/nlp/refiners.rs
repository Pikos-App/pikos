//! The refiners, in the order they run.
//!
//! Parsers are deliberately naive — each claims whatever its pattern matches,
//! knowing nothing about the others. Everything that makes a sentence parse
//! sensibly happens here: overlapping claims are resolved in favour of the
//! longest, a date and a time next to each other become one datetime, a
//! trailing year is pulled in, two dates joined by "to" become a range, and
//! implied dates are pushed into the future. Order is not incidental — the
//! range refiner runs last precisely because it needs everything else settled.

use fancy_regex::Regex;

use super::components::{
    add_duration, Component, Duration, ParsingComponents, ParsingResult, MERIDIEM_PM,
};
use super::dict::parse_year;
use super::engine::{
    refine_by_filtering, refine_by_merging, Context, Filter, MergingRefiner, Refiner,
};
use super::jsdate::JsDate;

fn matches(pattern: &str, text: &str) -> bool {
    Regex::new(pattern)
        .expect("static pattern")
        .is_match(text)
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Overlap removal: when two results claim overlapping text, the longer wins.
// ---------------------------------------------------------------------------

pub struct OverlapRemovalRefiner;

impl Refiner for OverlapRemovalRefiner {
    fn refine(&self, _context: &Context, results: Vec<ParsingResult>) -> Vec<ParsingResult> {
        if results.len() < 2 {
            return results;
        }
        let mut filtered = Vec::new();
        let mut iterator = results.into_iter();
        let mut previous = iterator.next().expect("length checked");

        for result in iterator {
            if result.index >= previous.index + previous.text.len() {
                filtered.push(previous);
                previous = result;
                continue;
            }
            if result.text.len() > previous.text.len() {
                previous = result;
            }
        }
        filtered.push(previous);
        filtered
    }
}

// ---------------------------------------------------------------------------
// Weekday + date: "Tuesday, January 13" is one result, not two.
// ---------------------------------------------------------------------------

pub struct MergeWeekdayComponentRefiner;

impl MergingRefiner for MergeWeekdayComponentRefiner {
    fn should_merge(
        &self,
        _context: &Context,
        text_between: &str,
        current: &ParsingResult,
        next: &ParsingResult,
    ) -> bool {
        current.start.is_only_weekday_component()
            && !current.start.is_certain(Component::Hour)
            && next.start.is_certain(Component::Day)
            && matches("^,?\\s*$", text_between)
    }

    fn merge(
        &self,
        _context: &Context,
        text_between: &str,
        current: ParsingResult,
        next: ParsingResult,
    ) -> ParsingResult {
        let weekday = current.start.get(Component::Weekday);
        let mut merged = next;
        merged.text = format!("{}{}{}", current.text, text_between, merged.text);
        merged.index = current.index;
        if let Some(weekday) = weekday {
            merged.start.assign(Component::Weekday, weekday);
            if let Some(end) = merged.end.as_mut() {
                end.assign(Component::Weekday, weekday);
            }
        }
        merged
    }
}

impl Refiner for MergeWeekdayComponentRefiner {
    fn refine(&self, context: &Context, results: Vec<ParsingResult>) -> Vec<ParsingResult> {
        refine_by_merging(self, context, results)
    }
}

// ---------------------------------------------------------------------------
// Date + time: "april 18 at 3pm".
// ---------------------------------------------------------------------------

pub struct MergeDateTimeRefiner;

impl MergingRefiner for MergeDateTimeRefiner {
    fn should_merge(
        &self,
        _context: &Context,
        text_between: &str,
        current: &ParsingResult,
        next: &ParsingResult,
    ) -> bool {
        let one_of_each = (current.start.is_only_date() && next.start.is_only_time())
            || (next.start.is_only_date() && current.start.is_only_time());
        one_of_each
            && matches(
                "(?i)^\\s*(T|at|after|before|on|of|,|-|\\.|∙|:)?\\s*$",
                text_between,
            )
    }

    fn merge(
        &self,
        _context: &Context,
        text_between: &str,
        current: ParsingResult,
        next: ParsingResult,
    ) -> ParsingResult {
        let index = current.index;
        let text = format!("{}{}{}", current.text, text_between, next.text);
        let mut merged = if current.start.is_only_date() {
            merge_date_time_result(current, next)
        } else {
            merge_date_time_result(next, current)
        };
        merged.index = index;
        merged.text = text;
        merged
    }
}

impl Refiner for MergeDateTimeRefiner {
    fn refine(&self, context: &Context, results: Vec<ParsingResult>) -> Vec<ParsingResult> {
        refine_by_merging(self, context, results)
    }
}

fn merge_date_time_result(date: ParsingResult, time: ParsingResult) -> ParsingResult {
    let mut result = date.clone();
    result.start = merge_date_time_component(&date.start, &time.start);

    if date.end.is_some() || time.end.is_some() {
        let end_date = date.end.as_ref().unwrap_or(&date.start);
        let end_time = time.end.as_ref().unwrap_or(&time.start);
        let mut end = merge_date_time_component(end_date, end_time);

        // "Tuesday 9pm - 1am": only a time range was given, and it finishes
        // before it starts, so the finish belongs to the next day.
        if date.end.is_none() {
            let ends_before_it_starts = match (end.date(), result.start.date()) {
                (Some(end_at), Some(start_at)) => end_at < start_at,
                _ => false,
            };
            if ends_before_it_starts {
                if let Some(next_day) = end.date().and_then(|at| at.add_days(1)) {
                    if end.is_certain(Component::Day) {
                        end.assign_similar_date(next_day);
                    } else {
                        end.imply_similar_date(next_day);
                    }
                }
            }
        }
        result.end = Some(end);
    }
    result
}

fn merge_date_time_component(
    date: &ParsingComponents,
    time: &ParsingComponents,
) -> ParsingComponents {
    let mut merged = date.clone();

    if time.is_certain(Component::Hour) {
        if let Some(hour) = time.get(Component::Hour) {
            merged.assign(Component::Hour, hour);
        }
        if let Some(minute) = time.get(Component::Minute) {
            merged.assign(Component::Minute, minute);
        }
        if time.is_certain(Component::Second) {
            if let Some(second) = time.get(Component::Second) {
                merged.assign(Component::Second, second);
            }
            if let Some(millisecond) = time.get(Component::Millisecond) {
                if time.is_certain(Component::Millisecond) {
                    merged.assign(Component::Millisecond, millisecond);
                } else {
                    merged.imply(Component::Millisecond, millisecond);
                }
            }
        } else {
            if let Some(second) = time.get(Component::Second) {
                merged.imply(Component::Second, second);
            }
            if let Some(millisecond) = time.get(Component::Millisecond) {
                merged.imply(Component::Millisecond, millisecond);
            }
        }
    } else {
        for component in [
            Component::Hour,
            Component::Minute,
            Component::Second,
            Component::Millisecond,
        ] {
            if let Some(value) = time.get(component) {
                merged.imply(component, value);
            }
        }
    }

    if time.is_certain(Component::TimezoneOffset) {
        if let Some(offset) = time.get(Component::TimezoneOffset) {
            merged.assign(Component::TimezoneOffset, offset);
        }
    }

    if time.is_certain(Component::Meridiem) {
        if let Some(meridiem) = time.get(Component::Meridiem) {
            merged.assign(Component::Meridiem, meridiem);
        }
    } else if let Some(meridiem) = time.get(Component::Meridiem) {
        if merged.get(Component::Meridiem).is_none() {
            merged.imply(Component::Meridiem, meridiem);
        }
    }

    // A date that carried an afternoon meridiem lifts a bare hour into it:
    // "tomorrow evening at 7" is 19:00.
    if merged.get(Component::Meridiem) == Some(MERIDIEM_PM) {
        if let Some(hour) = merged.get(Component::Hour) {
            if hour < 12 {
                if time.is_certain(Component::Hour) {
                    merged.assign(Component::Hour, hour + 12);
                } else {
                    merged.imply(Component::Hour, hour + 12);
                }
            }
        }
    }

    merged
}

// ---------------------------------------------------------------------------
// A UTC offset written after a date: "2020-02-13 +09:00".
// ---------------------------------------------------------------------------

/// Pull a `+hh`/`-hh[:mm]` following a result into it.
///
/// This engine has no timezone concept of its own, and the offset it records is
/// never reported or stored — but the reference *applies* what it finds, so a
/// port that ignored it would disagree on the result's time and on how much
/// text the match claimed.
///
/// Worth knowing how loosely it fires: the pattern is a sign and one or two
/// digits, so a hyphen after a date is enough. In "may 2 to 10 2026-04-01" the
/// month-name parser claims "may 2 to 10 2026" and this reads the "-04" of the
/// *following date* as UTC-4, shifting the result four hours. That is the
/// reference's behaviour and almost certainly unwanted in a wall-clock app;
/// it is reproduced here rather than fixed because the fix belongs on the
/// TypeScript side, where it would land for both platforms at once.
pub struct ExtractTimezoneOffsetRefiner;

impl Refiner for ExtractTimezoneOffsetRefiner {
    fn refine(&self, context: &Context, mut results: Vec<ParsingResult>) -> Vec<ParsingResult> {
        let pattern =
            Regex::new("(?i)^\\s*(?:\\(?(?:GMT|UTC)\\s?)?([+-])([0-9]{1,2})(?::?([0-9]{2}))?\\)?")
                .expect("static pattern");

        for result in results.iter_mut() {
            if result.start.is_certain(Component::TimezoneOffset) {
                continue;
            }
            let suffix_start = result.index + result.text.len();
            let Some(suffix) = context.text.get(suffix_start..) else {
                continue;
            };
            let Ok(Some(captures)) = pattern.captures(suffix) else {
                continue;
            };
            let Some(hours) = captures.get(2).and_then(|m| m.as_str().parse::<i64>().ok()) else {
                continue;
            };
            let minutes = captures
                .get(3)
                .and_then(|m| m.as_str().parse::<i64>().ok())
                .unwrap_or(0);
            let mut offset = hours * 60 + minutes;
            // No real zone is more than fourteen hours out, so a larger number
            // is something else that happens to look like one.
            if offset > 14 * 60 {
                continue;
            }
            if captures.get(1).map(|m| m.as_str()) == Some("-") {
                offset = -offset;
            }

            if let Some(end) = result.end.as_mut() {
                end.assign(Component::TimezoneOffset, offset);
            }
            result.start.assign(Component::TimezoneOffset, offset);
            result
                .text
                .push_str(captures.get(0).expect("group 0").as_str());
        }
        results
    }
}

// ---------------------------------------------------------------------------
// A relative offset written beside a date: "2020-02-13 +2 weeks".
// ---------------------------------------------------------------------------

pub struct MergeRelativeAfterDateRefiner;

impl MergingRefiner for MergeRelativeAfterDateRefiner {
    fn should_merge(
        &self,
        _context: &Context,
        text_between: &str,
        _current: &ParsingResult,
        next: &ParsingResult,
    ) -> bool {
        matches("^\\s*$", text_between) && matches("^[+-]", &next.text)
    }

    fn merge(
        &self,
        _context: &Context,
        text_between: &str,
        current: ParsingResult,
        next: ParsingResult,
    ) -> ParsingResult {
        let text = format!("{}{}{}", current.text, text_between, next.text);
        let negative = next.text.starts_with('-');
        let duration = super::dict::parse_duration(&next.text).unwrap_or_default();
        let duration = if negative {
            duration.reversed()
        } else {
            duration
        };

        let anchored = current
            .start
            .date()
            .map(super::components::Reference::new)
            .and_then(|reference| ParsingComponents::relative_from_reference(reference, &duration));

        match anchored {
            Some(components) => ParsingResult::new(current.index, text, components),
            None => current,
        }
    }
}

impl Refiner for MergeRelativeAfterDateRefiner {
    fn refine(&self, context: &Context, results: Vec<ParsingResult>) -> Vec<ParsingResult> {
        refine_by_merging(self, context, results)
    }
}

// ---------------------------------------------------------------------------
// A relative offset written before a date: "2 weeks before 2020-02-13".
// ---------------------------------------------------------------------------

pub struct MergeRelativeFollowByDateRefiner;

fn implies_earlier_reference(result: &ParsingResult) -> bool {
    matches("(?i)\\s+(before|from)$", &result.text)
}

fn implies_later_reference(result: &ParsingResult) -> bool {
    matches("(?i)\\s+(after|since)$", &result.text)
}

impl MergingRefiner for MergeRelativeFollowByDateRefiner {
    fn should_merge(
        &self,
        _context: &Context,
        text_between: &str,
        current: &ParsingResult,
        next: &ParsingResult,
    ) -> bool {
        if !matches("^\\s*$", text_between) {
            return false;
        }
        if !implies_earlier_reference(current) && !implies_later_reference(current) {
            return false;
        }
        next.start.get(Component::Day).is_some_and(|v| v != 0)
            && next.start.get(Component::Month).is_some_and(|v| v != 0)
            && next.start.get(Component::Year).is_some_and(|v| v != 0)
    }

    fn merge(
        &self,
        _context: &Context,
        text_between: &str,
        current: ParsingResult,
        next: ParsingResult,
    ) -> ParsingResult {
        let text = format!("{}{}{}", current.text, text_between, next.text);
        let duration = super::dict::parse_duration(&current.text).unwrap_or_default();
        let duration = if implies_earlier_reference(&current) {
            duration.reversed()
        } else {
            duration
        };

        let anchored = next
            .start
            .date()
            .map(super::components::Reference::new)
            .and_then(|reference| ParsingComponents::relative_from_reference(reference, &duration));

        match anchored {
            Some(components) => ParsingResult::new(current.index, text, components),
            None => next,
        }
    }
}

impl Refiner for MergeRelativeFollowByDateRefiner {
    fn refine(&self, context: &Context, results: Vec<ParsingResult>) -> Vec<ParsingResult> {
        refine_by_merging(self, context, results)
    }
}

// ---------------------------------------------------------------------------
// Push implied dates into the future.
// ---------------------------------------------------------------------------

pub struct ForwardDateRefiner;

impl Refiner for ForwardDateRefiner {
    fn refine(&self, context: &Context, mut results: Vec<ParsingResult>) -> Vec<ParsingResult> {
        if !context.forward_date {
            return results;
        }
        for result in results.iter_mut() {
            forward_one(context, result);
        }
        results
    }
}

fn forward_one(context: &Context, result: &mut ParsingResult) {
    let mut reference = context.reference.instant;

    // A time with no date: if it has already passed today, it means tomorrow.
    let start_passed = result
        .start
        .date()
        .is_some_and(|at| context.reference.instant > at);
    if result.start.is_only_time() && start_passed {
        if let Some(following_day) = reference.add_days(1) {
            result.start.imply_similar_date(following_day);
            if let Some(end) = result.end.as_mut() {
                if end.is_only_time() {
                    end.imply_similar_date(following_day);
                    let inverted = match (result.start.date(), end.date()) {
                        (Some(start_at), Some(end_at)) => start_at > end_at,
                        _ => false,
                    };
                    if inverted {
                        if let Some(day_after) = following_day.add_days(1) {
                            end.imply_similar_date(day_after);
                        }
                    }
                }
            }
        }
    }

    // A bare weekday always means the coming one.
    let weekday_passed = result.start.date().is_some_and(|at| reference > at);
    if result.start.is_only_weekday_component() && weekday_passed {
        if let Some(weekday) = result.start.get(Component::Weekday) {
            let mut days = weekday - reference.weekday();
            if days <= 0 {
                days += 7;
            }
            if let Some(moved) = add_duration(reference, &Duration::days(days as f64)) {
                reference = moved;
                result.start.imply_similar_date(reference);
            }
        }
        if let Some(end) = result.end.as_mut() {
            if end.is_only_weekday_component() {
                if let Some(weekday) = end.get(Component::Weekday) {
                    let mut days = weekday - reference.weekday();
                    if days <= 0 {
                        days += 7;
                    }
                    if let Some(moved) = add_duration(reference, &Duration::days(days as f64)) {
                        reference = moved;
                        end.imply_similar_date(reference);
                    }
                }
            }
        }
    }

    // A month and day with no year: try the next year, up to three times.
    if result.start.is_date_with_unknown_year() {
        for _ in 0..3 {
            let past = result.start.date().is_some_and(|at| reference > at);
            if !past {
                break;
            }
            if let Some(year) = result.start.get(Component::Year) {
                result.start.imply(Component::Year, year + 1);
            }
            if let Some(end) = result.end.as_mut() {
                if !end.is_certain(Component::Year) {
                    if let Some(year) = end.get(Component::Year) {
                        end.imply(Component::Year, year + 1);
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Drop results that cannot be dates.
// ---------------------------------------------------------------------------

pub struct UnlikelyFormatFilter;

impl Filter for UnlikelyFormatFilter {
    fn is_valid(&self, _context: &Context, result: &ParsingResult) -> bool {
        // Bare digits, however they are spaced, are not a date.
        if matches("^[0-9]*(\\.[0-9]*)?$", &result.text.replacen(' ', "", 1)) {
            return false;
        }
        if !result.start.is_valid_date() {
            return false;
        }
        if let Some(end) = &result.end {
            if !end.is_valid_date() {
                return false;
            }
        }
        true
    }
}

impl Refiner for UnlikelyFormatFilter {
    fn refine(&self, context: &Context, results: Vec<ParsingResult>) -> Vec<ParsingResult> {
        refine_by_filtering(self, context, results)
    }
}

/// English's own ambiguities: "may" is usually a verb, and "the second" is
/// usually an ordinal.
pub struct EnglishUnlikelyFormatFilter;

impl Filter for EnglishUnlikelyFormatFilter {
    fn is_valid(&self, context: &Context, result: &ParsingResult) -> bool {
        let text = result.text.trim();

        // If the match is the entire input, the user meant it as a date.
        if text == context.text.trim() {
            return true;
        }

        if text.eq_ignore_ascii_case("may") {
            let before = context.text[..result.index].trim_end();
            if !matches("(?i)\\bin$", before) {
                return false;
            }
        }

        if text.to_lowercase().ends_with("the second") {
            return false;
        }

        true
    }
}

impl Refiner for EnglishUnlikelyFormatFilter {
    fn refine(&self, context: &Context, results: Vec<ParsingResult>) -> Vec<ParsingResult> {
        refine_by_filtering(self, context, results)
    }
}

// ---------------------------------------------------------------------------
// A year written after the date: "14/4 2026".
// ---------------------------------------------------------------------------

pub struct ExtractYearSuffixRefiner;

impl Refiner for ExtractYearSuffixRefiner {
    fn refine(&self, context: &Context, mut results: Vec<ParsingResult>) -> Vec<ParsingResult> {
        let pattern = Regex::new(&format!("(?i)^\\s*({})", super::dict::YEAR_PATTERN))
            .expect("static pattern");
        for result in results.iter_mut() {
            if !result.start.is_date_with_unknown_year() {
                continue;
            }
            let suffix_start = result.index + result.text.len();
            let Some(suffix) = context.text.get(suffix_start..) else {
                continue;
            };
            let Ok(Some(captures)) = pattern.captures(suffix) else {
                continue;
            };
            let whole = captures.get(0).expect("group 0").as_str();
            // "14/4 90" — too short to be a year written out.
            if whole.trim().len() <= 3 {
                continue;
            }
            let Some(year) = captures.get(1).and_then(|m| parse_year(m.as_str())) else {
                continue;
            };
            if let Some(end) = result.end.as_mut() {
                end.assign(Component::Year, year);
            }
            result.start.assign(Component::Year, year);
            result.text.push_str(whole);
        }
        results
    }
}

// ---------------------------------------------------------------------------
// Two dates joined by "to": "april 18 to april 25".
// ---------------------------------------------------------------------------

pub struct MergeDateRangeRefiner;

impl MergingRefiner for MergeDateRangeRefiner {
    fn should_merge(
        &self,
        _context: &Context,
        text_between: &str,
        current: &ParsingResult,
        next: &ParsingResult,
    ) -> bool {
        current.end.is_none()
            && next.end.is_none()
            && matches("(?i)^\\s*(to|-|–|until|through|till)\\s*$", text_between)
    }

    fn merge(
        &self,
        _context: &Context,
        text_between: &str,
        current: ParsingResult,
        next: ParsingResult,
    ) -> ParsingResult {
        let (mut from, mut to) = (current, next);

        // Each side fills the other's gaps: "may 2 to 10" gets its month from
        // the left, "18 to 25 april" its month from the right.
        if !from.start.is_only_weekday_component() && !to.start.is_only_weekday_component() {
            for component in to.start.certain_components() {
                if !from.start.is_certain(component) {
                    if let Some(value) = to.start.get(component) {
                        from.start.imply(component, value);
                    }
                }
            }
            for component in from.start.certain_components() {
                if !to.start.is_certain(component) {
                    if let Some(value) = from.start.get(component) {
                        to.start.imply(component, value);
                    }
                }
            }
        }

        let inverted = match (from.start.date(), to.start.date()) {
            (Some(from_at), Some(to_at)) => from_at > to_at,
            _ => false,
        };
        if inverted {
            let from_at = from.start.date().expect("checked");
            let to_at = to.start.date().expect("checked");
            // "friday to monday" crosses a week; "dec 28 to jan 3" crosses a
            // year. Try each before concluding the two were written backwards.
            if to.start.is_only_weekday_component()
                && to_at.add_days(7).is_some_and(|moved| moved > from_at)
            {
                let moved = to_at.add_days(7).expect("checked");
                to.start.imply(Component::Day, moved.day());
                to.start.imply(Component::Month, moved.month0() + 1);
                to.start.imply(Component::Year, moved.year());
            } else if from.start.is_only_weekday_component()
                && from_at.add_days(-7).is_some_and(|moved| moved < to_at)
            {
                let moved = from_at.add_days(-7).expect("checked");
                from.start.imply(Component::Day, moved.day());
                from.start.imply(Component::Month, moved.month0() + 1);
                from.start.imply(Component::Year, moved.year());
            } else if to.start.is_date_with_unknown_year()
                && shift_years(to_at, 1).is_some_and(|moved| moved > from_at)
            {
                let moved = shift_years(to_at, 1).expect("checked");
                to.start.imply(Component::Year, moved.year());
            } else if from.start.is_date_with_unknown_year()
                && shift_years(from_at, -1).is_some_and(|moved| moved < to_at)
            {
                let moved = shift_years(from_at, -1).expect("checked");
                from.start.imply(Component::Year, moved.year());
            } else {
                std::mem::swap(&mut from, &mut to);
            }
        }

        let index = from.index.min(to.index);
        let text = if from.index < to.index {
            format!("{}{}{}", from.text, text_between, to.text)
        } else {
            format!("{}{}{}", to.text, text_between, from.text)
        };
        let mut result = ParsingResult::new(index, text, from.start);
        result.end = Some(to.start);
        result
    }
}

fn shift_years(date: JsDate, years: i64) -> Option<JsDate> {
    add_duration(date, &Duration::years(years as f64))
}

impl Refiner for MergeDateRangeRefiner {
    fn refine(&self, context: &Context, results: Vec<ParsingResult>) -> Vec<ParsingResult> {
        refine_by_merging(self, context, results)
    }
}

/// Every refiner, in the order chrono-node's casual English configuration runs
/// them. Overlap removal appears three times on purpose: merging can create
/// new overlaps, and the pass after each merge stage is what keeps them from
/// compounding.
///
/// One of the reference's refiners is deliberately absent: the one that reads a
/// *written-out* zone ("3pm EST"). See the note in `nlp`.
pub fn all_refiners() -> Vec<Box<dyn Refiner>> {
    vec![
        Box::new(OverlapRemovalRefiner),
        Box::new(MergeRelativeAfterDateRefiner),
        Box::new(MergeRelativeFollowByDateRefiner),
        Box::new(OverlapRemovalRefiner),
        Box::new(ExtractTimezoneOffsetRefiner),
        Box::new(MergeWeekdayComponentRefiner),
        Box::new(MergeDateTimeRefiner),
        Box::new(OverlapRemovalRefiner),
        Box::new(ForwardDateRefiner),
        Box::new(UnlikelyFormatFilter),
        Box::new(MergeDateTimeRefiner),
        Box::new(ExtractYearSuffixRefiner),
        Box::new(MergeDateRangeRefiner),
        Box::new(EnglishUnlikelyFormatFilter),
    ]
}
