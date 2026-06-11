//! Pool-based queries behind the desktop notification scheduler.
//!
//! The scheduler (`apps/desktop/.../notifications/scheduler`) owns timing,
//! quiet-hours logic, settings, and OS delivery. The SQLite read/write here is
//! split out so it runs under `cargo test` against an in-memory pool without a
//! Tauri runtime.
//!
//! These functions return `sqlx::Error` directly (not `AppResult`): the
//! scheduler's run loop logs a content-free error class via `classify_sqlx`
//! rather than the sqlx `Display` output, which can echo SQL fragments and
//! parameter values (titles, etc.). Surfacing the raw error type preserves that
//! discipline at the call site.

use sqlx::SqlitePool;

/// A schedule occurrence whose reminder is due to fire.
#[derive(sqlx::FromRow, Clone, Debug)]
pub struct DueReminder {
    pub schedule_id: String,
    pub page_id: String,
    pub title: String,
    pub scheduled_start: String,
    pub minutes_before: i64,
}

/// Pages with explicit `page_reminders` rows whose lead time lands in
/// `(window_start, now_ts]`. All-day events (no `T` in `scheduled_start`) are
/// excluded — they'd fire at midnight-minus-N. Already-fired reminders are
/// skipped via the `notification_log` dedup row.
pub async fn due_explicit_reminders(
    pool: &SqlitePool,
    window_start: &str,
    now_ts: &str,
) -> Result<Vec<DueReminder>, sqlx::Error> {
    sqlx::query_as(
        "SELECT ps.id AS schedule_id, ps.page_id, p.title,
                ps.scheduled_start, pr.minutes_before
         FROM page_schedules ps
         JOIN pages p ON p.id = ps.page_id
         JOIN page_reminders pr ON pr.page_id = ps.page_id
         WHERE p.status != 'done'
           AND p.deleted_at IS NULL
           AND ps.status != 'done'
           AND pr.minutes_before >= 0
           AND ps.scheduled_start LIKE '%T%'
           AND NOT (
             ps.rule_id IS NULL
             AND EXISTS (SELECT 1 FROM page_recurrence_rules r WHERE r.page_id = ps.page_id)
           )
           AND datetime(ps.scheduled_start, '-' || pr.minutes_before || ' minutes')
               BETWEEN ? AND ?
           AND NOT EXISTS (
             SELECT 1 FROM notification_log nl
             WHERE nl.schedule_id = ps.id
               AND nl.type = 'reminder'
           )",
    )
    .bind(window_start)
    .bind(now_ts)
    .fetch_all(pool)
    .await
}

/// Pages *without* `page_reminders` rows — use the global `default_minutes`
/// lead time. All-day events and already-fired reminders are excluded as above.
pub async fn due_default_reminders(
    pool: &SqlitePool,
    default_minutes: i64,
    window_start: &str,
    now_ts: &str,
) -> Result<Vec<DueReminder>, sqlx::Error> {
    sqlx::query_as(
        "SELECT ps.id AS schedule_id, ps.page_id, p.title,
                ps.scheduled_start, ? AS minutes_before
         FROM page_schedules ps
         JOIN pages p ON p.id = ps.page_id
         WHERE p.status != 'done'
           AND p.deleted_at IS NULL
           AND ps.status != 'done'
           AND ps.scheduled_start LIKE '%T%'
           AND NOT EXISTS (
             SELECT 1 FROM page_reminders pr WHERE pr.page_id = ps.page_id
           )
           AND NOT (
             ps.rule_id IS NULL
             AND EXISTS (SELECT 1 FROM page_recurrence_rules r WHERE r.page_id = ps.page_id)
           )
           AND datetime(ps.scheduled_start, '-' || ? || ' minutes')
               BETWEEN ? AND ?
           AND NOT EXISTS (
             SELECT 1 FROM notification_log nl
             WHERE nl.schedule_id = ps.id
               AND nl.type = 'reminder'
           )",
    )
    .bind(default_minutes)
    .bind(default_minutes)
    .bind(window_start)
    .bind(now_ts)
    .fetch_all(pool)
    .await
}

