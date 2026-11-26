//! Which rules a structured editor may touch, graded against `rruleEditWouldDegrade`.
//!
//! Too permissive is the expensive direction and silent: an edit rebuilds the rule through a
//! shape that cannot hold `BYWEEKNO`, and the terms that made it the user's are lost. The corpus
//! is `degradeCases` in `tests/corpus/recurrence.json`. The function under test is
//! `pikos-recurrence`'s; it is graded here because the corpus lives here.

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

/// Both halves matter: the locked half stops a lossy edit, the editable half stops the guard
/// from locking every rule.
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
