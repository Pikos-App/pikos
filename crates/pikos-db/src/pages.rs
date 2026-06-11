use serde::{Deserialize, Deserializer, Serialize};

use crate::error::{AppError, AppResult};
use crate::{now_iso, now_local_iso};

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

/// `serde_json::Value` fields can be explicitly set to null (vs. omitted = unchanged).
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
    /// When Some(true), restrict to rows where scheduled_start IS NOT NULL —
    /// used by the calendar to pull completed scheduled pages without also
    /// loading unscheduled completed pages.
    pub has_schedule: Option<bool>,
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/// Synchronise the normalised tag tables for a single page.
///
/// Runs against a transaction executor so callers can bundle this with the
/// matching `pages` row write — pages.tags JSON and page_tags must stay in
/// sync (FTS indexes the JSON; queries hit the join table).
async fn upsert_page_tags_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    page_id: &str,
    tags: &[String],
) -> AppResult<()> {
    sqlx::query("DELETE FROM page_tags WHERE page_id = ?")
        .bind(page_id)
        .execute(&mut **tx)
        .await?;

    // Tags are stored lowercase (see migration 009): trim + lowercase, dedupe in
    // input order. The deduped list also rewrites the pages.tags denorm so it
    // can't drift from the page_tags join.
    let mut seen = std::collections::HashSet::new();
    let mut normalized: Vec<String> = Vec::new();

    for tag in tags {
        let tag = tag.trim().to_lowercase();
        if tag.is_empty() || !seen.insert(tag.clone()) {
            continue;
        }
        let tag_id = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT OR IGNORE INTO tags (id, name) VALUES (?, ?)")
            .bind(&tag_id)
            .bind(&tag)
            .execute(&mut **tx)
            .await?;

        sqlx::query(
            "INSERT OR IGNORE INTO page_tags (page_id, tag_id) \
             SELECT ?, id FROM tags WHERE name = ?",
        )
        .bind(page_id)
        .bind(&tag)
        .execute(&mut **tx)
        .await?;

        normalized.push(tag);
    }

    // Keep the denorm lowercase + deduped so the UI (which renders pages.tags,
    // not the join) never shows case/whitespace duplicates of one tag.
    let tags_json = serde_json::to_string(&normalized).unwrap_or_else(|_| "[]".to_string());
    sqlx::query("UPDATE pages SET tags = ? WHERE id = ?")
        .bind(&tags_json)
        .bind(page_id)
        .execute(&mut **tx)
        .await?;

    Ok(())
}

async fn fetch_page(pool: &sqlx::SqlitePool, id: &str) -> AppResult<Page> {
    sqlx::query_as::<_, PageRow>("SELECT * FROM pages WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Page not found: {id}")))
        .map(Page::from)
}

async fn next_sort_order(pool: &sqlx::SqlitePool, folder_id: Option<&str>) -> AppResult<i64> {
    let value = match folder_id {
        Some(folder_id) => {
            sqlx::query_scalar(
                "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM pages WHERE folder_id = ?",
            )
            .bind(folder_id)
            .fetch_one(pool)
            .await?
        }
        None => {
            sqlx::query_scalar(
                "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM pages WHERE folder_id IS NULL",
            )
            .fetch_one(pool)
            .await?
        }
    };
    Ok(value)
}

// ─── Commands ─────────────────────────────────────────────────────────────────

pub async fn create_page_impl(pool: &sqlx::SqlitePool, data: NewPage) -> AppResult<Page> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    let created_at = data.created_at.as_deref().unwrap_or(&now);
    let updated_at = data.updated_at.as_deref().unwrap_or(&now);
    let sort_order = next_sort_order(pool, data.folder_id.as_deref()).await?;
    let tags_json = serde_json::to_string(&data.tags).unwrap_or_else(|_| "[]".to_string());
    let links_json = serde_json::to_string(&data.links).unwrap_or_else(|_| "[]".to_string());

    // Transaction wraps the pages row + page_tags rows together. The FTS
    // index is driven from pages.tags text — if a crash splits these two
    // writes apart, search results don't match the join table.
    let mut tx = pool.begin().await?;

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
    .execute(&mut *tx)
    .await?;

    upsert_page_tags_tx(&mut tx, &id, &data.tags).await?;

    tx.commit().await?;

    fetch_page(pool, &id).await
}

