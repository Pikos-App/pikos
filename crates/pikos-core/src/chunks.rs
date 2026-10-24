//! A page body as chunks: ordered runs of whole top-level blocks, about 16 to 32 KB each.
//!
//! A list or table is one top-level block, so it is never split; one bigger than a chunk is a
//! chunk of its own. Each block is carried as the stored JSON text, never parsed and encoded again,
//! so joining a body's chunks gives back its blocks byte for byte.
//!
//! A chunk keeps its id across edits, so a diff by id tells which chunks changed and sync can
//! resolve a conflict per chunk. Rechunking keeps every previous chunk whose blocks are unchanged
//! at the start and at the end of the page as it was, and repacks only the run between them under
//! the ids that run had. An edit to one block rewrites one chunk under its old id.
//!
//! A body that isn't a document with a block list, `''` or `'{}'`, has no chunks: both are an
//! empty page.

use std::collections::{BTreeMap, HashSet};

use serde_json::value::RawValue;

use crate::hash::fnv_hex;

/// A chunk closes once it holds this much, so a fresh chunk has room to grow before it splits.
pub const CHUNK_MIN_BYTES: usize = 16 * 1024;

/// A chunk splits rather than grow past this, unless one block is bigger on its own.
pub const CHUNK_MAX_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub id: String,
    /// The chunk's blocks, as a JSON array.
    pub body: String,
}

/// `content`'s chunks, keeping the ids of `previous`, the same page's chunks in order, wherever
/// their blocks survive.
pub fn chunk_body(content: &str, previous: &[Chunk]) -> Vec<Chunk> {
    let blocks = top_level_blocks(content);
    let previous_blocks: Vec<Vec<&str>> = previous
        .iter()
        .map(|chunk| array_items(&chunk.body))
        .collect();

    let mut start = 0;
    let mut front = 0;
    while front < previous.len() && is_run_at(&blocks, start, &previous_blocks[front]) {
        start += previous_blocks[front].len();
        front += 1;
    }

    let mut end = blocks.len();
    let mut back = previous.len();
    while back > front {
        let run = &previous_blocks[back - 1];
        let fits = end - start >= run.len();
        if !(fits && is_run_at(&blocks, end - run.len(), run)) {
            break;
        }
        end -= run.len();
        back -= 1;
    }

    // Blocks added between two kept chunks join a neighbour rather than start a chunk of their
    // own, or a page written by appending would become a chunk per paragraph.
    let is_pure_insert = front == back && start < end;
    if is_pure_insert && front > 0 {
        front -= 1;
        start -= previous_blocks[front].len();
    } else if is_pure_insert && back < previous.len() {
        end += previous_blocks[back].len();
        back += 1;
    }

    let middle = &blocks[start..end];
    let fits_one_chunk = body_of(middle).len() <= CHUNK_MAX_BYTES;
    let runs = match middle {
        [] => Vec::new(),
        _ if fits_one_chunk => vec![middle.to_vec()],
        _ => pack(middle),
    };

    let mut taken: HashSet<String> = previous.iter().map(|chunk| chunk.id.clone()).collect();
    let mut reused = previous[front..back].iter().map(|chunk| chunk.id.clone());
    let mut repacked = Vec::with_capacity(runs.len());
    for run in runs {
        let body = body_of(&run);
        let id = reused.next().unwrap_or_else(|| mint_id(&body, &taken));
        taken.insert(id.clone());
        repacked.push(Chunk { id, body });
    }

    previous[..front]
        .iter()
        .cloned()
        .chain(repacked)
        .chain(previous[back..].iter().cloned())
        .collect()
}

