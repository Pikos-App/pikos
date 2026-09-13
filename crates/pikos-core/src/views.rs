//! The date-grouped views — Today and Upcoming.
//!
//! Port of the membership, ordering and grouping halves of
//! `packages/core/src/pages/pageFilters.ts` and `packages/core/src/pages/upcoming.ts`.
//!
//! These two views are not lists with a filter on them; their order is derived
//! from the schedule and rendered as sections, which is why a user-chosen sort
//! has nothing to act on in either. What is ported here is exactly the part that
//! decides membership and order. What is *not* ported is the day label — the
//! TypeScript builds "Today" / "Tomorrow" / "Thu, Aug 27" with
//! `toLocaleDateString`, and a Rust copy of that would be a second locale
//! implementation that disagrees with the platform's. Each section carries its
//! `YYYY-MM-DD` instead and the shell writes the label in the reader's own
//! locale.
//!
//! Everything takes "today" and "now" as parameters rather than reading the
//! clock. Both are boundaries a test has to be able to stand on: "overdue"
//! depends on the minute, and a suite that reads the machine clock passes all
//! day and fails at 23:59.

use crate::dates::{format_date_only, is_all_day_iso, parse_local_iso};
use chrono::{Duration, NaiveDateTime};

/// How many days Upcoming spans, counting today as day one.
pub const UPCOMING_WINDOW_DAYS: i64 = 7;

/// The day part of a schedule string, for both `YYYY-MM-DD` and
/// `YYYY-MM-DDTHH:MM:SS`.
///
/// A slice rather than a parse: these comparisons are lexicographic on purpose.
/// `YYYY-MM-DD` sorts and compares correctly as text, so a day-window check
/// needs no calendar arithmetic and cannot be wrong about a date it could not
/// parse. Returns the whole string when it is shorter than a date, so a
/// malformed value fails a window test rather than panicking on a slice.
pub fn day_key(iso: &str) -> &str {
    if iso.len() >= 10 && iso.is_char_boundary(10) {
        &iso[..10]
    } else {
        iso
    }
}

/// The last day Upcoming reaches, inclusive.
///
/// Built by adding days to a date rather than by adding 6 × 86,400 seconds: a
/// DST boundary inside the window is a day that is not 24 hours long, and the
/// seconds form would land the window's end on the wrong date across one.
pub fn upcoming_window_end(today: &str) -> Option<String> {
    let start = parse_local_iso(today)?;
    Some(format_date_only(
        &(start + Duration::days(UPCOMING_WINDOW_DAYS - 1)),
    ))
}

/// Whether a page belongs to Today by its schedule alone.
///
/// Today and earlier — the view is "what is due", and something that slipped is
/// still due. Says nothing about completion; a caller composes this with
/// [`crate::page::is_open`].
pub fn belongs_to_today(scheduled_start: Option<&str>, today: &str) -> bool {
    match scheduled_start {
        Some(start) => day_key(start) <= today,
        None => false,
    }
}

/// Whether a page belongs to Upcoming by its schedule alone.
///
/// The window opens at today, not tomorrow: the view answers "what is coming",
/// and one that starts tomorrow leaves the reader wondering where today went.
/// It does not reach back past today — chasing what already slipped is the
/// Today view's job, and an Upcoming list that also carried the backlog would
/// be the same list twice.
///
/// So a page dated today is in *both* views, deliberately. They are asking two
/// different questions of it: Today asks what is due, Upcoming asks what the
/// week holds, and today is the first day of the week ahead. Only the overdue
/// backlog is exclusive to Today.
pub fn belongs_to_upcoming(scheduled_start: Option<&str>, today: &str) -> bool {
    let Some(start) = scheduled_start else {
        return false;
    };
    let Some(end) = upcoming_window_end(today) else {
        return false;
    };
    let day = day_key(start);
    day >= today && day <= end.as_str()
}

/// Whether a page has already slipped, as of `now`.
///
/// The two schedule shapes are judged differently, and the difference is the
/// whole point. An all-day item is compared by date, so it stays in "today" all
/// day rather than becoming overdue at 00:01. A timed one is compared by the
/// moment, so a 1:45am reminder reads as overdue by 10am — which is what makes
/// the Today view's first section worth looking at.
pub fn is_overdue(scheduled_start: &str, today: &str, now: &NaiveDateTime) -> bool {
    if is_all_day_iso(scheduled_start) {
        return scheduled_start < today;
    }
    match parse_local_iso(scheduled_start) {
        Some(at) => at < *now,
        // Unparseable: not overdue. A row nobody can place should sit in the
        // ordinary section rather than being promoted into the one the reader
        // is meant to act on.
        None => false,
    }
}

