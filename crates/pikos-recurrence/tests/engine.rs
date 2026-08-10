//! Engine behavior pins ported from `packages/core/src/utils/recurrence.test.ts`
//! (via the wasm branch's port), so the native build carries the same explicit
//! cases the JS suite asserts — the corpus and goldens pin breadth; these pin
//! the readable, named behaviors without a JS toolchain in the loop.

use pikos_recurrence::{
    align_weekly_rule_to_anchor, build_rrule, compute_next_end, expand_range, list_occurrences,
    missed_occurrences_between, parse_rrule, snap_anchor_to_rule, Freq, Occurrence,
    RecurrenceOptions,
};

fn ex(dates: &[&str]) -> Vec<String> {
    dates.iter().map(|s| s.to_string()).collect()
}

fn expand(rrule: &str, start: &str, end: Option<&str>, rs: &str, re: &str, exdates: &[String]) -> Vec<Occurrence> {
    expand_range(rrule, start, end, rs, re, exdates).unwrap()
}

/// Start-only view of `next_occurrence_after`, matching the TS return shape.
fn next(rrule: &str, start: &str, after: &str, exdates: &[String]) -> Option<String> {
    pikos_recurrence::next_occurrence_after(rrule, start, after, exdates)
        .unwrap()
        .map(|(s, _end)| s)
}

// ─── expand_range ───────────────────────────────────────────────────────────

#[test]
fn expands_weekly_recurrence_for_a_one_week_range() {
    let occ = expand(
        "FREQ=WEEKLY;BYDAY=MO",
        "2026-03-02T09:00:00",
        Some("2026-03-02T10:00:00"),
        "2026-03-02T00:00:00",
        "2026-03-09T00:00:00",
        &[],
    );
    assert_eq!(occ.len(), 1);
    assert_eq!(occ[0].scheduled_start, "2026-03-02T09:00:00");
    assert_eq!(occ[0].scheduled_end.as_deref(), Some("2026-03-02T10:00:00"));
    assert_eq!(occ[0].original_date, "2026-03-02");
}

#[test]
fn expands_multiple_weeks() {
    let occ = expand(
        "FREQ=WEEKLY;BYDAY=MO",
        "2026-03-02T09:00:00",
        Some("2026-03-02T10:00:00"),
        "2026-03-02T00:00:00",
        "2026-03-23T00:00:00",
        &[],
    );
    let dates: Vec<&str> = occ.iter().map(|o| o.original_date.as_str()).collect();
    assert_eq!(dates, ["2026-03-02", "2026-03-09", "2026-03-16"]);
}

#[test]
fn excludes_exdates() {
    let occ = expand(
        "FREQ=WEEKLY;BYDAY=MO",
        "2026-03-02T09:00:00",
        None,
        "2026-03-02T00:00:00",
        "2026-03-23T00:00:00",
        &ex(&["2026-03-09"]),
    );
    let dates: Vec<&str> = occ.iter().map(|o| o.original_date.as_str()).collect();
    assert_eq!(dates, ["2026-03-02", "2026-03-16"]);
}

#[test]
fn handles_all_day_recurrence() {
    let occ = expand(
        "FREQ=WEEKLY;BYDAY=MO",
        "2026-03-02",
        None,
        "2026-03-02T00:00:00",
        "2026-03-09T00:00:00",
        &[],
    );
    assert_eq!(occ.len(), 1);
    assert_eq!(occ[0].scheduled_start, "2026-03-02");
    assert_eq!(occ[0].scheduled_end, None);
}

#[test]
fn daily_recurrence_preserves_duration() {
    let occ = expand(
        "FREQ=DAILY",
        "2026-03-02T09:00:00",
        Some("2026-03-02T09:30:00"),
        "2026-03-02T00:00:00",
        "2026-03-05T00:00:00",
        &[],
    );
    assert_eq!(occ.len(), 3);
    for o in &occ {
        assert!(o.scheduled_start.ends_with("T09:00:00"));
        assert!(o.scheduled_end.as_deref().unwrap().ends_with("T09:30:00"));
    }
}

