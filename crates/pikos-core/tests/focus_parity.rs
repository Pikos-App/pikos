//! The focus timer's floor and its two duration formats, graded against the
//! TypeScript.
//!
//! `tests/corpus/focus.json` is `packages/core/src/format/focusDuration.ts` over
//! durations chosen around every boundary the formatters have — regenerate with
//! `pnpm --filter @pikos/core gen:parity`.
//!
//! Small functions with a lot of edges: the floor, the minute rounding, the
//! singular/plural switch, the jump from `M:SS` to `H:MM:SS`, and an exact hour
//! where the trailing minutes are dropped. Each of those is a place where two
//! implementations can agree on every value anybody tried by hand and differ on
//! the one the user hits.

use std::fs;
use std::path::PathBuf;

use pikos_core::focus::{
    elapsed_label, finish_session, session_length, FocusOutcome, MIN_SESSION_S,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    seconds: i64,
    elapsed: String,
    session_length: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Corpus {
    cases: Vec<Case>,
    min_session_s: i64,
}

fn corpus() -> Corpus {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/corpus/focus.json");
    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&raw).expect("focus.json parses")
}

#[test]
fn both_formats_match_the_reference_at_every_boundary() {
    let corpus = corpus();
    for case in &corpus.cases {
        assert_eq!(
            elapsed_label(case.seconds),
            case.elapsed,
            "elapsed at {}s",
            case.seconds
        );
        assert_eq!(
            session_length(case.seconds),
            case.session_length,
            "session length at {}s",
            case.seconds
        );
    }
}

#[test]
fn the_floor_is_the_reference_s_floor() {
    assert_eq!(MIN_SESSION_S, corpus().min_session_s);
}

/// The floor is a `<`, and which side 30 seconds falls on is the whole question.
#[test]
fn a_session_exactly_at_the_floor_is_recorded() {
    assert!(matches!(
        finish_session(MIN_SESSION_S),
        FocusOutcome::Recorded { .. }
    ));
    assert!(matches!(
        finish_session(MIN_SESSION_S - 1),
        FocusOutcome::TooShort { .. }
    ));
}

/// Both outcomes say something. A silent discard below the floor reads exactly
/// like a silent success, which is the failure this exists to avoid.
#[test]
fn every_outcome_carries_a_sentence() {
    match finish_session(5) {
        FocusOutcome::TooShort { label } => {
            assert_eq!(label, "Under 30 seconds — not recorded")
        }
        other => panic!("expected TooShort, got {other:?}"),
    }
    match finish_session(1_500) {
        FocusOutcome::Recorded { duration_s, label } => {
            assert_eq!(duration_s, 1_500);
            assert_eq!(label, "Focused for 25 minutes");
        }
        other => panic!("expected Recorded, got {other:?}"),
    }
}

/// A clock that went backwards is not a session.
#[test]
fn a_negative_duration_is_too_short_rather_than_a_long_one() {
    assert!(matches!(finish_session(-90), FocusOutcome::TooShort { .. }));
    assert_eq!(elapsed_label(-5), "0:00", "and reads as zero, not as 0:-5");
}
