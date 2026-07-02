//! Conformance: the Rust engine must agree with rrule.js occurrence-for-
//! occurrence. The fixture is generated from rrule.js via `recurrence.ts` (see
//! `packages/core/src/utils/recurrence.corpus.test.ts`) and committed, so this
//! test is hermetic — no Node at test time.

use pikos_recurrence::{
    align_weekly_rule_to_anchor, build_rrule, compute_next_end, expand_range, missed_occurrences_between,
    next_occurrence_after, parse_rrule, rrule_to_short_label, snap_anchor_to_rule, Freq, RecurrenceOptions,
};
use serde::Deserialize;

const CORPUS: &str = include_str!("fixtures/corpus.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Corpus {
    expand_range: Vec<ExpandCase>,
    next_after: Vec<NextCase>,
    snap_anchor: Vec<AnchorCase>,
    align_weekly: Vec<AlignCase>,
    missed_between: Vec<MissedCase>,
    compute_next_end: Vec<NextEndCase>,
    short_label: Vec<LabelCase>,
    roundtrip: Vec<RoundtripCase>,
    property_expand: Vec<PropertyCase>,
}

/// Seeded property cases assert date-set parity only (comma-joined), so a large
/// batch stays compact; start/end formatting is covered by `expand_range`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PropertyCase {
    rrule: String,
    start: String,
    range_start: String,
    range_end: String,
    dates: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpandCase {
    name: String,
    rrule: String,
    start: String,
    end: Option<String>,
    range_start: String,
    range_end: String,
    exdates: Vec<String>,
    expected: Vec<ExpectedOcc>,
}

#[derive(Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct ExpectedOcc {
    original_date: String,
    scheduled_start: String,
    scheduled_end: Option<String>,
}

#[derive(Deserialize)]
struct NextCase {
    name: String,
    rrule: String,
    start: String,
    after: String,
    exdates: Vec<String>,
    expected: Option<NextExpected>,
}

#[derive(Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct NextExpected {
    scheduled_start: String,
    scheduled_end: Option<String>,
}

#[derive(Deserialize)]
struct AnchorCase {
    name: String,
    rrule: String,
    anchor: String,
    expected: String,
}

#[derive(Deserialize)]
struct AlignCase {
    name: String,
    rrule: String,
    anchor: String,
    expected: String,
}

#[derive(Deserialize)]
struct MissedCase {
    name: String,
    rrule: String,
    start: String,
    after: String,
    before: String,
    exdates: Vec<String>,
    expected: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NextEndCase {
    name: String,
    base_end: String,
    next_start: String,
    expected: Option<String>,
}

#[derive(Deserialize)]
struct LabelCase {
    rrule: String,
    expected: String,
}

#[derive(Deserialize)]
struct RoundtripCase {
    rrule: String,
    options: CorpusOptions,
}

#[derive(Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct CorpusOptions {
    freq: String,
    interval: u32,
    #[serde(default)]
    byweekday: Option<Vec<u8>>,
    #[serde(default)]
    bysetpos: Option<Vec<i32>>,
    #[serde(default)]
    bymonthday: Option<Vec<i32>>,
    #[serde(default)]
    wkst: Option<u8>,
    #[serde(default)]
    count: Option<u32>,
    #[serde(default)]
    until: Option<String>,
}

fn freq_str(freq: Freq) -> String {
    match freq {
        Freq::Daily => "DAILY",
        Freq::Weekly => "WEEKLY",
        Freq::Monthly => "MONTHLY",
        Freq::Yearly => "YEARLY",
    }
    .to_string()
}

fn to_corpus(o: &RecurrenceOptions) -> CorpusOptions {
    CorpusOptions {
        freq: freq_str(o.freq.expect("freq")),
        interval: o.interval,
        byweekday: o.byweekday.clone(),
        bysetpos: o.bysetpos.clone(),
        bymonthday: o.bymonthday.clone(),
        wkst: o.wkst,
        count: o.count,
        until: o.until.clone(),
    }
}

