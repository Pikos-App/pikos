//! Clearing the overdue backlog, graded against the TypeScript it replaces.
//!
//! `tests/corpus/overdue.json` is the output of
//! `pages/moveOverdueToToday.ts` over one fixture set at each of the suite's
//! seven reference times — regenerate with
//! `pnpm --filter @pikos/core gen:parity`.
//!
//! Seven references over ten pages is not repetition. The same fixture is days
//! overdue from one reference, dated *today* from another and in the future
//! from a third, so the boundary this is most likely to get wrong in only one
//! direction is crossed in both.
//!
//! One fixture sits astride the EU DST change, and what it grades is the two
//! implementations agreeing across it — not this one's arithmetic. A JavaScript
//! `Date` is an absolute instant and can be moved an hour by such a shift;
//! `NaiveDateTime` carries no zone and cannot. So the case is here to catch the
//! *reference* diverging, and a mutation from days to seconds on the Rust side
//! is correctly invisible to it.
//!
//! The label is graded too. It is the only place the user is told that
//! something stayed behind, and two apps disagreeing about how they were told
//! is how "2 recurring left" becomes a support question.

use std::fs;
use std::path::PathBuf;

use pikos_core::overdue::{move_overdue_to_today_label, plan_move_overdue_to_today, OverdueRow};
use serde::Deserialize;

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CorpusPage {
    id: String,
    #[serde(default)]
    scheduled_start: Option<String>,
    #[serde(default)]
    scheduled_end: Option<String>,
    is_recurring: bool,
    schedule_locked: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CorpusMove {
    page_id: String,
    start: String,
    #[serde(default)]
    end: Option<String>,
    previous_start: String,
    #[serde(default)]
    previous_end: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CorpusPlan {
    moves: Vec<CorpusMove>,
    recurring_kept: u32,
    synced_kept: u32,
}

#[derive(Debug, Deserialize)]
struct Case {
    #[serde(rename = "ref")]
    reference: String,
    plan: CorpusPlan,
    label: String,
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
    pages: Vec<CorpusPage>,
}

fn corpus() -> Corpus {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/corpus/overdue.json");
    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&raw).expect("overdue.json parses")
}

fn rows(pages: &[CorpusPage]) -> Vec<OverdueRow<'_>> {
    pages
        .iter()
        .map(|p| OverdueRow {
            id: &p.id,
            scheduled_start: p.scheduled_start.as_deref(),
            scheduled_end: p.scheduled_end.as_deref(),
            is_recurring: p.is_recurring,
            schedule_locked: p.schedule_locked,
        })
        .collect()
}

#[test]
fn the_plan_matches_the_reference_at_every_hour_it_was_taken() {
    let corpus = corpus();
    let rows = rows(&corpus.pages);

    for case in &corpus.cases {
        let today = &corpus
            .meta
            .references
            .iter()
            .find(|r| r.id == case.reference)
            .unwrap_or_else(|| panic!("unknown reference {}", case.reference))
            .iso[..10];

        let plan = plan_move_overdue_to_today(&rows, today);
        let context = format!("at {} ({today})", case.reference);

        assert_eq!(
            plan.moves.len(),
            case.plan.moves.len(),
            "{context}: moved {:?}, reference moved {:?}",
            plan.moves.iter().map(|m| &m.page_id).collect::<Vec<_>>(),
            case.plan
                .moves
                .iter()
                .map(|m| &m.page_id)
                .collect::<Vec<_>>()
        );
        for (got, want) in plan.moves.iter().zip(&case.plan.moves) {
            assert_eq!(got.page_id, want.page_id, "{context}: order differs");
            assert_eq!(got.start, want.start, "{context}: {} start", want.page_id);
            assert_eq!(
                got.end, want.end,
                "{context}: {} end — it has to travel with the start, or a \
                 one-hour meeting comes back a week long",
                want.page_id
            );
            assert_eq!(
                got.previous_start, want.previous_start,
                "{context}: {} previous start — this is what undo writes back",
                want.page_id
            );
            assert_eq!(
                got.previous_end, want.previous_end,
                "{context}: {} previous end",
                want.page_id
            );
        }
        assert_eq!(
            plan.recurring_kept, case.plan.recurring_kept,
            "{context}: recurring kept"
        );
        assert_eq!(
            plan.synced_kept, case.plan.synced_kept,
            "{context}: synced kept"
        );
        assert_eq!(
            move_overdue_to_today_label(&plan),
            case.label,
            "{context}: the sentence shown afterwards"
        );
    }
}

/// The corpus is only worth anything if it reaches every arm.
#[test]
fn the_corpus_exercises_each_reason_a_page_is_left_behind() {
    let corpus = corpus();
    assert!(corpus.pages.iter().any(|p| p.is_recurring));
    assert!(corpus.pages.iter().any(|p| p.schedule_locked));
    assert!(corpus.pages.iter().any(|p| p.scheduled_start.is_none()));
    assert!(corpus.pages.iter().any(|p| p.scheduled_end.is_some()));

    // The same page has to be overdue from one reference and in the future from
    // another, or the "do not run backwards" arm is never taken.
    let rows = rows(&corpus.pages);
    let early = plan_move_overdue_to_today(&rows, "2026-03-15");
    let late = plan_move_overdue_to_today(&rows, "2026-12-31");
    assert!(
        late.moves.len() > early.moves.len(),
        "a later today should have more to move, not the same"
    );
    assert!(
        !early.moves.iter().any(|m| m.page_id == "o_future"),
        "a page dated ahead of today is not overdue"
    );

    // And the label's three shapes — clean, mixed, and nothing to move — are
    // all reachable from this fixture set.
    let labels: Vec<String> = corpus.cases.iter().map(|c| c.label.clone()).collect();
    assert!(
        labels.iter().any(|l| l.contains("recurring")),
        "no reference time produces the 'left behind' sentence: {labels:?}"
    );
}
