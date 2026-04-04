use serde::{Deserialize, Deserializer, Serialize};
use tauri::State;

use super::{now_iso, DbState};

/// Deserializes a field that may be missing OR explicitly null.
/// - Missing field → `None` (via `#[serde(default)]` on the struct)
/// - Explicit `null` → `Some(Value::Null)`
/// - Any other value → `Some(value)`
fn deserialize_nullable<'de, D>(deserializer: D) -> Result<Option<serde_json::Value>, D::Error>
where
    D: Deserializer<'de>,
{
    serde_json::Value::deserialize(deserializer).map(Some)
}

// ─── DB row (snake_case matches column names) ─────────────────────────────────

#[derive(sqlx::FromRow)]
struct PageRow {
    id: String,
    folder_id: Option<String>,
    title: String,
    subtitle: Option<String>,
    content: String,
    content_text: Option<String>,
    status: String,
    priority: i64,
    tags: String, // JSON array
    sort_order: i64,
    scheduled_start: Option<String>,
    scheduled_end: Option<String>,
    completed_at: Option<String>,
    links: Option<String>, // JSON array
    parent_id: Option<String>,
    last_opened_at: Option<String>,
    created_at: String,
    updated_at: String,
}

// ─── Output type (camelCase for TypeScript) ───────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub id: String,
    pub folder_id: Option<String>,
    pub title: String,
    pub subtitle: Option<String>,
    pub content: String,
    pub content_text: Option<String>,
    pub status: String,
    pub priority: i64,
    pub tags: Vec<String>,
    pub sort_order: i64,
    pub scheduled_start: Option<String>,
    pub scheduled_end: Option<String>,
    pub completed_at: Option<String>,
    pub links: Vec<String>,
    pub parent_id: Option<String>,
    pub last_opened_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl From<PageRow> for Page {
    fn from(row: PageRow) -> Self {
        let tags: Vec<String> = serde_json::from_str(&row.tags).unwrap_or_default();
        let links: Vec<String> = row
            .links
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();
        Page {
            id: row.id,
            folder_id: row.folder_id,
            title: row.title,
            subtitle: row.subtitle,
            content: row.content,
            content_text: row.content_text,
            status: row.status,
            priority: row.priority,
            tags,
            sort_order: row.sort_order,
            scheduled_start: row.scheduled_start,
            scheduled_end: row.scheduled_end,
            completed_at: row.completed_at,
            links,
            parent_id: row.parent_id,
            last_opened_at: row.last_opened_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

// ─── Summary row (no content/content_text — for list views) ──────────────

#[derive(sqlx::FromRow)]
struct PageSummaryRow {
    id: String,
    folder_id: Option<String>,
    title: String,
    subtitle: Option<String>,
    status: String,
    priority: i64,
    tags: String,
    sort_order: i64,
    scheduled_start: Option<String>,
    scheduled_end: Option<String>,
    completed_at: Option<String>,
    links: Option<String>,
    parent_id: Option<String>,
    last_opened_at: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSummary {
    pub id: String,
    pub folder_id: Option<String>,
    pub title: String,
    pub subtitle: Option<String>,
    pub status: String,
    pub priority: i64,
    pub tags: Vec<String>,
    pub sort_order: i64,
    pub scheduled_start: Option<String>,
    pub scheduled_end: Option<String>,
    pub completed_at: Option<String>,
    pub links: Vec<String>,
    pub parent_id: Option<String>,
    pub last_opened_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl From<PageSummaryRow> for PageSummary {
    fn from(row: PageSummaryRow) -> Self {
        let tags: Vec<String> = serde_json::from_str(&row.tags).unwrap_or_default();
        let links: Vec<String> = row
            .links
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();
        PageSummary {
            id: row.id,
            folder_id: row.folder_id,
            title: row.title,
            subtitle: row.subtitle,
            status: row.status,
            priority: row.priority,
            tags,
            sort_order: row.sort_order,
            scheduled_start: row.scheduled_start,
            scheduled_end: row.scheduled_end,
            completed_at: row.completed_at,
            links,
            parent_id: row.parent_id,
            last_opened_at: row.last_opened_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

const SUMMARY_COLUMNS: &str =
    "id, folder_id, title, subtitle, status, priority, tags, sort_order, \
     scheduled_start, scheduled_end, completed_at, links, \
     parent_id, last_opened_at, created_at, updated_at";

// ─── Input types ──────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPage {
    pub folder_id: Option<String>,
    pub title: String,
    pub subtitle: Option<String>,
    pub content: String,
    pub content_text: Option<String>,
    pub status: String,
    pub priority: i64,
    #[serde(default)]
    pub tags: Vec<String>,
    pub scheduled_start: Option<String>,
    pub scheduled_end: Option<String>,
    pub completed_at: Option<String>,
    #[serde(default)]
    pub links: Vec<String>,
    pub parent_id: Option<String>,
    pub last_opened_at: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

/// All fields optional. Use `serde_json::Value` for fields that can be explicitly set to null.
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PageUpdate {
    #[serde(default, deserialize_with = "deserialize_nullable")]
    pub folder_id: Option<serde_json::Value>,
    pub title: Option<String>,
    #[serde(default, deserialize_with = "deserialize_nullable")]
    pub subtitle: Option<serde_json::Value>,
    pub content: Option<String>,
    pub content_text: Option<String>,
    pub status: Option<String>,
    pub priority: Option<i64>,
    pub tags: Option<Vec<String>>,
    pub sort_order: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_nullable")]
    pub scheduled_start: Option<serde_json::Value>,
    #[serde(default, deserialize_with = "deserialize_nullable")]
    pub scheduled_end: Option<serde_json::Value>,
    #[serde(default, deserialize_with = "deserialize_nullable")]
    pub completed_at: Option<serde_json::Value>,
    pub links: Option<Vec<String>>,
    #[serde(default, deserialize_with = "deserialize_nullable")]
    pub parent_id: Option<serde_json::Value>,
    #[serde(default, deserialize_with = "deserialize_nullable")]
    pub last_opened_at: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PageFilter {
    /// None = no folder filter; Value::Null = inbox (folder_id IS NULL); Value::String = specific folder
    pub folder_id: Option<serde_json::Value>,
    pub status: Option<String>,
    pub priority: Option<i64>,
    pub tags: Option<Vec<String>>,
    pub query: Option<String>,
    pub scheduled_after: Option<String>,
    pub scheduled_before: Option<String>,
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/// Synchronise the normalised tag tables for a single page.
///
/// 1. Deletes existing `page_tags` rows for the page.
/// 2. Upserts each tag into `tags` (INSERT OR IGNORE keeps the existing id on conflict).
/// 3. Re-inserts `page_tags` rows by joining on the tag name.
///
/// `pages.tags` JSON is NOT updated here — callers are responsible for keeping the
/// denorm column in sync when they write the page row.
async fn upsert_page_tags(pool: &sqlx::SqlitePool, page_id: &str, tags: &[String]) -> Result<(), String> {
    sqlx::query("DELETE FROM page_tags WHERE page_id = ?")
        .bind(page_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    for tag in tags {
        if tag.is_empty() {
            continue;
        }
        // Use a compact hex ID generated by SQLite so we don't need uuid here.
        sqlx::query(
            "INSERT OR IGNORE INTO tags (id, name) VALUES (lower(hex(randomblob(8))), ?)",
        )
        .bind(tag)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

        sqlx::query(
            "INSERT OR IGNORE INTO page_tags (page_id, tag_id) \
             SELECT ?, id FROM tags WHERE name = ?",
        )
        .bind(page_id)
        .bind(tag)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

async fn fetch_page(pool: &sqlx::SqlitePool, id: &str) -> Result<Page, String> {
    sqlx::query_as::<_, PageRow>("SELECT * FROM pages WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Page not found: {id}"))
        .map(Page::from)
}

async fn next_sort_order(pool: &sqlx::SqlitePool, folder_id: Option<&str>) -> i64 {
    let result: Result<i64, _> = match folder_id {
        Some(fid) => {
            sqlx::query_scalar(
                "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM pages WHERE folder_id = ?",
            )
            .bind(fid)
            .fetch_one(pool)
            .await
        }
        None => {
            sqlx::query_scalar(
                "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM pages WHERE folder_id IS NULL",
            )
            .fetch_one(pool)
            .await
        }
    };
    result.unwrap_or(0)
}

// ─── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_page(state: State<'_, DbState>, id: String) -> Result<Option<Page>, String> {
    let pool = state.get_pool().await?;
    let row = sqlx::query_as::<_, PageRow>("SELECT * FROM pages WHERE id = ?")
        .bind(&id)
        .fetch_optional(&pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.map(Page::from))
}

#[tauri::command]
pub async fn create_page(state: State<'_, DbState>, data: NewPage) -> Result<Page, String> {
    let pool = state.get_pool().await?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    let created_at = data.created_at.as_deref().unwrap_or(&now);
    let updated_at = data.updated_at.as_deref().unwrap_or(&now);
    let sort_order = next_sort_order(&pool, data.folder_id.as_deref()).await;
    let tags_json = serde_json::to_string(&data.tags).unwrap_or_else(|_| "[]".to_string());
    let links_json = serde_json::to_string(&data.links).unwrap_or_else(|_| "[]".to_string());

    sqlx::query(
        "INSERT INTO pages (id, folder_id, title, subtitle, content, content_text, status,
         priority, tags, sort_order, scheduled_start, scheduled_end, completed_at,
         links, parent_id, last_opened_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&data.folder_id)
    .bind(&data.title)
    .bind(&data.subtitle)
    .bind(&data.content)
    .bind(data.content_text.as_deref().unwrap_or(""))
    .bind(&data.status)
    .bind(data.priority)
    .bind(&tags_json)
    .bind(sort_order)
    .bind(&data.scheduled_start)
    .bind(&data.scheduled_end)
    .bind(&data.completed_at)
    .bind(&links_json)
    .bind(&data.parent_id)
    .bind(&data.last_opened_at)
    .bind(created_at)
    .bind(updated_at)
    .execute(&pool)
    .await
    .map_err(|e| e.to_string())?;

    upsert_page_tags(&pool, &id, &data.tags).await?;

    fetch_page(&pool, &id).await
}

#[tauri::command]
pub async fn update_page(
    state: State<'_, DbState>,
    id: String,
    updates: PageUpdate,
) -> Result<Page, String> {
    let pool = state.get_pool().await?;

    let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new("UPDATE pages SET ");
    let mut sep = builder.separated(", ");
    let mut has_updates = false;

    // Non-nullable string fields
    if let Some(v) = updates.title {
        sep.push("title = ");
        sep.push_bind_unseparated(v);
        has_updates = true;
    }
    if let Some(v) = updates.content {
        sep.push("content = ");
        sep.push_bind_unseparated(v);
        has_updates = true;
    }
    if let Some(v) = updates.content_text {
        sep.push("content_text = ");
        sep.push_bind_unseparated(v);
        has_updates = true;
    }
    if let Some(v) = updates.status {
        sep.push("status = ");
        sep.push_bind_unseparated(v);
        has_updates = true;
    }
    if let Some(v) = updates.priority {
        sep.push("priority = ");
        sep.push_bind_unseparated(v);
        has_updates = true;
    }
    if let Some(v) = updates.sort_order {
        sep.push("sort_order = ");
        sep.push_bind_unseparated(v);
        has_updates = true;
    }
    let updated_tags = updates.tags.as_deref().map(|t| t.to_vec());
    if let Some(ref v) = updates.tags {
        let json = serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string());
        sep.push("tags = ");
        sep.push_bind_unseparated(json);
        has_updates = true;
    }
    if let Some(v) = updates.links {
        let json = serde_json::to_string(&v).unwrap_or_else(|_| "[]".to_string());
        sep.push("links = ");
        sep.push_bind_unseparated(json);
        has_updates = true;
    }

    // Nullable string fields (Value::Null sets to NULL, Value::String sets to value)
    macro_rules! push_nullable_str {
        ($field:expr, $col:literal) => {
            if let Some(val) = $field {
                sep.push(concat!($col, " = "));
                match val {
                    serde_json::Value::Null => sep.push_bind_unseparated(None::<String>),
                    serde_json::Value::String(s) => sep.push_bind_unseparated(s),
                    _ => sep.push_bind_unseparated(None::<String>),
                };
                has_updates = true;
            }
        };
    }

    push_nullable_str!(updates.folder_id, "folder_id");
    push_nullable_str!(updates.subtitle, "subtitle");
    push_nullable_str!(updates.scheduled_start, "scheduled_start");
    push_nullable_str!(updates.scheduled_end, "scheduled_end");
    push_nullable_str!(updates.completed_at, "completed_at");
    push_nullable_str!(updates.parent_id, "parent_id");
    push_nullable_str!(updates.last_opened_at, "last_opened_at");

    if !has_updates {
        return fetch_page(&pool, &id).await;
    }

    sep.push("updated_at = ");
    sep.push_bind_unseparated(now_iso());
    drop(sep);

    builder.push(" WHERE id = ");
    builder.push_bind(&id);

    builder
        .build()
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

    if let Some(tags) = updated_tags {
        upsert_page_tags(&pool, &id, &tags).await?;
    }

    fetch_page(&pool, &id).await
}

#[tauri::command]
pub async fn delete_page(state: State<'_, DbState>, id: String) -> Result<(), String> {
    let pool = state.get_pool().await?;
    sqlx::query("DELETE FROM pages WHERE id = ?")
        .bind(&id)
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn soft_delete_page(state: State<'_, DbState>, id: String) -> Result<(), String> {
    let pool = state.get_pool().await?;
    sqlx::query("UPDATE pages SET deleted_at = ?, updated_at = ? WHERE id = ?")
        .bind(now_iso())
        .bind(now_iso())
        .bind(&id)
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn restore_page(state: State<'_, DbState>, id: String) -> Result<(), String> {
    let pool = state.get_pool().await?;
    sqlx::query("UPDATE pages SET deleted_at = NULL, updated_at = ? WHERE id = ?")
        .bind(now_iso())
        .bind(&id)
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn list_pages(
    state: State<'_, DbState>,
    filter: Option<PageFilter>,
) -> Result<Vec<PageSummary>, String> {
    let pool = state.get_pool().await?;

    let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new(format!(
        "SELECT {SUMMARY_COLUMNS} FROM pages WHERE deleted_at IS NULL"
    ));

    if let Some(ref f) = filter {
        if let Some(ref folder_val) = f.folder_id {
            match folder_val {
                serde_json::Value::Null => {
                    builder.push(" AND folder_id IS NULL");
                }
                serde_json::Value::String(fid) => {
                    builder.push(" AND folder_id = ");
                    builder.push_bind(fid.clone());
                }
                _ => {}
            }
        }
        if let Some(ref status) = f.status {
            builder.push(" AND status = ");
            builder.push_bind(status.clone());
        }
        if let Some(priority) = f.priority {
            builder.push(" AND priority = ");
            builder.push_bind(priority);
        }
        if let Some(ref after) = f.scheduled_after {
            builder.push(" AND scheduled_start >= ");
            builder.push_bind(after.clone());
        }
        if let Some(ref before) = f.scheduled_before {
            builder.push(" AND scheduled_start <= ");
            builder.push_bind(before.clone());
        }
        if let Some(ref query) = f.query {
            let like = format!("%{query}%");
            builder.push(" AND (title LIKE ");
            builder.push_bind(like.clone());
            builder.push(" OR content_text LIKE ");
            builder.push_bind(like);
            builder.push(")");
        }
    }

    builder.push(" ORDER BY sort_order ASC");

    let rows = builder
        .build_query_as::<PageSummaryRow>()
        .fetch_all(&pool)
        .await
        .map_err(|e| e.to_string())?;

    let mut summaries: Vec<PageSummary> = rows.into_iter().map(PageSummary::from).collect();

    // Tags filter is post-query (JSON array in SQLite is opaque)
    if let Some(f) = &filter {
        if let Some(filter_tags) = &f.tags {
            if !filter_tags.is_empty() {
                summaries.retain(|p| filter_tags.iter().all(|t| p.tags.contains(t)));
            }
        }
    }

    Ok(summaries)
}

#[tauri::command]
pub async fn list_pages_today(state: State<'_, DbState>) -> Result<Vec<PageSummary>, String> {
    let pool = state.get_pool().await?;
    let query = format!(
        "SELECT DISTINCT {cols} FROM pages
         JOIN page_schedules ON page_schedules.page_id = pages.id
         WHERE pages.deleted_at IS NULL
           AND date(page_schedules.scheduled_start) <= date('now')
           AND pages.status != 'done'
         ORDER BY pages.sort_order ASC",
        cols = SUMMARY_COLUMNS
            .split(", ")
            .map(|c| format!("pages.{c}"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let rows = sqlx::query_as::<_, PageSummaryRow>(&query)
        .fetch_all(&pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(PageSummary::from).collect())
}

#[tauri::command]
pub async fn reorder_pages(
    state: State<'_, DbState>,
    folder_id: Option<String>,
    ordered_ids: Vec<String>,
) -> Result<(), String> {
    let pool = state.get_pool().await?;
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    let now = now_iso();
    for (i, id) in ordered_ids.iter().enumerate() {
        match &folder_id {
            Some(fid) => {
                sqlx::query(
                    "UPDATE pages SET sort_order = ?, updated_at = ? WHERE id = ? AND folder_id = ?",
                )
                .bind(i as i64)
                .bind(&now)
                .bind(id)
                .bind(fid)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            }
            None => {
                sqlx::query(
                    "UPDATE pages SET sort_order = ?, updated_at = ? WHERE id = ? AND folder_id IS NULL",
                )
                .bind(i as i64)
                .bind(&now)
                .bind(id)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            }
        }
    }
    tx.commit().await.map_err(|e| e.to_string())
}

// ─── Completed pages (lazy-loaded, paginated) ────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedPagesFilter {
    pub folder_id: Option<serde_json::Value>, // null = inbox, missing = all
    pub completed_since: Option<String>,       // ISO date for "today" filter
    pub limit: i64,
    pub offset: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedPagesResponse {
    pub pages: Vec<PageSummary>,
    pub total: i64,
}

#[tauri::command]
pub async fn list_completed_pages(
    state: State<'_, DbState>,
    filter: CompletedPagesFilter,
) -> Result<CompletedPagesResponse, String> {
    let pool = state.get_pool().await?;

    // Build the WHERE clause shared by both count and data queries
    let mut where_parts: Vec<String> = vec![
        "deleted_at IS NULL".to_string(),
        "status = 'done'".to_string(),
    ];
    let mut bind_values: Vec<String> = Vec::new();

    if let Some(ref folder_val) = filter.folder_id {
        match folder_val {
            serde_json::Value::Null => {
                where_parts.push("folder_id IS NULL".to_string());
            }
            serde_json::Value::String(fid) => {
                where_parts.push("folder_id = ?".to_string());
                bind_values.push(fid.clone());
            }
            _ => {}
        }
    }

    if let Some(ref since) = filter.completed_since {
        where_parts.push("date(completed_at) >= ?".to_string());
        bind_values.push(since.clone());
    }

    let where_clause = where_parts.join(" AND ");

    // Count query
    let count_sql = format!("SELECT COUNT(*) FROM pages WHERE {where_clause}");
    let mut count_query = sqlx::query_scalar::<_, i64>(&count_sql);
    for v in &bind_values {
        count_query = count_query.bind(v);
    }
    let total = count_query
        .fetch_one(&pool)
        .await
        .map_err(|e| e.to_string())?;

    // Data query
    let data_sql = format!(
        "SELECT {SUMMARY_COLUMNS} FROM pages WHERE {where_clause} \
         ORDER BY completed_at DESC LIMIT ? OFFSET ?"
    );
    let mut data_query = sqlx::query_as::<_, PageSummaryRow>(&data_sql);
    for v in &bind_values {
        data_query = data_query.bind(v);
    }
    data_query = data_query.bind(filter.limit).bind(filter.offset);

    let rows = data_query
        .fetch_all(&pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(CompletedPagesResponse {
        pages: rows.into_iter().map(PageSummary::from).collect(),
        total,
    })
}

// ─── Recurring page completion ───────────────────────────────────────────────

/// Input for the complete_recurring_page command.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteRecurringInput {
    /// The head page ID to complete.
    pub page_id: String,
    /// The next occurrence's scheduled start (ISO date or datetime).
    /// None = series is finished, mark head as done.
    pub next_scheduled_start: Option<String>,
    /// The next occurrence's scheduled end (ISO datetime), if timed.
    pub next_scheduled_end: Option<String>,
}

/// Result of completing a recurring page.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteRecurringResult {
    /// The newly created completed clone page.
    pub clone: PageSummary,
    /// The updated head page (advanced to next occurrence, or done).
    pub head: PageSummary,
}

/// Atomically completes a recurring page:
/// 1. Clones the head as a done page (snapshot of current state)
/// 2. Advances the head to the next occurrence, or marks it done if series is finished
#[tauri::command]
pub async fn complete_recurring_page(
    state: State<'_, DbState>,
    data: CompleteRecurringInput,
) -> Result<CompleteRecurringResult, String> {
    let pool = state.get_pool().await?;
    let now = now_iso();

    // 1. Fetch the head page (full content for cloning)
    let head = fetch_page(&pool, &data.page_id).await?;

    // 2. Create the completed clone
    let clone_id = uuid::Uuid::new_v4().to_string();
    let clone_sort_order = next_sort_order(&pool, head.folder_id.as_deref()).await;
    let tags_json = serde_json::to_string(&head.tags).unwrap_or_else(|_| "[]".to_string());

    sqlx::query(
        "INSERT INTO pages (id, folder_id, title, subtitle, content, content_text, status,
         priority, tags, sort_order, scheduled_start, scheduled_end, completed_at,
         links, parent_id, last_opened_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'done', ?, ?, ?, ?, ?, ?, '[]', NULL, NULL, ?, ?)",
    )
    .bind(&clone_id)
    .bind(&head.folder_id)
    .bind(&head.title)
    .bind(&head.subtitle)
    .bind(&head.content)
    .bind(head.content_text.as_deref().unwrap_or(""))
    .bind(head.priority)
    .bind(&tags_json)
    .bind(clone_sort_order)
    .bind(&head.scheduled_start) // clone gets the occurrence date being completed
    .bind(&head.scheduled_end)
    .bind(&now) // completed_at
    .bind(&now) // created_at
    .bind(&now) // updated_at
    .execute(&pool)
    .await
    .map_err(|e| format!("Failed to create completion clone: {e}"))?;

    // Sync tags for the clone
    upsert_page_tags(&pool, &clone_id, &head.tags).await?;

    // 3. Advance the head (or mark done if series finished)
    if let Some(ref next_start) = data.next_scheduled_start {
        // Series continues — advance to next occurrence
        sqlx::query(
            "UPDATE pages SET scheduled_start = ?, scheduled_end = ?, updated_at = ? WHERE id = ?",
        )
        .bind(next_start)
        .bind(&data.next_scheduled_end)
        .bind(&now)
        .bind(&data.page_id)
        .execute(&pool)
        .await
        .map_err(|e| format!("Failed to advance head: {e}"))?;
    } else {
        // Series finished — mark head as done
        sqlx::query(
            "UPDATE pages SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?",
        )
        .bind(&now)
        .bind(&now)
        .bind(&data.page_id)
        .execute(&pool)
        .await
        .map_err(|e| format!("Failed to mark head done: {e}"))?;
    }

    // 4. Fetch updated results
    let clone_row =
        sqlx::query_as::<_, PageSummaryRow>(&format!("SELECT {SUMMARY_COLUMNS} FROM pages WHERE id = ?"))
            .bind(&clone_id)
            .fetch_one(&pool)
            .await
            .map_err(|e| format!("Failed to fetch clone: {e}"))?;

    let head_row =
        sqlx::query_as::<_, PageSummaryRow>(&format!("SELECT {SUMMARY_COLUMNS} FROM pages WHERE id = ?"))
            .bind(&data.page_id)
            .fetch_one(&pool)
            .await
            .map_err(|e| format!("Failed to fetch head: {e}"))?;

    Ok(CompleteRecurringResult {
        clone: PageSummary::from(clone_row),
        head: PageSummary::from(head_row),
    })
}
