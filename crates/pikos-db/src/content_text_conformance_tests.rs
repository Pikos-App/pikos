//! The `content_text` projection, run against the table `extractText` also runs —
//! the reconciler compares the two implementations byte for byte, so they need a
//! shared expectation rather than two suites. See `CONTENT_TEXT_PROJECTION_VERSION`.

use serde::Deserialize;

use crate::pool::extract_text_from_tiptap;

const TABLE: &str = include_str!("../tests/fixtures/content-text-projection.json");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Table {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    name: String,
    doc: serde_json::Value,
    text: String,
}

#[test]
fn every_case_projects_to_the_shared_expectation() {
    let table: Table = serde_json::from_str(TABLE).expect("parse content-text-projection.json");
    assert!(!table.cases.is_empty());

    for case in &table.cases {
        let projected = extract_text_from_tiptap(&case.doc.to_string());
        assert_eq!(projected, case.text, "case: {}", case.name);
    }
}
