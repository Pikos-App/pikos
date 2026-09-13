//! The calendar layout port against randomly composed scenarios.
//!
//! `calendar_parity.rs` grades it against 32 hand-written arrangements and
//! finds nothing. So did the 317-input parser corpus, until a fuzzer found six
//! divergence classes behind it.
//!
//! Layout is the weakest case for hand-written scenarios, because the behaviour
//! is combinatorial: which column an event lands in depends on which others it
//! overlaps and in what order they were considered, and which row an all-day
//! bar takes depends on span lengths, ties broken by creation time, and gaps a
//! later event may or may not fit into. Nobody can write the arrangement that
//! breaks it — the difficulty is precisely that it is not obvious which one
//! does.
//!
//! Scenarios come from `apps/desktop/scripts/fuzz-calendar-parity.ts`, which
//! keeps the density guard: cascade depth is computed at all three rendering
//! densities and a disagreement stops the generator, because the port assumes
//! column assignment is pixel-independent.
//!
//! Search wider than the committed corpus by hand:
//!
//! ```text
//! FUZZ_CASES=5000 FUZZ_OUT=/tmp/c.json pnpm --filter @pikos/desktop gen:fuzz-calendar
//! PIKOS_CALENDAR_FUZZ=/tmp/c.json cargo test -p pikos-core --test calendar_fuzz
//! ```

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use pikos_core::calendar::all_day::{assign_stable_all_day_rows, build_all_day_bars};
use pikos_core::calendar::timed::assign_timed_columns;
use pikos_core::calendar::LayoutPage;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CorpusPage {
    id: String,
    created_at: String,
    scheduled_start: Option<String>,
    scheduled_end: Option<String>,
}

