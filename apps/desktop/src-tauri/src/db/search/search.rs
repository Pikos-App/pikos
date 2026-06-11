//! Thin Tauri command wrappers over the shared pikos-db writer.
use tauri::State;

use pikos_db::*;

use super::DbState;

#[tauri::command]
pub async fn search_pages(
    state: State<'_, DbState>,
    query: String,
    include_completed: Option<bool>,
) -> AppResult<SearchResponse> {
    let pool = state.get_pool().await?;
    search_pages_impl(&pool, query, include_completed).await
}
