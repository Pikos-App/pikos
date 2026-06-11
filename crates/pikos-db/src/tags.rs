use crate::error::AppResult;

/// Tag names whose prefix matches `query` (case-insensitive), up to 20 — for
/// autocomplete. Pool-based mirror of the desktop app's `search_tags` command.
pub async fn search_tags(pool: &sqlx::SqlitePool, query: &str) -> AppResult<Vec<String>> {
    let pattern = format!("{}%", query.to_lowercase());
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM tags WHERE lower(name) LIKE ? ORDER BY name ASC LIMIT 20",
    )
    .bind(&pattern)
    .fetch_all(pool)
    .await?;
    Ok(names)
}

#[cfg(test)]
#[path = "tags_tests.rs"]
mod tags_tests;
