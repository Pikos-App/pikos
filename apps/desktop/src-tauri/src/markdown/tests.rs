use super::*;
use serde_json::json;

#[test]
fn simple_paragraph() {
    let doc = json!({
        "type": "doc",
        "content": [
            { "type": "paragraph", "content": [{ "type": "text", "text": "Hello world" }] }
        ]
    });
    assert_eq!(prosemirror_to_markdown(&doc), "Hello world\n");
}

#[test]
fn heading_and_paragraph() {
    let doc = json!({
        "type": "doc",
        "content": [
            { "type": "heading", "attrs": { "level": 2 }, "content": [{ "type": "text", "text": "Title" }] },
            { "type": "paragraph", "content": [{ "type": "text", "text": "Body text." }] }
        ]
    });
    assert_eq!(prosemirror_to_markdown(&doc), "## Title\n\nBody text.\n");
}

#[test]
fn bold_and_italic() {
    let doc = json!({
        "type": "doc",
        "content": [{
            "type": "paragraph",
            "content": [{
                "type": "text",
                "text": "bold",
                "marks": [{ "type": "bold" }]
            }, {
                "type": "text",
                "text": " and "
            }, {
                "type": "text",
                "text": "italic",
                "marks": [{ "type": "italic" }]
            }]
        }]
    });
    assert_eq!(prosemirror_to_markdown(&doc), "**bold** and *italic*\n");
}

#[test]
fn task_list() {
    let doc = json!({
        "type": "doc",
        "content": [{
            "type": "taskList",
            "content": [
                { "type": "taskItem", "attrs": { "checked": true }, "content": [
                    { "type": "paragraph", "content": [{ "type": "text", "text": "Done" }] }
                ]},
                { "type": "taskItem", "attrs": { "checked": false }, "content": [
                    { "type": "paragraph", "content": [{ "type": "text", "text": "Todo" }] }
                ]}
            ]
        }]
    });
    assert_eq!(prosemirror_to_markdown(&doc), "- [x] Done\n- [ ] Todo\n");
}

#[test]
fn link_with_bold() {
    let doc = json!({
        "type": "doc",
        "content": [{
            "type": "paragraph",
            "content": [{
                "type": "text",
                "text": "click here",
                "marks": [
                    { "type": "bold" },
                    { "type": "link", "attrs": { "href": "https://example.com" } }
                ]
            }]
        }]
    });
    assert_eq!(
        prosemirror_to_markdown(&doc),
        "[**click here**](https://example.com)\n"
    );
}

#[test]
fn code_block() {
    let doc = json!({
        "type": "doc",
        "content": [{
            "type": "codeBlock",
            "attrs": { "language": "rust" },
            "content": [{ "type": "text", "text": "fn main() {}" }]
        }]
    });
    assert_eq!(
        prosemirror_to_markdown(&doc),
        "```rust\nfn main() {}\n```\n"
    );
}

#[test]
fn table() {
    let doc = json!({
        "type": "doc",
        "content": [{
            "type": "table",
            "content": [
                { "type": "tableRow", "content": [
                    { "type": "tableHeader", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Name" }] }] },
                    { "type": "tableHeader", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Value" }] }] }
                ]},
                { "type": "tableRow", "content": [
                    { "type": "tableCell", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "A" }] }] },
                    { "type": "tableCell", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "1" }] }] }
                ]}
            ]
        }]
    });
    assert_eq!(
        prosemirror_to_markdown(&doc),
        "| Name | Value |\n| --- | --- |\n| A | 1 |\n"
    );
}

#[test]
fn image_node() {
    let doc = json!({
        "type": "doc",
        "content": [{
            "type": "image",
            "attrs": {
                "src": "http://asset.localhost/path/to/image.png",
                "alt": "screenshot",
                "data-asset-path": "/tmp/test-assets/abc123.png"
            }
        }]
    });
    assert_eq!(
        prosemirror_to_markdown(&doc),
        "![screenshot](/tmp/test-assets/abc123.png)\n"
    );
}

#[test]
fn image_without_asset_path() {
    let doc = json!({
        "type": "doc",
        "content": [{
            "type": "image",
            "attrs": {
                "src": "https://example.com/photo.jpg",
                "alt": "remote"
            }
        }]
    });
    assert_eq!(
        prosemirror_to_markdown(&doc),
        "![remote](https://example.com/photo.jpg)\n"
    );
}

#[test]
fn empty_doc() {
    let doc = json!({ "type": "doc", "content": [] });
    assert_eq!(prosemirror_to_markdown(&doc), "");
}

#[test]
fn empty_paragraph_renders_single_blank_line() {
    // The importer turns one source blank line into one empty paragraph node.
    // Export must give it back ONE blank line (two '\n'), not three — otherwise
    // a markdown → import → export → re-import round trip amplifies blank runs
    // (1 → 3 → 7 …). Regression for QA §14.
    let doc = json!({
        "type": "doc",
        "content": [
            { "type": "paragraph", "content": [{ "type": "text", "text": "A" }] },
            { "type": "paragraph" },
            { "type": "paragraph", "content": [{ "type": "text", "text": "B" }] }
        ]
    });
    assert_eq!(prosemirror_to_markdown(&doc), "A\n\nB\n");
}

#[test]
fn consecutive_empty_paragraphs_scale_blank_lines_one_for_one() {
    // K empty paragraphs → K+1 newlines (K blank lines), so re-import yields the
    // same K empty paragraphs. Two empties here → exactly two blank lines.
    let doc = json!({
        "type": "doc",
        "content": [
            { "type": "paragraph", "content": [{ "type": "text", "text": "A" }] },
            { "type": "paragraph" },
            { "type": "paragraph" },
            { "type": "paragraph", "content": [{ "type": "text", "text": "B" }] }
        ]
    });
    assert_eq!(prosemirror_to_markdown(&doc), "A\n\n\nB\n");
}