#[test]
fn empty_when_no_occurrences_in_range() {
    let occ = expand(
        "FREQ=WEEKLY;BYDAY=MO",
        "2026-03-02T09:00:00",
        None,
        "2026-03-03T00:00:00",
        "2026-03-06T00:00:00",
        &[],
    );
    assert!(occ.is_empty());
}

#[test]
fn biweekly_interval_skips_alternate_weeks() {
    let occ = expand(
        "FREQ=WEEKLY;BYDAY=MO;INTERVAL=2",
        "2026-03-02T09:00:00",
        None,
        "2026-03-02T00:00:00",
        "2026-04-13T00:00:00",
        &[],
    );
    let dates: Vec<&str> = occ.iter().map(|o| o.original_date.as_str()).collect();
    assert_eq!(dates, ["2026-03-02", "2026-03-16", "2026-03-30"]);
}

#[test]
fn empty_when_range_entirely_after_until() {
    let occ = expand(
        "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260309T235959Z",
        "2026-03-02T09:00:00",
        None,
        "2026-03-16T00:00:00",
        "2026-03-30T00:00:00",
        &[],
    );
    assert!(occ.is_empty());
}

#[test]
fn expansion_bounded_by_count() {
    let occ = expand(
        "FREQ=WEEKLY;BYDAY=MO;COUNT=2",
        "2026-03-02T09:00:00",
        None,
        "2026-03-02T00:00:00",
        "2026-03-30T00:00:00",
        &[],
    );
    let dates: Vec<&str> = occ.iter().map(|o| o.original_date.as_str()).collect();
    assert_eq!(dates, ["2026-03-02", "2026-03-09"]);
}

#[test]
fn no_occurrences_before_dtstart() {
    let occ = expand(
        "FREQ=WEEKLY;BYDAY=MO",
        "2026-03-02T09:00:00",
        None,
        "2026-02-23T00:00:00",
        "2026-03-09T00:00:00",
        &[],
    );
    let dates: Vec<&str> = occ.iter().map(|o| o.original_date.as_str()).collect();
    assert_eq!(dates, ["2026-03-02"]);
}

// ─── next_occurrence_after ──────────────────────────────────────────────────

#[test]
fn next_monday_after_given_date() {
    assert_eq!(
        next("FREQ=WEEKLY;BYDAY=MO", "2026-03-02T09:00:00", "2026-03-02T00:00:00", &[]).as_deref(),
        Some("2026-03-09T09:00:00")
    );
}

#[test]
fn skips_missed_occurrences() {
    assert_eq!(
        next("FREQ=WEEKLY;BYDAY=MO", "2026-03-02T09:00:00", "2026-03-18T00:00:00", &[]).as_deref(),
        Some("2026-03-23T09:00:00")
    );
}

#[test]
fn next_handles_all_day() {
    assert_eq!(
        next("FREQ=WEEKLY;BYDAY=FR", "2026-03-06", "2026-03-06T00:00:00", &[]).as_deref(),
        Some("2026-03-13")
    );
}

#[test]
fn next_handles_daily() {
    assert_eq!(
        next("FREQ=DAILY", "2026-03-02T08:00:00", "2026-03-05T00:00:00", &[]).as_deref(),
        Some("2026-03-06T08:00:00")
    );
}

#[test]
fn none_when_until_has_passed() {
    assert_eq!(
        next(
            "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260310T000000Z",
            "2026-03-02T09:00:00",
            "2026-03-15T00:00:00",
            &[]
        ),
        None
    );
}

#[test]
fn none_when_count_exhausted_weekly() {
    assert_eq!(
        next("FREQ=WEEKLY;BYDAY=MO;COUNT=2", "2026-03-02T09:00:00", "2026-03-09T23:59:00", &[]),
        None
    );
}

