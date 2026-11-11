//! Links between pages inside a Tiptap document.
//!
//! A `pageLink` node holds the target's id, which is what makes a link survive a
//! rename, and the target's title when the link was made. Markdown has no id, so
//! there a link is `[[title]]`: the export writes the target's current title, and
//! a write from the CLI or MCP turns `[[title]]` back into a link by looking the
//! title up.

use serde_json::{json, Map, Value};

/// The title a link node carries, empty when it has none.
pub fn link_title(node: &Value) -> &str {
    node.get("attrs")
        .and_then(|a| a.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn link_target(node: &Value) -> Option<&str> {
    let is_link = node.get("type").and_then(Value::as_str) == Some("pageLink");
    if !is_link {
        return None;
    }

    node.get("attrs")
        .and_then(|a| a.get("pageId"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
}

/// The ids of the pages a document links to, each once, in the order they first appear.
pub fn link_targets(doc: &Value) -> Vec<String> {
    let mut targets: Vec<String> = Vec::new();
    visit(doc, &mut |node| {
        if let Some(id) = link_target(node) {
            if !targets.iter().any(|t| t == id) {
                targets.push(id.to_string());
            }
        }
    });
    targets
}

fn visit(node: &Value, f: &mut impl FnMut(&Value)) {
    f(node);
    if let Some(children) = node.get("content").and_then(Value::as_array) {
        for child in children {
            visit(child, f);
        }
    }
}

/// The titles written as `[[title]]` in the document's text, outside code, each once.
pub fn wikilink_titles(doc: &Value) -> Vec<String> {
    let mut titles: Vec<String> = Vec::new();
    let mut probe = doc.clone();
    resolve_wikilinks(&mut probe, &mut |title| {
        if !titles.iter().any(|t| t == title) {
            titles.push(title.to_string());
        }
        None
    });
    titles
}

/// Rewrite every link's stored title to the target's current one, where `title_of` knows it.
pub fn refresh_link_titles(doc: &mut Value, title_of: &impl Fn(&str) -> Option<String>) {
    let current = link_target(doc).and_then(title_of);
    if let (Some(title), Some(attrs)) = (current, doc.get_mut("attrs")) {
        attrs["title"] = Value::String(title);
    }

    if let Some(children) = doc.get_mut("content").and_then(Value::as_array_mut) {
        for child in children {
            refresh_link_titles(child, title_of);
        }
    }
}

/// Turn each `[[title]]` in the document's text into a link to the page `resolve` names.
/// A title it can't place stays as text, and so does anything inside code.
pub fn resolve_wikilinks(doc: &mut Value, resolve: &mut impl FnMut(&str) -> Option<String>) {
    let is_code_block = doc.get("type").and_then(Value::as_str) == Some("codeBlock");
    if is_code_block {
        return;
    }

    let Some(children) = doc.get_mut("content").and_then(Value::as_array_mut) else {
        return;
    };

    let mut rebuilt: Vec<Value> = Vec::with_capacity(children.len());
    for mut child in children.drain(..) {
        if is_plain_text(&child) {
            rebuilt.extend(split_text(&child, resolve));
        } else {
            resolve_wikilinks(&mut child, resolve);
            rebuilt.push(child);
        }
    }
    *children = rebuilt;
}

fn is_plain_text(node: &Value) -> bool {
    let is_text = node.get("type").and_then(Value::as_str) == Some("text");
    let is_code = node
        .get("marks")
        .and_then(Value::as_array)
        .is_some_and(|marks| {
            marks
                .iter()
                .any(|m| m.get("type").and_then(Value::as_str) == Some("code"))
        });
    is_text && !is_code
}

fn split_text(node: &Value, resolve: &mut impl FnMut(&str) -> Option<String>) -> Vec<Value> {
    let text = node.get("text").and_then(Value::as_str).unwrap_or("");
    let mut pieces: Vec<Value> = Vec::new();
    let mut pending = String::new();
    let mut rest = text;

    while let Some(open) = rest.find("[[") {
        let after = &rest[open + 2..];
        let Some(close) = after.find("]]") else {
            break;
        };

        let title = after[..close].trim();
        let is_plain_title = !title.is_empty() && !title.contains(['[', ']', '|']);
        let target = if is_plain_title { resolve(title) } else { None };
        match target {
            Some(id) => {
                pending.push_str(&rest[..open]);
                if !pending.is_empty() {
                    pieces.push(text_like(node, std::mem::take(&mut pending)));
                }
                pieces.push(json!({
                    "type": "pageLink",
                    "attrs": { "pageId": id, "title": title },
                }));
                rest = &after[close + 2..];
            }
            None => {
                pending.push_str(&rest[..open + 2]);
                rest = after;
            }
        }
    }

    pending.push_str(rest);
    let is_unchanged = pieces.is_empty();
    if is_unchanged {
        return vec![node.clone()];
    }

    if !pending.is_empty() {
        pieces.push(text_like(node, pending));
    }

    pieces
}

/// A text node with `text`, carrying the marks of the node it was cut from.
fn text_like(node: &Value, text: String) -> Value {
    let mut out = Map::new();
    out.insert("type".into(), Value::String("text".into()));
    out.insert("text".into(), Value::String(text));
    if let Some(marks) = node.get("marks") {
        out.insert("marks".into(), marks.clone());
    }
    Value::Object(out)
}

#[cfg(test)]
#[path = "page_links_tests.rs"]
mod tests;
