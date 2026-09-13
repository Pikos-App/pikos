//! Merging scheduled pages with their recurrence rules, for one visible range.
//!
//! Ported from `apps/desktop/src/shared/hooks/useRecurrenceExpansion.ts` — the
//! pure half of it. Fetching is the caller's job; what arrives here is already
//! gathered.
//!
//! A recurring page is stored once — a head row plus a rule — and its other
//! occurrences are projected at display time rather than written out. That is
//! why a calendar cannot simply draw the pages it queried: a weekly standup
//! anchored three months ago has no row this week, and would silently not
//! appear.
//!
//! ## The exclusion union
//!
//! Four things can stop a rule projecting onto a date, and they arrive from
//! three different places:
//!
//! - the rule's own EXDATEs, applied by the expansion underneath;
//! - a **completed** occurrence, which has a clone recording it;
//! - a **skipped** occurrence, dismissed by the user;
//! - a materialised **override** row, which is a real schedule that will be
//!   drawn on its own — projecting the rule there too would draw it twice.
//!
//! Completed and skipped live on the page; override dates come from the rows
//! and must be gathered **by rule id, not by date range**. An override moved
//! out of the visible week still has to suppress the slot it came from, and a
//! range query keyed on where it moved *to* misses it — leaving a ghost in the
//! original slot.

use std::collections::HashSet;

use pikos_recurrence::expand_range;

use super::LayoutPage;

/// A recurrence rule, as the calendar needs to read it.
pub struct SeriesRule {
    pub id: String,
    pub page_id: String,
    pub rrule: String,
    /// The rule's own EXDATEs. Everything else that excludes a date arrives
    /// through [`SeriesPage`] or [`OverrideRow`] instead, because it is not a
    /// property of the rule.
    pub exdates: Vec<String>,
    pub scheduled_start: String,
    pub scheduled_end: Option<String>,
}

/// The head page of a series, and the state that decides what it projects.
pub struct SeriesPage {
    pub id: String,
    /// The head's own date. The head block already draws it.
    pub scheduled_start: Option<String>,
    /// Dates (`YYYY-MM-DD`) whose occurrence has been completed.
    pub completed_dates: Vec<String>,
    /// Dates dismissed by the user.
    pub skipped_dates: Vec<String>,
    /// The day this page first synced, if it came from a calendar. Occurrences
    /// before it are not drawn: the calendar was never asked about that period,
    /// so what a rule would show there is not something anyone confirmed.
    pub synced_since: Option<String>,
}

/// A materialised override — a real schedule row standing in for one occurrence.
pub struct OverrideRow {
    pub rule_id: String,
    /// The occurrence this replaces, always date-only.
    pub original_date: String,
}

/// One projected occurrence of a series.
///
/// Carries the *page's* id rather than an id of its own, deliberately: the
/// all-day row assignment in [`super::all_day`] identifies a span by page id and
/// relies on a Mon/Wed/Fri series sharing one, so that it claims three specific
/// day indices instead of a contiguous block. A renderer needing a
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

/// The `YYYY-MM-DD` of a wall-clock string.
///
/// A completed-occurrence key can be stored as a full wall clock while an
/// occurrence's own date is day-only, so both are reduced to a day before being
/// compared. `get` rather than a slice because a malformed value shorter than a
/// date would otherwise panic, and these reach here from the database.
fn day_key(iso: &str) -> &str {
    iso.get(..10).unwrap_or(iso)
}

