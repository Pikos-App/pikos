//! Merging scheduled pages with their recurrence rules, for one visible range.
//!
//! Ported from `apps/desktop/src/features/calendar/hooks/useRecurrenceExpansion.ts`
//! — the pure half of it. The hook also fetches materialised override rows for
//! the range; fetching is the caller's job here, and the dates it finds arrive
//! folded into [`SeriesRule::excluded_dates`] alongside the rule's own exdates.
//! Both are the same thing to the expansion: a date the series does not occur
//! on.
//!
//! A recurring page is stored once — a head row plus a rule — and its other
//! occurrences are projected at display time rather than written out. That is
//! why a calendar cannot simply draw the pages it queried: a weekly standup
//! anchored three months ago has no row this week, and would silently not
//! appear.
//!
//! The expansion underneath ([`crate::recurrence::expand_for_range`]) is graded
//! against a golden corpus and differentially fuzzed. What is added here is the
//! merge around it, and its whole content is two rules that are easy to state
//! and were both learned the hard way — see `head_date` below.

use chrono::NaiveDateTime;

use super::LayoutPage;
use crate::recurrence::expand_for_range;

/// A recurrence rule, as the calendar needs to read it.
pub struct SeriesRule {
    pub id: String,
    pub page_id: String,
    pub rrule: String,
    /// Dates the series does not occur on: the rule's own exdates, plus every
    /// date already materialised as an override row. An override is a real
    /// schedule row that will be drawn on its own, so projecting the rule onto
    /// that date as well would draw it twice.
    pub excluded_dates: Vec<String>,
    pub scheduled_start: String,
    pub scheduled_end: Option<String>,
}

/// One projected occurrence of a series.
///
/// Carries the *page's* id rather than an id of its own, deliberately: the
/// all-day row assignment in [`super::all_day`] identifies a span by page id
/// and relies on a Mon/Wed/Fri series sharing one, so that it claims three
/// specific day indices instead of a contiguous block. A renderer that needs a
/// per-occurrence identity should pair the page id with `original_date`.
pub struct VirtualOccurrence {
    pub page_id: String,
    pub rule_id: String,
    /// The rule's own date for this occurrence — always date-only, even for a
    /// timed series. This is how a skip or an override is matched back to it.
    pub original_date: String,
    pub scheduled_start: String,
    pub scheduled_end: Option<String>,
}

/// The first ten characters of a wall-clock string: its date.
///
/// `get` rather than a slice because a malformed value shorter than a date
/// would otherwise panic, and the input reaches here from the database.
fn date_part(iso: &str) -> Option<&str> {
    iso.get(..10)
}

