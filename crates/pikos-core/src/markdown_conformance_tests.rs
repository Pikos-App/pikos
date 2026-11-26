//! Export, run against the table the importer also runs.
//!
//! The importer must be able to read back what this exporter emits. `roundtrip.test.ts`
//! does not check that: it serializes with `tiptap-markdown`, a third implementation, so the
//! two dialects that meet in a vault export could drift apart. The `blocks` column is what the
//! TS half asserts after importing `markdown`.

use serde::Deserialize;

use super::prosemirror_to_markdown;

// The cross-language fixture directory; the TS runners read the same file.
const TABLE: &str = include_str!("../../pikos-db/tests/fixtures/markdown-export.json");

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
    markdown: String,
    #[allow(dead_code)]
    blocks: serde_json::Value,
}

#[test]
fn every_case_exports_to_the_shared_markdown() {
    let table: Table = serde_json::from_str(TABLE).expect("parse markdown-export.json");
    assert!(!table.cases.is_empty());

    for case in &table.cases {
        assert_eq!(
            prosemirror_to_markdown(&case.doc),
            case.markdown,
            "case: {}",
            case.name
        );
    }
}
