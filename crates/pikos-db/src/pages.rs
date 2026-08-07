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
    schedule_locked: bool,
    sync_state: Option<String>,
    timezone: Option<String>,
    completed_occurrences: Option<String>,
    skipped_occurrences: Option<String>,
    mirror_location: Option<String>,
    mirror_attendees: Option<String>,
    pending_description: Option<String>,
    is_recurring: bool,
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
    /// Derived (not a stored column): an active `page_sync` row owns this page's
    /// schedule, so the calendar/editor render it read-only and non-draggable.
    pub schedule_locked: bool,
    /// Derived from `page_sync.sync_state` ('active' | 'detached' | 'tombstoned'),
    /// `None` for native pages. Drives detached treatment (dim + broken-sync icon).
    pub sync_state: Option<String>,
    /// Source/authoring IANA zone (schedule or recurrence rule). Synced pages render
    /// it absolute in the viewer's zone at read time; native pages float and ignore it.
    pub timezone: Option<String>,
    /// `occurrence-date → done-clone page id`, from `completed_set`. The frontend
    /// hides a completed occurrence and routes an uncomplete by the clone id.
    /// `None` when the series has no completions.
    pub completed_occurrences: Option<std::collections::HashMap<String, String>>,
    /// Dismissed occurrence dates for a recurring series, from the `skip_set` table.
    /// Excluded from expansion (both native + synced). `None` when nothing skipped.
    pub skipped_occurrences: Option<Vec<String>>,
    /// Calendar-owned location, a read-only mirror field. `None` for native pages
    /// or a synced event with no location; rendered only while the page is locked.
    pub mirror_location: Option<String>,
    /// Calendar-owned attendee list (emails), a read-only mirror field. `None` when
    /// the event has no attendees or the page is native.
    pub mirror_attendees: Option<Vec<String>>,
    /// Upstream description change withheld because the user already edited the body
    /// (see `page_sync.pending_description`). `None` = nothing pending.
    pub pending_description: Option<String>,
    /// Derived (not a stored column): lets the frontend tell a one-off from a series
    /// without loading the rule set.
    pub is_recurring: bool,
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
            schedule_locked: row.schedule_locked,
            sync_state: row.sync_state,
            timezone: row.timezone,
            completed_occurrences: parse_completed_occurrences(row.completed_occurrences),
            skipped_occurrences: parse_skipped_occurrences(row.skipped_occurrences),
            mirror_location: row.mirror_location,
            mirror_attendees: parse_attendees(row.mirror_attendees),
            pending_description: row.pending_description,
            is_recurring: row.is_recurring,
        }
    }
}

/// Parse the `mirror_attendees` JSON array the reconciler stores; both `None`
/// (no attendees) and malformed JSON yield `None`.
fn parse_attendees(raw: Option<String>) -> Option<Vec<String>> {
    raw.as_deref().and_then(|s| serde_json::from_str(s).ok())
}

/// Parse the `completed_occurrences` JSON object built by `json_group_object` over
/// `completed_set`; `NULLIF(..., '{}')` already maps an empty set to `None`.
fn parse_completed_occurrences(
    raw: Option<String>,
) -> Option<std::collections::HashMap<String, String>> {
    raw.as_deref().and_then(|s| serde_json::from_str(s).ok())
}

