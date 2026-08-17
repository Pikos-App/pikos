//! Query tokenization, run against the table `ftsTokens` also runs. Neither side is
//! the authority — FTS5's `unicode61` is — so they need one expectation between them.

use serde::Deserialize;

use crate::search::fts_tokens;

const TABLE: &str = include_str!("../tests/fixtures/search-tokenization.json");

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
    tokens: Vec<String>,
}

#[test]
fn every_case_tokenizes_to_the_shared_expectation() {
    let table: Table = serde_json::from_str(TABLE).expect("parse search-tokenization.json");
    assert!(!table.cases.is_empty());

    for case in &table.cases {
        // Expectations are folded because the TS side compares tokens itself; here
        // SQLite folds at match time, so this side never needs to.
        let tokens: Vec<String> = fts_tokens(&case.query)
            .iter()
            .map(|t| t.to_lowercase())
            .collect();
        assert_eq!(tokens, case.tokens, "case: {}", case.name);
    }
}
