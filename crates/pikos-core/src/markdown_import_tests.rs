use serde::Deserialize;
use serde_json::{json, Value};

use super::*;

const CORPUS: &str = include_str!("../tests/corpus/markdown-import.json");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Corpus {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    name: String,
    markdown: String,
    doc: Value,
    #[serde(default)]
    refused: bool,
}

#[test]
fn every_corpus_case_matches_the_app_or_is_refused() {
    let corpus: Corpus = serde_json::from_str(CORPUS).expect("the corpus parses");
    let mut failures = Vec::new();
    for case in &corpus.cases {
        match (markdown_to_prosemirror(&case.markdown), case.refused) {
            (Ok(doc), false) if doc == case.doc => {}
            (Err(_), true) => {}
            (Ok(doc), false) => failures.push(format!(
                "{}\n  want {}\n  got  {}",
                case.name, case.doc, doc
            )),
            (Ok(doc), true) => {
                failures.push(format!("{}: accepted, want refused: {doc}", case.name))
            }
            (Err(Refused(why)), false) => failures.push(format!("{}: refused: {why}", case.name)),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// Read then write is how an agent edits a page, so repeating it must settle. The first
/// pass may reshape what the exporter can't say (a list item's second paragraph comes
/// back as a line break); every pass after it has to change nothing.
#[test]
fn reading_and_writing_a_page_again_changes_nothing() {
    let corpus: Corpus = serde_json::from_str(CORPUS).unwrap();
    let round = |markdown: &str| {
        crate::prosemirror_to_markdown(&markdown_to_prosemirror(markdown).unwrap())
    };
    for case in corpus.cases.iter().filter(|c| !c.refused) {
        let once = round(&crate::prosemirror_to_markdown(&case.doc));
        assert_eq!(round(&once), once, "{}", case.name);
    }
}

#[test]
fn a_url_is_encoded_once() {
    assert_eq!(normalize_url("https://x.io/café"), "https://x.io/caf%C3%A9");
    assert_eq!(normalize_url("https://x.io/a%20b"), "https://x.io/a%20b");
    assert_eq!(normalize_url("https://x.io/100%"), "https://x.io/100%25");
}

#[test]
fn an_empty_body_is_one_empty_paragraph() {
    assert_eq!(
        markdown_to_prosemirror("").unwrap(),
        json!({ "type": "doc", "content": [{ "type": "paragraph" }] })
    );
}
