use tauri::State;

use super::DbState;
use crate::error::AppResult;

#[tauri::command]
pub async fn search_tags(state: State<'_, DbState>, query: String) -> AppResult<Vec<String>> {
    let pool = state.get_pool().await?;
    pikos_db::search_tags(&pool, &query).await
}
