//! The recurrence port against randomly composed rules.
//!
//! `parity.rs` grades these four functions against 35 hand-written cases. That
//! found nothing — which is exactly what the 317-input parser corpus said, right
//! up until a fuzzer found six divergence classes in it. The recurrence surface
//! has at least as much edge: leap days, month days a month does not have,
//! `BYDAY=3TU`, `COUNT` and `UNTIL` meeting exdates, all-day against timed, and
//! a DST boundary the wall-clock contract says must move nothing.
//!
//! Rules and anchors come from
//! `packages/core/scripts/parser-grammar/fuzz-recurrence.ts`. Same acceptance
//! rule as everywhere else: a difference is a defect in the Rust side until
//! proven otherwise.
//!
//! Search wider than the committed corpus by hand:
//!
//! ```text
//! FUZZ_CASES=20000 FUZZ_OUT=/tmp/r.json pnpm --filter @pikos/core gen:fuzz-recurrence
//! PIKOS_RECURRENCE_FUZZ=/tmp/r.json cargo test -p pikos-core --test recurrence_fuzz
//! ```

use std::fs;
use std::path::PathBuf;

use chrono::NaiveDateTime;
use pikos_core::dates::parse_local_iso;
use pikos_core::recurrence::{
    compute_next_end, expand_for_range, next_occurrence_after, snap_anchor_to_rule,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum Captured<T> {
    Ok { value: T },
    Err { error: String },
}

impl<T> Captured<T> {
    /// The reference throwing is a finding about the reference, not about this
    /// port — there is nothing to compare against, so say so loudly.
    fn expect_ok(&self, case: &str) -> &T {
        match self {
            Captured::Ok { value } => value,
            Captured::Err { error } => {
                panic!("the reference threw on {case}: {error}")
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NextValue {
    scheduled_start: String,
    scheduled_end: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OccurrenceValue {
    original_date: String,
    scheduled_start: String,
    scheduled_end: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    rrule: String,
    scheduled_start: String,
    scheduled_end: Option<String>,
    exdates: Vec<String>,
    after_date: String,
    range_start: String,
    range_end: String,
    next: Captured<Option<NextValue>>,
    next_end: Captured<Option<String>>,
    snapped: Captured<String>,
    occurrences: Captured<Vec<OccurrenceValue>>,
}

#[derive(Debug, Deserialize)]
struct Corpus {
    cases: Vec<Case>,
}

fn corpus_path() -> PathBuf {
    match std::env::var("PIKOS_RECURRENCE_FUZZ") {
        Ok(path) if !path.is_empty() => PathBuf::from(path),
        _ => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/corpus/recurrence-fuzz.json"),
    }
}

fn load() -> Corpus {
    let path = corpus_path();
    let raw = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

fn parse_ref(iso: &str) -> NaiveDateTime {
    parse_local_iso(iso).unwrap_or_else(|| panic!("corpus holds an unparseable datetime: {iso}"))
}

/// Every case, described the way a failure message wants to read it.
fn label(case: &Case) -> String {
    format!(
        "{} @ {} (end {:?}, exdates {:?}, after {})",
        case.rrule, case.scheduled_start, case.scheduled_end, case.exdates, case.after_date
    )
}

#[test]
fn randomly_composed_rules_match_the_reference() {
    let corpus = load();
    let total = corpus.cases.len();
    assert!(total >= 200, "corpus looks truncated: {total} cases");

    let mut failures: Vec<String> = Vec::new();
    // Counted per function, so a failure says which of the four is broken
    // rather than just that something is.
    let (mut next_ok, mut end_ok, mut snap_ok, mut expand_ok) = (0usize, 0usize, 0usize, 0usize);

    for case in &corpus.cases {
        let name = label(case);

        // ── next occurrence ──────────────────────────────────────────────
        let expected = case.next.expect_ok(&name);
        let actual = next_occurrence_after(
            &case.rrule,
            &case.scheduled_start,
            &parse_ref(&case.after_date),
            &case.exdates,
        );
        match (expected, &actual) {
            (None, None) => next_ok += 1,
            (Some(expected), Some(actual))
                if expected.scheduled_start == actual.scheduled_start
                    && expected.scheduled_end == actual.scheduled_end =>
            {
                next_ok += 1
            }
            _ => failures.push(format!(
                "  next_occurrence_after — {name}\n    reference: {:?}\n    rust:      {:?}",
                expected.as_ref().map(|e| &e.scheduled_start),
                actual.as_ref().map(|a| &a.scheduled_start),
            )),
        }

        // ── the end carried onto that occurrence ─────────────────────────
        let expected_end = case.next_end.expect_ok(&name);
        let actual_end = actual
            .as_ref()
            .zip(case.scheduled_end.as_deref())
            .and_then(|(next, end)| compute_next_end(end, &next.scheduled_start));
        if expected_end == &actual_end {
            end_ok += 1;
        } else {
            failures.push(format!(
                "  compute_next_end — {name}\n    reference: {expected_end:?}\n    rust:      {actual_end:?}"
            ));
        }

        // ── anchor snapping ──────────────────────────────────────────────
        let expected_snap = case.snapped.expect_ok(&name);
        let actual_snap = snap_anchor_to_rule(&case.rrule, &case.scheduled_start);
        if expected_snap == &actual_snap {
            snap_ok += 1;
        } else {
            failures.push(format!(
                "  snap_anchor_to_rule — {name}\n    reference: {expected_snap}\n    rust:      {actual_snap}"
            ));
        }

        // ── expansion over a range ───────────────────────────────────────
        let expected_occurrences = case.occurrences.expect_ok(&name);
        let actual_occurrences = expand_for_range(
            &case.rrule,
            &case.scheduled_start,
            case.scheduled_end.as_deref(),
            &case.exdates,
            &parse_ref(&case.range_start),
            &parse_ref(&case.range_end),
        );
        let same = expected_occurrences.len() == actual_occurrences.len()
            && expected_occurrences
                .iter()
                .zip(&actual_occurrences)
                .all(|(expected, actual)| {
                    expected.scheduled_start == actual.scheduled_start
                        && expected.scheduled_end == actual.scheduled_end
                        && expected.original_date == actual.original_date
                });
        if same {
            expand_ok += 1;
        } else {
            failures.push(format!(
                "  expand_for_range [{}..{}] — {name}\n    reference: {:?}\n    rust:      {:?}",
                case.range_start,
                case.range_end,
                expected_occurrences
                    .iter()
                    .map(|o| &o.scheduled_start)
                    .collect::<Vec<_>>(),
                actual_occurrences
                    .iter()
                    .map(|o| &o.scheduled_start)
                    .collect::<Vec<_>>(),
            ));
        }
    }

    // A corpus that generated only degenerate rules would pass every
    // comparison while testing nothing, so what was actually exercised is
    // asserted rather than assumed.
    let produced_occurrences = corpus
        .cases
        .iter()
        .filter(|case| match &case.occurrences {
            Captured::Ok { value } => !value.is_empty(),
            Captured::Err { .. } => false,
        })
        .count();
    assert!(
        produced_occurrences * 4 > total,
        "only {produced_occurrences} of {total} cases expanded to anything"
    );

    if !failures.is_empty() {
        let shown = failures.len().min(20);
        let mut message = format!(
            "{} comparisons differ from the TypeScript reference \
             (of {total} cases: next {next_ok}, end {end_ok}, snap {snap_ok}, expand {expand_ok} \
             matched)\n\n",
            failures.len()
        );
        message.push_str(&failures[..shown].join("\n"));
        if failures.len() > shown {
            message.push_str(&format!("\n  ... and {} more", failures.len() - shown));
        }
        panic!("{message}");
    }
}
