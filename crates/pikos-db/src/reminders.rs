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

#[derive(Debug, Serialize, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields = nullable)]
pub struct PageReminder {
    pub id: String,
    pub page_id: String,
    #[ts(type = "number")]
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

/// `minutes_before` meaning "no reminders for this page".
pub const NO_REMINDERS: i64 = -1;

/// Add a reminder to a page. `minutes_before` is minutes ahead of the scheduled start (0 = at
/// start), or [`NO_REMINDERS`].
///
/// A page holds "no reminders" or real reminders, never both, and each lead once: "no reminders"
/// replaces the page's reminders, a real one replaces "no reminders", and a lead the page already
/// has returns that row. Every caller gets the same rules, and sync's settling of two devices'
/// edits relies on no device holding a page any other way.
pub async fn create_page_reminder(
    pool: &sqlx::SqlitePool,
    page_id: &str,
    minutes_before: i64,
) -> AppResult<PageReminder> {
    crate::tx::retry_on_busy(|| async {
        let mut tx = pool.begin().await?;
        let replaced = if minutes_before == NO_REMINDERS {
            "DELETE FROM page_reminders WHERE page_id = ? AND minutes_before <> ?"
        } else {
            "DELETE FROM page_reminders WHERE page_id = ? AND minutes_before = ?"
        };
        sqlx::query(replaced)
            .bind(page_id)
            .bind(NO_REMINDERS)
            .execute(&mut *tx)
            .await?;

        let existing = sqlx::query_as::<_, PageReminderRow>(
            "SELECT * FROM page_reminders WHERE page_id = ? AND minutes_before = ?",
        )
        .bind(page_id)
        .bind(minutes_before)
        .fetch_optional(&mut *tx)
        .await?;
        let reminder = match existing {
            Some(row) => PageReminder::from(row),
            None => {
                let reminder = PageReminder {
                    id: uuid::Uuid::new_v4().to_string(),
                    page_id: page_id.to_string(),
                    minutes_before,
                    created_at: now_iso(),
                };
                sqlx::query(
                    "INSERT INTO page_reminders (id, page_id, minutes_before, created_at)
                     VALUES (?, ?, ?, ?)",
                )
                .bind(&reminder.id)
                .bind(page_id)
                .bind(minutes_before)
                .bind(&reminder.created_at)
                .execute(&mut *tx)
                .await?;
                reminder
            }
        };
        tx.commit().await?;
        Ok(reminder)
    })
    .await
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