pub async fn update_page_impl(
    pool: &sqlx::SqlitePool,
    id: String,
    updates: PageUpdate,
) -> AppResult<Page> {
    let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new("UPDATE pages SET ");
    let mut fields = builder.separated(", ");
    let mut has_updates = false;

    if let Some(v) = updates.title {
        fields.push("title = ");
        fields.push_bind_unseparated(v);
        has_updates = true;
    }
    if let Some(v) = updates.content {
        fields.push("content = ");
        fields.push_bind_unseparated(v);
        has_updates = true;
    }
    if let Some(v) = updates.content_text {
        fields.push("content_text = ");
        fields.push_bind_unseparated(v);
        has_updates = true;
    }
    if let Some(v) = updates.status {
        fields.push("status = ");
        fields.push_bind_unseparated(v);
        has_updates = true;
    }
    if let Some(v) = updates.priority {
        fields.push("priority = ");
        fields.push_bind_unseparated(v);
        has_updates = true;
    }
    if let Some(v) = updates.sort_order {
        fields.push("sort_order = ");
        fields.push_bind_unseparated(v);
        has_updates = true;
    }
    let updated_tags = updates.tags.as_deref().map(|t| t.to_vec());
    if let Some(ref v) = updates.tags {
        let json = serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string());
        fields.push("tags = ");
        fields.push_bind_unseparated(json);
        has_updates = true;
    }
    if let Some(v) = updates.links {
        let json = serde_json::to_string(&v).unwrap_or_else(|_| "[]".to_string());
        fields.push("links = ");
        fields.push_bind_unseparated(json);
        has_updates = true;
    }

    // Nullable string fields (Value::Null sets to NULL, Value::String sets to value)
    macro_rules! push_nullable_str {
        ($field:expr, $col:literal) => {
            if let Some(val) = $field {
                fields.push(concat!($col, " = "));
                match val {
                    serde_json::Value::Null => fields.push_bind_unseparated(None::<String>),
                    serde_json::Value::String(s) => fields.push_bind_unseparated(s),
                    _ => fields.push_bind_unseparated(None::<String>),
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
        return fetch_page(pool, &id).await;
    }

    fields.push("updated_at = ");
    fields.push_bind_unseparated(now_iso());
    drop(fields);

    // Never mutate a trashed page — a stale view or queued edit must not
    // resurrect or silently rewrite a row the user has deleted.
    builder.push(" WHERE id = ");
    builder.push_bind(&id);
    builder.push(" AND deleted_at IS NULL");

    // Transaction wraps the pages row + (optional) page_tags rewrite so the
    // pages.tags JSON denorm and the page_tags join table cannot diverge.
    let mut tx = pool.begin().await?;
    builder.build().execute(&mut *tx).await?;

    if let Some(tags) = updated_tags {
        upsert_page_tags_tx(&mut tx, &id, &tags).await?;
    }
    tx.commit().await?;

    fetch_page(pool, &id).await
}

pub async fn delete_page_impl(pool: &sqlx::SqlitePool, id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM pages WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn soft_delete_page_impl(pool: &sqlx::SqlitePool, id: &str) -> AppResult<()> {
    // Guard on deleted_at IS NULL (mirrors soft_delete_folder_impl) so a second
    // delete can't overwrite the original trash timestamp and reset the
    // auto-purge clock.
    sqlx::query(
        "UPDATE pages SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(now_iso())
    .bind(now_iso())
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn restore_page_impl(pool: &sqlx::SqlitePool, id: &str) -> AppResult<()> {
    sqlx::query("UPDATE pages SET deleted_at = NULL, updated_at = ? WHERE id = ?")
        .bind(now_iso())
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// List pages with an optional filter (folder, status, priority, scheduled
/// range, etc.).
///
/// `filter.query` is implemented as an unindexed `title LIKE '%q%' OR
/// content_text LIKE '%q%'` — O(n) full table scan. Audit (2026-05): the
/// only caller in tree is `MockStorageAdapter` tests in `packages/core`,
/// where the dataset is a handful of rows and the cost is irrelevant. No
/// production code path passes `query` to list_pages — production search
/// goes through `search_pages` (FTS5). If a production caller ever needs
/// query here, route it through FTS5 instead of widening the LIKE scan.
pub async fn list_pages_impl(
    pool: &sqlx::SqlitePool,
    filter: Option<PageFilter>,
) -> AppResult<Vec<PageSummary>> {
    let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new(format!(
        "SELECT {SUMMARY_COLUMNS} FROM pages WHERE deleted_at IS NULL"
    ));

    if let Some(ref f) = filter {
        if let Some(ref folder_val) = f.folder_id {
            match folder_val {
                serde_json::Value::Null => {
                    builder.push(" AND folder_id IS NULL");
                }
                serde_json::Value::String(folder_id) => {
                    builder.push(" AND folder_id = ");
                    builder.push_bind(folder_id.clone());
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
        if f.has_schedule == Some(true) {
            builder.push(" AND scheduled_start IS NOT NULL");
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
        .fetch_all(pool)
        .await?;

    let mut summaries: Vec<PageSummary> = rows.into_iter().map(PageSummary::from).collect();

    // Tags filter is post-query (JSON array in SQLite is opaque)
    if let Some(f) = &filter {
        if let Some(filter_tags) = &f.tags {
            if !filter_tags.is_empty() {
                summaries.retain(|page| filter_tags.iter().all(|tag| page.tags.contains(tag)));
            }
        }
    }

    Ok(summaries)
}

pub async fn list_pages_today_impl(pool: &sqlx::SqlitePool) -> AppResult<Vec<PageSummary>> {
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
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(PageSummary::from).collect())
}

pub async fn reorder_pages_impl(
    pool: &sqlx::SqlitePool,
    folder_id: Option<&str>,
    ordered_ids: &[String],
) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    let now = now_iso();
    for (i, id) in ordered_ids.iter().enumerate() {
        match &folder_id {
            Some(folder_id) => {
                sqlx::query(
                    "UPDATE pages SET sort_order = ?, updated_at = ? WHERE id = ? AND folder_id = ?",
                )
                .bind(i as i64)
                .bind(&now)
                .bind(id)
                .bind(folder_id)
                .execute(&mut *tx)
                .await?;
            }
            None => {
                sqlx::query(
                    "UPDATE pages SET sort_order = ?, updated_at = ? WHERE id = ? AND folder_id IS NULL",
                )
                .bind(i as i64)
                .bind(&now)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            }
        }
    }
    tx.commit().await?;
    Ok(())
}

/// Bulk-set `status` (+ `completed_at`) for many pages in a single transaction.
///
/// Backs multi-select "complete/uncomplete all" (Cmd+A → Space). Doing every
/// flip in ONE transaction — rather than one `update_page_impl` call per id —
/// is both atomic and avoids N concurrent writes racing the WAL pool. Those
/// concurrent writes deadlock with SQLITE_BUSY and silently drop some of the
/// completions, which is the "Space doesn't reliably complete all" defect
/// (QA §4). Skips soft-deleted rows (`deleted_at IS NULL`), mirroring
/// `update_page_impl`.
///
/// Recurring heads must NOT be passed here — completing a recurring page clones
/// the head and advances it (see `complete_recurring_page_impl`); a plain status
/// flip would corrupt the series.
pub async fn set_pages_status_impl(
    pool: &sqlx::SqlitePool,
    ids: &[String],
    status: &str,
    completed_at: Option<&str>,
) -> AppResult<Vec<PageSummary>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    // Write-first (the first statement is an UPDATE, no prior read), so this
    // can't hit BUSY_SNAPSHOT (517) — busy_timeout already covers plain lock
    // contention. No retry wrapper needed, unlike complete_recurring_page_impl.
    let now = now_iso();
    let mut tx = pool.begin().await?;
    for id in ids {
        sqlx::query(
            "UPDATE pages SET status = ?, completed_at = ?, updated_at = ? \
             WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(status)
        .bind(completed_at)
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    // Return the updated summaries so the client can reconcile (post-commit so
    // any FTS triggers have fired).
    let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new(format!(
        // sql-ok: SUMMARY_COLUMNS is a compile-time constant
        "SELECT {SUMMARY_COLUMNS} FROM pages WHERE deleted_at IS NULL AND id IN ("
    ));
    let mut separated = builder.separated(", ");
    for id in ids {
        separated.push_bind(id);
    }
    separated.push_unseparated(")");

    let rows = builder
        .build_query_as::<PageSummaryRow>()
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(PageSummary::from).collect())
}

// ─── Completed pages (lazy-loaded, paginated) ────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedPagesFilter {
    pub folder_id: Option<serde_json::Value>, // null = inbox, missing = all
    pub completed_since: Option<String>,      // ISO date for "today" filter
    pub limit: i64,
    pub offset: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedPagesResponse {
    pub pages: Vec<PageSummary>,
    pub total: i64,
}

pub async fn list_completed_pages_impl(
    pool: &sqlx::SqlitePool,
    filter: CompletedPagesFilter,
) -> AppResult<CompletedPagesResponse> {
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
            serde_json::Value::String(folder_id) => {
                where_parts.push("folder_id = ?".to_string());
                bind_values.push(folder_id.clone());
            }
            _ => {}
        }
    }

    if let Some(ref since) = filter.completed_since {
        where_parts.push("date(completed_at) >= ?".to_string());
        bind_values.push(since.clone());
    }

    let where_clause = where_parts.join(" AND ");

    let count_sql = format!("SELECT COUNT(*) FROM pages WHERE {where_clause}");
    let mut count_query = sqlx::query_scalar::<_, i64>(&count_sql);
    for v in &bind_values {
        count_query = count_query.bind(v);
    }
    let total = count_query.fetch_one(pool).await?;

    let data_sql = format!(
        "SELECT {SUMMARY_COLUMNS} FROM pages WHERE {where_clause} \
         ORDER BY completed_at DESC LIMIT ? OFFSET ?"
    );
    let mut data_query = sqlx::query_as::<_, PageSummaryRow>(&data_sql);
    for v in &bind_values {
        data_query = data_query.bind(v);
    }
    data_query = data_query.bind(filter.limit).bind(filter.offset);

    let rows = data_query.fetch_all(pool).await?;

    Ok(CompletedPagesResponse {
        pages: rows.into_iter().map(PageSummary::from).collect(),
        total,
    })
}

// ─── Recurring page completion ───────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteRecurringInput {
    pub page_id: String,
    /// The next occurrence's scheduled start (ISO date or datetime).
    /// None = series is finished, mark head as done.
    pub next_scheduled_start: Option<String>,
    /// The next occurrence's scheduled end (ISO datetime), if timed.
    pub next_scheduled_end: Option<String>,
    /// Recurrence rule to advance, when the completion should also update the
    /// rule's exdates (e.g. exclude the just-completed date / skipped gap).
    /// Folded into the completion transaction so it's atomic AND so the caller
    /// doesn't issue a *second, concurrent* write — two writes racing the same
    /// WAL pool deadlock with SQLITE_BUSY (code 517) and the completion is lost.
    #[serde(default)]
    pub rule_id: Option<String>,
    /// Dates to ADD to `rule_id`'s exdates, merged into the current row inside
    /// the transaction (see merge_rule_exdates_tx). A full replacement array is
    /// deliberately not accepted: it would clobber exdates persisted after the
    /// caller's snapshot was taken. Ignored unless `rule_id` is also set.
    #[serde(default)]
    pub add_exdates: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteRecurringResult {
    /// The newly created completed clone page.
    pub clone: PageSummary,
    /// The updated head page (advanced to next occurrence, or done).
    pub head: PageSummary,
    /// Post-merge exdates when `rule_id` was supplied — callers sync their local
    /// rule state from this rather than from their pre-call computation.
    pub rule_exdates: Option<Vec<String>>,
}

/// Atomically completes a recurring page:
/// 1. Clones the head as a done page (snapshot of current state)
/// 2. Advances the head to the next occurrence, or marks it done if series is finished
///
/// Entire flow — including the head read and sort_order allocation — runs inside
/// a single transaction so a mid-flight crash can't leave the workspace with a
/// clone but no head advance (double-counted completion) or a head advance
/// without a clone (lost completion history), and so concurrent completions
/// can't allocate the same sort_order.
///
/// The head's `pages.scheduled_start` is advanced directly here and is NOT
/// re-derived from `page_schedules` — `refresh_schedule_denorm` deliberately
/// skips rrule-backed pages for exactly this reason.
pub async fn complete_recurring_page_impl(
    pool: &sqlx::SqlitePool,
    data: CompleteRecurringInput,
) -> AppResult<CompleteRecurringResult> {
    // Read-then-write: the transaction reads the head before writing, so if
    // another connection commits in between (e.g. the background notification
    // scheduler) its snapshot goes stale and the write fails with
    // SQLITE_BUSY_SNAPSHOT (517) — which busy_timeout cannot wait out. Retry the
    // whole attempt; each re-reads fresh state. (See crate::tx.)
    crate::tx::retry_on_busy(|| complete_recurring_page_once(pool, &data)).await
}

/// What differs between the two clone flavors: a completion clone ('done' at
/// the completed occurrence) vs a reschedule clone ('not_started' at the new
/// time).
struct CloneSpec<'a> {
    clone_id: &'a str,
    status: &'a str,
    completed_at: Option<&'a str>,
    scheduled_start: Option<&'a str>,
    scheduled_end: Option<&'a str>,
}

/// Snapshot-clones `head` as a new page inside the caller's transaction:
/// allocates the next sort_order in the head's folder, copies content/metadata,
/// and syncs the normalized tag tables. Shared by recurring completion and
/// virtual-occurrence reschedule.
async fn insert_head_clone_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    head: &Page,
    spec: CloneSpec<'_>,
    now: &str,
) -> AppResult<()> {
    // sort_order read lives inside the tx so two concurrent clones can't
    // allocate the same value.
    let clone_sort_order: i64 = match head.folder_id.as_deref() {
        Some(folder_id) => {
            sqlx::query_scalar(
                "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM pages WHERE folder_id = ?",
            )
            .bind(folder_id)
            .fetch_one(&mut **tx)
            .await?
        }
        None => {
            sqlx::query_scalar(
                "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM pages WHERE folder_id IS NULL",
            )
            .fetch_one(&mut **tx)
            .await?
        }
    };
    let tags_json = serde_json::to_string(&head.tags).unwrap_or_else(|_| "[]".to_string());

    sqlx::query(
        "INSERT INTO pages (id, folder_id, title, subtitle, content, content_text, status,
         priority, tags, sort_order, scheduled_start, scheduled_end, completed_at,
         links, parent_id, last_opened_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', NULL, NULL, ?, ?)",
    )
    .bind(spec.clone_id)
    .bind(&head.folder_id)
    .bind(&head.title)
    .bind(&head.subtitle)
    .bind(&head.content)
    .bind(head.content_text.as_deref().unwrap_or(""))
    .bind(spec.status)
    .bind(head.priority)
    .bind(&tags_json)
    .bind(clone_sort_order)
    .bind(spec.scheduled_start)
    .bind(spec.scheduled_end)
    .bind(spec.completed_at)
    .bind(now) // created_at
    .bind(now) // updated_at
    .execute(&mut **tx)
    .await?;

    // Sync tags for the clone — same transaction as the pages insert above
    // so the JSON denorm and the page_tags join can't fall out of sync.
    upsert_page_tags_tx(tx, spec.clone_id, &head.tags).await?;
    Ok(())
}

async fn complete_recurring_page_once(
    pool: &sqlx::SqlitePool,
    data: &CompleteRecurringInput,
) -> AppResult<CompleteRecurringResult> {
    let now = now_iso();
    // `completed_at` follows the local-wall-clock convention (like scheduled_start),
    // NOT the UTC `now_iso()` used for created_at/updated_at. The Completed view
    // date-compares `completed_at.slice(0,10)` against the local day, so a UTC
    // stamp would hide a just-completed clone whenever UTC's date ≠ the local date.
    let completed = now_local_iso();
    let clone_id = uuid::Uuid::new_v4().to_string();

    let mut tx = pool.begin().await?;

    // 1. Fetch the head page (full content for cloning) inside the tx, rejecting
    // soft-deleted pages: completing a trashed recurring page must not resurrect
    // it as a visible "done" clone. The sort_order read also lives inside the tx
    // so two concurrent completions can't allocate the same value.
    let head =
        sqlx::query_as::<_, PageRow>("SELECT * FROM pages WHERE id = ? AND deleted_at IS NULL")
            .bind(&data.page_id)
            .fetch_optional(&mut *tx)
            .await?
            .map(Page::from)
            .ok_or_else(|| AppError::NotFound(format!("Page not found: {}", data.page_id)))?;

    // 2. Create the completed clone — it gets the occurrence date being
    // completed, and completed_at in local wall-clock (see above).
    insert_head_clone_tx(
        &mut tx,
        &head,
        CloneSpec {
            clone_id: &clone_id,
            status: "done",
            completed_at: Some(&completed),
            scheduled_start: head.scheduled_start.as_deref(),
            scheduled_end: head.scheduled_end.as_deref(),
        },
        &now,
    )
    .await?;

    // 3. Advance the head (or mark done if series finished)
    if let Some(ref next_start) = data.next_scheduled_start {
        sqlx::query(
            "UPDATE pages SET scheduled_start = ?, scheduled_end = ?, updated_at = ? WHERE id = ?",
        )
        .bind(next_start)
        .bind(&data.next_scheduled_end)
        .bind(&now)
        .bind(&data.page_id)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query(
            "UPDATE pages SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?",
        )
        .bind(&completed) // local wall-clock (see above)
        .bind(&now)
        .bind(&data.page_id)
        .execute(&mut *tx)
        .await?;
    }

    // 4. Advance the rule's exdates in the SAME tx (e.g. exclude the completed
    // date and any skipped gap). Doing it here — rather than as a separate
    // concurrent update_recurrence_rule call on the client — keeps the whole
    // completion atomic and avoids the write-write SQLITE_BUSY deadlock. The
    // dates are MERGED into the current row, not written as a replacement, so
    // an exdate persisted after the caller's snapshot (a skip, a CLI write)
    // survives the completion.
    let rule_exdates = match (&data.rule_id, &data.add_exdates) {
        (Some(rule_id), Some(add)) => {
            Some(crate::schedules::merge_rule_exdates_tx(&mut tx, rule_id, add).await?)
        }
        _ => None,
    };

    tx.commit().await?;

    // 5. Fetch updated results (post-commit so any FTS triggers have fired)
    let clone_row = sqlx::query_as::<_, PageSummaryRow>(&format!(
        // sql-ok: SUMMARY_COLUMNS is a compile-time constant
        "SELECT {SUMMARY_COLUMNS} FROM pages WHERE id = ?"
    ))
    .bind(&clone_id)
    .fetch_one(pool)
    .await?;

    let head_row = sqlx::query_as::<_, PageSummaryRow>(&format!(
        // sql-ok: SUMMARY_COLUMNS is a compile-time constant
        "SELECT {SUMMARY_COLUMNS} FROM pages WHERE id = ?"
    ))
    .bind(&data.page_id)
    .fetch_one(pool)
    .await?;

    Ok(CompleteRecurringResult {
        clone: PageSummary::from(clone_row),
        head: PageSummary::from(head_row),
        rule_exdates,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RescheduleVirtualInput {
    pub rule_id: String,
    /// The rule-generated date being detached (YYYY-MM-DD) — merged into the
    /// rule's exdates so the virtual occurrence stops rendering.
    pub original_date: String,
    pub scheduled_start: String,
    #[serde(default)]
    pub scheduled_end: Option<String>,
    pub timezone: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RescheduleVirtualResult {
    /// The independent clone page materialized at the new time.
    pub clone: PageSummary,
    /// Post-merge exdates for the rule — callers sync local rule state from this.
    pub rule_exdates: Vec<String>,
}

/// Atomically materializes a virtual rrule occurrence at a new time (drag or
/// popover date pick on a virtual block):
/// 1. Clones the head as an independent 'not_started' page
/// 2. Schedules the clone at the new time (page_schedules row + denorm)
/// 3. Merges the original date into the rule's exdates so the virtual disappears
///
/// One transaction — previously these were three separate client-issued writes,
/// so a failure after the clone insert left BOTH the clone and the still-
/// unexcluded virtual on the calendar (duplicate occurrence, duplicate
/// reminders). The head and rule are otherwise untouched.
pub async fn reschedule_virtual_occurrence_impl(
    pool: &sqlx::SqlitePool,
    data: RescheduleVirtualInput,
) -> AppResult<RescheduleVirtualResult> {
    // Read-then-write under WAL — retry on BUSY_SNAPSHOT like completion.
    crate::tx::retry_on_busy(|| reschedule_virtual_occurrence_once(pool, &data)).await
}

async fn reschedule_virtual_occurrence_once(
    pool: &sqlx::SqlitePool,
    data: &RescheduleVirtualInput,
) -> AppResult<RescheduleVirtualResult> {
    let now = now_iso();
    let clone_id = uuid::Uuid::new_v4().to_string();
    let schedule_id = uuid::Uuid::new_v4().to_string();

    let mut tx = pool.begin().await?;

    let page_id: String =
        sqlx::query_scalar("SELECT page_id FROM page_recurrence_rules WHERE id = ?")
            .bind(&data.rule_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| {
                AppError::NotFound(format!("Recurrence rule not found: {}", data.rule_id))
            })?;

    // Reject soft-deleted heads: rescheduling an occurrence of a trashed series
    // must not resurrect its content as a visible page.
    let head =
        sqlx::query_as::<_, PageRow>("SELECT * FROM pages WHERE id = ? AND deleted_at IS NULL")
            .bind(&page_id)
            .fetch_optional(&mut *tx)
            .await?
            .map(Page::from)
            .ok_or_else(|| AppError::NotFound(format!("Page not found: {page_id}")))?;

    insert_head_clone_tx(
        &mut tx,
        &head,
        CloneSpec {
            clone_id: &clone_id,
            status: "not_started",
            completed_at: None,
            scheduled_start: Some(&data.scheduled_start),
            scheduled_end: data.scheduled_end.as_deref(),
        },
        &now,
    )
    .await?;

    // The clone's schedule block. Its denorm scheduled_start/end is already set
    // by the insert above (single row, matches by construction), so no
    // refresh_schedule_denorm pass is needed.
    sqlx::query(
        "INSERT INTO page_schedules
         (id, page_id, scheduled_start, scheduled_end, timezone, rule_id, original_date, status, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, 'not_started', ?)",
    )
    .bind(&schedule_id)
    .bind(&clone_id)
    .bind(&data.scheduled_start)
    .bind(&data.scheduled_end)
    .bind(&data.timezone)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    let rule_exdates = crate::schedules::merge_rule_exdates_tx(
        &mut tx,
        &data.rule_id,
        std::slice::from_ref(&data.original_date),
    )
    .await?;

    tx.commit().await?;

    // Fetch post-commit so any FTS triggers have fired.
    let clone_row = sqlx::query_as::<_, PageSummaryRow>(&format!(
        // sql-ok: SUMMARY_COLUMNS is a compile-time constant
        "SELECT {SUMMARY_COLUMNS} FROM pages WHERE id = ?"
    ))
    .bind(&clone_id)
    .fetch_one(pool)
    .await?;

    Ok(RescheduleVirtualResult {
        clone: PageSummary::from(clone_row),
        rule_exdates,
    })
}

/// Fetch a single page by id (mirrors the app's get_page — no deleted_at filter).
pub async fn get_page(pool: &sqlx::SqlitePool, id: &str) -> AppResult<Option<Page>> {
    let row = sqlx::query_as::<_, PageRow>("SELECT * FROM pages WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(Page::from))
}

#[cfg(test)]
#[path = "pages_tests.rs"]
mod pages_tests;

#[cfg(test)]
#[path = "pages_concurrency_tests.rs"]
mod pages_concurrency_tests;