#[test]
fn none_when_count_1_daily() {
    assert_eq!(
        next("FREQ=DAILY;COUNT=1", "2026-03-02T09:00:00", "2026-03-02T00:00:00", &[]),
        None
    );
}

#[test]
fn next_within_count_bound() {
    assert_eq!(
        next("FREQ=WEEKLY;BYDAY=MO;COUNT=3", "2026-03-02T09:00:00", "2026-03-05T00:00:00", &[])
            .as_deref(),
        Some("2026-03-09T09:00:00")
    );
}

#[test]
fn final_occurrence_within_count() {
    assert_eq!(
        next("FREQ=DAILY;COUNT=3", "2026-03-02T09:00:00", "2026-03-03T00:00:00", &[]).as_deref(),
        Some("2026-03-04T09:00:00")
    );
}

#[test]
fn skips_single_exdate() {
    assert_eq!(
        next("FREQ=DAILY", "2026-03-02T09:00:00", "2026-03-02T00:00:00", &ex(&["2026-03-03"]))
            .as_deref(),
        Some("2026-03-04T09:00:00")
    );
}

#[test]
fn skips_consecutive_exdates() {
    assert_eq!(
        next(
            "FREQ=DAILY",
            "2026-03-02T09:00:00",
            "2026-03-02T00:00:00",
            &ex(&["2026-03-03", "2026-03-04", "2026-03-05"])
        )
        .as_deref(),
        Some("2026-03-06T09:00:00")
    );
}

#[test]
fn ignores_non_matching_exdates() {
    assert_eq!(
        next(
            "FREQ=WEEKLY;BYDAY=MO",
            "2026-03-02T09:00:00",
            "2026-03-02T00:00:00",
            &ex(&["2026-03-05"])
        )
        .as_deref(),
        Some("2026-03-09T09:00:00")
    );
}

#[test]
fn none_when_every_remaining_count_occurrence_excluded() {
    assert_eq!(
        next(
            "FREQ=DAILY;COUNT=3",
            "2026-03-02T09:00:00",
            "2026-03-02T00:00:00",
            &ex(&["2026-03-03", "2026-03-04"])
        ),
        None
    );
}

#[test]
fn completing_same_day_returns_next_week() {
    assert_eq!(
        next("FREQ=WEEKLY;BYDAY=MO", "2026-03-02T09:00:00", "2026-03-02T08:00:00", &[]).as_deref(),
        Some("2026-03-09T09:00:00")
    );
}

// ─── snap_anchor_to_rule ────────────────────────────────────────────────────

#[test]
fn snaps_sunday_anchor_to_mwf_rule() {
    assert_eq!(snap_anchor_to_rule("FREQ=WEEKLY;BYDAY=MO,WE,FR", "2026-06-07"), "2026-06-08");
}

#[test]
fn leaves_satisfying_anchor() {
    assert_eq!(snap_anchor_to_rule("FREQ=WEEKLY;BYDAY=MO,WE,FR", "2026-06-08"), "2026-06-08");
}

#[test]
fn snap_preserves_wall_clock_time() {
    assert_eq!(
        snap_anchor_to_rule("FREQ=WEEKLY;BYDAY=MO,WE,FR", "2026-06-07T09:30:00"),
        "2026-06-08T09:30:00"
    );
}

#[test]
fn snap_leaves_daily_and_monthly_anchor() {
    assert_eq!(snap_anchor_to_rule("FREQ=DAILY", "2026-06-07"), "2026-06-07");
    assert_eq!(snap_anchor_to_rule("FREQ=MONTHLY", "2026-06-07"), "2026-06-07");
}

#[test]
fn snap_unchanged_when_rule_yields_nothing() {
    assert_eq!(
        snap_anchor_to_rule("FREQ=WEEKLY;BYDAY=MO;UNTIL=20260610T235959Z", "2026-06-09"),
        "2026-06-09"
    );
}