/// Parse the `skipped_occurrences` JSON array built by `json_group_array` over
/// `skip_set`; `NULLIF(..., '[]')` already maps an empty set to `None`.
fn parse_skipped_occurrences(raw: Option<String>) -> Option<Vec<String>> {
    raw.as_deref().and_then(|s| serde_json::from_str(s).ok())
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
    schedule_locked: bool,
    sync_state: Option<String>,
    timezone: Option<String>,
    completed_occurrences: Option<String>,
    skipped_occurrences: Option<String>,
    mirror_location: Option<String>,
    mirror_attendees: Option<String>,
    pending_description: Option<String>,
    is_recurring: bool,
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
    /// Derived (not a stored column) — see `Page::schedule_locked`.
    pub schedule_locked: bool,
    /// See `Page::sync_state`.
    pub sync_state: Option<String>,
    /// See `Page::timezone`.
    pub timezone: Option<String>,
    /// See `Page::completed_occurrences`.
    pub completed_occurrences: Option<std::collections::HashMap<String, String>>,
    /// See `Page::skipped_occurrences`.
    pub skipped_occurrences: Option<Vec<String>>,
    /// See `Page::mirror_location`.
    pub mirror_location: Option<String>,
    /// See `Page::mirror_attendees`.
    pub mirror_attendees: Option<Vec<String>>,
    /// See `Page::pending_description`.
    pub pending_description: Option<String>,
    /// See `Page::is_recurring`.
    pub is_recurring: bool,
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
            schedule_locked: row.schedule_locked,
            sync_state: row.sync_state,
            timezone: row.timezone,
            completed_occurrences: parse_completed_occurrences(row.completed_occurrences),
            skipped_occurrences: parse_skipped_occurrences(row.skipped_occurrences),
            mirror_location: row.mirror_location,
            mirror_attendees: parse_attendees(row.mirror_attendees),
            pending_description: row.pending_description,
            is_recurring: row.is_recurring,
        }
    }
}

const SUMMARY_COLUMNS: &str =
    "id, folder_id, title, subtitle, status, priority, tags, sort_order, \
     scheduled_start, scheduled_end, completed_at, links, \
     parent_id, last_opened_at, created_at, updated_at";