/// Where a page sorts within a date-grouped section, soonest first.
///
/// The one non-obvious rule, carried from the TypeScript deliberately: an
/// all-day item dated *today* sorts at `now`, not at midnight. Sorting it at
/// midnight would bury every all-day task under the morning's timed ones and
/// above nothing — "sometime today" belongs between what has already passed and
/// what has not, which is exactly where `now` puts it. All-day items on any
/// other day sort at that day's midnight, where there is no such ambiguity.
///
/// An unparseable value sorts at `now` as well, which keeps it visible in the
/// middle of the list rather than pinning it to the top or the bottom, where it
/// would look deliberate.
pub fn schedule_sort_key(scheduled_start: &str, today: &str, now: &NaiveDateTime) -> NaiveDateTime {
    if is_all_day_iso(scheduled_start) && scheduled_start == today {
        return *now;
    }
    parse_local_iso(scheduled_start).unwrap_or(*now)
}

/// Today's two sections, in the order they are drawn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TodayGroups<T> {
    /// Already slipped. First, because it is the part worth acting on.
    pub overdue: Vec<T>,
    /// Due today and not yet passed.
    pub today: Vec<T>,
}

/// One day of Upcoming.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpcomingDay<T> {
    /// `YYYY-MM-DD`. The row key, and what the shell turns into a label.
    pub date: String,
    pub pages: Vec<T>,
}

/// Split Today's pages into overdue and due-today, each in schedule order.
///
/// Generic over the row type with a borrowing accessor rather than taking a
/// concrete page struct: this crate sits below the one that defines a page, and
/// a shape declared here for the grouping to consume would be a second page
/// type to keep in step. The caller passes what it already has.
///
/// The sort is stable, which is load-bearing rather than incidental: two pages
/// sharing a scheduled time keep the order they arrived in, and that order is
/// the caller's `sort_order`. An unstable sort would shuffle same-time rows on
/// every redraw.
pub fn group_today<T>(
    pages: Vec<T>,
    today: &str,
    now: &NaiveDateTime,
    start_of: impl Fn(&T) -> Option<&str>,
) -> TodayGroups<T> {
    let (mut overdue, mut due): (Vec<T>, Vec<T>) = pages
        .into_iter()
        .partition(|page| start_of(page).is_some_and(|start| is_overdue(start, today, now)));
    let key = |page: &T| {
        start_of(page)
            .map(|start| schedule_sort_key(start, today, now))
            .unwrap_or(*now)
    };
    overdue.sort_by_key(&key);
    due.sort_by_key(&key);
    TodayGroups {
        overdue,
        today: due,
    }
}