// ─── Recurring head reminders ────────────────────────────────────────────────
//
// rrule-backed pages don't store a `page_schedules` row per occurrence — the
// current occurrence ("head") lives in `pages.scheduled_start`, advanced by
// `complete_recurring_page_impl`. The page_schedules queries above deliberately
// skip such pages' stale `rule_id IS NULL` anchor rows, so reminders for
// recurring pages come from here instead: fire off the head, keyed for dedup by
// a synthetic `page_id@scheduled_start` id so each occurrence reminds exactly
// once and completing the head (which advances `scheduled_start`) naturally
// re-arms the next occurrence and suppresses the just-completed one.
//
// A head that coincides with a materialized override row (`rule_id IS NOT NULL`
// at the same start) is skipped here — the override row drives that reminder via
// the page_schedules query, so it can't double-fire.

/// Recurring pages with explicit `page_reminders` rows whose lead time off the
/// head lands in `(window_start, now_ts]`. Dedup id encodes the lead time so
/// multiple reminders on one occurrence stay independent.
pub async fn due_recurring_explicit_reminders(
    pool: &SqlitePool,
    window_start: &str,
    now_ts: &str,
) -> Result<Vec<DueReminder>, sqlx::Error> {
    sqlx::query_as(
        "SELECT (p.id || '@' || p.scheduled_start || '#' || pr.minutes_before) AS schedule_id,
                p.id AS page_id, p.title, p.scheduled_start, pr.minutes_before
         FROM pages p
         JOIN page_recurrence_rules r ON r.page_id = p.id
         JOIN page_reminders pr ON pr.page_id = p.id
         WHERE p.status != 'done'
           AND p.deleted_at IS NULL
           AND pr.minutes_before >= 0
           AND p.scheduled_start LIKE '%T%'
           AND datetime(p.scheduled_start, '-' || pr.minutes_before || ' minutes')
               BETWEEN ? AND ?
           AND NOT EXISTS (
             SELECT 1 FROM page_schedules ps
             WHERE ps.page_id = p.id AND ps.rule_id IS NOT NULL
               AND ps.scheduled_start = p.scheduled_start
           )
           AND NOT EXISTS (
             SELECT 1 FROM notification_log nl
             WHERE nl.schedule_id = (p.id || '@' || p.scheduled_start || '#' || pr.minutes_before)
               AND nl.type = 'reminder'
           )",
    )
    .bind(window_start)
    .bind(now_ts)
    .fetch_all(pool)
    .await
}

/// Recurring pages *without* `page_reminders` rows — use the global default
/// lead time off the head. Dedup id is `page_id@scheduled_start`.
pub async fn due_recurring_default_reminders(
    pool: &SqlitePool,
    default_minutes: i64,
    window_start: &str,
    now_ts: &str,
) -> Result<Vec<DueReminder>, sqlx::Error> {
    sqlx::query_as(
        "SELECT (p.id || '@' || p.scheduled_start) AS schedule_id,
                p.id AS page_id, p.title, p.scheduled_start, ? AS minutes_before
         FROM pages p
         JOIN page_recurrence_rules r ON r.page_id = p.id
         WHERE p.status != 'done'
           AND p.deleted_at IS NULL
           AND p.scheduled_start LIKE '%T%'
           AND NOT EXISTS (
             SELECT 1 FROM page_reminders pr WHERE pr.page_id = p.id
           )
           AND datetime(p.scheduled_start, '-' || ? || ' minutes')
               BETWEEN ? AND ?
           AND NOT EXISTS (
             SELECT 1 FROM page_schedules ps
             WHERE ps.page_id = p.id AND ps.rule_id IS NOT NULL
               AND ps.scheduled_start = p.scheduled_start
           )
           AND NOT EXISTS (
             SELECT 1 FROM notification_log nl
             WHERE nl.schedule_id = (p.id || '@' || p.scheduled_start)
               AND nl.type = 'reminder'
           )",
    )
    .bind(default_minutes)
    .bind(default_minutes)
    .bind(window_start)
    .bind(now_ts)
    .fetch_all(pool)
    .await
}

/// Whether the daily-summary marker row was already inserted on `date`
/// (`date(fired_at) = date`). The marker is `type='overdue'` with both
/// `page_id` and `schedule_id` NULL.
pub async fn daily_summary_fired_on(pool: &SqlitePool, date: &str) -> Result<bool, sqlx::Error> {
    let count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM notification_log
         WHERE type = 'overdue'
           AND page_id IS NULL
           AND schedule_id IS NULL
           AND date(fired_at) = ?",
    )
    .bind(date)
    .fetch_one(pool)
    .await?;
    Ok(count.0 > 0)
}

