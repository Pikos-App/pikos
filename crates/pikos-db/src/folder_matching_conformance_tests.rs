//! Quick Add folder resolution, run against the table `fuzzyMatchFolder` also runs.
//! The parser hands both binaries the same `folderQuery` out of the same workspace,
//! so a tier that exists on one side only files the string differently depending on
//! which one the user typed it into.

use serde::Deserialize;

use crate::folders::{fuzzy_match_folder, Folder};

const TABLE: &str = include_str!("../tests/fixtures/folder-matching.json");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Table {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    name: String,
    query: String,
    folders: Vec<String>,
    #[serde(rename = "match")]
    matched: Option<String>,
}

fn folder(name: &str) -> Folder {
    Folder {
        id: name.to_string(),
        name: name.to_string(),
        parent_id: None,
        sort_order: 0,
        color: None,
        icon: None,
        is_external_calendar: false,
        created_at: "2026-01-01T00:00:00".into(),
        updated_at: "2026-01-01T00:00:00".into(),
    }
}

#[test]
fn every_case_resolves_to_the_shared_expectation() {
    let table: Table = serde_json::from_str(TABLE).expect("parse folder-matching.json");
    assert!(!table.cases.is_empty());

    for case in &table.cases {
        let folders: Vec<Folder> = case.folders.iter().map(|n| folder(n)).collect();
        let matched = fuzzy_match_folder(&case.query, &folders).map(|f| f.name.clone());
        assert_eq!(matched, case.matched, "case: {}", case.name);
    }
}
