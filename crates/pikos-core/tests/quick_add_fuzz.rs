//! The Rust quick-add parser against randomly composed lines.
//!
//! `quick_add_parity.rs` grades the port against 317 inputs scraped from the
//! test suite. That is what the author thought to test, and a port passing all
//! of it says nothing about the space around it — which is where a *pipeline*
//! port goes wrong. Cadence is read before the date, intervals before day
//! words, "biweekly" before "weekly"; none of those orderings is exercised by
//! an input that carries one feature at a time.
//!
//! So this grades it against lines composed of fragments in random order, from
//! `packages/core/scripts/parser-grammar/fuzz.ts`. Same acceptance rule as the
//! hand-written corpus: a difference is a defect in the Rust parser until
//! proven otherwise.
//!
//! The committed corpus is deliberately small — every input that has ever
//! diverged, plus enough random lines to keep it varied. It is a *regression
//! guard*; the searching happens in CI, which generates a fresh 8,000-line
//! sweep each run with the run number as its seed.
//!
//! Point `PIKOS_FUZZ_CORPUS` at a larger generated file to search wider by
//! hand:
//!
//! ```text
//! FUZZ_CASES=20000 FUZZ_OUT=/tmp/f.json pnpm --filter @pikos/core gen:fuzz
//! PIKOS_FUZZ_CORPUS=/tmp/f.json cargo test -p pikos-core --test quick_add_fuzz
//! ```

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use chrono::NaiveDateTime;
use pikos_core::nlp::quick_add::{parse_input, ParseResult, ParsedInput, Priority};
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
struct ExpectedInput {
    title: String,
    #[serde(default)]
    tags: Vec<String>,
    scheduled_start: Option<String>,
    scheduled_end: Option<String>,
    duration_minutes: Option<i64>,
    folder_query: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    priority: Option<Option<String>>,
}

/// An absent key and an explicit `null` mean different things here: not
/// mentioned versus cleared.
fn double_option<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ExpectedValue {
    Single {
        input: ExpectedInput,
    },
    Finite {
        inputs: Vec<ExpectedInput>,
        count: usize,
    },
    Recurring {
        input: ExpectedInput,
        rrule: String,
    },
}

#[derive(Debug, Deserialize)]
struct ExpectedResult {
    ok: bool,
    value: Option<ExpectedValue>,
}

#[derive(Debug, Deserialize)]
struct Case {
    input: String,
    #[serde(rename = "ref")]
    reference: String,
    result: ExpectedResult,
}

#[derive(Debug, Deserialize)]
struct Corpus {
    cases: Vec<Case>,
    meta: Meta,
}

fn corpus_path() -> PathBuf {
    match std::env::var("PIKOS_FUZZ_CORPUS") {
        Ok(path) if !path.is_empty() => PathBuf::from(path),
        _ => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/corpus/parser-fuzz.json"),
    }
}

