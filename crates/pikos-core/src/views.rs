//! The date-grouped views, Today and Upcoming: membership, ordering and grouping.
//!
//! Each section carries its `YYYY-MM-DD` and the shell writes the label in the reader's own
//! locale, so no locale code lives here.
//!
//! "Today" and "now" are parameters, never the clock, so a test can stand on both boundaries.

use crate::dates::{format_date_only, is_all_day_iso, parse_local_iso};
use chrono::{Duration, NaiveDateTime};

/// How many days Upcoming spans, counting today as day one.
pub const UPCOMING_WINDOW_DAYS: i64 = 7;

/// The day part of a schedule string, for both `YYYY-MM-DD` and `YYYY-MM-DDTHH:MM:SS`.
///
/// A slice rather than a parse, so a window check is a text comparison. A string shorter
/// than a date comes back whole and fails the test rather than panicking.
pub fn day_key(iso: &str) -> &str {
    if iso.len() >= 10 && iso.is_char_boundary(10) {
        &iso[..10]
    } else {
        iso
    }
}

/// The last day Upcoming reaches, inclusive.
///
/// Adds days to a date rather than 6 × 86,400 seconds, which lands on the wrong date
/// across a DST boundary.
pub fn upcoming_window_end(today: &str) -> Option<String> {
    let start = parse_local_iso(today)?;
    Some(format_date_only(
        &(start + Duration::days(UPCOMING_WINDOW_DAYS - 1)),
    ))
}

/// Whether a page belongs to Today by its schedule alone: today or earlier, so what
/// slipped is still due. Completion is the caller's, via [`crate::page::is_open`].
pub fn belongs_to_today(scheduled_start: Option<&str>, today: &str) -> bool {
    match scheduled_start {
        Some(start) => day_key(start) <= today,
        None => false,
    }
}

/// Whether a page belongs to Upcoming by its schedule alone.
///
/// The window opens at today and does not reach back; the overdue backlog is Today's alone.
/// A page dated today is deliberately in both views.
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

/// Whether a page was scheduled on an earlier day than `today`.
///
/// Compares days, never the moment: grouping on the moment moved a page to Overdue the
/// minute its time passed and filled the section with the day's own plan.
pub fn is_overdue(scheduled_start: &str, today: &str) -> bool {
    day_key(scheduled_start) < today
}

/// Where a page sorts within a date-grouped section, soonest first.
///
/// An all-day item dated today sorts at `now`, not midnight, so "sometime today" sits between
/// what has passed and what has not. Other all-day items sort at their day's midnight. An
/// unparseable value sorts at `now` too, so it stays mid-list rather than looking deliberate.
pub fn schedule_sort_key(scheduled_start: &str, today: &str, now: &NaiveDateTime) -> NaiveDateTime {
    if is_all_day_iso(scheduled_start) && scheduled_start == today {
        return *now;
    }
    parse_local_iso(scheduled_start).unwrap_or(*now)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TodayGroups<T> {
    pub overdue: Vec<T>,
    pub today: Vec<T>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpcomingDay<T> {
    /// `YYYY-MM-DD`; the shell turns it into a label.
    pub date: String,
    pub pages: Vec<T>,
}

/// Split Today's pages into overdue and due-today, each in schedule order.
///
/// Generic over the row type because this crate sits below the one that defines a page.
/// The sort is stable on purpose: same-time rows keep the caller's `sort_order` instead of
/// shuffling on every redraw.
pub fn group_today<T>(
    pages: Vec<T>,
    today: &str,
    now: &NaiveDateTime,
    start_of: impl Fn(&T) -> Option<&str>,
) -> TodayGroups<T> {
    let (mut overdue, mut due): (Vec<T>, Vec<T>) = pages
        .into_iter()
        .partition(|page| start_of(page).is_some_and(|start| is_overdue(start, today)));
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

/// Group Upcoming's pages by scheduled day, ascending, each day in schedule order.
///
/// Only days holding something get a section. A page with no schedule is dropped.
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
    fn only_an_earlier_day_is_overdue() {
        let today = "2026-09-13";
        assert!(is_overdue("2026-09-12", today));
        assert!(is_overdue("2026-09-12T23:30:00", today));
        assert!(!is_overdue("2026-09-13", today));
    }

    #[test]
    fn a_timed_item_whose_moment_has_passed_today_stays_in_today() {
        assert!(!is_overdue("2026-09-13T01:45:00", "2026-09-13"));
    }

    #[test]
    fn an_unreadable_schedule_is_not_promoted_into_the_overdue_section() {
        assert!(!is_overdue("2026-09-13Tnope", "2026-09-13"));
        assert!(!is_overdue("nope", "2026-09-13"));
    }

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