/// Appended to every page-hydrating SELECT to populate the derived sync columns
/// (see the `Page` field docs). Correlated on the unqualified `pages.id`, so it
/// works whether or not the query aliases the table.
const SYNC_DERIVED_SELECT: &str = ", EXISTS(SELECT 1 FROM page_sync \
     WHERE page_sync.page_id = pages.id AND page_sync.sync_state = 'active') \
     AS schedule_locked\
     , (SELECT sync_state FROM page_sync WHERE page_sync.page_id = pages.id) AS sync_state\
     , NULLIF((SELECT json_group_object(occurrence_date, clone_id) FROM completed_set \
         WHERE completed_set.page_id = pages.id), '{}') AS completed_occurrences\
     , NULLIF((SELECT json_group_array(occurrence_date) FROM skip_set \
         WHERE skip_set.page_id = pages.id), '[]') AS skipped_occurrences\
     , COALESCE(\
         (SELECT timezone FROM page_recurrence_rules WHERE page_recurrence_rules.page_id = pages.id LIMIT 1), \
         (SELECT timezone FROM page_schedules WHERE page_schedules.page_id = pages.id LIMIT 1)) \
     AS timezone\
     , (SELECT mirror_location FROM page_sync WHERE page_sync.page_id = pages.id) AS mirror_location\
     , (SELECT mirror_attendees FROM page_sync WHERE page_sync.page_id = pages.id) AS mirror_attendees\
     , (SELECT pending_description FROM page_sync WHERE page_sync.page_id = pages.id) AS pending_description\
     , EXISTS(SELECT 1 FROM page_recurrence_rules \
         WHERE page_recurrence_rules.page_id = pages.id) AS is_recurring";

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
    sqlx::query_as::<_, PageRow>(&format!(
        "SELECT *{SYNC_DERIVED_SELECT} FROM pages WHERE id = ?"
    ))
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
    // External-calendar folders are system-managed; only the reconciler (raw SQL)
    // seeds into them. Reject a create targeting one, or the page lands trapped —
    // the placement lock in update_page_impl then blocks it from ever leaving.
    if let Some(folder_id) = data.folder_id.as_deref() {
        let target_external: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM folders WHERE id = ? AND is_external_calendar = 1)",
        )
        .bind(folder_id)
        .fetch_one(pool)
        .await?;
        if target_external {
            return Err(AppError::Conflict(
                "Pages cannot be created in an external calendar folder".to_string(),
            ));
        }
    }

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
    // Editing any authored field claims ownership (the reconciler never calls this
    // path, so sync can't trip it). `last_opened_at`/`sort_order` are excluded —
    // reading and arranging don't author — and ownership decides whether an
    // upstream delete removes the page or detaches it permanently.
    let marks_ownership = updates.title.is_some()
        || updates.content.is_some()
        || updates.content_text.is_some()
        || updates.status.is_some()
        || updates.priority.is_some()
        || updates.tags.is_some()
        || updates.links.is_some()
        || updates.folder_id.is_some()
        || updates.subtitle.is_some()
        || updates.scheduled_start.is_some()
        || updates.scheduled_end.is_some()
        || updates.completed_at.is_some()
        || updates.parent_id.is_some();

    // Placement lock, keyed on the live sync link rather than the folder: nothing
    // moves into a calendar folder, and an actively-synced page can't leave; once
    // detached it's the user's and files anywhere. The reconciler seeds via raw SQL,
    // bypassing this command.
    if let Some(ref folder_val) = updates.folder_id {
        let target_external: bool = match folder_val {
            serde_json::Value::String(target) => sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM folders WHERE id = ? AND is_external_calendar = 1)",
            )
            .bind(target)
            .fetch_one(pool)
            .await?,
            _ => false,
        };
        if target_external {
            return Err(AppError::Conflict(
                "Pages cannot be moved into an external calendar folder".to_string(),
            ));
        }
        if crate::sync::page_schedule_locked(pool, &id).await? {
            return Err(AppError::Conflict(
                crate::sync::SYNCED_PLACEMENT_MSG.to_string(),
            ));
        }
    }

    // Locked mirror: title + schedule (start/end) are calendar-owned on a synced
    // page. Body/meta/status/tags stay editable (and still set user_modified).
    if updates.title.is_some()
        || updates.scheduled_start.is_some()
        || updates.scheduled_end.is_some()
    {
        crate::sync::ensure_page_schedule_unlocked(pool, &id).await?;
    }

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

    if marks_ownership {
        // No page_sync row for native pages → no-op.
        sqlx::query(
            "UPDATE page_sync SET user_modified = 1 WHERE page_id = ? AND user_modified = 0",
        )
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    }

    if let Some(tags) = updated_tags {
        upsert_page_tags_tx(&mut tx, &id, &tags).await?;
    }
    tx.commit().await?;

    fetch_page(pool, &id).await
}

