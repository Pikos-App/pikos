//! The search operators, graded against `nlp/searchQuery.ts`.
//!
//! Seven reference times because `due:` reads a clock: `due:week` on a Sunday and a Wednesday
//! name different windows, and `due:tomorrow` on 2026-12-31 crosses a year.
//!
//! Every case records the text left behind, so a port that recognises one token too many
//! (`ratio:1.5`, `priority:9`) fails even when its filter looks right.

use std::fs;
use std::path::PathBuf;

use pikos_core::dates::parse_local_iso;
use pikos_core::search::parse_search_query;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Expected {
    text: String,
    tags: Vec<String>,
    folder: Option<String>,
    status: Option<String>,
    scheduled: bool,
    priority: Option<i64>,
    due_from: Option<String>,
    due_to: Option<String>,
    has_operators: bool,
}

#[derive(Debug, Deserialize)]
struct Captured {
    ok: bool,
    #[serde(default)]
    value: Option<Expected>,
}

#[derive(Debug, Deserialize)]
struct Case {
    query: String,
    #[serde(rename = "ref")]
    reference: String,
    parsed: Captured,
}

#[derive(Debug, Deserialize)]
struct Reference {
    id: String,
    iso: String,
}

#[derive(Debug, Deserialize)]
struct Meta {
    references: Vec<Reference>,
}

#[derive(Debug, Deserialize)]
struct Corpus {
    cases: Vec<Case>,
    meta: Meta,
    #[serde(rename = "queryCount")]
    query_count: usize,
}

fn corpus() -> Corpus {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/corpus/search.json");
    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&raw).expect("search.json parses")
}

#[test]
fn every_query_parses_the_way_the_reference_does() {
    let corpus = corpus();
    let mut failures: Vec<String> = Vec::new();

    for case in &corpus.cases {
        let Some(expected) = &case.parsed.value else {
            // If the reference starts throwing on this input, the corpus says so.
            assert!(!case.parsed.ok, "a successful capture must carry a value");
            continue;
        };
        let iso = &corpus
            .meta
            .references
            .iter()
            .find(|r| r.id == case.reference)
            .unwrap_or_else(|| panic!("unknown reference {}", case.reference))
            .iso;
        let reference = parse_local_iso(iso).unwrap_or_else(|| panic!("bad reference {iso}"));

        let actual = parse_search_query(&case.query, reference);
        let mut wrong: Vec<String> = Vec::new();
        let mut check = |field: &str, got: String, want: String| {
            if got != want {
                wrong.push(format!("{field}: got {got}, want {want}"));
            }
        };
        check(
            "text",
            format!("{:?}", actual.text),
            format!("{:?}", expected.text),
        );
        check(
            "tags",
            format!("{:?}", actual.tags),
            format!("{:?}", expected.tags),
        );
        check(
            "folder",
            format!("{:?}", actual.folder),
            format!("{:?}", expected.folder),
        );
        check(
            "status",
            format!("{:?}", actual.status.map(|s| s.as_str())),
            format!("{:?}", expected.status.as_deref()),
        );
        check(
            "scheduled",
            actual.scheduled.to_string(),
            expected.scheduled.to_string(),
        );
        check(
            "priority",
            format!("{:?}", actual.priority),
            format!("{:?}", expected.priority),
        );
        check(
            "dueFrom",
            format!("{:?}", actual.due_from),
            format!("{:?}", expected.due_from),
        );
        check(
            "dueTo",
            format!("{:?}", actual.due_to),
            format!("{:?}", expected.due_to),
        );
        check(
            "hasOperators",
            actual.has_operators.to_string(),
            expected.has_operators.to_string(),
        );

        if !wrong.is_empty() {
            failures.push(format!(
                "{:?} @ {}: {}",
                case.query,
                case.reference,
                wrong.join("; ")
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "{} of {} cases diverge from the reference:\n{}",
        failures.len(),
        corpus.cases.len(),
        failures
            .iter()
            .take(25)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[test]
fn the_corpus_covers_every_operator_and_both_kinds_of_near_miss() {
    let corpus = corpus();
    assert!(
        corpus.query_count >= 60,
        "the corpus should carry the suite's queries plus the supplementary set, got {}",
        corpus.query_count
    );
    let queries: Vec<&str> = corpus.cases.iter().map(|c| c.query.as_str()).collect();
    for needle in ["tag:", "folder:", "is:", "priority:", "due:"] {
        assert!(
            queries.iter().any(|q| q.contains(needle)),
            "no case exercises {needle}"
        );
    }
    // A keyword the grammar lacks and a value it rejects must both survive as text.
    assert!(queries.iter().any(|q| q.contains("ratio:")));
    assert!(queries.iter().any(|q| q.contains("priority:9")));
}
