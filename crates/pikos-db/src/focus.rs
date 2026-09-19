//! `focus_sessions` — how long the user actually sat with a page open.
//!
//! The table has existed since migration 001 and `get_usage_stats` has counted
//! it into the Data panel's "Focus time" card all along, but nothing ever wrote
//! a row: the card has been showing a hard zero that reads as a measurement.
//! This is the writer that makes it honest.
//!
//! One row per completed session. The frontend times the session and writes on
//! stop, so `started_at`/`ended_at` come in from the caller rather than being
//! stamped here — a session that spans a suspend or a clock change is still the
//! wall-clock span the user lived through, and `duration_s` is what the totals
//! sum, so it is stored rather than recomputed from the two timestamps.

use serde::Serialize;

use crate::error::{AppError, AppResult};

#[derive(Debug, Serialize, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields = nullable)]
pub struct FocusSession {
    pub id: String,
    pub page_id: String,
    pub started_at: String,
    pub ended_at: String,
    #[ts(type = "number")]
    pub duration_s: i64,
}

/// Record one finished focus session against a page.
///
/// Two refusals, both because a bad row here is invisible rather than loud — it
/// lands in a sum on a settings card, where a negative or orphaned session shows
/// up as a total nobody can explain:
///
/// - `duration_s` must be positive. Zero or negative is a caller bug (a clock
///   that went backwards, a stop that raced the start), not a zero-length
///   session worth keeping.
/// - the page must exist. The column is `ON DELETE SET NULL`, so a row written
///   against a deleted page would still count toward the totals while belonging
///   to nothing — indistinguishable from a session whose page was trashed later,
///   which is a state the app deliberately keeps.
pub async fn create_focus_session(
    pool: &sqlx::SqlitePool,
    page_id: &str,
    started_at: &str,
    ended_at: &str,
    duration_s: i64,
) -> AppResult<FocusSession> {
    if duration_s <= 0 {
        return Err(AppError::Invalid(format!(
            "focus session duration must be positive, got {duration_s}"
        )));
    }

    let exists: Option<String> = sqlx::query_scalar("SELECT id FROM pages WHERE id = ?")
        .bind(page_id)
        .fetch_optional(pool)
        .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!("Page not found: {page_id}")));
    }

    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO focus_sessions (id, page_id, started_at, ended_at, duration_s)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(page_id)
    .bind(started_at)
    .bind(ended_at)
    .bind(duration_s)
    .execute(pool)
    .await?;

    Ok(FocusSession {
        id,
        page_id: page_id.to_string(),
        started_at: started_at.to_string(),
        ended_at: ended_at.to_string(),
        duration_s,
    })
}

#[cfg(test)]
#[path = "focus_tests.rs"]
mod focus_tests;
