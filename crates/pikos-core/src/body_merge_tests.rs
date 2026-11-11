use super::*;
use serde_json::json;

fn doc<S: AsRef<str>>(lines: &[S]) -> Value {
    let content: Vec<Value> = lines
        .iter()
        .map(
            |t| json!({ "type": "paragraph", "content": [{ "type": "text", "text": t.as_ref() }] }),
        )
        .collect();
    json!({ "type": "doc", "content": content })
}

/// A name, then the base, theirs, mine, and the merge wanted.
type Case<'a> = (
    &'a str,
    &'a [&'a str],
    &'a [&'a str],
    &'a [&'a str],
    &'a [&'a str],
);

#[test]
fn each_side_keeps_what_only_it_changed() {
    let cases: &[Case] = &[
        (
            "only theirs changed",
            &["a", "b"],
            &["a", "B"],
            &["a", "b"],
            &["a", "B"],
        ),
        (
            "only mine changed",
            &["a", "b"],
            &["a", "b"],
            &["A", "b"],
            &["A", "b"],
        ),
        (
            "different blocks",
            &["a", "b", "c"],
            &["A", "b", "c"],
            &["a", "b", "C"],
            &["A", "b", "C"],
        ),
        (
            "the same change",
            &["a", "b"],
            &["a", "B"],
            &["a", "B"],
            &["a", "B"],
        ),
        (
            "theirs deleted",
            &["a", "b", "c"],
            &["a", "c"],
            &["a", "b", "c"],
            &["a", "c"],
        ),
        (
            "mine deleted",
            &["a", "b", "c"],
            &["a", "b", "c"],
            &["a", "c"],
            &["a", "c"],
        ),
        (
            "added at both ends",
            &["a"],
            &["x", "a"],
            &["a", "y"],
            &["x", "a", "y"],
        ),
        (
            "nothing changed",
            &["a", "b"],
            &["a", "b"],
            &["a", "b"],
            &["a", "b"],
        ),
    ];

    for (name, base, theirs, mine, want) in cases {
        let merged = merge_bodies(&doc(base), &doc(theirs), &doc(mine));
        assert_eq!(merged, doc(want), "{name}");
    }
}

#[test]
fn a_block_both_sides_changed_keeps_both_with_the_stored_one_first() {
    let cases: &[Case] = &[
        (
            "same block",
            &["a", "b", "c"],
            &["a", "B1", "c"],
            &["a", "B2", "c"],
            &["a", "B1", "B2", "c"],
        ),
        (
            "added at the same place",
            &["a", "c"],
            &["a", "x", "c"],
            &["a", "y", "c"],
            &["a", "x", "y", "c"],
        ),
        (
            "both typed into an empty page",
            &[],
            &["x"],
            &["y"],
            &["x", "y"],
        ),
        (
            "changed where the other deleted",
            &["a", "b", "c"],
            &["a", "c"],
            &["a", "B", "c"],
            &["a", "B", "c"],
        ),
    ];

    for (name, base, theirs, mine, want) in cases {
        let merged = merge_bodies(&doc(base), &doc(theirs), &doc(mine));
        assert_eq!(merged, doc(want), "{name}");
    }
}

#[test]
fn blocks_compare_by_value_not_key_order() {
    let base =
        json!({ "type": "doc", "content": [{ "type": "paragraph", "attrs": { "a": 1, "b": 2 } }] });
    let reordered = serde_json::from_str::<Value>(
        r#"{"type":"doc","content":[{"attrs":{"b":2,"a":1},"type":"paragraph"}]}"#,
    )
    .unwrap();

    let merged = merge_bodies(&base, &reordered, &doc(&["mine"]));

    assert_eq!(merged, doc(&["mine"]));
}

#[test]
fn the_document_keeps_my_attributes() {
    let mut mine = doc(&["a"]);
    mine["attrs"] = json!({ "dir": "rtl" });

    let merged = merge_bodies(&doc(&["a"]), &doc(&["a"]), &mine);

    assert_eq!(merged["attrs"], json!({ "dir": "rtl" }));
}

#[test]
fn a_stretch_too_long_to_line_up_keeps_both_sides_whole() {
    let base_lines: Vec<String> = (0..3000).map(|i| format!("b{i}")).collect();
    let their_lines: Vec<String> = (0..3000).map(|i| format!("t{i}")).collect();
    let mut my_lines = base_lines.clone();
    my_lines[0] = "mine".to_string();

    let merged = merge_bodies(&doc(&base_lines), &doc(&their_lines), &doc(&my_lines));

    let mut want = their_lines.clone();
    want.extend(my_lines);
    assert_eq!(merged, doc(&want));
}
