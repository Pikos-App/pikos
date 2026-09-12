//! Parity tests: Rust port vs. the TypeScript reference.
//!
//! The iOS plan's engineering conventions require that "every ported Rust
//! function gets a parity test comparing against the TS original on a fixture
//! corpus before the TS path is deleted." This is that test.
//!
//! The corpus in `tests/corpus/` is *generated*, never hand-written — it is the
//! literal output of the TypeScript implementation, captured at pinned
//! reference times in a pinned timezone. Regenerate with:
//!
//! ```text
//! pnpm --filter @pikos/core gen:parity
//! ```
//!
//! A diff in the regenerated corpus is a behaviour change in the TypeScript
//! reference. Review it; do not reflexively commit it. A failure *here* is a
//! divergence in the Rust port, which is the thing this file exists to catch.

use std::fs;
use std::path::PathBuf;

use chrono::NaiveDateTime;
use pikos_core::dates::parse_local_iso;
use pikos_core::recurrence::{compute_next_end, expand_for_range, next_occurrence_after};
use serde::Deserialize;

fn corpus_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/corpus")
        .join(name)
}

fn load<T: for<'de> Deserialize<'de>>(name: &str) -> T {
    let path = corpus_path(name);
    let raw = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "cannot read parity corpus at {}: {e}\n\
             Generate it with `pnpm --filter @pikos/core gen:parity`.",
            path.display()
        )
    });
    serde_json::from_str(&raw).unwrap_or_else(|e| {
        panic!(
            "corpus {} is not valid JSON for this schema: {e}",
            path.display()
        )
    })
}

/// The generator wraps every captured value so a throwing TS call is recorded
/// rather than crashing the run — the Rust port has to reproduce failure modes
/// too, not just happy paths.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum Captured<T> {
    // Untagged matching discriminates on field presence: a success record
    // carries `value`, a failure record carries `error`. The generator also
    // writes an `ok` boolean, which serde ignores here — deserializing it only
    // to never read it would trip the dead-code lint.
    Ok { value: T },
    Err { error: String },
}

