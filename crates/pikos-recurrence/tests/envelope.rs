//! Envelope boundary: the engine REJECTS (never silently mis-enumerates) parts
//! it does not implement, and ENUMERATES everything with defined rrule.js
//! semantics. With rrule.js gone there is no fallback engine — a rejected rule
//! renders nowhere — so rejection is reserved for parts whose semantics the
//! enumerator genuinely lacks. See `ParsedRule::parse`.

use pikos_recurrence::{expand_range, list_occurrences, RecurrenceError};

fn parse_result(rrule: &str) -> Result<(), RecurrenceError> {
    expand_range(
        rrule,
        "2026-01-01T09:00:00",
        None,
        "2026-01-01T00:00:00",
        "2027-01-01T00:00:00",
        &[],
    )
    .map(|_| ())
}

fn assert_unsupported(rrule: &str) {
    match parse_result(rrule) {
        Err(RecurrenceError::Unsupported(_)) => {}
        other => panic!("expected Unsupported for `{rrule}`, got {other:?}"),
    }
}

fn assert_ok(rrule: &str) {
    assert!(
        parse_result(rrule).is_ok(),
        "expected `{rrule}` to be in-envelope"
    );
}

#[test]
fn rejects_unimplemented_by_parts() {
    assert_unsupported("FREQ=MONTHLY;BYWEEKNO=1");
    assert_unsupported("FREQ=YEARLY;BYYEARDAY=100");
    assert_unsupported("FREQ=DAILY;BYHOUR=9");
    assert_unsupported("FREQ=WEEKLY;BYMONTHDAY=15"); // RFC-forbidden combination
}

#[test]
fn rejects_sub_daily_freq() {
    assert_unsupported("FREQ=HOURLY");
    assert_unsupported("FREQ=MINUTELY;INTERVAL=30");
}

#[test]
fn accepts_in_envelope() {
    assert_ok("FREQ=DAILY");
    assert_ok("FREQ=WEEKLY;BYDAY=MO,WE,FR;WKST=SU");
    assert_ok("FREQ=MONTHLY;BYMONTHDAY=-1");
    assert_ok("FREQ=MONTHLY;BYDAY=1MO");
    assert_ok("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1");
    assert_ok("FREQ=YEARLY");
}

// ─── Arms the envelope widening added — enumeration pinned, not just accepted ──

#[test]
fn yearly_bymonth_byday_ordinal_enumerates() {
    // The VTIMEZONE / US-holiday shape the old envelope rejected.
    let thanksgiving =
        list_occurrences("FREQ=YEARLY;BYMONTH=11;BYDAY=4TH", "2026-01-01T09:00:00", 3);
    assert_eq!(
        thanksgiving,
        [
            "2026-11-26T09:00:00",
            "2027-11-25T09:00:00",
            "2028-11-23T09:00:00"
        ]
    );
}

#[test]
fn yearly_bymonth_bymonthday_enumerates() {
    // "15 March, annually" — the common provider rule C37 named.
    let dates = list_occurrences(
        "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15",
        "2026-01-01T09:00:00",
        2,
    );
    assert_eq!(dates, ["2026-03-15T09:00:00", "2027-03-15T09:00:00"]);
}

#[test]
fn daily_byday_filters() {
    let dates = list_occurrences("FREQ=DAILY;BYDAY=MO,WE", "2026-03-02T09:00:00", 4);
    assert_eq!(
        dates,
        [
            "2026-03-02T09:00:00", // Mon
            "2026-03-04T09:00:00", // Wed
            "2026-03-09T09:00:00", // Mon
            "2026-03-11T09:00:00", // Wed
        ]
    );
}

#[test]
fn weekly_bymonth_filters() {
    // June/July Mondays only — the head-drag degrade scenario's rule (C43).
    let dates = list_occurrences("FREQ=WEEKLY;BYDAY=MO;BYMONTH=6,7", "2026-05-01T09:00:00", 3);
    assert_eq!(
        dates,
        [
            "2026-06-01T09:00:00",
            "2026-06-08T09:00:00",
            "2026-06-15T09:00:00"
        ]
    );
}

#[test]
fn monthly_byday_bymonthday_intersects() {
    // Friday the 13th: BYMONTHDAY limits BYDAY (RFC 5545), not either-or.
    let dates = list_occurrences(
        "FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13",
        "2026-01-01T09:00:00",
        2,
    );
    assert_eq!(dates, ["2026-02-13T09:00:00", "2026-03-13T09:00:00"]);
}

#[test]
fn weekly_byday_ordinal_reads_as_bare_weekday() {
    // rrule.js parity: ordinals are only meaningful under MONTHLY/YEARLY.
    assert_eq!(
        list_occurrences("FREQ=WEEKLY;BYDAY=1MO", "2026-03-02T09:00:00", 3),
        list_occurrences("FREQ=WEEKLY;BYDAY=MO", "2026-03-02T09:00:00", 3),
    );
}

#[test]
fn count_and_until_run_to_the_tighter_bound() {
    // RFC forbids the pair but rrule.js honors both; with no fallback engine,
    // enumerate rather than reject. COUNT tighter:
    let by_count = list_occurrences(
        "FREQ=DAILY;COUNT=3;UNTIL=20260401T000000Z",
        "2026-03-02T09:00:00",
        10,
    );
    assert_eq!(by_count.len(), 3);
    // UNTIL tighter:
    let by_until = list_occurrences(
        "FREQ=DAILY;COUNT=90;UNTIL=20260304T235959Z",
        "2026-03-02T09:00:00",
        10,
    );
    assert_eq!(
        by_until,
        [
            "2026-03-02T09:00:00",
            "2026-03-03T09:00:00",
            "2026-03-04T09:00:00"
        ]
    );
}