pub async fn delete_page_impl(pool: &sqlx::SqlitePool, id: &str) -> AppResult<()> {
    // A synced page can't be hard-deleted — it still exists upstream and the next
    // poll would resurrect it. Soft-delete + tombstone instead: recoverable from
    // trash, sync suppressed. (Sync's own hard-deletes use raw SQL, not this path.)
    let synced: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM page_sync WHERE page_id = ?)")
            .bind(id)
            .fetch_one(pool)
            .await?;
    if synced {
        return soft_delete_page_impl(pool, id).await;
    }

    sqlx::query("DELETE FROM pages WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn soft_delete_page_impl(pool: &sqlx::SqlitePool, id: &str) -> AppResult<()> {
    let now = now_iso();
    let mut tx = pool.begin().await?;
    // Guard on deleted_at IS NULL (mirrors soft_delete_folder_impl) so a second
    // delete can't overwrite the original trash timestamp and reset the
    // auto-purge clock.
    sqlx::query(
        "UPDATE pages SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(&now)
    .bind(&now)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    // Tombstones the active sync link so the next poll doesn't resurrect the page.
    // A detached link is skipped so it stays detached through trash → restore,
    // rather than being wrongly reactivated. No-op for native pages.
    sqlx::query("UPDATE page_sync SET sync_state = 'tombstoned' WHERE page_id = ? AND sync_state = 'active'")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn restore_page_impl(pool: &sqlx::SqlitePool, id: &str) -> AppResult<()> {
    let now = now_iso();
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE pages SET deleted_at = NULL, updated_at = ? WHERE id = ?")
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    // Resume syncing a restored page (only flips the tombstone this delete set;
    // a detached page stays detached). No-op for native pages.
    sqlx::query(
        "UPDATE page_sync SET sync_state = 'active' WHERE page_id = ? AND sync_state = 'tombstoned'",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    // Sets survive soft-delete, so a restored recurring head must re-derive
    // (no-op if non-recurring). Skip active-synced heads — their cache is
    // reconciler-owned, and recomputing here would clobber a pinned provider head.
    if !is_active_synced(&mut tx, id).await? {
        crate::recurrence_derive::recompute_recurring_schedule(&mut tx, id).await?;
    }
    tx.commit().await?;
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
        "SELECT {SUMMARY_COLUMNS}{SYNC_DERIVED_SELECT} FROM pages WHERE deleted_at IS NULL"
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
        "SELECT DISTINCT {cols}{SYNC_DERIVED_SELECT} FROM pages
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
        "SELECT {SUMMARY_COLUMNS}{SYNC_DERIVED_SELECT} FROM pages WHERE deleted_at IS NULL AND id IN ("
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
        "SELECT {SUMMARY_COLUMNS}{SYNC_DERIVED_SELECT} FROM pages WHERE {where_clause} \
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
    /// Missed-occurrence dates (YYYY-MM-DD) the "advance to today" gap dialog
    /// dismisses — written to the skip-set. Empty for a plain completion.
    #[serde(default)]
    pub skip_dates: Vec<String>,
    /// Synced series only: the client-rendered occurrence being completed (the
    /// reconciler pins the head at the base, so the virtual is the only record of
    /// it). Native series omit these — the head's own oldest-open date is used.
    #[serde(default)]
    pub occurrence_date: Option<String>,
    #[serde(default)]
    pub scheduled_start: Option<String>,
    #[serde(default)]
    pub scheduled_end: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteRecurringResult {
    /// The newly created completed clone page.
    pub clone: PageSummary,
    /// The head after recompute — advanced to the next open occurrence, or `done`
    /// when the series is exhausted.
    pub head: PageSummary,
}

/// Atomically completes one occurrence of a recurring page (native or synced) onto
/// the occurrence-sets model:
/// 1. Clones the head as a done page at the occurrence being completed (snapshot):
///    for a native series the head's own oldest-open occurrence; for a synced series
///    the client-supplied virtual (validated against the rule), since the reconciler
///    pins the head at the base.
/// 2. Records `(page_id, occurrence_date) → clone_id` in `completed_set`, and any
///    gap `skip_dates` in `skip_set` — no EXDATE merge (the exclusion is set-only).
/// 3. Recomputes `pages.scheduled_start` from truth (`recompute_recurring_schedule`),
///    which advances the head to the next open occurrence or marks it `done`. A
///    synced head advances the same way; the reconciler recomputes off the same sets
///    on the next sync, so the two converge (an out-of-envelope rule the engine can't
///    advance stays put, suppressed on the frontend by `headCompleted`).
///
/// Entire flow runs in one transaction: a mid-flight crash can't leave a clone
/// without its set entry (lost history) or a set entry without a recompute (stale
/// head), and concurrent completions can't allocate the same sort_order. The
/// head's denorm is owned by the recompute, not `refresh_schedule_denorm`, which
/// deliberately skips rrule-backed pages.
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

    // Fetch the head inside the tx, rejecting soft-deleted pages — completing a
    // trashed series must not resurrect it as a visible "done" clone. The
    // sort_order read also lives in the tx so concurrent completions can't collide.
    let head = sqlx::query_as::<_, PageRow>(&format!(
        "SELECT *{SYNC_DERIVED_SELECT} FROM pages WHERE id = ? AND deleted_at IS NULL"
    ))
    .bind(&data.page_id)
    .fetch_optional(&mut *tx)
    .await?
    .map(Page::from)
    .ok_or_else(|| AppError::NotFound(format!("Page not found: {}", data.page_id)))?;

    // Occurrence completion is set-only, so a misroute to a non-recurring page would
    // mint a clone no series can ever suppress. Reject it (both kinds).
    let is_recurring: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM page_recurrence_rules WHERE page_id = ?)")
            .bind(&data.page_id)
            .fetch_one(&mut *tx)
            .await?;
    if !is_recurring {
        return Err(AppError::Conflict(
            "Occurrence completion applies only to a recurring series.".to_string(),
        ));
    }

    // Resolve the occurrence: a native head sits on its own oldest-open date (used
    // directly as the clone's schedule and set key). A synced head is pinned at the
    // base, so the client supplies the rendered virtual, validated below against
    // the rule (see synced_occurrence_is_valid).
    let (occurrence_date, occurrence_start, occurrence_end) = if head.schedule_locked {
        let occurrence_date = data.occurrence_date.clone().ok_or_else(|| {
            AppError::Conflict(
                "Synced occurrence completion requires an occurrence date.".to_string(),
            )
        })?;
        let start = data.scheduled_start.clone().ok_or_else(|| {
            AppError::Conflict(
                "Synced occurrence completion requires the occurrence start.".to_string(),
            )
        })?;
        if !synced_occurrence_is_valid(&mut tx, &data.page_id, &occurrence_date).await? {
            return Err(AppError::Conflict(
                "Occurrence is not part of this synced series.".to_string(),
            ));
        }
        (occurrence_date, start, data.scheduled_end.clone())
    } else {
        let occurrence_start = head.scheduled_start.clone().ok_or_else(|| {
            AppError::Conflict(
                "Recurring page has no scheduled occurrence to complete.".to_string(),
            )
        })?;
        let occurrence_date = occurrence_start[..occurrence_start.len().min(10)].to_string();
        (
            occurrence_date,
            occurrence_start,
            head.scheduled_end.clone(),
        )
    };

    // Idempotency: a double-click or post-`SQLITE_BUSY_SNAPSHOT` retry must not mint
    // a second clone for the same occurrence. A live clone → return it unchanged;
    // a trashed one falls through so the OR REPLACE below re-points the set row.
    if let Some(clone) = existing_completed_clone(&mut tx, &data.page_id, &occurrence_date).await? {
        let head_row = sqlx::query_as::<_, PageSummaryRow>(&format!(
            // sql-ok: SUMMARY_COLUMNS is a compile-time constant
            "SELECT {SUMMARY_COLUMNS}{SYNC_DERIVED_SELECT} FROM pages WHERE id = ?"
        ))
        .bind(&data.page_id)
        .fetch_one(&mut *tx)
        .await?;
        return Ok(CompleteRecurringResult {
            clone,
            head: PageSummary::from(head_row),
        });
    }

    insert_head_clone_tx(
        &mut tx,
        &head,
        CloneSpec {
            clone_id: &clone_id,
            status: "done",
            completed_at: Some(&completed),
            scheduled_start: Some(&occurrence_start),
            scheduled_end: occurrence_end.as_deref(),
        },
        &now,
    )
    .await?;

    sqlx::query(
        "INSERT OR REPLACE INTO completed_set (page_id, occurrence_date, clone_id) VALUES (?, ?, ?)",
    )
    .bind(&data.page_id)
    .bind(&occurrence_date)
    .bind(&clone_id)
    .execute(&mut *tx)
    .await?;

    // Gap "advance to today" dismisses the in-between occurrences to the skip-set.
    for date in &data.skip_dates {
        sqlx::query("INSERT OR IGNORE INTO skip_set (page_id, occurrence_date) VALUES (?, ?)")
            .bind(&data.page_id)
            .bind(date)
            .execute(&mut *tx)
            .await?;
    }

    // Advance the head off the completed + skipped dates (or mark done if the
    // series is exhausted) from truth, in the same tx.
    crate::recurrence_derive::recompute_recurring_schedule(&mut tx, &data.page_id).await?;

    tx.commit().await?;

    // Fetch updated results (post-commit so any FTS triggers have fired).
    let clone_row = sqlx::query_as::<_, PageSummaryRow>(&format!(
        // sql-ok: SUMMARY_COLUMNS is a compile-time constant
        "SELECT {SUMMARY_COLUMNS}{SYNC_DERIVED_SELECT} FROM pages WHERE id = ?"
    ))
    .bind(&clone_id)
    .fetch_one(pool)
    .await?;

    let head_row = sqlx::query_as::<_, PageSummaryRow>(&format!(
        // sql-ok: SUMMARY_COLUMNS is a compile-time constant
        "SELECT {SUMMARY_COLUMNS}{SYNC_DERIVED_SELECT} FROM pages WHERE id = ?"
    ))
    .bind(&data.page_id)
    .fetch_one(pool)
    .await?;

    Ok(CompleteRecurringResult {
        clone: PageSummary::from(clone_row),
        head: PageSummary::from(head_row),
    })
}

/// The live done clone recorded for `(page_id, occurrence_date)`, if any. `None`
/// when unrecorded or the clone was trashed out of band — the caller then
/// re-points the set row to a fresh clone.
async fn existing_completed_clone(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    page_id: &str,
    occurrence_date: &str,
) -> AppResult<Option<PageSummary>> {
    let clone_id: Option<String> = sqlx::query_scalar(
        "SELECT clone_id FROM completed_set WHERE page_id = ? AND occurrence_date = ?",
    )
    .bind(page_id)
    .bind(occurrence_date)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(clone_id) = clone_id else {
        return Ok(None);
    };
    let row = sqlx::query_as::<_, PageSummaryRow>(&format!(
        // sql-ok: SUMMARY_COLUMNS is a compile-time constant
        "SELECT {SUMMARY_COLUMNS}{SYNC_DERIVED_SELECT} FROM pages WHERE id = ? AND deleted_at IS NULL"
    ))
    .bind(&clone_id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(row.map(PageSummary::from))
}

/// Whether an active `page_sync` row owns this page — the guard that forks a write
/// on native vs reconciler-owned (synced) treatment.
async fn is_active_synced(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    page_id: &str,
) -> AppResult<bool> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM page_sync WHERE page_id = ? AND sync_state = 'active')",
    )
    .bind(page_id)
    .fetch_one(&mut **tx)
    .await?)
}