impl<T> Captured<T> {
    /// Unwrap a case the TS side completed successfully; skip cases it threw
    /// on, reporting them so a corpus full of errors can't masquerade as a pass.
    fn expect_ok(&self, case: &str) -> &T {
        match self {
            Captured::Ok { value } => value,
            Captured::Err { error } => {
                panic!("corpus case `{case}` records a TS failure, so there is nothing to compare against: {error}")
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
struct RecurrenceCase {
    rrule: String,
    scheduled_start: String,
    scheduled_end: Option<String>,
    after_date: String,
    exdates: Vec<String>,
    next: Captured<Option<NextValue>>,
    next_end: Captured<Option<String>>,
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
struct ExpansionCase {
    id: String,
    rrule: String,
    scheduled_start: String,
    scheduled_end: Option<String>,
    exdates: Vec<String>,
    range_start: String,
    range_end: String,
    occurrences: Captured<Vec<OccurrenceValue>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecurrenceCorpus {
    recurrence_cases: Vec<RecurrenceCase>,
    expansion_cases: Vec<ExpansionCase>,
    meta: Meta,
}

#[derive(Debug, Deserialize)]
struct Meta {
    timezone: String,
}

fn parse_ref(s: &str) -> NaiveDateTime {
    parse_local_iso(s).unwrap_or_else(|| panic!("corpus holds an unparseable datetime: {s}"))
}

#[test]
fn corpus_is_present_and_pinned() {
    let corpus: RecurrenceCorpus = load("recurrence.json");
    // The corpus is only reproducible in the timezone it was generated in;
    // a corpus generated elsewhere would produce confusing failures below.
    assert_eq!(
        corpus.meta.timezone, "UTC",
        "parity corpus must be generated with TZ=UTC"
    );
    assert!(!corpus.recurrence_cases.is_empty());
    assert!(!corpus.expansion_cases.is_empty());
}

#[test]
fn next_occurrence_matches_typescript() {
    let corpus: RecurrenceCorpus = load("recurrence.json");
    let mut compared = 0usize;

    for (i, case) in corpus.recurrence_cases.iter().enumerate() {
        let label = format!("recurrenceCases[{i}] {}", case.rrule);
        let expected = case.next.expect_ok(&label);

        let actual = next_occurrence_after(
            &case.rrule,
            &case.scheduled_start,
            &parse_ref(&case.after_date),
            &case.exdates,
        );

        match (expected, &actual) {
            (None, None) => {}
            (Some(exp), Some(act)) => {
                assert_eq!(
                    exp.scheduled_start, act.scheduled_start,
                    "{label}: scheduledStart diverged"
                );
                assert_eq!(
                    exp.scheduled_end, act.scheduled_end,
                    "{label}: scheduledEnd diverged"
                );
            }
            (None, Some(act)) => {
                panic!("{label}: TS returned no occurrence, Rust returned {act:?}")
            }
            (Some(exp), None) => panic!("{label}: TS returned {exp:?}, Rust returned none"),
        }
        compared += 1;
    }

    assert!(
        compared > 0,
        "no cases compared — corpus is empty or all-error"
    );
}

#[test]
fn compute_next_end_matches_typescript() {
    let corpus: RecurrenceCorpus = load("recurrence.json");

    for (i, case) in corpus.recurrence_cases.iter().enumerate() {
        let label = format!("recurrenceCases[{i}] {}", case.rrule);
        let expected = case.next_end.expect_ok(&label);

        // The generator derives nextEnd from the occurrence it just computed,
        // so reproduce that same composition rather than testing in isolation.
        let next = next_occurrence_after(
            &case.rrule,
            &case.scheduled_start,
            &parse_ref(&case.after_date),
            &case.exdates,
        );
        let actual = match (&next, &case.scheduled_end) {
            (Some(n), Some(base_end)) => compute_next_end(base_end, &n.scheduled_start),
            _ => None,
        };

        assert_eq!(expected, &actual, "{label}: nextEnd diverged");
    }
}

#[test]
fn expansion_matches_typescript() {
    let corpus: RecurrenceCorpus = load("recurrence.json");

    for case in &corpus.expansion_cases {
        let expected = case.occurrences.expect_ok(&case.id);

        let actual = expand_for_range(
            &case.rrule,
            &case.scheduled_start,
            case.scheduled_end.as_deref(),
            &case.exdates,
            &parse_ref(&case.range_start),
            &parse_ref(&case.range_end),
        );

        assert_eq!(
            expected.len(),
            actual.len(),
            "{}: occurrence count diverged\n  TS:   {:?}\n  Rust: {:?}",
            case.id,
            expected
                .iter()
                .map(|o| &o.scheduled_start)
                .collect::<Vec<_>>(),
            actual
                .iter()
                .map(|o| &o.scheduled_start)
                .collect::<Vec<_>>(),
        );

        for (n, (exp, act)) in expected.iter().zip(actual.iter()).enumerate() {
            assert_eq!(
                exp.scheduled_start, act.scheduled_start,
                "{}[{n}]: scheduledStart diverged",
                case.id
            );
            assert_eq!(
                exp.scheduled_end, act.scheduled_end,
                "{}[{n}]: scheduledEnd diverged",
                case.id
            );
            assert_eq!(
                exp.original_date, act.original_date,
                "{}[{n}]: originalDate diverged",
                case.id
            );
        }
    }
}

/// Wall-clock time must survive a DST transition unchanged. This is the
/// behaviour the fake-UTC mapping exists to protect, and the one a plausible
/// "improvement" to the port would silently break, so it gets its own test
/// rather than relying on the generic expansion comparison to notice.
#[test]
fn wall_clock_survives_dst_transition() {
    let corpus: RecurrenceCorpus = load("recurrence.json");
    let case = corpus
        .expansion_cases
        .iter()
        .find(|c| c.id == "daily_across_dst")
        .expect("corpus must carry a DST fixture");

    let actual = expand_for_range(
        &case.rrule,
        &case.scheduled_start,
        case.scheduled_end.as_deref(),
        &case.exdates,
        &parse_ref(&case.range_start),
        &parse_ref(&case.range_end),
    );

    assert!(!actual.is_empty(), "DST fixture produced no occurrences");
    for occ in &actual {
        assert!(
            occ.scheduled_start.ends_with("T09:00:00"),
            "wall-clock drifted across the DST boundary: {}",
            occ.scheduled_start
        );
    }
}
