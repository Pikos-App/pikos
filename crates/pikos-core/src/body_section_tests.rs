use super::*;
use serde_json::json;

/// Blocks in the editor's key order, which encoding a parsed value would sort.
fn heading(level: u8, text: &str) -> String {
    format!(
        r#"{{"type":"heading","attrs":{{"level":{level}}},"content":[{{"type":"text","text":"{text}"}}]}}"#
    )
}

fn para(text: &str) -> String {
    format!(r#"{{"type":"paragraph","content":[{{"type":"text","text":"{text}"}}]}}"#)
}

fn body(blocks: &[String]) -> String {
    format!(r#"{{"type":"doc","content":[{}]}}"#, blocks.join(","))
}

fn new_para(text: &str) -> Value {
    json!({ "type": "paragraph", "content": [{ "type": "text", "text": text }] })
}

fn page() -> Vec<String> {
    vec![
        heading(1, "Plan"),
        para("intro"),
        heading(2, "Notes"),
        para("first note"),
        heading(3, "Detail"),
        para("deep"),
        heading(2, "Later"),
        para("someday"),
    ]
}

fn edited(edit: SectionEdit) -> String {
    edit_section(&body(&page()), &edit, &[new_para("added")]).unwrap()
}

fn with_added_at(at: usize, removing: usize) -> String {
    let mut blocks = page();
    blocks.splice(at..at + removing, [new_para("added").to_string()]);
    body(&blocks)
}

#[test]
fn appending_to_a_section_lands_before_the_next_heading_of_its_level() {
    assert_eq!(
        edited(SectionEdit::AppendTo("Notes".into())),
        with_added_at(6, 0)
    );
}

#[test]
fn inserting_after_a_heading_lands_straight_under_it() {
    assert_eq!(
        edited(SectionEdit::InsertAfter("Notes".into())),
        with_added_at(3, 0)
    );
}

#[test]
fn replacing_a_section_takes_its_subheadings_and_keeps_the_heading() {
    assert_eq!(
        edited(SectionEdit::Replace("Notes".into())),
        with_added_at(3, 3)
    );
}

#[test]
fn appending_to_the_page_lands_after_its_last_block() {
    assert_eq!(edited(SectionEdit::Append), with_added_at(8, 0));
}

#[test]
fn the_last_section_runs_to_the_end_of_the_page() {
    assert_eq!(
        edited(SectionEdit::AppendTo("Later".into())),
        with_added_at(8, 0)
    );
}

#[test]
fn a_heading_matches_ignoring_case_and_leading_hashes() {
    assert_eq!(
        edited(SectionEdit::AppendTo("## notes".into())),
        with_added_at(6, 0)
    );
}

#[test]
fn a_page_with_no_body_takes_an_append() {
    let out = edit_section(
        r#"{"type":"doc"}"#,
        &SectionEdit::Append,
        &[new_para("added")],
    );

    assert_eq!(out.unwrap(), body(&[new_para("added").to_string()]));
}

#[test]
fn a_missing_heading_names_the_headings_there_are() {
    let err = edit_section(&body(&page()), &SectionEdit::Replace("Ideas".into()), &[]).unwrap_err();

    assert_eq!(
        err.0,
        r####"no heading "Ideas"; the page's headings are "# Plan", "## Notes", "### Detail", "## Later""####
    );
}

#[test]
fn a_heading_named_twice_is_refused_naming_both() {
    let blocks = vec![
        heading(2, "Notes"),
        para("a"),
        heading(3, "Notes"),
        para("b"),
    ];

    let err =
        edit_section(&body(&blocks), &SectionEdit::AppendTo("Notes".into()), &[]).unwrap_err();

    assert_eq!(
        err.0,
        r####""Notes" matches 2 headings: "## Notes" (heading 1), "### Notes" (heading 2); rename one, or replace the whole body"####
    );
}

#[test]
fn a_heading_on_a_page_without_any_is_refused() {
    let err = edit_section(
        &body(&[para("a")]),
        &SectionEdit::InsertAfter("Notes".into()),
        &[],
    )
    .unwrap_err();

    assert_eq!(err.0, r#"no heading "Notes": the page has no headings"#);
}
