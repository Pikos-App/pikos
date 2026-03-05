use serde::Serialize;
use tauri::State;

use super::DbState;

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct SearchResult {
    pub id: String,
    pub title: String,
    pub excerpt: String,
}

#[tauri::command]
pub async fn search_pages(
    state: State<'_, DbState>,
    query: String,
) -> Result<Vec<SearchResult>, String> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    let pool = state.get_pool().await?;

    // FTS5 column indices: 0=title 1=subtitle 2=content_text 3=tags
    // snippet() uses index 2 (content_text) for the excerpt
    let rows = sqlx::query_as::<_, SearchResult>(
        "SELECT pages.id, pages.title,
           snippet(pages_fts, 2, '<mark>', '</mark>', '…', 20) AS excerpt
         FROM pages_fts
         JOIN pages ON pages.rowid = pages_fts.rowid
         WHERE pages_fts MATCH ?
         ORDER BY rank",
    )
    .bind(&query)
    .fetch_all(&pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows)
}