/// Whether `occurrence_date` (YYYY-MM-DD) is a real occurrence of the page's rule —
/// guards a synced completion, whose client-supplied virtual could otherwise key a
/// `completed_set` entry that matches nothing and stays open forever. Enumerates the
/// raw rule (no exclusions), so a moved override's `original_date` still counts; an
/// unparseable rule skips the check.
async fn synced_occurrence_is_valid(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    page_id: &str,
    occurrence_date: &str,
) -> AppResult<bool> {
    let rule: Option<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT rrule, scheduled_start, scheduled_end FROM page_recurrence_rules WHERE page_id = ?",
    )
    .bind(page_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((rrule, base_start, base_end)) = rule else {
        return Ok(false);
    };
    let day = &occurrence_date[..occurrence_date.len().min(10)];
    let (lo, hi) = (format!("{day}T00:00:00"), format!("{day}T23:59:59"));
    match pikos_recurrence::occurrences_in_window(
        &rrule,
        &base_start,
        base_end.as_deref(),
        &lo,
        &hi,
        &[],
    ) {
        Ok(occ) => Ok(occ.iter().any(|o| o.original_date.as_str() == day)),
        Err(_) => Ok(true),
    }
}

/// Drops the `completed_set` row and hard-deletes the done clone via the back-link.
/// Returns `false` when the date wasn't completed (no-op). Shared by native +
/// synced uncomplete; the native caller additionally recomputes the head.
async fn drop_completed_occurrence_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    page_id: &str,
    occurrence_date: &str,
) -> AppResult<bool> {
    let clone_id: Option<String> = sqlx::query_scalar(
        "SELECT clone_id FROM completed_set WHERE page_id = ? AND occurrence_date = ?",
    )
    .bind(page_id)
    .bind(occurrence_date)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(clone_id) = clone_id else {
        return Ok(false);
    };
    sqlx::query("DELETE FROM completed_set WHERE page_id = ? AND occurrence_date = ?")
        .bind(page_id)
        .bind(occurrence_date)
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM pages WHERE id = ?")
        .bind(&clone_id)
        .execute(&mut **tx)
        .await?;
    Ok(true)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UncompleteRecurringInput {
    pub page_id: String,
    pub occurrence_date: String,
}

/// Reverses a recurring completion (native or synced): drops the completed-set
/// entry and the done clone (via its back-link), then recomputes the head — which
/// un-marks `done`, or rewinds a synced head, once the series yields the occurrence
/// again. No-op if the date wasn't completed. Pre-swap native completions have no
/// back-link and are not uncompletable.
pub async fn uncomplete_recurring_occurrence_impl(
    pool: &sqlx::SqlitePool,
    data: UncompleteRecurringInput,
) -> AppResult<()> {
    crate::tx::retry_on_busy(|| async {
        let mut tx = pool.begin().await?;
        drop_completed_occurrence_tx(&mut tx, &data.page_id, &data.occurrence_date).await?;
        crate::recurrence_derive::recompute_recurring_schedule(&mut tx, &data.page_id).await?;
        tx.commit().await?;
        Ok(())
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkipOccurrenceInput {
    pub page_id: String,
    /// The rrule occurrence date to dismiss (YYYY-MM-DD).
    pub occurrence_date: String,
}

/// Dismisses one occurrence (native or synced) to the skip-set, then recomputes.
/// The skip-set is user state the reconciler never writes, so a synced skip
/// survives sync (expansion unions completed ∪ skip). Distinct from — and mutually
/// exclusive with — a *moved* occurrence (a `page_schedules` override). Undo is
/// [`undo_skip_occurrence_impl`].
pub async fn skip_occurrence_impl(
    pool: &sqlx::SqlitePool,
    data: SkipOccurrenceInput,
) -> AppResult<()> {
    crate::tx::retry_on_busy(|| async {
        let mut tx = pool.begin().await?;
        sqlx::query("INSERT OR IGNORE INTO skip_set (page_id, occurrence_date) VALUES (?, ?)")
            .bind(&data.page_id)
            .bind(&data.occurrence_date)
            .execute(&mut *tx)
            .await?;
        crate::recurrence_derive::recompute_recurring_schedule(&mut tx, &data.page_id).await?;
        tx.commit().await?;
        Ok(())
    })
    .await
}

/// Reverses a skip: drop the skip-set entry and recompute. No-op if the date
/// wasn't skipped.
pub async fn undo_skip_occurrence_impl(
    pool: &sqlx::SqlitePool,
    data: SkipOccurrenceInput,
) -> AppResult<()> {
    crate::tx::retry_on_busy(|| async {
        let mut tx = pool.begin().await?;
        sqlx::query("DELETE FROM skip_set WHERE page_id = ? AND occurrence_date = ?")
            .bind(&data.page_id)
            .bind(&data.occurrence_date)
            .execute(&mut *tx)
            .await?;
        crate::recurrence_derive::recompute_recurring_schedule(&mut tx, &data.page_id).await?;
        tx.commit().await?;
        Ok(())
    })
    .await
}

/// Heals the display cache for every recurring series on foreground load,
/// returning only the summaries whose head materially changed (`scheduled_start`
/// or `status`). Guards against a cache left stale by an out-of-process writer
/// (CLI/mobile) or a prior bug — the in-session path keeps it fresh on every
/// write, so the steady-state result is empty.
///
/// Active-synced series are included: their head floors at today
/// (`recurrence_derive::synced_head_floor`), so it goes stale by the calendar
/// rather than by a write, and the reconciler no-ops on an unchanged etag. This
/// heal is the only thing that advances them across a day boundary — skipping
/// them here would leave the head a day behind for any session that outlives
/// midnight.
pub async fn recompute_recurring_schedules_impl(
    pool: &sqlx::SqlitePool,
) -> AppResult<Vec<PageSummary>> {
    let page_ids: Vec<String> = sqlx::query_scalar(
        "SELECT r.page_id FROM page_recurrence_rules r
         JOIN pages p ON p.id = r.page_id
         WHERE p.deleted_at IS NULL",
    )
    .fetch_all(pool)
    .await?;

    let mut changed_ids = Vec::new();
    for pid in page_ids {
        let before: Option<(Option<String>, String)> =
            sqlx::query_as("SELECT scheduled_start, status FROM pages WHERE id = ?")
                .bind(&pid)
                .fetch_optional(pool)
                .await?;
        crate::recurrence_derive::recompute_recurring_schedule_pool(pool, &pid).await?;
        let after: Option<(Option<String>, String)> =
            sqlx::query_as("SELECT scheduled_start, status FROM pages WHERE id = ?")
                .bind(&pid)
                .fetch_optional(pool)
                .await?;
        if before != after {
            changed_ids.push(pid);
        }
    }
    if changed_ids.is_empty() {
        return Ok(Vec::new());
    }

    let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new(&format!(
        "SELECT {SUMMARY_COLUMNS}{SYNC_DERIVED_SELECT} FROM pages WHERE id IN ("
    ));
    let mut sep = builder.separated(", ");
    for id in &changed_ids {
        sep.push_bind(id);
    }
    sep.push_unseparated(")");
    let rows = builder
        .build_query_as::<PageSummaryRow>()
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(PageSummary::from).collect())
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
    // Rescheduling an occurrence rewrites the rule's schedule/exdates — locked on
    // a synced series. Reject before the retry loop.
    crate::schedules::ensure_rule_row_unlocked(pool, &data.rule_id).await?;
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
    let head = sqlx::query_as::<_, PageRow>(&format!(
        "SELECT *{SYNC_DERIVED_SELECT} FROM pages WHERE id = ? AND deleted_at IS NULL"
    ))
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

    // The exclusion set grew (the detached date), so re-derive the head. A no-op
    // when the moved occurrence is a future virtual (head unaffected), but the
    // trigger surface must be exhaustive — the CI shadow invariant is the backstop.
    crate::recurrence_derive::recompute_recurring_schedule(&mut tx, &page_id).await?;

    tx.commit().await?;

    // Fetch post-commit so any FTS triggers have fired.
    let clone_row = sqlx::query_as::<_, PageSummaryRow>(&format!(
        // sql-ok: SUMMARY_COLUMNS is a compile-time constant
        "SELECT {SUMMARY_COLUMNS}{SYNC_DERIVED_SELECT} FROM pages WHERE id = ?"
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
    let row = sqlx::query_as::<_, PageRow>(&format!(
        "SELECT *{SYNC_DERIVED_SELECT} FROM pages WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(Page::from))
}

#[cfg(test)]
#[path = "pages_tests.rs"]
mod pages_tests;

#[cfg(test)]
#[path = "shadow_invariant_tests.rs"]
mod shadow_invariant_tests;

#[cfg(test)]
#[path = "pages_concurrency_tests.rs"]
mod pages_concurrency_tests;
