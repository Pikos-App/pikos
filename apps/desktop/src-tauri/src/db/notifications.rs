use serde::{Deserialize, Serialize};
use tauri::State;

use super::{now_iso, DbState};

// ─── PageReminder ─────────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct PageReminderRow {
    id: String,
    page_id: String,
    minutes_before: i64,
    created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageReminder {
    pub id: String,
    pub page_id: String,
    pub minutes_before: i64,
    pub created_at: String,
}

impl From<PageReminderRow> for PageReminder {
    fn from(row: PageReminderRow) -> Self {
        PageReminder {
            id: row.id,
            page_id: row.page_id,
            minutes_before: row.minutes_before,
            created_at: row.created_at,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPageReminder {
    pub page_id: String,
    pub minutes_before: i64,
}

// ─── NotificationLogEntry ─────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct NotificationLogRow {
    id: String,
    page_id: Option<String>,
    schedule_id: Option<String>,
    #[sqlx(rename = "type")]
    kind: String,
    fired_at: String,
    action: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationLogEntry {
    pub id: String,
    pub page_id: Option<String>,
    pub schedule_id: Option<String>,
    #[serde(rename = "type")]
    pub kind: String,
    pub fired_at: String,
    pub action: Option<String>,
}

impl From<NotificationLogRow> for NotificationLogEntry {
    fn from(row: NotificationLogRow) -> Self {
        NotificationLogEntry {
            id: row.id,
            page_id: row.page_id,
            schedule_id: row.schedule_id,
            kind: row.kind,
            fired_at: row.fired_at,
            action: row.action,
        }
    }
}

// ─── PageReminder commands ───────────────────────────────────────────────────

#[tauri::command]
pub async fn create_page_reminder(
    state: State<'_, DbState>,
    data: NewPageReminder,
) -> Result<PageReminder, String> {
    let pool = state.get_pool().await?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();

    sqlx::query(
        "INSERT INTO page_reminders (id, page_id, minutes_before, created_at)
         VALUES (?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&data.page_id)
    .bind(data.minutes_before)
    .bind(&now)
    .execute(&pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(PageReminder {
        id,
        page_id: data.page_id,
        minutes_before: data.minutes_before,
        created_at: now,
    })
}

#[tauri::command]
pub async fn list_page_reminders(
    state: State<'_, DbState>,
    page_id: String,
) -> Result<Vec<PageReminder>, String> {
    let pool = state.get_pool().await?;
    let rows = sqlx::query_as::<_, PageReminderRow>(
        "SELECT * FROM page_reminders WHERE page_id = ? ORDER BY minutes_before ASC",
    )
    .bind(&page_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(PageReminder::from).collect())
}

#[tauri::command]
pub async fn delete_page_reminder(
    state: State<'_, DbState>,
    id: String,
) -> Result<(), String> {
    let pool = state.get_pool().await?;
    sqlx::query("DELETE FROM page_reminders WHERE id = ?")
        .bind(&id)
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Delete all reminders for a page (used when resetting to "use default").
#[tauri::command]
pub async fn delete_page_reminders(
    state: State<'_, DbState>,
    page_id: String,
) -> Result<(), String> {
    let pool = state.get_pool().await?;
    sqlx::query("DELETE FROM page_reminders WHERE page_id = ?")
        .bind(&page_id)
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