/// Project every rule into the occurrences to draw in `[range_start, range_end)`.
///
/// Returns only the *virtual* ones. The real pages are already known to the
/// caller, which concatenates — matching the original, which spreads both into
/// one array so the calendar renders them identically.
pub fn virtual_occurrences_in_range(
    pages: &[SeriesPage],
    rules: &[SeriesRule],
    overrides: &[OverrideRow],
    range_start: &str,
    range_end: &str,
) -> Vec<VirtualOccurrence> {
    let mut out = Vec::new();

    for rule in rules {
        // A rule whose page is not in the set produces nothing. The caller is
        // responsible for including every rule's head page even when its own
        // date falls outside the range, because that is the normal case: the
        // head of a long-running series is almost never in the week being
        // looked at.
        let Some(page) = pages.iter().find(|p| p.id == rule.page_id) else {
            continue;
        };

        let mut excluded: HashSet<&str> = page
            .completed_dates
            .iter()
            .chain(page.skipped_dates.iter())
            .map(|d| day_key(d))
            .collect();
        for row in overrides {
            if row.rule_id == rule.id {
                excluded.insert(day_key(&row.original_date));
            }
        }

        // Only the head's *own* date is suppressed, because the head block
        // already draws it.
        //
        // Not every date at or before it, which is what an earlier version of
        // the reference did and this port copied. Moving the head shifts the
        // rule's anchor, so vacated dates stop being emitted at all; a
        // completed or skipped one lands in the union above. A date that is
        // neither is a genuine open gap in the series, and hiding it makes the
        // calendar quietly disagree with what the user actually has outstanding.
        let head_date = page.scheduled_start.as_deref().map(day_key);

        // A rule that will not parse yields nothing rather than failing the
        // whole range: one malformed series must not blank the calendar.
        let expanded = expand_range(
            &rule.rrule,
            &rule.scheduled_start,
            rule.scheduled_end.as_deref(),
            range_start,
            range_end,
            &rule.exdates,
        )
        .unwrap_or_default();

        for occurrence in expanded {
            let date = occurrence.original_date.as_str();
            if excluded.contains(date) {
                continue;
            }
            if head_date == Some(date) {
                continue;
            }
            // The floor is the only bound on how far back a synced series
            // reaches. The visible range alone would happily paint one into any
            // past week the user navigates to.
            if let Some(floor) = page.synced_since.as_deref() {
                if date < day_key(floor) {
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

/// A [`SeriesPage`] carrying only what the layout algorithms read.
///
/// The calendar needs both views of the same page — this one to lay it out,
/// [`SeriesPage`] to decide what it projects — and keeping them separate is
/// what stops the layout code growing a dependency on sync state.
pub fn layout_page_of(page: &SeriesPage, created_at: &str) -> LayoutPage {
    LayoutPage {
        id: page.id.clone(),
        created_at: created_at.to_string(),
        scheduled_start: page.scheduled_start.clone(),
        scheduled_end: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cases below are ported from the reference's own suite,
    /// `useRecurrenceExpansion.test.tsx`, rather than invented here — the point
    /// is to agree with the desktop, and its tests are the statement of what it
    /// does.
    fn page(id: &str, scheduled_start: Option<&str>) -> SeriesPage {
        SeriesPage {
            id: id.to_string(),
            scheduled_start: scheduled_start.map(str::to_string),
            completed_dates: Vec::new(),
            skipped_dates: Vec::new(),
            synced_since: None,
        }
    }

    fn rule(id: &str, page_id: &str, rrule: &str, start: &str) -> SeriesRule {
        SeriesRule {
            id: id.to_string(),
            page_id: page_id.to_string(),
            rrule: rrule.to_string(),
            exdates: Vec::new(),
            scheduled_start: start.to_string(),
            scheduled_end: None,
        }
    }

    /// The week of Monday 9 March 2026, as the hook's `weekDays` builds it.
    /// Half-open: the 16th is the morning after the last visible day.
    fn week_of_march_9() -> (&'static str, &'static str) {
        ("2026-03-09", "2026-03-16")
    }

    fn dates(v: Vec<VirtualOccurrence>) -> Vec<String> {
        v.into_iter().map(|o| o.original_date).collect()
    }

    #[test]
    fn no_rules_means_no_virtual_occurrences() {
        let (from, to) = week_of_march_9();
        let pages = vec![page("page-1", Some("2026-03-02T09:00:00"))];
        assert!(virtual_occurrences_in_range(&pages, &[], &[], from, to).is_empty());
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

        let virtuals = virtual_occurrences_in_range(&pages, &rules, &[], from, to);
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

        assert!(
            !dates(virtual_occurrences_in_range(
                &pages, &rules, &[], from, to
            ))
            .contains(&"2026-03-09".to_string()),
            "the real head occupies that slot"
        );
    }

    /// The rule this port originally got wrong, in the direction that matters.
    ///
    /// An earlier reference suppressed every date at or *before* the head.
    /// It no longer does, and the difference is visible: a daily series whose
    /// head sits on the 11th still owes the user the 9th and the 10th unless
    /// they were completed or skipped. Hiding them made the calendar disagree
    /// with what was actually outstanding.
    #[test]
    fn dates_before_the_head_are_still_shown() {
        let (from, to) = week_of_march_9();
        let pages = vec![page("page-1", Some("2026-03-11T09:00:00"))];
        let rules = vec![rule("rule-1", "page-1", "FREQ=DAILY", "2026-03-02T09:00:00")];

        assert_eq!(
            dates(virtual_occurrences_in_range(
                &pages, &rules, &[], from, to
            )),
            [
                "2026-03-09",
                "2026-03-10",
                "2026-03-12",
                "2026-03-13",
                "2026-03-14",
                "2026-03-15"
            ],
            "the 11th is the head's own date; nothing else is suppressed"
        );
    }

    #[test]
    fn a_completed_occurrence_is_not_projected() {
        let (from, to) = week_of_march_9();
        let mut p = page("page-1", Some("2026-03-02T09:00:00"));
        p.completed_dates = vec!["2026-03-10".to_string()];
        let rules = vec![rule("rule-1", "page-1", "FREQ=DAILY", "2026-03-02T09:00:00")];

        let got = dates(virtual_occurrences_in_range(
            &[p],
            &rules,
            &[],
            from,
            to,
        ));
        assert!(!got.contains(&"2026-03-10".to_string()), "got {got:?}");
        assert!(got.contains(&"2026-03-11".to_string()), "and only that one");
    }

    /// A completion key can be stored as a full wall clock while an occurrence's
    /// own date is day-only. Comparing them unreduced silently matches nothing,
    /// and the completed occurrence keeps rendering as though it were open.
    #[test]
    fn a_completion_stored_as_a_full_wall_clock_still_matches() {
        let (from, to) = week_of_march_9();
        let mut p = page("page-1", Some("2026-03-02T09:00:00"));
        p.completed_dates = vec!["2026-03-10T09:00:00".to_string()];
        let rules = vec![rule("rule-1", "page-1", "FREQ=DAILY", "2026-03-02T09:00:00")];

        assert!(!dates(virtual_occurrences_in_range(
            &[p],
            &rules,
            &[],
            from,
            to
        ))
        .contains(&"2026-03-10".to_string()));
    }

    #[test]
    fn a_skipped_occurrence_is_not_projected() {
        let (from, to) = week_of_march_9();
        let mut p = page("page-1", Some("2026-03-02T09:00:00"));
        p.skipped_dates = vec!["2026-03-12".to_string()];
        let rules = vec![rule("rule-1", "page-1", "FREQ=DAILY", "2026-03-02T09:00:00")];

        assert!(!dates(virtual_occurrences_in_range(
            &[p],
            &rules,
            &[],
            from,
            to
        ))
        .contains(&"2026-03-12".to_string()));
    }

    /// The case that motivates gathering overrides by rule rather than by date
    /// range: this row's own schedule sits in a different week entirely, and a
    /// range query would never see it — leaving a ghost in the slot it left.
    #[test]
    fn an_override_moved_out_of_the_week_still_suppresses_its_original_slot() {
        let (from, to) = week_of_march_9();
        let pages = vec![page("page-1", Some("2026-03-02T09:00:00"))];
        let rules = vec![rule(
            "rule-1",
            "page-1",
            "FREQ=WEEKLY;BYDAY=MO",
            "2026-03-02T09:00:00",
        )];
        let overrides = vec![OverrideRow {
            rule_id: "rule-1".to_string(),
            original_date: "2026-03-09".to_string(),
        }];

        assert!(
            virtual_occurrences_in_range(&pages, &rules, &overrides, from, to).is_empty()
        );
    }

    /// An override belonging to another series must not suppress this one.
    #[test]
    fn an_override_for_a_different_rule_is_ignored() {
        let (from, to) = week_of_march_9();
        let pages = vec![page("page-1", Some("2026-03-02T09:00:00"))];
        let rules = vec![rule(
            "rule-1",
            "page-1",
            "FREQ=WEEKLY;BYDAY=MO",
            "2026-03-02T09:00:00",
        )];
        let overrides = vec![OverrideRow {
            rule_id: "rule-OTHER".to_string(),
            original_date: "2026-03-09".to_string(),
        }];

        assert_eq!(
            virtual_occurrences_in_range(&pages, &rules, &overrides, from, to).len(),
            1
        );
    }

    #[test]
    fn an_exdate_produces_no_virtual() {
        let (from, to) = week_of_march_9();
        let pages = vec![page("page-1", Some("2026-03-02T09:00:00"))];
        let mut rules = vec![rule(
            "rule-1",
            "page-1",
            "FREQ=WEEKLY;BYDAY=MO",
            "2026-03-02T09:00:00",
        )];
        rules[0].exdates = vec!["2026-03-09".to_string()];

        assert!(virtual_occurrences_in_range(&pages, &rules, &[], from, to).is_empty());
    }

    /// A synced series reaches back only as far as the calendar was actually
    /// asked about. Without the floor, navigating to any past week paints the
    /// series across it as though those occurrences were confirmed.
    #[test]
    fn a_synced_series_does_not_reach_before_it_was_synced() {
        let (from, to) = week_of_march_9();
        let mut p = page("page-1", Some("2026-03-02T09:00:00"));
        p.synced_since = Some("2026-03-12".to_string());
        let rules = vec![rule("rule-1", "page-1", "FREQ=DAILY", "2026-03-02T09:00:00")];

        assert_eq!(
            dates(virtual_occurrences_in_range(
                &[p],
                &rules,
                &[],
                from,
                to
            )),
            ["2026-03-12", "2026-03-13", "2026-03-14", "2026-03-15"]
        );
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

        let virtuals = virtual_occurrences_in_range(&pages, &rules, &[], from, to);
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
        assert!(virtual_occurrences_in_range(&[], &rules, &[], from, to).is_empty());
    }

    /// An all-day series projects date-only strings, which is what the all-day
    /// packer expects — handing it a timed string would drop the bar entirely.
    #[test]
    fn an_all_day_series_projects_date_only_occurrences() {
        let (from, to) = week_of_march_9();
        let pages = vec![page("page-1", Some("2026-03-02"))];
        let rules = vec![rule("rule-1", "page-1", "FREQ=WEEKLY;BYDAY=MO", "2026-03-02")];

        let virtuals = virtual_occurrences_in_range(&pages, &rules, &[], from, to);
        assert_eq!(virtuals.len(), 1);
        assert_eq!(virtuals[0].scheduled_start, "2026-03-09");
        assert!(virtuals[0].scheduled_end.is_none());
    }

    /// A page whose schedule was cleared still has a rule until something
    /// deletes it. With no head date there is nothing to suppress against.
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
            virtual_occurrences_in_range(&pages, &rules, &[], from, to).len(),
            1
        );
    }
}
