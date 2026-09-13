//! The Rust quick-add parser, graded against the TypeScript reference.
//!
//! `parser.json` is the golden output of `packages/core/src/nlp/parser.ts` for
//! 317 inputs at 7 pinned reference times — 2,219 cases covering tags, folders,
//! priorities, durations, windows, every cadence spelling, and the whole date
//! grammar underneath. The TypeScript side stays the reference until the port
//! replaces it, so a difference here is a defect in the Rust parser until
//! proven otherwise.
//!
//! Regenerate with `pnpm --filter @pikos/core gen:parity`.

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
    /// Three states in JSON: absent, `null` (explicitly cleared), or a name.
    #[serde(default, deserialize_with = "double_option")]
    priority: Option<Option<String>>,
}

/// Distinguish an absent key from an explicit `null`, which the reference uses
/// to mean "priority cleared" rather than "priority not mentioned".
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

fn load() -> Corpus {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/corpus/parser.json");
    let raw = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

/// Render a parsed input as a single comparable line. Comparing rendered
/// strings rather than field by field means a failure message shows the whole
/// shape at once, which is what you need when a date moved and a duration
/// moved with it.
fn render(input: &ParsedInput) -> String {
    let priority = match &input.priority {
        None => "-".to_string(),
        Some(None) => "cleared".to_string(),
        Some(Some(priority)) => priority.as_str().to_string(),
    };
    format!(
        "title={:?} tags={:?} start={:?} end={:?} mins={:?} folder={:?} priority={priority}",
        input.title,
        input.tags,
        input.scheduled_start,
        input.scheduled_end,
        input.duration_minutes,
        input.folder_query,
    )
}

fn render_expected(input: &ExpectedInput) -> String {
    let priority = match &input.priority {
        None => "-".to_string(),
        Some(None) => "cleared".to_string(),
        Some(Some(priority)) => priority.clone(),
    };
    format!(
        "title={:?} tags={:?} start={:?} end={:?} mins={:?} folder={:?} priority={priority}",
        input.title,
        input.tags,
        input.scheduled_start,
        input.scheduled_end,
        input.duration_minutes,
        input.folder_query,
    )
}

fn render_result(result: &ParseResult) -> String {
    match result {
        ParseResult::Single { input } => format!("single  {}", render(input)),
        ParseResult::Recurring { input, rrule } => {
            format!("recurring {rrule}  {}", render(input))
        }
        ParseResult::Finite { inputs } => {
            let mut lines = format!("finite({})", inputs.len());
            for input in inputs {
                lines.push_str(&format!("\n      {}", render(input)));
            }
            lines
        }
    }
}

fn render_expected_result(value: &ExpectedValue) -> String {
    match value {
        ExpectedValue::Single { input } => format!("single  {}", render_expected(input)),
        ExpectedValue::Recurring { input, rrule } => {
            format!("recurring {rrule}  {}", render_expected(input))
        }
        ExpectedValue::Finite { inputs, count } => {
            let mut lines = format!("finite({count})");
            for input in inputs {
                lines.push_str(&format!("\n      {}", render_expected(input)));
            }
            lines
        }
    }
}

fn priority_name(priority: Priority) -> &'static str {
    priority.as_str()
}

fn inputs_match(expected: &ExpectedInput, actual: &ParsedInput) -> bool {
    let priority_matches = match (&expected.priority, &actual.priority) {
        (None, None) => true,
        (Some(None), Some(None)) => true,
        (Some(Some(expected)), Some(Some(actual))) => expected == priority_name(*actual),
        _ => false,
    };
    priority_matches
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
fn every_quick_add_input_matches_the_reference() {
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
    assert!(total > 2000, "corpus looks truncated: {total} cases");

    let mut compared = 0usize;
    let mut recurring = 0usize;
    let mut finite = 0usize;
    let mut with_priority = 0usize;
    let mut failures = Vec::new();
    for case in &corpus.cases {
        // The reference never fails on these inputs; if that changes, the
        // corpus is describing something this port does not model.
        assert!(
            case.result.ok,
            "corpus case {:?} expects an error, which this port does not model",
            case.input
        );
        let Some(expected) = &case.result.value else {
            continue;
        };
        compared += 1;
        match expected {
            ExpectedValue::Recurring { .. } => recurring += 1,
            ExpectedValue::Finite { .. } => finite += 1,
            ExpectedValue::Single { input } => {
                if input.priority.is_some() {
                    with_priority += 1;
                }
            }
        }
        let reference = references[&case.reference];
        let actual = parse_input(&case.input, reference);
        if !results_match(expected, &actual) {
            failures.push(format!(
                "  {:?} @ {}\n    reference: {}\n    rust:      {}",
                case.input,
                case.reference,
                render_expected_result(expected),
                render_result(&actual),
            ));
        }
    }

    // A comparison that silently skipped everything would pass too, so the
    // shape of what was actually checked is asserted rather than assumed.
    assert_eq!(compared, total, "some cases carried no expected value");
    assert!(recurring > 700, "only {recurring} recurring cases compared");
    assert!(finite > 90, "only {finite} finite cases compared");
    assert!(
        with_priority > 20,
        "only {with_priority} single cases carried a priority"
    );

    if !failures.is_empty() {
        let shown = failures.len().min(20);
        let mut message = format!(
            "{} of {total} quick-add cases differ from the TypeScript reference\n\n",
            failures.len()
        );
        message.push_str(&failures[..shown].join("\n"));
        if failures.len() > shown {
            message.push_str(&format!("\n  ... and {} more", failures.len() - shown));
        }
        panic!("{message}");
    }
}
