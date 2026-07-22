//! Shadow-invariant harness — ACTIVE (the permanent `cache == f(truth)` gate for
//! the native head).
//!
//! Pins the load-bearing fact behind the occurrence-sets swap: after any sequence
//! of completions and skips, the stored native head (`pages.scheduled_start`)
//! equals `oldest_open_for_page` derived from scratch over `(base anchor, rrule,
//! exclusion union)`. Completion now recomputes the head from truth; this gates
//! the whole path (completion → recompute → cache, plus every skip/exdate trigger)
//! end-to-end across the corpus, so a missed trigger or a union bug desyncs it.

use super::*;
use crate::pool::{insert_test_page, test_pool, TestPage};

async fn head_scheduled_start(pool: &sqlx::SqlitePool) -> Option<String> {
    sqlx::query_scalar("SELECT scheduled_start FROM pages WHERE id = 'head'")
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn head_status(pool: &sqlx::SqlitePool) -> String {
    sqlx::query_scalar("SELECT status FROM pages WHERE id = 'head'")
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Drives a fresh series through `skip_indices` (future occurrences skipped
/// up-front, like a user dismissing them) then `completions` head completions,
/// asserting `head == oldest_open(base, rrule, completed ∪ skipped)` at every
/// step. Completion derives its own advance via recompute — no client next date.
async fn assert_invariant(
    rrule: &str,
    base_start: &str,
    base_end: Option<&str>,
    skip_indices: &[usize],
    completions: usize,
) {
    let pool = test_pool().await;
    insert_test_page(
        &pool,
        TestPage {
            scheduled_start: Some(base_start),
            ..TestPage::new("head", "H")
        },
    )
    .await
    .unwrap();
    let rule = crate::schedules::create_recurrence_rule_impl(
        &pool,
        crate::NewRecurrenceRule {
            page_id: "head".into(),
            rrule: rrule.into(),
            rrule_exdates: vec![],
            scheduled_start: base_start.into(),
            scheduled_end: base_end.map(str::to_string),
            timezone: "America/Los_Angeles".into(),
        },
    )
    .await
    .unwrap();

    // Skip a few future occurrences up-front — the head must later advance
    // *over* them, never onto one.
    let mut exdates: Vec<String> = Vec::new();
    let upcoming = pikos_recurrence::expand_range(
        rrule,
        base_start,
        base_end,
        base_start,
        "2099-01-01T00:00:00",
        &[],
    )
    .unwrap();
    for &i in skip_indices {
        if let Some(occ) = upcoming.get(i) {
            crate::schedules::add_rule_exdates_impl(
                &pool,
                rule.id.clone(),
                vec![occ.original_date.clone()],
            )
            .await
            .unwrap();
            exdates.push(occ.original_date.clone());
        }
    }

    for step in 0..completions {
        // Independent check: the stored head — advanced imperatively by prior
        // completions — equals oldest_open derived from scratch.
        let Some(head_occ) = crate::oldest_open_for_page(&pool, "head").await.unwrap() else {
            assert_eq!(
                head_status(&pool).await,
                "done",
                "exhausted series head not done: {rrule}"
            );
            return;
        };
        assert_eq!(
            head_scheduled_start(&pool).await.as_deref(),
            Some(head_occ.scheduled_start.as_str()),
            "invariant before step {step}: rrule={rrule}, exdates={exdates:?}"
        );

        // Track the completed date for the error context; the backend records it in
        // completed_set and recomputes the head — no client-supplied next date.
        exdates.push(head_occ.original_date.clone());
        complete_recurring_page_impl(
            &pool,
            CompleteRecurringInput {
                page_id: "head".into(),
                skip_dates: vec![],
                occurrence_date: None,
                scheduled_start: None,
                scheduled_end: None,
            },
        )
        .await
        .unwrap();
    }

    match crate::oldest_open_for_page(&pool, "head").await.unwrap() {
        Some(occ) => assert_eq!(
            head_scheduled_start(&pool).await.as_deref(),
            Some(occ.scheduled_start.as_str()),
            "final invariant: rrule={rrule}, exdates={exdates:?}"
        ),
        None => assert_eq!(head_status(&pool).await, "done"),
    }
}

/// Rule + a matching base anchor (an occurrence of the rule, mirroring the
/// frontend's `snapAnchorToRule`).
const CORPUS: &[(&str, &str, Option<&str>)] = &[
    (
        "FREQ=DAILY",
        "2026-05-21T09:00:00",
        Some("2026-05-21T09:30:00"),
    ),
    ("FREQ=DAILY;INTERVAL=3", "2026-05-21T09:00:00", None),
    (
        "FREQ=WEEKLY;BYDAY=MO",
        "2026-05-18T09:00:00",
        Some("2026-05-18T10:00:00"),
    ),
    ("FREQ=WEEKLY;BYDAY=MO,WE,FR", "2026-05-18T09:00:00", None),
    (
        "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;WKST=SU",
        "2026-05-19T09:00:00",
        None,
    ),
    ("FREQ=MONTHLY;BYMONTHDAY=15", "2026-05-15T09:00:00", None),
    ("FREQ=MONTHLY;BYMONTHDAY=-1", "2026-05-31T09:00:00", None),
    (
        "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
        "2026-05-29T09:00:00",
        None,
    ),
    ("FREQ=MONTHLY;BYDAY=1MO", "2026-06-01T09:00:00", None),
    ("FREQ=YEARLY", "2026-02-14T09:00:00", None),
    (
        "FREQ=DAILY;UNTIL=20260525T235959Z",
        "2026-05-21T09:00:00",
        None,
    ),
    ("FREQ=WEEKLY;BYDAY=MO", "2026-05-18", None), // all-day
    // The real recorded standup event from the CalDAV sync fixtures (tests/
    // fixtures/caldav/sync) — BYDAY combined with a UNTIL=…Z bound, an intersection
    // the hand-written entries above split apart. The fixtures' other RRULEs are
    // VTIMEZONE-transition rules (FREQ=YEARLY;BYMONTH=…), which BYMONTH puts outside
    // the native engine's envelope, so they're not valid native-series shapes.
    (
        "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260831T130000Z",
        "2026-06-01T09:00:00",
        Some("2026-06-01T09:30:00"),
    ),
];

#[tokio::test]
async fn head_equals_oldest_open_across_corpus() {
    for (rrule, base, end) in CORPUS {
        assert_invariant(rrule, base, *end, &[], 5).await;
    }
}

#[tokio::test]
async fn head_equals_oldest_open_with_interleaved_skips() {
    // Skipping future occurrences must not desync the head; completion advances
    // over the skipped dates.
    for (rrule, base, end) in CORPUS {
        assert_invariant(rrule, base, *end, &[1, 3], 4).await;
    }
}

#[tokio::test]
async fn head_equals_oldest_open_finite_series_terminal() {
    // COUNT bounds the series; completing past it must land the head on `done`,
    // matching oldest_open returning None.
    assert_invariant("FREQ=DAILY;COUNT=3", "2026-05-21T09:00:00", None, &[], 5).await;
    assert_invariant(
        "FREQ=WEEKLY;BYDAY=MO;COUNT=2",
        "2026-05-18T09:00:00",
        None,
        &[],
        4,
    )
    .await;
}