/// The document whose blocks are `bodies`' in order, as [`chunk_body`] split it.
pub fn join_chunks<'a>(bodies: impl IntoIterator<Item = &'a str>) -> String {
    let inners: Vec<&str> = bodies
        .into_iter()
        .filter_map(|body| body.strip_prefix('[')?.strip_suffix(']'))
        .filter(|inner| !inner.is_empty())
        .collect();

    format!(r#"{{"type":"doc","content":[{}]}}"#, inners.join(","))
}

/// Whether `content`'s blocks are `chunks`' blocks in order. A block counts as the same when it is
/// the same JSON in other bytes, since a body round-tripped through Markdown by the CLI or MCP comes
/// back with its keys reordered.
pub fn has_blocks_of(content: &str, chunks: &[Chunk]) -> bool {
    let blocks = top_level_blocks(content);
    let stored: Vec<&str> = chunks
        .iter()
        .flat_map(|chunk| array_items(&chunk.body))
        .collect();

    let is_same_count = blocks.len() == stored.len();
    is_same_count
        && blocks
            .iter()
            .zip(&stored)
            .all(|(block, was)| block == was || is_same_json(block, was))
}

/// The document `content` reads back as once its chunks are stored: its blocks and nothing else.
/// None when it has no blocks.
pub fn rejoined(content: &str) -> Option<String> {
    let blocks = top_level_blocks(content);
    if blocks.is_empty() {
        return None;
    }

    Some(join_chunks([body_of(&blocks).as_str()]))
}

fn is_same_json(a: &str, b: &str) -> bool {
    let parsed = (
        serde_json::from_str::<serde_json::Value>(a),
        serde_json::from_str::<serde_json::Value>(b),
    );
    matches!(parsed, (Ok(a), Ok(b)) if a == b)
}

fn top_level_blocks(content: &str) -> Vec<&str> {
    let Ok(fields) = serde_json::from_str::<BTreeMap<&str, &RawValue>>(content) else {
        return Vec::new();
    };

    fields
        .get("content")
        .map(|raw| array_items(raw.get()))
        .unwrap_or_default()
}

fn array_items(array: &str) -> Vec<&str> {
    serde_json::from_str::<Vec<&RawValue>>(array)
        .map(|items| items.into_iter().map(RawValue::get).collect())
        .unwrap_or_default()
}

fn is_run_at(blocks: &[&str], at: usize, run: &[&str]) -> bool {
    blocks.get(at..at + run.len()) == Some(run)
}

fn body_of(blocks: &[&str]) -> String {
    format!("[{}]", blocks.join(","))
}

/// Greedy runs of at least [`CHUNK_MIN_BYTES`], none past [`CHUNK_MAX_BYTES`] but a lone block. A
/// short last run joins the one before when the two fit, so a split doesn't leave a sliver.
fn pack<'a>(blocks: &[&'a str]) -> Vec<Vec<&'a str>> {
    let mut runs: Vec<Vec<&str>> = Vec::new();
    let mut run: Vec<&str> = Vec::new();
    let mut bytes = 0;
    for block in blocks {
        let is_full = bytes >= CHUNK_MIN_BYTES || bytes + block.len() > CHUNK_MAX_BYTES;
        if !run.is_empty() && is_full {
            runs.push(std::mem::take(&mut run));
            bytes = 0;
        }
        bytes += block.len() + 1;
        run.push(block);
    }

    let joins_previous = runs
        .last()
        .is_some_and(|last| body_of(last).len() + bytes <= CHUNK_MAX_BYTES);
    match runs.last_mut() {
        Some(last) if joins_previous => last.extend(run),
        _ if !run.is_empty() => runs.push(run),
        _ => {}
    }

    runs
}

/// An id from the chunk's first body, so two devices chunking the same page agree on it.
fn mint_id(body: &str, taken: &HashSet<String>) -> String {
    let mut id = fnv_hex(body);
    let mut salt = 0;
    while taken.contains(&id) {
        salt += 1;
        id = fnv_hex(&format!("{body}#{salt}"));
    }

    id
}

#[cfg(test)]
#[path = "chunks_tests.rs"]
mod tests;