/// Count of distinct pages scheduled on `date` (timed or all-day), not done.
pub async fn today_scheduled_count(pool: &SqlitePool, date: &str) -> Result<i64, sqlx::Error> {
    let row: (i64,) = sqlx::query_as(
        "SELECT COUNT(DISTINCT ps.page_id)
         FROM page_schedules ps
         JOIN pages p ON p.id = ps.page_id
         WHERE p.status != 'done'
           AND p.deleted_at IS NULL
           AND ps.status != 'done'
           AND date(ps.scheduled_start) = ?",
    )
    .bind(date)
    .fetch_one(pool)
    .await?;
    Ok(row.0)
}

/// Count of distinct timed, not-done pages overdue in `[stale_cutoff, now_ts)`,
/// excluding pages created after `recent_cutoff` (skips fresh import batches).
pub async fn overdue_count(
    pool: &SqlitePool,
    now_ts: &str,
    stale_cutoff: &str,
    recent_cutoff: &str,
) -> Result<i64, sqlx::Error> {
    let row: (i64,) = sqlx::query_as(
        "SELECT COUNT(DISTINCT ps.page_id)
         FROM page_schedules ps
         JOIN pages p ON p.id = ps.page_id
         WHERE p.status != 'done'
           AND p.deleted_at IS NULL
           AND ps.status != 'done'
           AND ps.scheduled_start LIKE '%T%'
           AND datetime(ps.scheduled_start) < datetime(?)
           AND datetime(ps.scheduled_start) >= datetime(?)
           AND datetime(p.created_at) < datetime(?)",
    )
    .bind(now_ts)
    .bind(stale_cutoff)
    .bind(recent_cutoff)
    .fetch_one(pool)
    .await?;
    Ok(row.0)
}

/// Record that a per-reminder notification fired (dedup anchor for future ticks).
pub async fn log_reminder_fired(
    pool: &SqlitePool,
    page_id: &str,
    schedule_id: &str,
    fired_at: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO notification_log (id, page_id, schedule_id, type, fired_at)
         VALUES (?, ?, ?, 'reminder', ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(page_id)
    .bind(schedule_id)
    .bind(fired_at)
    .execute(pool)
    .await?;
    Ok(())
}

/// Insert the daily-summary marker row (one per local day).
pub async fn log_daily_summary(pool: &SqlitePool, fired_at: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO notification_log (id, page_id, schedule_id, type, fired_at)
         VALUES (?, NULL, NULL, 'overdue', ?)",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(fired_at)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn prune_notification_log(pool: &SqlitePool, cutoff: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM notification_log WHERE datetime(fired_at) < datetime(?)")
        .bind(cutoff)
        .execute(pool)
        .await?;
    Ok(())
}

/// Diagnostic snapshot of a page at the moment one of its reminders fires.
///
/// Used only for logging so we can tell *why* a reminder fired for a page the
/// user believes is complete. The smoking-gun signals:
/// - `has_rule = 1` with `page_scheduled_start` != the firing row's
///   `scheduled_start` → recurring drift (the head advanced but the reminder
///   keyed off a stale `page_schedules` row).
/// - `status = 'done'` here should be impossible (the due queries filter it
///   out); seeing it would point at a TOCTOU between the query and this read.
#[derive(sqlx::FromRow, Debug)]
pub struct ReminderFireDiagnostics {
    pub status: String,
    pub completed_at: Option<String>,
    pub page_scheduled_start: Option<String>,
    pub has_rule: i64,
}

/// Fetch the diagnostic snapshot for `page_id`. Returns `None` if the page is
/// gone (e.g. deleted between the due query and this read).
pub async fn reminder_fire_diagnostics(
    pool: &SqlitePool,
    page_id: &str,
) -> Result<Option<ReminderFireDiagnostics>, sqlx::Error> {
    sqlx::query_as(
        "SELECT p.status,
                p.completed_at,
                p.scheduled_start AS page_scheduled_start,
                EXISTS(SELECT 1 FROM page_recurrence_rules r WHERE r.page_id = p.id) AS has_rule
         FROM pages p
         WHERE p.id = ?",
    )
    .bind(page_id)
    .fetch_optional(pool)
    .await
}

#[cfg(test)]
#[path = "notification_log_tests.rs"]
mod notification_log_tests;
