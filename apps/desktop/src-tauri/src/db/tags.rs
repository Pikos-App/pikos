use tauri::State;

use super::DbState;

/// Returns tag names whose prefix matches `query` (case-insensitive), up to 20 results.
/// Used for autocomplete in the tag chip input.
#[tauri::command]
pub async fn search_tags(state: State<'_, DbState>, query: String) -> Result<Vec<String>, String> {
    let pool = state.get_pool().await?;
    let pattern = format!("{}%", query.to_lowercase());
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM tags WHERE lower(name) LIKE ? ORDER BY name ASC LIMIT 20",
    )
    .bind(&pattern)
    .fetch_all(&pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(names)
}
