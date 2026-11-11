use super::*;
use crate::{markdown_to_prosemirror, prosemirror_to_markdown};
use serde_json::json;

fn link(id: &str, title: &str) -> Value {
    json!({ "type": "pageLink", "attrs": { "pageId": id, "title": title } })
}

fn paragraph(content: Vec<Value>) -> Value {
    json!({ "type": "doc", "content": [{ "type": "paragraph", "content": content }] })
}

fn resolve_known(title: &str) -> Option<String> {
    match title {
        "Plans" => Some("plans-id".to_string()),
        "Trip notes" => Some("trip-id".to_string()),
        _ => None,
    }
}

#[test]
fn link_targets_lists_each_target_once_in_order() {
    let doc = json!({
        "type": "doc",
        "content": [
            { "type": "paragraph", "content": [link("b", "B"), link("a", "A")] },
            { "type": "bulletList", "content": [{ "type": "listItem", "content": [
                { "type": "paragraph", "content": [link("b", "B"), link("c", "C")] }
            ]}]}
        ]
    });

    assert_eq!(link_targets(&doc), vec!["b", "a", "c"]);
}

#[test]
fn link_targets_skips_a_link_with_no_target() {
    let doc = paragraph(vec![
        json!({ "type": "pageLink", "attrs": { "pageId": null } }),
    ]);

    assert!(link_targets(&doc).is_empty());
}

#[test]
fn markdown_writes_a_link_as_its_title_in_brackets() {
    let doc = paragraph(vec![
        json!({ "type": "text", "text": "See " }),
        link("plans-id", "Plans"),
    ]);

    assert_eq!(prosemirror_to_markdown(&doc), "See [[Plans]]\n");
}

#[test]
fn refresh_link_titles_writes_the_current_title_and_keeps_an_unknown_one() {
    let mut doc = paragraph(vec![
        link("plans-id", "Old name"),
        link("gone", "Gone page"),
    ]);

    refresh_link_titles(&mut doc, &|id| {
        (id == "plans-id").then(|| "Plans".to_string())
    });

    assert_eq!(prosemirror_to_markdown(&doc), "[[Plans]][[Gone page]]\n");
}

#[test]
fn resolve_wikilinks_links_known_titles_and_keeps_the_text_around_them() {
    let mut doc = paragraph(vec![json!({
        "type": "text",
        "text": "See [[Plans]] and [[Nobody]] then [[ Trip notes ]]."
    })]);

    resolve_wikilinks(&mut doc, &mut resolve_known);

    assert_eq!(
        doc["content"][0]["content"],
        json!([
            { "type": "text", "text": "See " },
            link("plans-id", "Plans"),
            { "type": "text", "text": " and [[Nobody]] then " },
            link("trip-id", "Trip notes"),
            { "type": "text", "text": "." },
        ])
    );
}

#[test]
fn resolve_wikilinks_carries_marks_onto_the_text_either_side() {
    let bold = json!([{ "type": "bold" }]);
    let mut doc = paragraph(vec![
        json!({ "type": "text", "text": "a [[Plans]] b", "marks": bold }),
    ]);

    resolve_wikilinks(&mut doc, &mut resolve_known);

    assert_eq!(
        doc["content"][0]["content"],
        json!([
            { "type": "text", "text": "a ", "marks": bold },
            link("plans-id", "Plans"),
            { "type": "text", "text": " b", "marks": bold },
        ])
    );
}

#[test]
fn resolve_wikilinks_leaves_code_alone() {
    let mut doc = json!({
        "type": "doc",
        "content": [
            { "type": "codeBlock", "content": [{ "type": "text", "text": "[[Plans]]" }] },
            { "type": "paragraph", "content": [
                { "type": "text", "text": "[[Plans]]", "marks": [{ "type": "code" }] }
            ]}
        ]
    });
    let before = doc.clone();

    resolve_wikilinks(&mut doc, &mut resolve_known);

    assert_eq!(doc, before);
}

#[test]
fn a_link_survives_a_markdown_round_trip() {
    let doc = paragraph(vec![
        json!({ "type": "text", "text": "See " }),
        link("plans-id", "Plans"),
    ]);

    let markdown = prosemirror_to_markdown(&doc);
    let mut back = markdown_to_prosemirror(&markdown).unwrap();
    resolve_wikilinks(&mut back, &mut resolve_known);

    assert_eq!(link_targets(&back), vec!["plans-id"]);
    assert_eq!(prosemirror_to_markdown(&back), markdown);
}

#[test]
fn wikilink_titles_lists_each_bracketed_title_once_outside_code() {
    let doc = json!({
        "type": "doc",
        "content": [
            { "type": "paragraph", "content": [
                { "type": "text", "text": "[[Plans]], [[ Trip notes ]] and [[Plans]]" }
            ]},
            { "type": "codeBlock", "content": [{ "type": "text", "text": "[[Code]]" }] }
        ]
    });

    assert_eq!(wikilink_titles(&doc), ["Plans", "Trip notes"]);
}
