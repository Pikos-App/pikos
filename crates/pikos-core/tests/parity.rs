//! Daylight-saving behaviour of recurrence expansion.
//!
//! Grading of the recurrence engine itself lives in
//! `crates/pikos-recurrence/tests/rrule_js_goldens.rs`. A corpus here would compare one
//! implementation with itself. This one test stays because it is about a decision this port
//! made, not about rrule semantics.

use std::fs;
use std::path::PathBuf;

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
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("corpus {name} did not parse: {e}"))
}

/// Only the fields the test reads.
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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecurrenceCorpus {
    expansion_cases: Vec<ExpansionCase>,
}

/// Wall-clock time must survive a DST transition unchanged: a 9am standup must not become
/// 8am for half the year.
#[test]
fn wall_clock_survives_dst_transition() {
    let corpus: RecurrenceCorpus = load("recurrence.json");
    let case = corpus
        .expansion_cases
        .iter()
        .find(|c| c.id == "daily_across_dst")
        .expect("corpus must carry a DST fixture");

    let actual = pikos_recurrence::expand_range(
        &case.rrule,
        &case.scheduled_start,
        case.scheduled_end.as_deref(),
        &case.range_start,
        &case.range_end,
        &case.exdates,
    )
    .expect("the DST fixture's rule must parse");

    assert!(!actual.is_empty(), "DST fixture produced no occurrences");
    for occurrence in &actual {
        assert!(
            occurrence.scheduled_start.ends_with("T09:00:00"),
            "wall-clock drifted across the DST boundary: {}",
            occurrence.scheduled_start
        );
    }
}
