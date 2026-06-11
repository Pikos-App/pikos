//! Pool-based mirror of the desktop app's per-page reminder commands. The
//! desktop `db::notifications` commands delegate here so the write path is
//! exercised by `cargo test` without a live Tauri runtime.

use serde::Serialize;

use crate::error::AppResult;
use crate::pool::now_iso;

#[derive(sqlx::FromRow)]
struct PageReminderRow {
    id: String,
    page_id: String,
    minutes_before: i64,
    created_at: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
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

/// Insert a reminder for a page. `minutes_before` is minutes ahead of the
/// scheduled start (0 = at start, -1 = the "no reminders" sentinel).
pub async fn create_page_reminder(
    pool: &sqlx::SqlitePool,
    page_id: &str,
    minutes_before: i64,
) -> AppResult<PageReminder> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();

    sqlx::query(
        "INSERT INTO page_reminders (id, page_id, minutes_before, created_at)
         VALUES (?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(page_id)
    .bind(minutes_before)
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(PageReminder {
        id,
        page_id: page_id.to_string(),
        minutes_before,
        created_at: now,
    })
}

/// Reminders for a page, soonest-first (smallest `minutes_before`).
pub async fn list_page_reminders(
    pool: &sqlx::SqlitePool,
    page_id: &str,
) -> AppResult<Vec<PageReminder>> {
    let rows = sqlx::query_as::<_, PageReminderRow>(
        "SELECT * FROM page_reminders WHERE page_id = ? ORDER BY minutes_before ASC",
    )
    .bind(page_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(PageReminder::from).collect())
}

pub async fn delete_page_reminder(pool: &sqlx::SqlitePool, id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM page_reminders WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Delete every reminder for a page (used when resetting to "use default").
pub async fn delete_page_reminders(pool: &sqlx::SqlitePool, page_id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM page_reminders WHERE page_id = ?")
        .bind(page_id)
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
#[path = "reminders_tests.rs"]
mod reminders_tests;
