//! A page body's chunks in `page_chunks`, written by triggers on `pages` from every write that sets
//! `content`, in the same transaction. `content` stays the source of truth: the chunks are derived
//! from it, never the other way round.
//!
//! A trigger can't keep a value between its statements, so one call works out every row write and
//! the trigger applies them as one upsert: a chunk whose bytes and place are unchanged gets no
//! write, and a chunk that has gone is marked with [`GONE`] for the trigger's second statement to
//! delete.
//!
//! `ord` places chunks with gaps of [`ORD_SPACING`], so a chunk added mid-page takes a number
//! between its neighbours and every chunk after it keeps its row. Only when a gap runs out is the
//! page renumbered.

use pikos_core::chunks::{chunk_body, Chunk};
use serde_json::{json, Value};

/// The `ord` that marks a chunk for deletion. Every live chunk's `ord` is positive.
pub const GONE: i64 = -1;

const ORD_SPACING: i64 = 1 << 20;

/// Separates the rows of [`chunk_writes`]' `previous`, and the fields within a row. JSON never
/// holds either unescaped, so neither can occur inside a chunk's body.
const ROW: char = '\u{1e}';
const FIELD: char = '\u{1f}';

struct Stored<'a> {
    id: &'a str,
    ord: i64,
    body: &'a str,
}

/// The row writes that bring a page's chunks in line with `content`, as a JSON array of
/// `{id, ord, body}`, `body` left out where the stored bytes stand. `previous` is the page's stored
/// chunks as `id FIELD ord FIELD body`, joined by `ROW`, in any order.
pub fn chunk_writes(content: &str, previous: &str) -> String {
    let mut stored: Vec<Stored> = previous
        .split(ROW)
        .filter_map(|row| {
            let mut fields = row.splitn(3, FIELD);
            let id = fields.next()?;
            let ord = fields.next()?.parse().ok()?;
            let body = fields.next()?;
            Some(Stored { id, ord, body })
        })
        .collect();
    stored.sort_by_key(|chunk| chunk.ord);

    let previous: Vec<Chunk> = stored
        .iter()
        .map(|chunk| Chunk {
            id: chunk.id.to_string(),
            body: chunk.body.to_string(),
        })
        .collect();
    let chunks = chunk_body(content, &previous);

    let stored_of = |id: &str| stored.iter().find(|chunk| chunk.id == id);
    let ords = place(&chunks, |id| stored_of(id).map(|chunk| chunk.ord));

    let mut writes: Vec<Value> = Vec::new();
    for (chunk, ord) in chunks.iter().zip(ords) {
        let was = stored_of(&chunk.id);
        let is_same_body = was.is_some_and(|was| was.body == chunk.body);
        let is_same_place = was.is_some_and(|was| was.ord == ord);
        match (is_same_body, is_same_place) {
            (true, true) => {}
            (true, false) => writes.push(json!({ "id": chunk.id, "ord": ord })),
            (false, _) => writes.push(json!({ "id": chunk.id, "ord": ord, "body": chunk.body })),
        }
    }

    for was in &stored {
        let is_gone = !chunks.iter().any(|chunk| chunk.id == was.id);
        if is_gone {
            writes.push(json!({ "id": was.id, "ord": GONE }));
        }
    }

    Value::Array(writes).to_string()
}

/// Each chunk's `ord`: its stored one where it has one, a number in the gap between its neighbours
/// where it doesn't, and the whole page renumbered when a gap is too narrow.
fn place(chunks: &[Chunk], stored_ord: impl Fn(&str) -> Option<i64>) -> Vec<i64> {
    let known: Vec<Option<i64>> = chunks.iter().map(|chunk| stored_ord(&chunk.id)).collect();
    let mut ords = Vec::with_capacity(chunks.len());
    let mut i = 0;
    while i < chunks.len() {
        if let Some(ord) = known[i] {
            ords.push(ord);
            i += 1;
            continue;
        }

        let run_end = (i..chunks.len())
            .find(|&j| known[j].is_some())
            .unwrap_or(chunks.len());
        let low = ords.last().copied().unwrap_or(0);
        let new_count = (run_end - i) as i64;
        let high = known
            .get(run_end)
            .copied()
            .flatten()
            .unwrap_or(low + ORD_SPACING * (new_count + 1));
        let step = (high - low) / (new_count + 1);
        if step == 0 {
            return (1..=chunks.len() as i64).map(|n| n * ORD_SPACING).collect();
        }

        for n in 1..=new_count {
            ords.push(low + step * n);
        }
        i = run_end;
    }

    ords
}

#[cfg(test)]
#[path = "page_chunks_tests.rs"]
mod tests;
