//! Tiptap document → plain text.
//!
//! Port of `packages/core/src/utils/extractText.ts`. The desktop app writes the
//! result into `pages.content_text`, which is what FTS5 actually indexes — the
//! ProseMirror JSON itself is unsearchable. iOS needs the same function on the
//! editor bridge's `docChanged` message, so search keeps working for anything
//! typed on the phone.
//!
//! Never fails. Malformed or non-document input yields an empty string, because
//! the alternative — refusing to save a page whose content could not be
//! summarised for search — would be far worse than an unsearchable page.

use serde_json::Value;

/// Node types whose children are joined without separators and then emitted as
/// one line. Everything else is a container that passes children through.
fn is_block(node_type: &str) -> bool {
    matches!(
        node_type,
        "paragraph" | "heading" | "codeBlock" | "blockquote" | "listItem" | "taskItem"
    )
}

/// Extract plain text from a Tiptap JSON document, given as the JSON string the
/// database stores.
pub fn extract_text(raw: &str) -> String {
    if raw.is_empty() || raw == "{}" {
        return String::new();
    }
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return String::new();
    };
    extract_text_value(&value)
}

/// Extract plain text from an already-parsed document.
pub fn extract_text_value(doc: &Value) -> String {
    // Mirrors the TS guard `!doc || typeof doc !== "object"`. In JavaScript an
    // array *is* an object, so an array input walks (and yields nothing, having
    // no `text` or `content` key) rather than returning early.
    if !doc.is_object() && !doc.is_array() {
        return String::new();
    }
    let mut parts: Vec<String> = Vec::new();
    walk(doc, &mut parts);
    parts.join("\n").trim().to_string()
}

fn walk(node: &Value, parts: &mut Vec<String>) {
    // A node with text is a leaf: emit and stop. Checked before `content`
    // because a text node never has children.
    if let Some(text) = node.get("text").and_then(Value::as_str) {
        if !text.is_empty() {
            parts.push(text.to_string());
            return;
        }
        // An empty string is falsy in JS, so the original falls through to the
        // content check rather than emitting. Preserved deliberately.
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
        // Inline children join seamlessly — "plain ", "bold", " tail" is one
        // line, not three — and the block itself becomes one part, so blocks
        // end up newline-separated by the final join.
        parts.push(child_parts.concat());
    } else {
        parts.extend(child_parts);
    }
}
