//! A page body is stored only as its chunks in `page_chunks`. Every writer saves one
//! through [`write_body`] and every reader gets one through [`body_sql`].
//!
//! One SQL call, [`chunk_writes`], works out every row write and [`write_body`] applies them as one
//! upsert: a chunk whose bytes and place are unchanged gets no write, and a chunk that has gone is
//! marked with [`GONE`] for the second statement to delete. The upgrade that first chunked every
//! body ran the same call from SQL.
//!
//! `ord` places chunks with gaps of [`ORD_SPACING`], so a chunk added mid-page takes a number
//! between its neighbours and every chunk after it keeps its row. Only when a gap runs out is the
//! page renumbered.

use pikos_core::chunks::{chunk_body, has_blocks_of, join_chunks, rejoined, Chunk};
use serde_json::{json, Value};

use crate::error::AppResult;

/// The `ord` that marks a chunk for deletion. Every live chunk's `ord` is positive.
pub const GONE: i64 = -1;

const ORD_SPACING: i64 = 1 << 20;

/// Separates the rows of [`chunk_writes`]' `previous`, and the fields within a row. JSON never
/// holds either unescaped, so neither can occur inside a chunk's body.
const ROW: char = '\u{1e}';
const FIELD: char = '\u{1f}';

/// The body of a page with no chunks. A document with no blocks isn't one the editor's schema
/// allows, and the editor loads what it is given unchecked, so an empty page reads as the one empty
/// paragraph every editor opens a new page with.
pub const EMPTY_BODY: &str = r#"{"type":"doc","content":[{"type":"paragraph"}]}"#;

/// The SQL for the body of the page whose id is `id_column`, rebuilt from its chunks by
/// [`joined_body`].
pub fn body_sql(id_column: &str) -> String {
    format!(
        "pikos_join_chunks((SELECT group_concat(page_chunks.body, char(30) ORDER BY page_chunks.ord) \
         FROM page_chunks WHERE page_chunks.page_id = {id_column}))"
    )
}

/// The document whose blocks are `bodies`', a page's chunk bodies in order joined by `ROW`.
pub fn joined_body(bodies: &str) -> String {
    if bodies.is_empty() {
        return EMPTY_BODY.to_string();
    }

    join_chunks(bodies.split(ROW))
}

/// Saves `content` as page `page_id`'s body, writing only the chunks that changed, and true when
/// one did. A change bumps the page's `body_rev`, which is what sync's capture watches: a body
/// isn't a column of the row, so a trigger on `pages` can't see it change.
///
/// An empty body in a row write means the stored bytes stand: no chunk's body is ever empty.
pub async fn write_body<'a>(
    db: impl sqlx::Acquire<'a, Database = sqlx::Sqlite>,
    page_id: &str,
    content: &str,
) -> AppResult<bool> {
    let mut tx = db.begin().await?;

    let rows = stored_rows_sql("?2");
    // sql-ok: stored_rows_sql is built from a compile-time constant
    let written = sqlx::query(&format!(
        "INSERT INTO page_chunks (page_id, chunk_id, ord, body)
           SELECT ?2, w.value ->> 'id', w.value ->> 'ord', COALESCE(w.value ->> 'body', '')
           FROM json_each(pikos_chunk_writes(?1, {rows})) AS w
           WHERE true
         ON CONFLICT (page_id, chunk_id) DO UPDATE
           SET ord = excluded.ord, body = iif(excluded.body = '', body, excluded.body)"
    ))
    .bind(content)
    .bind(page_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    sqlx::query("DELETE FROM page_chunks WHERE page_id = ? AND ord = ?")
        .bind(page_id)
        .bind(GONE)
        .execute(&mut *tx)
        .await?;

    let is_changed = written > 0;
    if is_changed {
        sqlx::query("UPDATE pages SET body_rev = body_rev + 1 WHERE id = ?")
            .bind(page_id)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;
    Ok(is_changed)
}

/// The SQL for the stored chunks of the page whose id is `id_column`, as `id FIELD ord FIELD body`
/// joined by `ROW`, the form [`chunk_writes`] reads.
fn stored_rows_sql(id_column: &str) -> String {
    format!(
        "(SELECT group_concat(chunk_id || char(31) || ord || char(31) || body, char(30)) \
         FROM page_chunks WHERE page_id = {id_column})"
    )
}

/// A page's chunks as one read found them, and the `body_rev` they were read at. A write guarded
/// on that `body_rev` lands only if no chunk has changed since, which is how a save typed over this
/// body is told from one typed over an older one without rejoining the page.
pub struct StoredBody {
    pub rev: i64,
    chunks: Vec<Chunk>,
}

impl StoredBody {
    /// Whether `content` is this body, block for block.
    pub fn holds(&self, content: &str) -> bool {
        match self.chunks.as_slice() {
            [] => has_blocks_of(content, &chunk_body(EMPTY_BODY, &[])),
            chunks => has_blocks_of(content, chunks),
        }
    }

    /// The body every reader gets.
    pub fn joined(&self) -> String {
        match self.chunks.as_slice() {
            [] => EMPTY_BODY.to_string(),
            chunks => join_chunks(chunks.iter().map(|chunk| chunk.body.as_str())),
        }
    }
}

/// Page `page_id`'s chunks and `body_rev`, read together. None when there is no such page.
pub async fn stored_body(pool: &sqlx::SqlitePool, page_id: &str) -> AppResult<Option<StoredBody>> {
    let rows = stored_rows_sql("pages.id");
    // sql-ok: stored_rows_sql is built from a compile-time constant
    let sql = format!("SELECT body_rev, {rows} FROM pages WHERE id = ?");
    let row: Option<(i64, Option<String>)> = sqlx::query_as(&sql)
        .bind(page_id)
        .fetch_optional(pool)
        .await?;

    Ok(row.map(|(rev, rows)| StoredBody {
        rev,
        chunks: stored_rows(rows.as_deref().unwrap_or_default())
            .into_iter()
            .map(|chunk| Chunk {
                id: chunk.id.to_string(),
                body: chunk.body.to_string(),
            })
            .collect(),
    }))
}

/// What a page saved as `content` reads back as, without reading it back.
pub fn stored_form(content: &str) -> String {
    rejoined(content).unwrap_or_else(|| EMPTY_BODY.to_string())
}

struct Stored<'a> {
    id: &'a str,
    ord: i64,
    body: &'a str,
}

/// `rows`, in the form [`stored_rows_sql`] reads, as chunks in page order.
fn stored_rows(rows: &str) -> Vec<Stored<'_>> {
    let mut stored: Vec<Stored> = rows
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

    stored
}

/// The row writes that bring a page's chunks in line with `content`, as a JSON array of
/// `{id, ord, body}`, `body` left out where the stored bytes stand. `previous` is the page's stored
/// chunks as `id FIELD ord FIELD body`, joined by `ROW`, in any order.
pub fn chunk_writes(content: &str, previous: &str) -> String {
    let stored = stored_rows(previous);

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