fn load() -> Corpus {
    let path = corpus_path();
    let raw = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

fn priority_label(priority: &Option<Option<Priority>>) -> String {
    match priority {
        None => "-".to_string(),
        Some(None) => "cleared".to_string(),
        Some(Some(priority)) => priority.as_str().to_string(),
    }
}

fn expected_priority_label(priority: &Option<Option<String>>) -> String {
    match priority {
        None => "-".to_string(),
        Some(None) => "cleared".to_string(),
        Some(Some(name)) => name.clone(),
    }
}

fn render(input: &ParsedInput) -> String {
    format!(
        "title={:?} tags={:?} start={:?} end={:?} mins={:?} folder={:?} priority={}",
        input.title,
        input.tags,
        input.scheduled_start,
        input.scheduled_end,
        input.duration_minutes,
        input.folder_query,
        priority_label(&input.priority),
    )
}

fn render_expected(input: &ExpectedInput) -> String {
    format!(
        "title={:?} tags={:?} start={:?} end={:?} mins={:?} folder={:?} priority={}",
        input.title,
        input.tags,
        input.scheduled_start,
        input.scheduled_end,
        input.duration_minutes,
        input.folder_query,
        expected_priority_label(&input.priority),
    )
}

fn render_result(result: &ParseResult) -> String {
    match result {
        ParseResult::Single { input } => format!("single {}", render(input)),
        ParseResult::Recurring { input, rrule } => format!("recurring {rrule} {}", render(input)),
        ParseResult::Finite { inputs } => format!(
            "finite({}) {}",
            inputs.len(),
            inputs.iter().map(render).collect::<Vec<_>>().join(" | ")
        ),
    }
}

fn render_expected_result(value: &ExpectedValue) -> String {
    match value {
        ExpectedValue::Single { input } => format!("single {}", render_expected(input)),
        ExpectedValue::Recurring { input, rrule } => {
            format!("recurring {rrule} {}", render_expected(input))
        }
        ExpectedValue::Finite { inputs, count } => format!(
            "finite({count}) {}",
            inputs
                .iter()
                .map(render_expected)
                .collect::<Vec<_>>()
                .join(" | ")
        ),
    }
}

fn inputs_match(expected: &ExpectedInput, actual: &ParsedInput) -> bool {
    expected_priority_label(&expected.priority) == priority_label(&actual.priority)
        && expected.title == actual.title
        && expected.tags == actual.tags
        && expected.scheduled_start == actual.scheduled_start
        && expected.scheduled_end == actual.scheduled_end
        && expected.duration_minutes == actual.duration_minutes
        && expected.folder_query == actual.folder_query
}

fn results_match(expected: &ExpectedValue, actual: &ParseResult) -> bool {
    match (expected, actual) {
        (ExpectedValue::Single { input: expected }, ParseResult::Single { input: actual }) => {
            inputs_match(expected, actual)
        }
        (
            ExpectedValue::Recurring {
                input: expected,
                rrule: expected_rrule,
            },
            ParseResult::Recurring {
                input: actual,
                rrule: actual_rrule,
            },
        ) => expected_rrule == actual_rrule && inputs_match(expected, actual),
        (
            ExpectedValue::Finite {
                inputs: expected,
                count,
            },
            ParseResult::Finite { inputs: actual },
        ) => {
            *count == expected.len()
                && expected.len() == actual.len()
                && expected.iter().zip(actual).all(|(e, a)| inputs_match(e, a))
        }
        _ => false,
    }
}

#[test]
fn randomly_composed_lines_match_the_reference() {
    let corpus = load();
    let references: BTreeMap<String, NaiveDateTime> = corpus
        .meta
        .references
        .iter()
        .map(|point| {
            let instant = point
                .iso
                .parse()
                .unwrap_or_else(|error| panic!("reference {}: {error}", point.iso));
            (point.id.clone(), instant)
        })
        .collect();

    let total = corpus.cases.len();
    assert!(total > 1000, "corpus looks truncated: {total} cases");

    let mut compared = 0usize;
    let mut failures: Vec<String> = Vec::new();
    // Distinct inputs, not distinct cases: the same bug at seven reference
    // times is one bug, and a failure listing it seven times buries the others.
    let mut seen_inputs: BTreeMap<String, ()> = BTreeMap::new();

    for case in &corpus.cases {
        // The reference throwing is a finding about the reference, not about
        // this port, and there is nothing to compare against.
        assert!(
            case.result.ok,
            "the reference threw on {:?} — that is a bug in it, not here",
            case.input
        );
        let Some(expected) = &case.result.value else {
            continue;
        };
        compared += 1;
        let reference = references[&case.reference];
        let actual = parse_input(&case.input, reference);
        if results_match(expected, &actual) {
            continue;
        }
        if seen_inputs.insert(case.input.clone(), ()).is_some() {
            continue;
        }
        failures.push(format!(
            "  {:?} @ {}\n    reference: {}\n    rust:      {}",
            case.input,
            case.reference,
            render_expected_result(expected),
            render_result(&actual),
        ));
    }

    assert_eq!(compared, total, "some cases carried no expected value");

    // A run over tens of thousands of lines can find more divergences than a
    // panic message can usefully hold. Point `PIKOS_FUZZ_FAILURES` at a file to
    // get every failing input, one per line, ready to be triaged and folded
    // into the regression list.
    if let Ok(path) = std::env::var("PIKOS_FUZZ_FAILURES") {
        if !path.is_empty() {
            let inputs: Vec<String> = seen_inputs
                .keys()
                .map(|input| serde_json::to_string(input).unwrap_or_default())
                .collect();
            let _ = fs::write(&path, format!("[\n  {}\n]\n", inputs.join(",\n  ")));
        }
    }

    if !failures.is_empty() {
        let shown = failures.len().min(15);
        let mut message = format!(
            "{} of {total} fuzzed cases differ from the TypeScript reference \
             ({} distinct inputs)\n\n",
            corpus.cases.len() - (total - failures.len()),
            failures.len()
        );
        message.push_str(&failures[..shown].join("\n"));
        if failures.len() > shown {
            message.push_str(&format!("\n  ... and {} more", failures.len() - shown));
        }
        panic!("{message}");
    }
}
