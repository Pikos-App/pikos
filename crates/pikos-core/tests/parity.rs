//! Daylight-saving behaviour of recurrence expansion.
//!
//! What used to be here was a full TypeScript-parity corpus for the recurrence
//! engine — anchor snapping, next-occurrence, end carrying, expansion — plus a
//! differential fuzzer over randomly composed rules. Both are gone, and the
//! reason is worth recording rather than rediscovering.
//!
//! They graded `pikos-core`'s own RRULE engine against rrule.js as reached
//! through `packages/core`. That engine no longer exists: the calendar-sync
//! work landed `crates/pikos-recurrence`, TypeScript now calls *it* through
//! wasm, and the duplicate was deleted rather than kept in sync. A corpus
//! comparing the two sides would now be comparing one implementation with
//! itself.
//!
//! Deleting them was not free of information. Replayed against the surviving
//! engine, 156 of 400 fuzz cases diverged — every one of them on BYHOUR,
//! BYMINUTE or BYSECOND, which `pikos_recurrence::ParsedRule::parse` rejects by
//! design and documents as rejecting. The old engine inherited rrule.js's
//! handling of those terms; the new one refuses rules it will not enumerate
//! correctly, and Pikos generates none of them. The corpus was pinning a
//! superseded reference, not catching a regression.
//!
//! Grading now lives with the engine:
//! `crates/pikos-recurrence/tests/rrule_js_goldens.rs`, against goldens
//! generated from rrule.js, plus its conformance suite.
//!
//! One test survives, because it is about a decision this port made rather than
//! about rrule semantics.

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

/// Only the fields the surviving test reads. The corpus carries more; the
/// structs that described the rest went with the tests that used them.
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

/// Wall-clock time must survive a DST transition unchanged. This is the
/// behaviour the fake-UTC mapping exists to protect, and the one a plausible
/// "improvement" would silently break — a 9am standup that becomes 8am for half
/// the year, on a calendar that otherwise looks perfectly reasonable.
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
