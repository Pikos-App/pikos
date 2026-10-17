//! The Rust date engine, graded against chrono-node.
//!
//! Two corpora, both generated from the TypeScript reference (see
//! `packages/core/scripts/parser-grammar/`):
//!
//! - **`date-expressions.json`** — each distinct date expression the parser
//!   corpus exercises, on its own, at every pinned reference. Development-grade
//!   granularity: when this fails it says which pattern family broke.
//! - **`date-calls.json`** — what chrono-node was *actually* asked, recorded
//!   through the real parser. The text is a whole quick-add title after
//!   pre-processing, so this is the one that grades match extents and the
//!   choice between competing candidates. It is also the one with teeth: 596 of
//!   its cases are titles with no date in them, and a parser that over-matches
//!   fails there rather than here.
//!
//! Indices need converting: the reference records JavaScript string indices,
//! which count UTF-16 code units, and this engine returns byte offsets. A title
//! starting with an emoji makes the two differ.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use chrono::NaiveDateTime;
use pikos_core::nlp::{parse_first, DateMatch, Granularity};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct ReferencePoint {
    id: String,
    iso: String,
}

#[derive(Debug, Deserialize)]
struct Meta {
    references: Vec<ReferencePoint>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedResult {
    index: usize,
    text: String,
    start: String,
    start_certain: Vec<String>,
    end: Option<String>,
    end_certain: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ExpressionCase {
    expression: String,
    #[serde(rename = "ref")]
    reference: String,
    result: Option<ExpectedResult>,
}

#[derive(Debug, Deserialize)]
struct ExpressionCorpus {
    cases: Vec<ExpressionCase>,
    meta: Meta,
}

#[derive(Debug, Deserialize)]
struct CallCase {
    input: String,
    #[serde(rename = "ref")]
    reference: String,
    text: String,
    result: Option<ExpectedResult>,
}

#[derive(Debug, Deserialize)]
struct CallCorpus {
    cases: Vec<CallCase>,
    meta: Meta,
}

fn corpus_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/corpus")
        .join(name)
}

fn load<T: serde::de::DeserializeOwned>(name: &str) -> T {
    let path = corpus_path(name);
    let raw = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

fn references(meta: &Meta) -> BTreeMap<String, NaiveDateTime> {
    meta.references
        .iter()
        .map(|point| {
            let instant = point
                .iso
                .parse::<NaiveDateTime>()
                .unwrap_or_else(|error| panic!("reference {}: {error}", point.iso));
            (point.id.clone(), instant)
        })
        .collect()
}

/// The reference's indices count UTF-16 code units; this engine's count bytes.
/// Convert so the two are comparable for text that is not pure ASCII.
fn utf16_index_to_byte_index(text: &str, utf16_index: usize) -> usize {
    let mut utf16 = 0usize;
    for (byte_index, character) in text.char_indices() {
        if utf16 == utf16_index {
            return byte_index;
        }
        utf16 += character.len_utf16();
    }
    text.len()
}

fn certain_names(granularities: &[Granularity]) -> Vec<String> {
    let mut names: Vec<String> = granularities
        .iter()
        .map(|g| g.as_str().to_string())
        .collect();
    names.sort();
    names
}

fn sorted(names: &[String]) -> Vec<String> {
    let mut sorted = names.to_vec();
    sorted.sort();
    sorted
}

/// What the reference said, rendered the way a failure message wants to read.
fn describe_expected(expected: &Option<ExpectedResult>) -> String {
    match expected {
        None => "no match".to_string(),
        Some(result) => format!(
            "index={} text={:?} start={} {:?} end={:?} {:?}",
            result.index,
            result.text,
            result.start,
            sorted(&result.start_certain),
            result.end,
            sorted(&result.end_certain),
        ),
    }
}

fn describe_actual(actual: &Option<DateMatch>, text: &str) -> String {
    match actual {
        None => "no match".to_string(),
        Some(matched) => {
            let _ = text;
            format!(
                "index={} text={:?} start={} {:?} end={:?} {:?}",
                matched.index,
                matched.text,
                matched.start.at.format("%Y-%m-%dT%H:%M:%S"),
                certain_names(&matched.start.certain),
                matched
                    .end
                    .as_ref()
                    .map(|end| end.at.format("%Y-%m-%dT%H:%M:%S").to_string()),
                matched
                    .end
                    .as_ref()
                    .map(|end| certain_names(&end.certain))
                    .unwrap_or_default(),
            )
        }
    }
}

/// Compare one parse against the reference, returning a description of the
/// first thing that differs.
fn mismatch(text: &str, expected: &Option<ExpectedResult>, actual: &Option<DateMatch>) -> bool {
    match (expected, actual) {
        (None, None) => false,
        (None, Some(_)) | (Some(_), None) => true,
        (Some(expected), Some(actual)) => {
            let expected_index = utf16_index_to_byte_index(text, expected.index);
            expected_index != actual.index
                || expected.text != actual.text
                || expected.start != actual.start.at.format("%Y-%m-%dT%H:%M:%S").to_string()
                || sorted(&expected.start_certain) != certain_names(&actual.start.certain)
                || expected.end
                    != actual
                        .end
                        .as_ref()
                        .map(|end| end.at.format("%Y-%m-%dT%H:%M:%S").to_string())
                || sorted(&expected.end_certain)
                    != actual
                        .end
                        .as_ref()
                        .map(|end| certain_names(&end.certain))
                        .unwrap_or_default()
        }
    }
}

struct Failure {
    label: String,
    reference: String,
    expected: String,
    actual: String,
}

fn report(failures: Vec<Failure>, total: usize, corpus: &str) {
    if failures.is_empty() {
        return;
    }
    let shown = failures.len().min(25);
    let mut message = format!(
        "{} of {total} {corpus} cases differ from the TypeScript reference\n\n",
        failures.len()
    );
    for failure in failures.iter().take(shown) {
        message.push_str(&format!(
            "  {:?} @ {}\n    reference: {}\n    rust:      {}\n",
            failure.label, failure.reference, failure.expected, failure.actual
        ));
    }
    if failures.len() > shown {
        message.push_str(&format!("  ... and {} more\n", failures.len() - shown));
    }
    panic!("{message}");
}

#[test]
fn every_date_expression_matches_the_reference() {
    let corpus: ExpressionCorpus = load("date-expressions.json");
    let references = references(&corpus.meta);
    let total = corpus.cases.len();
    assert!(total > 600, "corpus looks truncated: {total} cases");

    let mut failures = Vec::new();
    for case in &corpus.cases {
        let instant = references[&case.reference];
        let actual = parse_first(&case.expression, instant);
        if mismatch(&case.expression, &case.result, &actual) {
            failures.push(Failure {
                label: case.expression.clone(),
                reference: case.reference.clone(),
                expected: describe_expected(&case.result),
                actual: describe_actual(&actual, &case.expression),
            });
        }
    }
    report(failures, total, "date-expression");
}

#[test]
fn every_recorded_call_matches_the_reference() {
    let corpus: CallCorpus = load("date-calls.json");
    let references = references(&corpus.meta);
    let total = corpus.cases.len();
    assert!(total > 1500, "corpus looks truncated: {total} cases");

    // A corpus made only of matches would not catch over-matching, which is
    // the likelier failure for a hand-written parser.
    let without_a_date = corpus.cases.iter().filter(|c| c.result.is_none()).count();
    assert!(
        without_a_date > 400,
        "only {without_a_date} cases have no date; the corpus cannot catch over-matching"
    );

    let mut failures = Vec::new();
    for case in &corpus.cases {
        let instant = references[&case.reference];
        let actual = parse_first(&case.text, instant);
        if mismatch(&case.text, &case.result, &actual) {
            failures.push(Failure {
                label: format!("{} → {:?}", case.input, case.text),
                reference: case.reference.clone(),
                expected: describe_expected(&case.result),
                actual: describe_actual(&actual, &case.text),
            });
        }
    }
    report(failures, total, "recorded-call");
}
