//! Convert ProseMirror/Tiptap JSON → Markdown.
//! Handles the node types produced by our Tiptap editor configuration:
//! doc, paragraph, heading(1-3), bulletList, orderedList, listItem,
//! taskList, taskItem, codeBlock, blockquote, horizontalRule, hardBreak,
//! text with marks: bold, italic, strike, code, link, underline.

use serde_json::Value;

pub fn prosemirror_to_markdown(doc: &Value) -> String {
    let mut out = String::new();
    if let Some(content) = doc.get("content").and_then(|c| c.as_array()) {
        render_blocks(&mut out, content, 0);
    }
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
        // Blank line between top-level blocks (not after the last one).
        //
        // An empty paragraph is the importer's representation of a blank line
        // (see insertBlankLineParagraphs) and already renders as its own '\n'.
        // Adding the separator on top of it would emit two newlines per empty
        // paragraph, so a markdown → import → export round trip amplifies blank
        // runs (1 → 3 → 7 …). Suppress the separator on either side of an empty
        // paragraph so the empty paragraph alone carries the blank line (n → n).
        if depth == 0
            && i + 1 < len
            && !is_empty_paragraph(node)
            && !is_empty_paragraph(&nodes[i + 1])
        {
            out.push('\n');
        }
    }
}

/// True for a paragraph node with no inline content — the shape the importer
/// inserts for each blank line. These must not also receive the inter-block
/// separator (see `render_blocks`).
fn is_empty_paragraph(node: &Value) -> bool {
    node.get("type").and_then(|t| t.as_str()) == Some("paragraph")
        && node
            .get("content")
            .and_then(|c| c.as_array())
            .is_none_or(|a| a.is_empty())
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
        "table" => {
            if let Some(rows) = node.get("content").and_then(|c| c.as_array()) {
                let mut table_rows: Vec<Vec<String>> = Vec::new();
                let mut is_first_row_header = false;

                for (ri, row) in rows.iter().enumerate() {
                    if let Some(cells) = row.get("content").and_then(|c| c.as_array()) {
                        let mut cell_texts: Vec<String> = Vec::new();
                        if ri == 0 {
                            is_first_row_header = cells.iter().any(|c| {
                                c.get("type").and_then(|t| t.as_str()) == Some("tableHeader")
                            });
                        }
                        for cell in cells {
                            let mut cell_out = String::new();
                            if let Some(content) = cell.get("content").and_then(|c| c.as_array()) {
                                for (pi, para) in content.iter().enumerate() {
                                    if pi > 0 {
                                        cell_out.push_str("<br>");
                                    }
                                    render_inline_content(&mut cell_out, para);
                                }
                            }
                            cell_texts.push(cell_out);
                        }
                        table_rows.push(cell_texts);
                    }
                }

                if table_rows.is_empty() {
                    return;
                }

                let num_cols = table_rows.iter().map(|r| r.len()).max().unwrap_or(0);

                if let Some(header) = table_rows.first() {
                    out.push('|');
                    for col in 0..num_cols {
                        out.push(' ');
                        out.push_str(header.get(col).map(|s| s.as_str()).unwrap_or(""));
                        out.push_str(" |");
                    }
                    out.push('\n');

                    out.push('|');
                    for _ in 0..num_cols {
                        out.push_str(" --- |");
                    }
                    out.push('\n');
                }

                let start = if is_first_row_header { 1 } else { 0 };
                for row in table_rows.iter().skip(start) {
                    out.push('|');
                    for col in 0..num_cols {
                        out.push(' ');
                        out.push_str(row.get(col).map(|s| s.as_str()).unwrap_or(""));
                        out.push_str(" |");
                    }
                    out.push('\n');
                }
            }
        }
        "image" => {
            let attrs = node.get("attrs");
            let src = attrs
                .and_then(|a| a.get("src"))
                .and_then(|s| s.as_str())
                .unwrap_or("");
            let alt = attrs
                .and_then(|a| a.get("alt"))
                .and_then(|a| a.as_str())
                .unwrap_or("");
            // Prefer the stored asset path for export (relative path),
            // fall back to src
            let export_src = attrs
                .and_then(|a| a.get("data-asset-path"))
                .and_then(|p| p.as_str())
                .unwrap_or(src);
            out.push_str(&format!("![{}]({})\n", alt, export_src));
        }
        "horizontalRule" => {
            out.push_str("---\n");
        }
        _ => {
            // Unknown block type — degrade to its text content
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
                render_inline_content(out, child);
                out.push('\n');
            } else {
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
#[path = "tests.rs"]
mod tests;
