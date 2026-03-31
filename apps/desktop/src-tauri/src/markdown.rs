// markdown.rs — Convert ProseMirror/Tiptap JSON → Markdown.
// Handles the node types produced by our Tiptap editor configuration:
// doc, paragraph, heading(1-3), bulletList, orderedList, listItem,
// taskList, taskItem, codeBlock, blockquote, horizontalRule, hardBreak,
// text with marks: bold, italic, strike, code, link, underline.

use serde_json::Value;

/// Convert a ProseMirror JSON document to Markdown.
pub fn prosemirror_to_markdown(doc: &Value) -> String {
    let mut out = String::new();
    if let Some(content) = doc.get("content").and_then(|c| c.as_array()) {
        render_blocks(&mut out, content, 0);
    }
    // Trim trailing whitespace but keep a single trailing newline
    let trimmed = out.trim_end();
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("{}\n", trimmed)
    }
}

fn render_blocks(out: &mut String, nodes: &[Value], depth: usize) {
    let len = nodes.len();
    for (i, node) in nodes.iter().enumerate() {
        render_block(out, node, depth);
        // Add blank line between top-level blocks (not after the last one)
        if depth == 0 && i + 1 < len {
            out.push('\n');
        }
    }
}

fn render_block(out: &mut String, node: &Value, depth: usize) {
    let node_type = node.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match node_type {
        "paragraph" => {
            render_inline_content(out, node);
            out.push('\n');
        }
        "heading" => {
            let level = node
                .get("attrs")
                .and_then(|a| a.get("level"))
                .and_then(|l| l.as_u64())
                .unwrap_or(1) as usize;
            for _ in 0..level {
                out.push('#');
            }
            out.push(' ');
            render_inline_content(out, node);
            out.push('\n');
        }
        "codeBlock" => {
            let lang = node
                .get("attrs")
                .and_then(|a| a.get("language"))
                .and_then(|l| l.as_str())
                .unwrap_or("");
            out.push_str("```");
            out.push_str(lang);
            out.push('\n');
            render_inline_content(out, node);
            if !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str("```\n");
        }
        "blockquote" => {
            if let Some(content) = node.get("content").and_then(|c| c.as_array()) {
                for child in content {
                    out.push_str("> ");
                    render_block_inline(out, child);
                }
            }
        }
        "bulletList" => {
            if let Some(items) = node.get("content").and_then(|c| c.as_array()) {
                for item in items {
                    render_list_item(out, item, depth, None);
                }
            }
        }
        "orderedList" => {
            let start = node
                .get("attrs")
                .and_then(|a| a.get("start"))
                .and_then(|s| s.as_u64())
                .unwrap_or(1) as usize;
            if let Some(items) = node.get("content").and_then(|c| c.as_array()) {
                for (i, item) in items.iter().enumerate() {
                    render_list_item(out, item, depth, Some(start + i));
                }
            }
        }
        "taskList" => {
            if let Some(items) = node.get("content").and_then(|c| c.as_array()) {
                for item in items {
                    render_task_item(out, item, depth);
                }
            }
        }
        "horizontalRule" => {
            out.push_str("---\n");
        }
        _ => {
            // Unknown block type — try to extract text content
            render_inline_content(out, node);
            if !out.ends_with('\n') {
                out.push('\n');
            }
        }
    }
}

/// Render a block node as a single line (used inside blockquotes).
fn render_block_inline(out: &mut String, node: &Value) {
    let node_type = node.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match node_type {
        "paragraph" => {
            render_inline_content(out, node);
            out.push('\n');
        }
        _ => render_block(out, node, 0),
    }
}

fn render_list_item(out: &mut String, item: &Value, depth: usize, ordered_index: Option<usize>) {
    let indent = "  ".repeat(depth);
    let bullet = match ordered_index {
        Some(n) => format!("{}. ", n),
        None => "- ".to_string(),
    };

    if let Some(content) = item.get("content").and_then(|c| c.as_array()) {
        for (i, child) in content.iter().enumerate() {
            let child_type = child.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if i == 0 {
                out.push_str(&indent);
                out.push_str(&bullet);
                // First child is typically a paragraph — render inline
                render_inline_content(out, child);
                out.push('\n');
            } else {
                // Nested lists or additional paragraphs
                match child_type {
                    "bulletList" | "orderedList" | "taskList" => {
                        render_block(out, child, depth + 1);
                    }
                    _ => {
                        out.push_str(&indent);
                        out.push_str(&" ".repeat(bullet.len()));
                        render_inline_content(out, child);
                        out.push('\n');
                    }
                }
            }
        }
    }
}

