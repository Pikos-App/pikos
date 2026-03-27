use serde::{Deserialize, Serialize};
use tauri::State;

use super::{now_iso, DbState};

// ─── PageSchedule ──────────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct PageScheduleRow {
    id: String,
    page_id: String,
    scheduled_start: String,
    scheduled_end: Option<String>,
    timezone: Option<String>,
    rule_id: Option<String>,
    original_date: Option<String>,
    status: String,
    created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSchedule {
    pub id: String,
    pub page_id: String,
    pub scheduled_start: String,
    pub scheduled_end: Option<String>,
    pub timezone: Option<String>,
    pub rule_id: Option<String>,
    pub original_date: Option<String>,
    pub status: String,
    pub created_at: String,
}

impl From<PageScheduleRow> for PageSchedule {
    fn from(row: PageScheduleRow) -> Self {
        PageSchedule {
            id: row.id,
            page_id: row.page_id,
            scheduled_start: row.scheduled_start,
            scheduled_end: row.scheduled_end,
            timezone: row.timezone,
            rule_id: row.rule_id,
            original_date: row.original_date,
            status: row.status,
            created_at: row.created_at,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPageSchedule {
    pub page_id: String,
    pub scheduled_start: String,
    pub scheduled_end: Option<String>,
    pub timezone: Option<String>,
    pub rule_id: Option<String>,
    pub original_date: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PageScheduleUpdate {
    pub scheduled_start: Option<String>,
    pub scheduled_end: Option<serde_json::Value>, // Value::Null clears it
    pub status: Option<String>,
}

// ─── PageRecurrenceRule ────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct RecurrenceRuleRow {
    id: String,
    page_id: String,
    rrule: String,
    rrule_exdates: String, // JSON array
    scheduled_start: String,
    scheduled_end: Option<String>,
    timezone: String,
    created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRecurrenceRule {
    pub id: String,
    pub page_id: String,
    pub rrule: String,
    pub rrule_exdates: Vec<String>,
    pub scheduled_start: String,
    pub scheduled_end: Option<String>,
    pub timezone: String,
    pub created_at: String,
}

impl From<RecurrenceRuleRow> for PageRecurrenceRule {
    fn from(row: RecurrenceRuleRow) -> Self {
        let rrule_exdates: Vec<String> =
            serde_json::from_str(&row.rrule_exdates).unwrap_or_default();
        PageRecurrenceRule {
            id: row.id,
            page_id: row.page_id,
            rrule: row.rrule,
            rrule_exdates,
            scheduled_start: row.scheduled_start,
            scheduled_end: row.scheduled_end,
            timezone: row.timezone,
            created_at: row.created_at,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewRecurrenceRule {
    pub page_id: String,
    pub rrule: String,
    #[serde(default)]
    pub rrule_exdates: Vec<String>,
    pub scheduled_start: String,
    pub scheduled_end: Option<String>,
    pub timezone: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RecurrenceRuleUpdate {
    pub rrule: Option<String>,
    pub rrule_exdates: Option<Vec<String>>,
    pub scheduled_start: Option<String>,
    pub scheduled_end: Option<serde_json::Value>, // Value::Null clears it
    pub timezone: Option<String>,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Refreshes pages.scheduled_start/end to the nearest schedule for this page
/// (non-override rows only): prefers the earliest upcoming schedule; falls back
/// to the most recent past schedule if no future one exists.
/// Clears to NULL when no explicit schedules remain.
async fn refresh_schedule_denorm(pool: &sqlx::SqlitePool, page_id: &str) -> Result<(), String> {
    #[derive(sqlx::FromRow)]
    struct Denorm {
        scheduled_start: String,
        scheduled_end: Option<String>,
    }

    let row = sqlx::query_as::<_, Denorm>(
        "SELECT scheduled_start, scheduled_end
         FROM page_schedules
         WHERE page_id = ? AND rule_id IS NULL
         ORDER BY
           CASE WHEN scheduled_start >= strftime('%Y-%m-%dT%H:%M:%S', 'now') THEN 0 ELSE 1 END ASC,
           scheduled_start ASC
         LIMIT 1",
    )
    .bind(page_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    match row {
        Some(d) => {
            sqlx::query(
                "UPDATE pages SET scheduled_start = ?, scheduled_end = ? WHERE id = ?",
            )
            .bind(&d.scheduled_start)
            .bind(&d.scheduled_end)
            .bind(page_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        }
        None => {
            sqlx::query(
                "UPDATE pages SET scheduled_start = NULL, scheduled_end = NULL WHERE id = ?",
            )
            .bind(page_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

async fn fetch_schedule(pool: &sqlx::SqlitePool, id: &str) -> Result<PageSchedule, String> {
    sqlx::query_as::<_, PageScheduleRow>("SELECT * FROM page_schedules WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Schedule not found: {id}"))
        .map(PageSchedule::from)
}

async fn fetch_rule(pool: &sqlx::SqlitePool, id: &str) -> Result<PageRecurrenceRule, String> {
    sqlx::query_as::<_, RecurrenceRuleRow>(
        "SELECT * FROM page_recurrence_rules WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("Recurrence rule not found: {id}"))
    .map(PageRecurrenceRule::from)
}

// ─── Schedule commands ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn create_page_schedule(
    state: State<'_, DbState>,
    data: NewPageSchedule,
) -> Result<PageSchedule, String> {
    let pool = state.get_pool().await?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();

    sqlx::query(
        "INSERT INTO page_schedules
         (id, page_id, scheduled_start, scheduled_end, timezone, rule_id, original_date, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'not_started', ?)",
    )
    .bind(&id)
    .bind(&data.page_id)
    .bind(&data.scheduled_start)
    .bind(&data.scheduled_end)
    .bind(&data.timezone)
    .bind(&data.rule_id)
    .bind(&data.original_date)
    .bind(&now)
    .execute(&pool)
    .await
    .map_err(|e| e.to_string())?;

    refresh_schedule_denorm(&pool, &data.page_id).await?;

    fetch_schedule(&pool, &id).await
}

#[tauri::command]
pub async fn update_page_schedule(
    state: State<'_, DbState>,
    id: String,
    updates: PageScheduleUpdate,
) -> Result<PageSchedule, String> {
    let pool = state.get_pool().await?;

    let mut builder =
        sqlx::QueryBuilder::<sqlx::Sqlite>::new("UPDATE page_schedules SET ");
    let mut sep = builder.separated(", ");
    let mut has_updates = false;

    if let Some(v) = updates.scheduled_start {
        sep.push("scheduled_start = ");
        sep.push_bind_unseparated(v);
        has_updates = true;
    }
    if let Some(v) = updates.status {
        sep.push("status = ");
        sep.push_bind_unseparated(v);
        has_updates = true;
    }
    if let Some(val) = updates.scheduled_end {
        sep.push("scheduled_end = ");
        match val {
            serde_json::Value::Null => sep.push_bind_unseparated(None::<String>),
            serde_json::Value::String(s) => sep.push_bind_unseparated(s),
            _ => sep.push_bind_unseparated(None::<String>),
        };
        has_updates = true;
    }

    if !has_updates {
        return fetch_schedule(&pool, &id).await;
    }

    drop(sep);
    builder.push(" WHERE id = ");
    builder.push_bind(&id);

    builder
        .build()
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

    let schedule = fetch_schedule(&pool, &id).await?;
    refresh_schedule_denorm(&pool, &schedule.page_id).await?;
    Ok(schedule)
}

#[tauri::command]
pub async fn delete_page_schedule(
    state: State<'_, DbState>,
    id: String,
) -> Result<(), String> {
    let pool = state.get_pool().await?;

    let page_id: Option<String> =
        sqlx::query_scalar("SELECT page_id FROM page_schedules WHERE id = ?")
            .bind(&id)
            .fetch_optional(&pool)
            .await
            .map_err(|e| e.to_string())?;

    sqlx::query("DELETE FROM page_schedules WHERE id = ?")
        .bind(&id)
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

    if let Some(pid) = page_id {
        refresh_schedule_denorm(&pool, &pid).await?;
    }

    Ok(())
}

#[tauri::command]
pub async fn list_page_schedules(
    state: State<'_, DbState>,
    page_id: String,
) -> Result<Vec<PageSchedule>, String> {
    let pool = state.get_pool().await?;
    let rows = sqlx::query_as::<_, PageScheduleRow>(
        "SELECT * FROM page_schedules WHERE page_id = ? ORDER BY scheduled_start ASC",
    )
    .bind(&page_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(PageSchedule::from).collect())
}

/// Returns all schedule rows that overlap [start, end] (YYYY-MM-DD).
/// All-day single: scheduled_end IS NULL, start must be within range.
/// Multi-day / timed with end: overlaps if start <= range_end AND end >= range_start.
#[tauri::command]
pub async fn list_page_schedules_range(
    state: State<'_, DbState>,
    start: String,
    end: String,
) -> Result<Vec<PageSchedule>, String> {
    let pool = state.get_pool().await?;
    let rows = sqlx::query_as::<_, PageScheduleRow>(
        "SELECT page_schedules.* FROM page_schedules
         JOIN pages ON pages.id = page_schedules.page_id
         WHERE pages.deleted_at IS NULL
           AND ((page_schedules.scheduled_end IS NULL AND date(page_schedules.scheduled_start) BETWEEN ? AND ?)
             OR (page_schedules.scheduled_end IS NOT NULL
                 AND date(page_schedules.scheduled_start) <= ?
                 AND date(page_schedules.scheduled_end)   >= ?))
         ORDER BY page_schedules.scheduled_start ASC",
    )
    .bind(&start)
    .bind(&end)
    .bind(&end)
    .bind(&start)
    .fetch_all(&pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(PageSchedule::from).collect())
}

// ─── Recurrence rule commands ─────────────────────────────────────────────────

#[tauri::command]
pub async fn create_recurrence_rule(
    state: State<'_, DbState>,
    data: NewRecurrenceRule,
) -> Result<PageRecurrenceRule, String> {
    let pool = state.get_pool().await?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    let exdates_json =
        serde_json::to_string(&data.rrule_exdates).unwrap_or_else(|_| "[]".to_string());

    sqlx::query(
        "INSERT INTO page_recurrence_rules
         (id, page_id, rrule, rrule_exdates, scheduled_start, scheduled_end, timezone, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&data.page_id)
    .bind(&data.rrule)
    .bind(&exdates_json)
    .bind(&data.scheduled_start)
    .bind(&data.scheduled_end)
    .bind(&data.timezone)
    .bind(&now)
    .execute(&pool)
    .await
    .map_err(|e| e.to_string())?;

    fetch_rule(&pool, &id).await
}

#[tauri::command]
pub async fn update_recurrence_rule(
    state: State<'_, DbState>,
    id: String,
    updates: RecurrenceRuleUpdate,
) -> Result<PageRecurrenceRule, String> {
    let pool = state.get_pool().await?;

    let mut builder =
        sqlx::QueryBuilder::<sqlx::Sqlite>::new("UPDATE page_recurrence_rules SET ");
    let mut sep = builder.separated(", ");
    let mut has_updates = false;

    if let Some(v) = updates.rrule {
        sep.push("rrule = ");
        sep.push_bind_unseparated(v);
        has_updates = true;
    }
    if let Some(v) = updates.rrule_exdates {
        let json = serde_json::to_string(&v).unwrap_or_else(|_| "[]".to_string());
        sep.push("rrule_exdates = ");
        sep.push_bind_unseparated(json);
        has_updates = true;
    }
    if let Some(v) = updates.scheduled_start {
        sep.push("scheduled_start = ");
        sep.push_bind_unseparated(v);
        has_updates = true;
    }
    if let Some(v) = updates.timezone {
        sep.push("timezone = ");
        sep.push_bind_unseparated(v);
        has_updates = true;
    }
    if let Some(val) = updates.scheduled_end {
        sep.push("scheduled_end = ");
        match val {
            serde_json::Value::Null => sep.push_bind_unseparated(None::<String>),
            serde_json::Value::String(s) => sep.push_bind_unseparated(s),
            _ => sep.push_bind_unseparated(None::<String>),
        };
        has_updates = true;
    }

    if !has_updates {
        return fetch_rule(&pool, &id).await;
    }

    drop(sep);
    builder.push(" WHERE id = ");
    builder.push_bind(&id);

    builder
        .build()
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

    fetch_rule(&pool, &id).await
}

#[tauri::command]
pub async fn delete_recurrence_rule(
    state: State<'_, DbState>,
    id: String,
) -> Result<(), String> {
    let pool = state.get_pool().await?;
    // Cascades to page_schedules rows with rule_id = id
    sqlx::query("DELETE FROM page_recurrence_rules WHERE id = ?")
        .bind(&id)
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_recurrence_rule(
    state: State<'_, DbState>,
    page_id: String,
) -> Result<Option<PageRecurrenceRule>, String> {
    let pool = state.get_pool().await?;
    let row = sqlx::query_as::<_, RecurrenceRuleRow>(
        "SELECT * FROM page_recurrence_rules WHERE page_id = ?",
    )
    .bind(&page_id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.map(PageRecurrenceRule::from))
}
