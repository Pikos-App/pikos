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
    duration_mins: Option<i64>,
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
    pub duration_minutes: Option<i64>,
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
            duration_minutes: row.duration_mins,
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
    duration_mins: Option<i64>,
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
    pub duration_minutes: Option<i64>,
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
            duration_minutes: row.duration_mins,
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
     scheduled_start, scheduled_end, completed_at, duration_mins, links, \
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
    pub duration_minutes: Option<i64>,
    #[serde(default)]
    pub links: Vec<String>,
    pub parent_id: Option<String>,
    pub last_opened_at: Option<String>,
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
    #[serde(default, deserialize_with = "deserialize_nullable")]
    pub duration_minutes: Option<serde_json::Value>,
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
    let sort_order = next_sort_order(&pool, data.folder_id.as_deref()).await;
    let tags_json = serde_json::to_string(&data.tags).unwrap_or_else(|_| "[]".to_string());
    let links_json = serde_json::to_string(&data.links).unwrap_or_else(|_| "[]".to_string());

    sqlx::query(
        "INSERT INTO pages (id, folder_id, title, subtitle, content, content_text, status,
         priority, tags, sort_order, scheduled_start, scheduled_end, completed_at,
         duration_mins, links, parent_id, last_opened_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&data.folder_id)
    .bind(&data.title)
    .bind(&data.subtitle)
    .bind(&data.content)
    .bind(&data.content_text)
    .bind(&data.status)
    .bind(data.priority)
    .bind(&tags_json)
    .bind(sort_order)
    .bind(&data.scheduled_start)
    .bind(&data.scheduled_end)
    .bind(&data.completed_at)
    .bind(data.duration_minutes)
    .bind(&links_json)
    .bind(&data.parent_id)
    .bind(&data.last_opened_at)
    .bind(&now)
    .bind(&now)
    .execute(&pool)
    .await
    .map_err(|e| e.to_string())?;

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
    if let Some(v) = updates.tags {
        let json = serde_json::to_string(&v).unwrap_or_else(|_| "[]".to_string());
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

    // Nullable integer field
    if let Some(val) = updates.duration_minutes {
        sep.push("duration_mins = ");
        match val {
            serde_json::Value::Null => sep.push_bind_unseparated(None::<i64>),
            serde_json::Value::Number(n) => sep.push_bind_unseparated(n.as_i64()),
            _ => sep.push_bind_unseparated(None::<i64>),
        };
        has_updates = true;
    }

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
pub async fn list_pages(
    state: State<'_, DbState>,
    filter: Option<PageFilter>,
) -> Result<Vec<PageSummary>, String> {
    let pool = state.get_pool().await?;

    let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new(format!(
        "SELECT {SUMMARY_COLUMNS} FROM pages WHERE 1=1"
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
         WHERE date(page_schedules.scheduled_start) <= date('now')
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