impl From<&CorpusPage> for LayoutPage {
    fn from(page: &CorpusPage) -> Self {
        LayoutPage {
            id: page.id.clone(),
            created_at: page.created_at.clone(),
            scheduled_start: page.scheduled_start.clone(),
            scheduled_end: page.scheduled_end.clone(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedBlock {
    page_id: String,
    cascade_depth: usize,
    is_continuation_before: bool,
    is_continuation_after: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimedScenario {
    day: String,
    pages: Vec<CorpusPage>,
    blocks: Vec<ExpectedBlock>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedBar {
    page_id: String,
    row: usize,
    start_col: usize,
    span: usize,
    continues_left: bool,
    continues_right: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AllDayScenario {
    days: Vec<String>,
    pages: Vec<CorpusPage>,
    slots: Vec<Vec<Option<String>>>,
    row_count: usize,
    bars: Vec<ExpectedBar>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Corpus {
    timed: Vec<TimedScenario>,
    all_day: Vec<AllDayScenario>,
}

fn corpus_path() -> PathBuf {
    match std::env::var("PIKOS_CALENDAR_FUZZ") {
        Ok(path) if !path.is_empty() => PathBuf::from(path),
        _ => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/corpus/calendar-fuzz.json"),
    }
}

fn load() -> Corpus {
    let path = corpus_path();
    let raw = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

/// A scenario's inputs, for a failure message — without them the diverging
/// columns are unreproducible.
fn describe(pages: &[CorpusPage]) -> String {
    pages
        .iter()
        .map(|page| {
            format!(
                "{}[{}..{} @{}]",
                page.id,
                page.scheduled_start.as_deref().unwrap_or("-"),
                page.scheduled_end.as_deref().unwrap_or("-"),
                page.created_at
            )
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[test]
fn randomly_composed_timed_days_match_the_reference() {
    let corpus = load();
    let total = corpus.timed.len();
    assert!(total >= 100, "corpus looks truncated: {total} scenarios");

    // A corpus of non-overlapping events would pass while testing nothing —
    // every column would be zero. Cascades are the behaviour under test.
    let with_cascade = corpus
        .timed
        .iter()
        .filter(|scenario| scenario.blocks.iter().any(|block| block.cascade_depth > 0))
        .count();
    assert!(
        with_cascade * 5 > total,
        "only {with_cascade} of {total} timed scenarios have overlapping events"
    );

    let mut failures = Vec::new();
    for scenario in &corpus.timed {
        let pages: Vec<LayoutPage> = scenario.pages.iter().map(LayoutPage::from).collect();
        let actual = assign_timed_columns(&pages, &scenario.day);

        // Keyed, not positional: the reference emits in DOM paint order, which
        // is pixel-derived and deliberately not reproduced.
        let actual_map: BTreeMap<&str, (usize, bool, bool)> = actual
            .iter()
            .map(|block| {
                (
                    block.page_id.as_str(),
                    (
                        block.cascade_depth,
                        block.is_continuation_before,
                        block.is_continuation_after,
                    ),
                )
            })
            .collect();
        let expected_map: BTreeMap<&str, (usize, bool, bool)> = scenario
            .blocks
            .iter()
            .map(|block| {
                (
                    block.page_id.as_str(),
                    (
                        block.cascade_depth,
                        block.is_continuation_before,
                        block.is_continuation_after,
                    ),
                )
            })
            .collect();

        if expected_map != actual_map {
            failures.push(format!(
                "  {}\n    reference: {expected_map:?}\n    rust:      {actual_map:?}",
                describe(&scenario.pages)
            ));
        }
    }
    report(failures, total, "timed");
}

#[test]
fn randomly_composed_all_day_weeks_match_the_reference() {
    let corpus = load();
    let total = corpus.all_day.len();
    assert!(total >= 100, "corpus looks truncated: {total} scenarios");

    // Single-row weeks exercise none of the packing, so a corpus of them would
    // pass while testing nothing.
    let stacked = corpus
        .all_day
        .iter()
        .filter(|scenario| scenario.row_count > 1)
        .count();
    assert!(
        stacked * 5 > total,
        "only {stacked} of {total} all-day scenarios need more than one row"
    );

    let mut failures = Vec::new();
    for scenario in &corpus.all_day {
        let pages: Vec<LayoutPage> = scenario.pages.iter().map(LayoutPage::from).collect();
        let slots = assign_stable_all_day_rows(&pages, &scenario.days);

        let actual_slots: Vec<Vec<Option<String>>> = slots
            .iter()
            .map(|day| {
                day.iter()
                    .map(|slot| slot.as_ref().map(|item| item.page_id.clone()))
                    .collect()
            })
            .collect();
        if scenario.slots != actual_slots {
            failures.push(format!(
                "  slots — {}\n    reference: {:?}\n    rust:      {actual_slots:?}",
                describe(&scenario.pages),
                scenario.slots
            ));
            continue;
        }

        let actual_row_count = slots.first().map_or(0, |day| day.len());
        if scenario.row_count != actual_row_count {
            failures.push(format!(
                "  row count — {}\n    reference: {}\n    rust:      {actual_row_count}",
                describe(&scenario.pages),
                scenario.row_count
            ));
            continue;
        }

        let bars = build_all_day_bars(&slots);
        let actual_bars: Vec<_> = bars
            .iter()
            .map(|bar| {
                (
                    bar.page_id.clone(),
                    bar.row,
                    bar.start_col,
                    bar.span,
                    bar.continues_left,
                    bar.continues_right,
                )
            })
            .collect();
        let expected_bars: Vec<_> = scenario
            .bars
            .iter()
            .map(|bar| {
                (
                    bar.page_id.clone(),
                    bar.row,
                    bar.start_col,
                    bar.span,
                    bar.continues_left,
                    bar.continues_right,
                )
            })
            .collect();
        if expected_bars != actual_bars {
            failures.push(format!(
                "  bars — {}\n    reference: {expected_bars:?}\n    rust:      {actual_bars:?}",
                describe(&scenario.pages)
            ));
        }
    }
    report(failures, total, "all-day");
}

fn report(failures: Vec<String>, total: usize, kind: &str) {
    if failures.is_empty() {
        return;
    }
    let shown = failures.len().min(12);
    let mut message = format!(
        "{} of {total} fuzzed {kind} scenarios differ from the TypeScript reference\n\n",
        failures.len()
    );
    message.push_str(&failures[..shown].join("\n"));
    if failures.len() > shown {
        message.push_str(&format!("\n  ... and {} more", failures.len() - shown));
    }
    panic!("{message}");
}