/// Group Upcoming's pages by scheduled day, ascending, each day in schedule
/// order.
///
/// Only days holding something get a section. An empty day header says nothing
/// the next populated one does not already say, and in a long list it is a row
/// of furniture between the reader and what they came for.
///
/// A page with no schedule cannot be placed on a day and is dropped.
/// [`belongs_to_upcoming`] already excludes those, so this is the second of two
/// locks on the same door rather than the only one.
pub fn group_upcoming<T>(
    pages: Vec<T>,
    today: &str,
    now: &NaiveDateTime,
    start_of: impl Fn(&T) -> Option<&str>,
) -> Vec<UpcomingDay<T>> {
    let mut days: Vec<UpcomingDay<T>> = Vec::new();
    for page in pages {
        let Some(date) = start_of(&page).map(|start| day_key(start).to_string()) else {
            continue;
        };
        match days.iter_mut().find(|day| day.date == date) {
            Some(day) => day.pages.push(page),
            None => days.push(UpcomingDay {
                date,
                pages: vec![page],
            }),
        }
    }
    days.sort_by(|a, b| a.date.cmp(&b.date));
    for day in &mut days {
        let key = |page: &T| {
            start_of(page)
                .map(|start| schedule_sort_key(start, today, now))
                .unwrap_or(*now)
        };
        day.pages.sort_by_key(key);
    }
    days
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(iso: &str) -> NaiveDateTime {
        parse_local_iso(iso).expect("test datetime parses")
    }

    #[test]
    fn day_key_takes_the_date_from_both_shapes() {
        assert_eq!(day_key("2026-09-13"), "2026-09-13");
        assert_eq!(day_key("2026-09-13T14:30:00"), "2026-09-13");
    }

    /// A short or mangled value must not panic a list that is only trying to
    /// decide which day it is on.
    #[test]
    fn day_key_hands_back_anything_too_short_to_slice() {
        assert_eq!(day_key(""), "");
        assert_eq!(day_key("2026"), "2026");
        assert_eq!(day_key("2026-09-1"), "2026-09-1");
    }

    #[test]
    fn the_window_is_seven_days_counting_today() {
        assert_eq!(
            upcoming_window_end("2026-09-13").as_deref(),
            Some("2026-09-19")
        );
    }

    /// Across a month end, which is where naive arithmetic on day numbers goes
    /// wrong.
    #[test]
    fn the_window_crosses_a_month_boundary() {
        assert_eq!(
            upcoming_window_end("2026-09-28").as_deref(),
            Some("2026-10-04")
        );
        assert_eq!(
            upcoming_window_end("2026-12-30").as_deref(),
            Some("2027-01-05")
        );
    }

    #[test]
    fn today_takes_everything_due_and_everything_missed() {
        let today = "2026-09-13";
        assert!(belongs_to_today(Some("2026-09-13"), today));
        assert!(belongs_to_today(Some("2026-09-13T23:59:00"), today));
        assert!(
            belongs_to_today(Some("2026-09-01"), today),
            "overdue is due"
        );
        assert!(!belongs_to_today(Some("2026-09-14"), today));
        assert!(
            !belongs_to_today(None, today),
            "unscheduled is not due today"
        );
    }

    /// The two views must not both claim a page, and the boundary where they
    /// could is today itself.
    #[test]
    fn upcoming_starts_at_today_and_never_reaches_back() {
        let today = "2026-09-13";
        assert!(belongs_to_upcoming(Some("2026-09-13T09:00:00"), today));
        assert!(
            belongs_to_upcoming(Some("2026-09-19"), today),
            "the last day is in"
        );
        assert!(
            belongs_to_upcoming(Some("2026-09-19T23:00:00"), today),
            "and so is a time late on the last day"
        );
        assert!(
            !belongs_to_upcoming(Some("2026-09-20"), today),
            "the eighth day is out"
        );
        assert!(
            !belongs_to_upcoming(Some("2026-09-12"), today),
            "overdue is Today's job"
        );
        assert!(!belongs_to_upcoming(None, today));
    }

    #[test]
    fn an_all_day_item_stays_in_today_all_day() {
        let today = "2026-09-13";
        let late = at("2026-09-13T23:59:00");
        assert!(
            !is_overdue("2026-09-13", today, &late),
            "not overdue at 23:59"
        );
        assert!(is_overdue("2026-09-12", today, &late), "yesterday's is");
    }

    #[test]
    fn a_timed_item_goes_overdue_when_its_moment_passes() {
        let today = "2026-09-13";
        let now = at("2026-09-13T10:00:00");
        assert!(is_overdue("2026-09-13T01:45:00", today, &now));
        assert!(!is_overdue("2026-09-13T14:00:00", today, &now));
    }

    #[test]
    fn an_unreadable_schedule_is_not_promoted_into_the_overdue_section() {
        let now = at("2026-09-13T10:00:00");
        assert!(!is_overdue("2026-09-13Tnope", "2026-09-13", &now));
    }

    /// The rule worth porting rather than simplifying: "sometime today" sits
    /// between what has passed and what has not.
    #[test]
    fn an_all_day_item_today_sorts_at_now_rather_than_at_midnight() {
        let today = "2026-09-13";
        let now = at("2026-09-13T10:00:00");

        let all_day = schedule_sort_key("2026-09-13", today, &now);
        assert_eq!(all_day, now);
        assert!(schedule_sort_key("2026-09-13T09:00:00", today, &now) < all_day);
        assert!(schedule_sort_key("2026-09-13T11:00:00", today, &now) > all_day);
    }

    #[test]
    fn an_all_day_item_on_another_day_sorts_at_that_days_midnight() {
        let now = at("2026-09-13T10:00:00");
        assert_eq!(
            schedule_sort_key("2026-09-14", "2026-09-13", &now),
            at("2026-09-14T00:00:00")
        );
    }

    #[test]
    fn an_unreadable_schedule_sorts_where_it_stays_visible() {
        let now = at("2026-09-13T10:00:00");
        assert_eq!(schedule_sort_key("banana", "2026-09-13", &now), now);
    }
}
