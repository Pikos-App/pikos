//! Editing one section of a page body, the blocks under a heading, without touching the rest.
//!
//! A section runs from its heading to the next heading of the same or a higher level. Every block
//! outside the edit is carried over as the stored JSON text, never parsed and encoded again, so the
//! edit changes only the bytes it meant to and anything an encoder round trip could reshape stays as
//! the editor wrote it.

use std::collections::BTreeMap;

use serde_json::value::RawValue;
use serde_json::Value;

use crate::text::extract_text_value;

/// Where an edit lands. A heading is named by its text, matched ignoring case and any leading `#`s,
/// so a heading copied out of the page's markdown matches too.
#[derive(Debug, Clone, PartialEq)]
pub enum SectionEdit {
    /// After the page's last block.
    Append,
    /// After the last block of the heading's section.
    AppendTo(String),
    /// Straight after the heading.
    InsertAfter(String),
    /// In place of everything in the heading's section but the heading.
    Replace(String),
}

/// Why an edit could not be placed, worded for whoever asked for it.
#[derive(Debug, PartialEq)]
pub struct Unplaced(pub String);

struct Section {
    heading: usize,
    end: usize,
}

pub fn edit_section(
    stored: &str,
    edit: &SectionEdit,
    blocks: &[Value],
) -> Result<String, Unplaced> {
    let not_a_document = |_| Unplaced("the page's body is not a document".to_string());
    let fields: BTreeMap<String, &RawValue> =
        serde_json::from_str(stored).map_err(not_a_document)?;
    let stored_blocks: Vec<&RawValue> = match fields.get("content") {
        Some(raw) => serde_json::from_str(raw.get()).map_err(not_a_document)?,
        None => Vec::new(),
    };
    let parsed: Vec<Value> = stored_blocks
        .iter()
        .map(|block| serde_json::from_str(block.get()))
        .collect::<Result<_, _>>()
        .map_err(not_a_document)?;

    let (from, to) = match edit {
        SectionEdit::Append => (parsed.len(), parsed.len()),
        SectionEdit::AppendTo(name) => {
            let section = find_section(&parsed, name)?;
            (section.end, section.end)
        }
        SectionEdit::InsertAfter(name) => {
            let section = find_section(&parsed, name)?;
            (section.heading + 1, section.heading + 1)
        }
        SectionEdit::Replace(name) => {
            let section = find_section(&parsed, name)?;
            (section.heading + 1, section.end)
        }
    };

    let inserted: Vec<String> = blocks.iter().map(Value::to_string).collect();
    let content = stored_blocks[..from]
        .iter()
        .map(|block| block.get())
        .chain(inserted.iter().map(String::as_str))
        .chain(stored_blocks[to..].iter().map(|block| block.get()))
        .collect::<Vec<_>>()
        .join(",");

    let mut members: Vec<String> = fields
        .iter()
        .filter(|(key, _)| key.as_str() != "content")
        .map(|(key, raw)| format!("{}:{}", Value::from(key.as_str()), raw.get()))
        .collect();
    members.push(format!("\"content\":[{content}]"));

    Ok(format!("{{{}}}", members.join(",")))
}

fn heading_level(block: &Value) -> Option<u64> {
    let is_heading = block.get("type").and_then(Value::as_str) == Some("heading");

    is_heading.then(|| block["attrs"]["level"].as_u64().unwrap_or(1))
}

fn heading_key(text: &str) -> String {
    text.trim().trim_start_matches('#').trim().to_lowercase()
}

fn as_markdown(blocks: &[Value], at: usize, level: u64) -> String {
    format!(
        "\"{} {}\"",
        "#".repeat(level as usize),
        extract_text_value(&blocks[at])
    )
}

fn find_section(blocks: &[Value], name: &str) -> Result<Section, Unplaced> {
    let headings: Vec<(usize, u64)> = blocks
        .iter()
        .enumerate()
        .filter_map(|(i, block)| heading_level(block).map(|level| (i, level)))
        .collect();
    let wanted = heading_key(name);
    let matches: Vec<(usize, u64)> = headings
        .iter()
        .copied()
        .filter(|&(i, _)| heading_key(&extract_text_value(&blocks[i])) == wanted)
        .collect();

    match matches.as_slice() {
        [] if headings.is_empty() => Err(Unplaced(format!(
            "no heading \"{name}\": the page has no headings"
        ))),
        [] => {
            let all: Vec<String> = headings
                .iter()
                .map(|&(i, level)| as_markdown(blocks, i, level))
                .collect();
            Err(Unplaced(format!(
                "no heading \"{name}\"; the page's headings are {}",
                all.join(", ")
            )))
        }
        &[(heading, level)] => {
            let end = headings
                .iter()
                .find(|&&(i, l)| i > heading && l <= level)
                .map_or(blocks.len(), |&(i, _)| i);
            Ok(Section { heading, end })
        }
        many => {
            let positions: Vec<String> = many
                .iter()
                .map(|&(i, level)| {
                    let nth = headings.iter().position(|&(j, _)| j == i).unwrap_or(0) + 1;
                    format!("{} (heading {nth})", as_markdown(blocks, i, level))
                })
                .collect();
            Err(Unplaced(format!(
                "\"{name}\" matches {} headings: {}; rename one, or replace the whole body",
                many.len(),
                positions.join(", ")
            )))
        }
    }
}

#[cfg(test)]
#[path = "body_section_tests.rs"]
mod tests;
