//! The engine must REJECT (not silently mis-enumerate) any RRULE outside its
//! supported envelope, so a caller feeding arbitrary synced-provider rules can
//! fall back loudly. See `ParsedRule::validate_envelope`.

use pikos_recurrence::{expand_range, RecurrenceError};

fn parse_result(rrule: &str) -> Result<(), RecurrenceError> {
    expand_range(rrule, "2026-01-01T09:00:00", None, "2026-01-01T00:00:00", "2027-01-01T00:00:00", &[])
        .map(|_| ())
}

fn assert_unsupported(rrule: &str) {
    match parse_result(rrule) {
        Err(RecurrenceError::Unsupported(_)) => {}
        other => panic!("expected Unsupported for `{rrule}`, got {other:?}"),
    }
}

fn assert_ok(rrule: &str) {
    assert!(parse_result(rrule).is_ok(), "expected `{rrule}` to be in-envelope");
}

#[test]
fn rejects_unhandled_by_parts() {
    // VTIMEZONE-style yearly nth-weekday-of-month — the motivating hazard.
    assert_unsupported("FREQ=YEARLY;BYMONTH=11;BYDAY=1SU");
    assert_unsupported("FREQ=MONTHLY;BYWEEKNO=1");
    assert_unsupported("FREQ=YEARLY;BYYEARDAY=100");
}

#[test]
fn rejects_sub_daily_freq() {
    assert_unsupported("FREQ=HOURLY");
    assert_unsupported("FREQ=MINUTELY;INTERVAL=30");
}

#[test]
fn rejects_by_parts_misapplied_to_freq() {
    assert_unsupported("FREQ=YEARLY;BYDAY=1SU");
    assert_unsupported("FREQ=DAILY;BYDAY=MO");
    assert_unsupported("FREQ=DAILY;BYMONTHDAY=1");
    assert_unsupported("FREQ=WEEKLY;BYDAY=MO;BYSETPOS=1"); // BYSETPOS is monthly-only
    assert_unsupported("FREQ=WEEKLY;BYDAY=1MO"); // BYDAY ordinals are monthly-only
    assert_unsupported("FREQ=WEEKLY;BYMONTHDAY=15");
    assert_unsupported("FREQ=MONTHLY;BYDAY=MO;BYMONTHDAY=15"); // the combo would silently drop BYDAY
}

#[test]
fn accepts_in_envelope() {
    assert_ok("FREQ=DAILY");
    assert_ok("FREQ=WEEKLY;BYDAY=MO,WE,FR;WKST=SU");
    assert_ok("FREQ=MONTHLY;BYMONTHDAY=-1");
    assert_ok("FREQ=MONTHLY;BYDAY=1MO"); // ordinal on monthly is fine
    assert_ok("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1");
    assert_ok("FREQ=YEARLY");
}
