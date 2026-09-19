//! Snapping a parsed schedule onto its rule, run against the table
//! `snapScheduleToRule` also runs. Quick Add and `pikos add` snap the same parser
//! output; the engine is shared but the end-shift is not, and an end that doesn't
//! travel with its start lands before it.

use serde::Deserialize;

use pikos_recurrence::snap_schedule_to_rule;

const TABLE: &str = include_str!("../tests/fixtures/schedule-snap.json");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Table {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Case {
    name: String,
    rrule: String,
    start: String,
    end: Option<String>,
    snapped_start: String,
    snapped_end: Option<String>,
}

#[test]
fn every_case_snaps_to_the_shared_expectation() {
    let table: Table = serde_json::from_str(TABLE).expect("parse schedule-snap.json");
    assert!(!table.cases.is_empty());

    for case in &table.cases {
        let (start, end) = snap_schedule_to_rule(&case.rrule, &case.start, case.end.as_deref());
        assert_eq!(start, case.snapped_start, "start, case: {}", case.name);
        assert_eq!(end, case.snapped_end, "end, case: {}", case.name);
    }
}
