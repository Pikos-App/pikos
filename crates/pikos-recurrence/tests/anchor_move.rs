//! Ported from `packages/core/src/utils/scheduleAnchor.test.ts`, so the phone's anchor move
//! answers the same named cases as the desktop's.

use pikos_recurrence::resolve_anchor_move;

#[test]
fn a_single_weekday_weekly_rule_realigns_to_the_moved_weekday() {
    // 2026-01-05 is a Monday, 2026-01-07 a Wednesday.
    let moved = resolve_anchor_move("FREQ=WEEKLY;BYDAY=MO", "2026-01-07T09:00:00", None);
    assert_eq!(
        moved.rrule.as_deref(),
        Some("FREQ=WEEKLY;INTERVAL=1;BYDAY=WE")
    );
    assert_eq!(moved.start, "2026-01-07T09:00:00");
}

#[test]
fn a_daily_rule_keeps_its_shape_and_the_drop_point() {
    let moved = resolve_anchor_move("FREQ=DAILY", "2026-01-07T09:00:00", None);
    assert!(!moved.rrule.unwrap_or_default().contains("BYDAY"));
    assert_eq!(moved.start, "2026-01-07T09:00:00");
}

#[test]
fn an_off_pattern_drop_snaps_onto_a_day_a_multi_day_weekly_rule_yields() {
    let moved = resolve_anchor_move("FREQ=WEEKLY;BYDAY=MO,WE,FR", "2026-01-06T09:00:00", None);
    assert!(
        ["2026-01-05", "2026-01-07"].contains(&&moved.start[..10]),
        "got {}",
        moved.start
    );
}

#[test]
fn the_end_crosses_the_snap_so_the_block_keeps_its_span() {
    let moved = resolve_anchor_move(
        "FREQ=WEEKLY;BYDAY=MO,WE,FR",
        "2026-01-06T09:00:00",
        Some("2026-01-06T10:00:00"),
    );
    let end = moved.end.unwrap();
    assert_eq!(end[..10], moved.start[..10]);
    assert_eq!(&end[11..], "10:00:00");
}

#[test]
fn a_rule_the_editor_is_locked_out_of_is_not_realigned() {
    let moved = resolve_anchor_move(
        "FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO",
        "2026-01-07T09:00:00",
        None,
    );
    assert_eq!(moved.rrule, None);
}
