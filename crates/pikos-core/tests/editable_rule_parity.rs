//! Which rules a structured editor may touch, graded against the TypeScript.
//!
//! `rrule_edit_would_degrade` is the guard an editor asks before offering to
//! change a rule at all. Getting it wrong in the permissive direction is the
//! expensive one and it is silent: the user nudges an interval, the rule is
//! rebuilt through a shape that cannot hold `BYWEEKNO`, and the terms that made
//! the rule theirs are gone with no error anywhere.
//!
//! Graded rather than unit-tested because the answer is not a judgement call —
//! it is whatever `rruleEditWouldDegrade` says, and the desktop has been
//! answering it in production. The corpus is
//! `tests/corpus/recurrence.json`'s `degradeCases`; regenerate with
//! `pnpm --filter @pikos/core gen:parity`.
//!
//! This lives in `pikos-core` rather than beside the engine only because the
//! corpus does. The function under test is `pikos-recurrence`'s.

use std::fs;
use std::path::PathBuf;

use pikos_recurrence::rrule_edit_would_degrade;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Captured {
    ok: bool,
    #[serde(default)]
    value: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct DegradeCase {
    rrule: String,
    note: String,
    degrades: Captured,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Corpus {
    degrade_cases: Vec<DegradeCase>,
}

fn load() -> Corpus {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/corpus/recurrence.json");
    let raw = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "cannot read {}: {e}\nGenerate it with `pnpm --filter @pikos/core gen:parity`.",
            path.display()
        )
    });
    serde_json::from_str(&raw).expect("recurrence.json parses")
}

#[test]
fn the_editable_set_matches_the_typescript() {
    let corpus = load();
    assert!(
        corpus.degrade_cases.len() >= 20,
        "corpus looks truncated: {} cases",
        corpus.degrade_cases.len()
    );

    for case in &corpus.degrade_cases {
        assert!(case.degrades.ok, "the reference never throws here");
        let expected = case.degrades.value.expect("a captured boolean");
        assert_eq!(
            rrule_edit_would_degrade(&case.rrule),
            expected,
            "{:?} ({})",
            case.rrule,
            case.note
        );
    }
}

/// A corpus that only ever answers one way would pass whatever the port did.
///
/// Both halves matter and for different reasons: the locked half is what stops
/// a lossy edit, and the editable half is what stops the guard from locking
/// every rule and quietly disabling the editor entirely.
#[test]
fn the_corpus_covers_both_answers() {
    let corpus = load();
    let locked = corpus
        .degrade_cases
        .iter()
        .filter(|c| c.degrades.value == Some(true))
        .count();
    let editable = corpus.degrade_cases.len() - locked;
    assert!(locked >= 5, "only {locked} locking cases");
    assert!(editable >= 10, "only {editable} editable cases");
}