/// Project every rule into the occurrences to draw in `[range_start, range_end)`.
///
/// Returns only the *virtual* ones. The real pages are already in `pages` and
/// the caller concatenates — matching the original, which spreads both into one
/// array so the calendar renders them identically.
pub fn virtual_occurrences_in_range(
    pages: &[LayoutPage],
    rules: &[SeriesRule],
    range_start: &NaiveDateTime,
    range_end: &NaiveDateTime,
) -> Vec<VirtualOccurrence> {
    let mut out = Vec::new();

    for rule in rules {
        // A rule whose page is not in the visible set produces nothing. The
        // caller is responsible for including every rule's head page even when
        // its own date falls outside the range, because that is the normal
        // case: the head of a long-running series is almost never in the week
        // being looked at.
        let Some(page) = pages.iter().find(|p| p.id == rule.page_id) else {
            continue;
        };

        // Suppress every occurrence at or before the head's own date.
        //
        // Two distinct bugs, one rule. On the head's date, the head is already
        // being drawn as a real block, so a virtual there would stack a second
        // block on top of it. *Before* the head's date, the rule still emits
        // dates the user has moved past — drag the head from Monday to
        // Wednesday and the rule keeps emitting Monday, which would resurrect
        // the occurrence the drag was meant to move. Filtering on the head's
        // exact date fixes only the first.
        let head_date = page.scheduled_start.as_deref().and_then(date_part);

        for occurrence in expand_for_range(
            &rule.rrule,
            &rule.scheduled_start,
            rule.scheduled_end.as_deref(),
            &rule.excluded_dates,
            range_start,
            range_end,
        ) {
            if let Some(head) = head_date {
                if occurrence.original_date.as_str() <= head {
                    continue;
                }
            }
            out.push(VirtualOccurrence {
                page_id: rule.page_id.clone(),
                rule_id: rule.id.clone(),
                original_date: occurrence.original_date,
                scheduled_start: occurrence.scheduled_start,
                scheduled_end: occurrence.scheduled_end,
            });
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dates::parse_local_iso;

    /// The cases below are ported from the reference's own suite,
    /// `useRecurrenceExpansion.test.tsx`, rather than invented here — the
    /// point is to agree with the desktop, and its tests are the statement of
    /// what it does.
    fn page(id: &str, scheduled_start: Option<&str>) -> LayoutPage {
        LayoutPage {
            id: id.to_string(),
            created_at: "2026-01-01T00:00:00".to_string(),
            scheduled_start: scheduled_start.map(str::to_string),
            scheduled_end: None,
        }
    }

    fn rule(id: &str, page_id: &str, rrule: &str, start: &str) -> SeriesRule {
        SeriesRule {
            id: id.to_string(),
            page_id: page_id.to_string(),
            rrule: rrule.to_string(),
            excluded_dates: Vec::new(),
            scheduled_start: start.to_string(),
            scheduled_end: None,
        }
    }

    /// The week of Monday 9 March 2026, as the hook's `weekDays` builds it.
    fn week_of_march_9() -> (NaiveDateTime, NaiveDateTime) {
        (
            parse_local_iso("2026-03-09").unwrap(),
            parse_local_iso("2026-03-16").unwrap(),
        )
    }

    #[test]
    fn no_rules_means_no_virtual_occurrences() {
        let (from, to) = week_of_march_9();
        let pages = vec![page("page-1", Some("2026-03-02T09:00:00"))];
        assert!(virtual_occurrences_in_range(&pages, &[], &from, &to).is_empty());
    }

    #[test]
    fn a_weekly_rule_expands_into_the_visible_week() {
        let (from, to) = week_of_march_9();
        let pages = vec![page("page-1", Some("2026-03-02T09:00:00"))];
        let rules = vec![rule(
            "rule-1",
            "page-1",
            "FREQ=WEEKLY;BYDAY=MO",
            "2026-03-02T09:00:00",
        )];

        let virtuals = virtual_occurrences_in_range(&pages, &rules, &from, &to);
        assert_eq!(virtuals.len(), 1);
        assert_eq!(virtuals[0].scheduled_start, "2026-03-09T09:00:00");
        assert_eq!(virtuals[0].original_date, "2026-03-09");
        assert_eq!(
            virtuals[0].page_id, "page-1",
            "a virtual carries its head's id — all-day row assignment depends on it"
        );
    }

    #[test]
    fn the_heads_own_date_produces_no_virtual() {
        // The head is drawn as a real block on that date. A virtual there too
        // would stack two blocks on one occurrence.
        let (from, to) = week_of_march_9();
        let pages = vec![page("page-1", Some("2026-03-09T09:00:00"))];
        let rules = vec![rule(
            "rule-1",
            "page-1",
            "FREQ=WEEKLY;BYDAY=MO",
            "2026-03-02T09:00:00",
        )];

        let virtuals = virtual_occurrences_in_range(&pages, &rules, &from, &to);
        assert!(
            !virtuals
                .iter()
                .any(|v| v.scheduled_start.starts_with("2026-03-09")),
            "the real head occupies that slot"
        );
    }

    #[test]
    fn virtuals_before_the_head_are_hidden_so_the_series_tracks_it() {
        // A daily rule anchored 2 March, with the head moved forward to
        // Wednesday 11 March. Without the "at or before" half of the rule, the
        // 9th and 10th would reappear — dates the drag was meant to move past.
        let (from, to) = week_of_march_9();
        let pages = vec![page("page-1", Some("2026-03-11T09:00:00"))];
        let rules = vec![rule("rule-1", "page-1", "FREQ=DAILY", "2026-03-02T09:00:00")];

        let dates: Vec<String> = virtual_occurrences_in_range(&pages, &rules, &from, &to)
            .into_iter()
            .map(|v| v.original_date)
            .collect();

        assert_eq!(dates, ["2026-03-12", "2026-03-13", "2026-03-14", "2026-03-15"]);
    }

    #[test]
    fn an_excluded_date_produces_no_virtual() {
        // Covers both inputs that arrive as `excluded_dates`: the rule's own
        // exdates and a date already materialised as an override row.
        let (from, to) = week_of_march_9();
        let pages = vec![page("page-1", Some("2026-03-02T09:00:00"))];
        let mut rules = vec![rule(
            "rule-1",
            "page-1",
            "FREQ=WEEKLY;BYDAY=MO",
            "2026-03-02T09:00:00",
        )];
        rules[0].excluded_dates = vec!["2026-03-09".to_string()];

        assert!(virtual_occurrences_in_range(&pages, &rules, &from, &to).is_empty());
    }

    #[test]
    fn rules_expand_independently_of_one_another() {
        let (from, to) = week_of_march_9();
        let pages = vec![
            page("page-A", Some("2026-03-02T09:00:00")),
            page("page-B", Some("2026-03-04T15:00:00")),
        ];
        let rules = vec![
            rule(
                "rule-A",
                "page-A",
                "FREQ=WEEKLY;BYDAY=MO",
                "2026-03-02T09:00:00",
            ),
            rule(
                "rule-B",
                "page-B",
                "FREQ=WEEKLY;BYDAY=WE",
                "2026-03-04T15:00:00",
            ),
        ];

        let virtuals = virtual_occurrences_in_range(&pages, &rules, &from, &to);
        assert_eq!(virtuals.len(), 2);
        let a = virtuals.iter().find(|v| v.rule_id == "rule-A").unwrap();
        let b = virtuals.iter().find(|v| v.rule_id == "rule-B").unwrap();
        assert_eq!(a.scheduled_start, "2026-03-09T09:00:00");
        assert_eq!(b.scheduled_start, "2026-03-11T15:00:00");
    }

    /// The case the caller has to get right, pinned here because getting it
    /// wrong is invisible: the series simply does not appear, and an empty
    /// calendar looks like an empty calendar.
    #[test]
    fn a_rule_whose_head_page_is_absent_expands_to_nothing() {
        let (from, to) = week_of_march_9();
        let rules = vec![rule(
            "rule-1",
            "page-1",
            "FREQ=WEEKLY;BYDAY=MO",
            "2026-03-02T09:00:00",
        )];
        assert!(virtual_occurrences_in_range(&[], &rules, &from, &to).is_empty());
    }

    /// An all-day series projects date-only strings, which is what the all-day
    /// packer expects — handing it a timed string would drop the bar entirely.
    #[test]
    fn an_all_day_series_projects_date_only_occurrences() {
        let (from, to) = week_of_march_9();
        let pages = vec![page("page-1", Some("2026-03-02"))];
        let rules = vec![rule("rule-1", "page-1", "FREQ=WEEKLY;BYDAY=MO", "2026-03-02")];

        let virtuals = virtual_occurrences_in_range(&pages, &rules, &from, &to);
        assert_eq!(virtuals.len(), 1);
        assert_eq!(virtuals[0].scheduled_start, "2026-03-09");
        assert!(virtuals[0].scheduled_end.is_none());
    }

    /// A page whose schedule was cleared still has a rule until something
    /// deletes it. With no head date there is nothing to suppress against, so
    /// every occurrence stands.
    #[test]
    fn a_head_with_no_schedule_suppresses_nothing() {
        let (from, to) = week_of_march_9();
        let pages = vec![page("page-1", None)];
        let rules = vec![rule(
            "rule-1",
            "page-1",
            "FREQ=WEEKLY;BYDAY=MO",
            "2026-03-02T09:00:00",
        )];

        assert_eq!(
            virtual_occurrences_in_range(&pages, &rules, &from, &to).len(),
            1
        );
    }
}