fn corpus() -> Corpus {
    // `PIKOS_CORPUS_PATH` lets a regenerated corpus be validated against the
    // engine before it's committed; unset, the embedded fixture is used.
    let json = match std::env::var("PIKOS_CORPUS_PATH") {
        Ok(path) => std::fs::read_to_string(path).expect("override corpus reads"),
        Err(_) => CORPUS.to_string(),
    };
    serde_json::from_str(&json).expect("corpus.json parses")
}

#[test]
fn expand_range_matches() {
    for c in corpus().expand_range {
        let got = expand_range(&c.rrule, &c.start, c.end.as_deref(), &c.range_start, &c.range_end, &c.exdates)
            .unwrap_or_else(|e| panic!("[{}] {e}", c.name));
        let got: Vec<ExpectedOcc> = got
            .into_iter()
            .map(|o| ExpectedOcc {
                original_date: o.original_date,
                scheduled_start: o.scheduled_start,
                scheduled_end: o.scheduled_end,
            })
            .collect();
        assert_eq!(got, c.expected, "expand_range: {}", c.name);
    }
}

#[test]
fn next_occurrence_after_matches() {
    for c in corpus().next_after {
        let got = next_occurrence_after(&c.rrule, &c.start, &c.after, &c.exdates)
            .unwrap_or_else(|e| panic!("[{}] {e}", c.name));
        let got = got.map(|(start, end)| NextExpected { scheduled_start: start, scheduled_end: end });
        assert_eq!(got, c.expected, "next_occurrence_after: {}", c.name);
    }
}

#[test]
fn snap_anchor_matches() {
    for c in corpus().snap_anchor {
        assert_eq!(snap_anchor_to_rule(&c.rrule, &c.anchor), c.expected, "snap_anchor: {}", c.name);
    }
}

#[test]
fn align_weekly_matches() {
    for c in corpus().align_weekly {
        assert_eq!(align_weekly_rule_to_anchor(&c.rrule, &c.anchor), c.expected, "align_weekly: {}", c.name);
    }
}

#[test]
fn missed_between_matches() {
    for c in corpus().missed_between {
        let got = missed_occurrences_between(&c.rrule, &c.start, &c.after, &c.before, &c.exdates)
            .unwrap_or_else(|e| panic!("[{}] {e}", c.name));
        assert_eq!(got, c.expected, "missed_between: {}", c.name);
    }
}

#[test]
fn compute_next_end_matches() {
    for c in corpus().compute_next_end {
        assert_eq!(compute_next_end(&c.base_end, &c.next_start), c.expected, "compute_next_end: {}", c.name);
    }
}

#[test]
fn short_label_matches() {
    for c in corpus().short_label {
        assert_eq!(rrule_to_short_label(&c.rrule), c.expected, "short_label: {}", c.rrule);
    }
}

#[test]
fn property_expand_matches() {
    for c in corpus().property_expand {
        let got = expand_range(&c.rrule, &c.start, None, &c.range_start, &c.range_end, &[])
            .unwrap_or_else(|e| panic!("[{}] {e}", c.rrule));
        let got = got.into_iter().map(|o| o.original_date).collect::<Vec<_>>().join(",");
        assert_eq!(got, c.dates, "property_expand: {}", c.rrule);
    }
}

#[test]
fn roundtrip_matches() {
    for c in corpus().roundtrip {
        let parsed = parse_rrule(&c.rrule).unwrap_or_else(|| panic!("parse {}", c.rrule));
        assert_eq!(to_corpus(&parsed), c.options, "parse parity: {}", c.rrule);
        // Build must round-trip through parse (byte-parity with rrule.js is not required).
        let rebuilt = parse_rrule(&build_rrule(&parsed)).unwrap_or_else(|| panic!("reparse {}", c.rrule));
        assert_eq!(rebuilt, parsed, "build round-trip: {}", c.rrule);
    }
}