fn render_task_item(out: &mut String, item: &Value, depth: usize) {
    let indent = "  ".repeat(depth);
    let checked = item
        .get("attrs")
        .and_then(|a| a.get("checked"))
        .and_then(|c| c.as_bool())
        .unwrap_or(false);
    let checkbox = if checked { "- [x] " } else { "- [ ] " };

    if let Some(content) = item.get("content").and_then(|c| c.as_array()) {
        for (i, child) in content.iter().enumerate() {
            let child_type = child.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if i == 0 {
                out.push_str(&indent);
                out.push_str(checkbox);
                render_inline_content(out, child);
                out.push('\n');
            } else {
                match child_type {
                    "bulletList" | "orderedList" | "taskList" => {
                        render_block(out, child, depth + 1);
                    }
                    _ => {
                        out.push_str(&indent);
                        out.push_str(&" ".repeat(checkbox.len()));
                        render_inline_content(out, child);
                        out.push('\n');
                    }
                }
            }
        }
    }
}

/// Render the inline content (text nodes + marks) of a block node.
fn render_inline_content(out: &mut String, node: &Value) {
    if let Some(content) = node.get("content").and_then(|c| c.as_array()) {
        for child in content {
            render_inline(out, child);
        }
    }
}

fn render_inline(out: &mut String, node: &Value) {
    let node_type = node.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match node_type {
        "text" => {
            let text = node.get("text").and_then(|t| t.as_str()).unwrap_or("");
            let marks = node.get("marks").and_then(|m| m.as_array());
            render_marked_text(out, text, marks);
        }
        "hardBreak" => {
            out.push_str("  \n");
        }
        _ => {
            // Unknown inline — try text
            if let Some(text) = node.get("text").and_then(|t| t.as_str()) {
                out.push_str(text);
            }
        }
    }
}

fn render_marked_text(out: &mut String, text: &str, marks: Option<&Vec<Value>>) {
    let marks = match marks {
        Some(m) if !m.is_empty() => m,
        _ => {
            out.push_str(text);
            return;
        }
    };

    // Collect mark types
    let mut is_bold = false;
    let mut is_italic = false;
    let mut is_strike = false;
    let mut is_code = false;
    let mut link_href: Option<&str> = None;

    for mark in marks {
        match mark.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            "bold" => is_bold = true,
            "italic" => is_italic = true,
            "strike" => is_strike = true,
            "code" => is_code = true,
            "underline" => {} // No markdown equivalent — render as plain text
            "link" => {
                link_href = mark
                    .get("attrs")
                    .and_then(|a| a.get("href"))
                    .and_then(|h| h.as_str());
            }
            _ => {}
        }
    }

    // Code mark takes precedence — no nested formatting inside code spans
    if is_code {
        out.push('`');
        out.push_str(text);
        out.push('`');
        return;
    }

    // Build opening/closing sequences
    let mut prefix = String::new();
    let mut suffix = String::new();

    if is_bold {
        prefix.push_str("**");
        suffix.insert_str(0, "**");
    }
    if is_italic {
        prefix.push('*');
        suffix.insert(0, '*');
    }
    if is_strike {
        prefix.push_str("~~");
        suffix.insert_str(0, "~~");
    }

    if let Some(href) = link_href {
        out.push('[');
        out.push_str(&prefix);
        out.push_str(text);
        out.push_str(&suffix);
        out.push_str("](");
        out.push_str(href);
        out.push(')');
    } else {
        out.push_str(&prefix);
        out.push_str(text);
        out.push_str(&suffix);
    }
}

#[cfg(test)]
mod tests {
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
    fn empty_doc() {
        let doc = json!({ "type": "doc", "content": [] });
        assert_eq!(prosemirror_to_markdown(&doc), "");
    }
}
