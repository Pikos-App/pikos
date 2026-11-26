//! Tiptap document to plain text.
//!
//! The result is what `pages.content_text` holds and FTS5 indexes; the ProseMirror JSON itself
//! is unsearchable. iOS calls the same function on the editor bridge's `docChanged`, so
//! phone-typed text stays searchable.
//!
//! Never fails: malformed or non-document input yields an empty string, because refusing to
//! save a page whose content could not be summarised would be worse than an unsearchable page.

use serde_json::Value;

/// Node types whose children are joined without separators and then emitted as
/// one line. Everything else is a container that passes children through.
fn is_block(node_type: &str) -> bool {
    matches!(
        node_type,
        "paragraph" | "heading" | "codeBlock" | "blockquote" | "listItem" | "taskItem"
    )
}

/// Extract plain text from a Tiptap JSON document, given as the string the database stores.
pub fn extract_text(raw: &str) -> String {
    if raw.is_empty() || raw == "{}" {
        return String::new();
    }
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return String::new();
    };
    extract_text_value(&value)
}

pub fn extract_text_value(doc: &Value) -> String {
    // Mirrors the TS guard. A JavaScript array is an object, so an array input walks and
    // yields nothing rather than returning early.
    if !doc.is_object() && !doc.is_array() {
        return String::new();
    }
    let mut parts: Vec<String> = Vec::new();
    walk(doc, &mut parts);
    parts.join("\n").trim().to_string()
}

fn walk(node: &Value, parts: &mut Vec<String>) {
    if let Some(text) = node.get("text").and_then(Value::as_str) {
        if !text.is_empty() {
            parts.push(text.to_string());
            return;
        }
        // An empty string is falsy in JS, so the original falls through to the content check.
    }

    if node.get("type").and_then(Value::as_str) == Some("pageLink") {
        parts.push(crate::page_links::link_text(node).to_string());
        return;
    }

    let Some(content) = node.get("content").and_then(Value::as_array) else {
        return;
    };

    let mut child_parts: Vec<String> = Vec::new();
    for child in content {
        walk(child, &mut child_parts);
    }

    let node_type = node.get("type").and_then(Value::as_str).unwrap_or("");
    if is_block(node_type) {
        // Inline children join into one part, so blocks end up newline-separated by the final join.
        parts.push(child_parts.concat());
    } else {
        parts.extend(child_parts);
    }
}
