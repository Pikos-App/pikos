//! `extract_until` is the FREQ-agnostic UNTIL reader the reconciler's
//! pre-window sweep guard depends on. Format handling is shared with
//! `parse_until`; see its doc comment for why FREQ-agnostic matters.

use pikos_recurrence::extract_until;

fn until_ymd(rrule: &str) -> Option<String> {
    extract_until(rrule).map(|dt| dt.format("%Y-%m-%dT%H:%M:%S").to_string())
}

#[test]
fn reads_date_and_datetime_forms() {
    assert_eq!(
        until_ymd("FREQ=WEEKLY;UNTIL=20260201").as_deref(),
        Some("2026-02-01T00:00:00")
    );
    assert_eq!(
        until_ymd("FREQ=WEEKLY;BYDAY=MO;UNTIL=20260201T100000Z").as_deref(),
        Some("2026-02-01T10:00:00"),
    );
}

#[test]
fn is_freq_agnostic_so_a_bounded_hourly_rule_still_reports_its_bound() {
    assert!(extract_until("FREQ=HOURLY;UNTIL=20260201T100000Z").is_some());
}

#[test]
fn none_when_absent_or_unparseable() {
    assert!(extract_until("FREQ=WEEKLY").is_none());
    assert!(extract_until("FREQ=WEEKLY;COUNT=5").is_none());
    assert!(extract_until("FREQ=WEEKLY;UNTIL=garbage").is_none());
}

#[test]
fn tolerates_token_order_and_case() {
    assert!(extract_until("UNTIL=20260201;FREQ=DAILY").is_some());
    assert!(extract_until("freq=daily;until=20260201").is_some());
}