#[test]
fn snap_unchanged_for_unparseable_rule() {
    assert_eq!(snap_anchor_to_rule("not-a-rule", "2026-06-07"), "2026-06-07");
}

// ─── align_weekly_rule_to_anchor ────────────────────────────────────────────

#[test]
fn realigns_single_byday_to_moved_weekday() {
    // 2099-01-07 is a Wednesday.
    assert_eq!(
        align_weekly_rule_to_anchor("FREQ=WEEKLY;BYDAY=MO", "2099-01-07"),
        "FREQ=WEEKLY;INTERVAL=1;BYDAY=WE"
    );
    assert_eq!(
        align_weekly_rule_to_anchor("FREQ=WEEKLY;BYDAY=MO", "2099-01-07T09:00:00"),
        "FREQ=WEEKLY;INTERVAL=1;BYDAY=WE"
    );
}

#[test]
fn align_unchanged_when_already_on_weekday() {
    assert_eq!(
        align_weekly_rule_to_anchor("FREQ=WEEKLY;BYDAY=MO", "2099-01-05T14:00:00"),
        "FREQ=WEEKLY;BYDAY=MO"
    );
}

#[test]
fn align_preserves_interval_and_end_conditions() {
    assert_eq!(
        align_weekly_rule_to_anchor("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;COUNT=10", "2099-01-07"),
        "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;COUNT=10"
    );
}

#[test]
fn align_leaves_multi_day_nonweekly_and_no_byday() {
    assert_eq!(
        align_weekly_rule_to_anchor("FREQ=WEEKLY;BYDAY=MO,WE,FR", "2099-01-06"),
        "FREQ=WEEKLY;BYDAY=MO,WE,FR"
    );
    assert_eq!(align_weekly_rule_to_anchor("FREQ=DAILY", "2099-01-07"), "FREQ=DAILY");
    assert_eq!(align_weekly_rule_to_anchor("FREQ=MONTHLY", "2099-01-07"), "FREQ=MONTHLY");
    assert_eq!(align_weekly_rule_to_anchor("FREQ=WEEKLY", "2099-01-07"), "FREQ=WEEKLY");
}

// ─── compute_next_end ───────────────────────────────────────────────────────

#[test]
fn preserves_end_time_on_new_date() {
    assert_eq!(
        compute_next_end("2026-03-02T10:00:00", "2026-03-09T09:00:00").as_deref(),
        Some("2026-03-09T10:00:00")
    );
}

#[test]
fn next_end_none_for_all_day() {
    assert_eq!(compute_next_end("2026-03-02", "2026-03-09"), None);
}

#[test]
fn next_end_wraps_overnight() {
    assert_eq!(
        compute_next_end("2026-03-03T01:00:00", "2026-03-09T22:00:00").as_deref(),
        Some("2026-03-10T01:00:00")
    );
}

// ─── parse_rrule / build_rrule ──────────────────────────────────────────────

#[test]
fn parses_freq_and_defaults_interval() {
    for (s, freq) in [
        ("FREQ=DAILY", Freq::Daily),
        ("FREQ=WEEKLY", Freq::Weekly),
        ("FREQ=MONTHLY", Freq::Monthly),
        ("FREQ=YEARLY", Freq::Yearly),
    ] {
        let opts = parse_rrule(s).unwrap();
        assert_eq!(opts.freq, Some(freq));
        assert_eq!(opts.interval, 1);
        assert_eq!(opts.byweekday, None);
        assert_eq!(opts.count, None);
        assert_eq!(opts.until, None);
    }
}

