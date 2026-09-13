//! The quick-add FFI surface.
//!
//! Parsing itself is graded in `pikos-core` against the TypeScript corpus;
//! what is checked here is the boundary — that a malformed reference is
//! refused rather than guessed at, and that priority survives the crossing with
//! all three of its states intact. Collapsing "not mentioned" into "cleared" is
//! the mistake this surface is shaped to prevent, so it is the one the tests
//! aim at.

use pikos_ffi::{parse_quick_add, Priority, PriorityEdit, QuickAddResult};

const NOW: &str = "2026-03-15T12:00:00";

fn single(input: &str) -> pikos_ffi::QuickAddInput {
    match parse_quick_add(input.to_string(), NOW.to_string()).expect("valid reference") {
        QuickAddResult::Single { input } => input,
        other => panic!("expected a single page, got {:?}", discriminant(&other)),
    }
}

fn discriminant(result: &QuickAddResult) -> &'static str {
    match result {
        QuickAddResult::Single { .. } => "single",
        QuickAddResult::Finite { .. } => "finite",
        QuickAddResult::Recurring { .. } => "recurring",
    }
}

#[test]
fn a_malformed_reference_is_refused_rather_than_guessed_at() {
    assert!(parse_quick_add("call bob".into(), "not-a-date".into()).is_none());
    assert!(parse_quick_add("call bob".into(), String::new()).is_none());
    // February 30th does not exist, so neither does a parse relative to it.
    assert!(parse_quick_add("call bob".into(), "2026-02-30T12:00:00".into()).is_none());
    assert!(parse_quick_add("call bob".into(), NOW.into()).is_some());
}

#[test]
fn a_line_with_no_date_is_a_page_not_an_error() {
    let input = single("think about the roadmap");
    assert_eq!(input.title, "think about the roadmap");
    assert!(input.scheduled_start.is_none());
    assert!(input.tags.is_empty());
}

#[test]
fn priority_crosses_with_all_three_of_its_states() {
    assert!(matches!(
        single("call bob").priority,
        PriorityEdit::Unchanged
    ));
    assert!(matches!(
        single("call bob !0").priority,
        PriorityEdit::Cleared
    ));
    assert!(matches!(
        single("call bob !urgent").priority,
        PriorityEdit::Set {
            priority: Priority::Urgent
        }
    ));
    assert!(matches!(
        single("call bob !4").priority,
        PriorityEdit::Set {
            priority: Priority::Low
        }
    ));
}

#[test]
fn every_field_survives_the_crossing() {
    let input = single("call bob #work #home ~inbox !high for 2h tomorrow at 3pm");
    assert_eq!(input.title, "call bob");
    assert_eq!(input.tags, ["work", "home"]);
    assert_eq!(input.folder_query.as_deref(), Some("inbox"));
    assert_eq!(input.duration_minutes, Some(120));
    assert_eq!(
        input.scheduled_start.as_deref(),
        Some("2026-03-16T15:00:00")
    );
    assert_eq!(input.scheduled_end.as_deref(), Some("2026-03-16T17:00:00"));
}

#[test]
fn a_rule_comes_back_as_a_recurring_page() {
    let result = parse_quick_add("standup every weekday at 9am".into(), NOW.into())
        .expect("valid reference");
    let QuickAddResult::Recurring { input, rrule } = result else {
        panic!("expected a recurring page");
    };
    assert_eq!(rrule, "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
    assert_eq!(input.title, "standup");
    assert_eq!(
        input.scheduled_start.as_deref(),
        Some("2026-03-16T09:00:00")
    );
}

#[test]
fn a_named_set_of_days_comes_back_as_concrete_pages() {
    let result = parse_quick_add("run m/w/f at 3pm".into(), NOW.into()).expect("valid reference");
    let QuickAddResult::Finite { inputs } = result else {
        panic!("expected a finite series");
    };
    let starts: Vec<_> = inputs
        .iter()
        .map(|input| input.scheduled_start.as_deref().unwrap_or_default())
        .collect();
    assert_eq!(
        starts,
        [
            "2026-03-16T15:00:00",
            "2026-03-18T15:00:00",
            "2026-03-20T15:00:00"
        ]
    );
    // Every page in the series carries the same title and metadata.
    assert!(inputs.iter().all(|input| input.title == "run"));
}