#[test]
fn parses_interval_byday_count_until() {
    assert_eq!(parse_rrule("FREQ=WEEKLY;INTERVAL=3").unwrap().interval, 3);
    assert_eq!(
        parse_rrule("FREQ=WEEKLY;BYDAY=MO,WE,FR").unwrap().byweekday,
        Some(vec![0, 2, 4])
    );
    let counted = parse_rrule("FREQ=DAILY;COUNT=10").unwrap();
    assert_eq!(counted.count, Some(10));
    assert_eq!(counted.until, None);
    let until = parse_rrule("FREQ=WEEKLY;UNTIL=20260615T235959Z").unwrap();
    assert_eq!(until.until.as_deref(), Some("2026-06-15"));
    assert_eq!(until.count, None);
}

#[test]
fn parse_rejects_invalid_and_freqless() {
    assert_eq!(parse_rrule("NOT_A_RULE"), None);
    assert_eq!(parse_rrule("INTERVAL=2"), None);
}

#[test]
fn parse_strips_byday_ordinals_but_keeps_rich_terms() {
    // Unlike the historical rrule.js path, bymonthday/wkst are surfaced (the
    // Ends controls preserve them); BYDAY ordinals still reduce to the weekday.
    let opts = parse_rrule("FREQ=MONTHLY;BYDAY=2MO;BYMONTHDAY=15;WKST=SU").unwrap();
    assert_eq!(opts.byweekday, Some(vec![0]));
    assert_eq!(opts.bymonthday, Some(vec![15]));
    assert_eq!(opts.wkst, Some(6));
}

#[test]
fn builds_expected_rrule_strings() {
    let weekly = RecurrenceOptions {
        freq: Some(Freq::Weekly),
        interval: 1,
        byweekday: Some(vec![0, 2, 4]),
        ..Default::default()
    };
    assert_eq!(build_rrule(&weekly), "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR");

    let until = RecurrenceOptions {
        freq: Some(Freq::Weekly),
        interval: 1,
        until: Some("2026-06-15".to_string()),
        ..Default::default()
    };
    assert_eq!(build_rrule(&until), "FREQ=WEEKLY;INTERVAL=1;UNTIL=20260615T235959");

    let counted = RecurrenceOptions {
        freq: Some(Freq::Daily),
        interval: 2,
        count: Some(5),
        ..Default::default()
    };
    assert_eq!(build_rrule(&counted), "FREQ=DAILY;INTERVAL=2;COUNT=5");
}

#[test]
fn roundtrips_parse_build() {
    for original in [
        "FREQ=DAILY",
        "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR",
        "FREQ=MONTHLY;COUNT=12",
        "FREQ=YEARLY;UNTIL=20301231T235959Z",
        "FREQ=MONTHLY;BYMONTHDAY=15,-1;BYSETPOS=1;WKST=SU",
    ] {
        let parsed = parse_rrule(original).unwrap();
        let rebuilt = build_rrule(&parsed);
        assert_eq!(parse_rrule(&rebuilt).unwrap(), parsed, "roundtrip for {original}");
    }
}

// ─── missed_occurrences_between / list_occurrences ──────────────────────────

#[test]
fn missed_occurrences_strictly_between() {
    let missed = missed_occurrences_between(
        "FREQ=DAILY",
        "2026-03-02T09:00:00",
        "2026-03-02T09:00:00",
        "2026-03-06T00:00:00",
        &ex(&["2026-03-04"]),
    )
    .unwrap();
    assert_eq!(missed, ["2026-03-03", "2026-03-05"]);
}

#[test]
fn missed_empty_when_range_inverted() {
    let missed = missed_occurrences_between(
        "FREQ=DAILY",
        "2026-03-02T09:00:00",
        "2026-03-06T00:00:00",
        "2026-03-02T00:00:00",
        &[],
    )
    .unwrap();
    assert!(missed.is_empty());
}

#[test]
fn lists_occurrences_from_dtstart() {
    let occ = list_occurrences("FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=4", "2026-03-02T09:00:00", 100);
    assert_eq!(
        occ,
        [
            "2026-03-02T09:00:00",
            "2026-03-04T09:00:00",
            "2026-03-06T09:00:00",
            "2026-03-09T09:00:00"
        ]
    );
}
