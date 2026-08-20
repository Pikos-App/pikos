//! Rich usage stats for the Settings → Data panel. All queries are local — no
//! telemetry ever leaves the machine.

use serde::Serialize;
use sqlx::Row;

use crate::db::DbState;
use crate::error::AppResult;

#[derive(Serialize)]
pub struct StatusCount {
    pub status: String,
    pub count: i64,
}

#[derive(Serialize)]
pub struct WeekActivity {
    /// ISO week label, e.g. "Mar 24"
    pub week: String,
    pub created: i64,
    pub edited: i64,
    pub completed: i64,
    /// Whole minutes focused in the week, truncated like the running total.
    pub focus_minutes: i64,
}

#[derive(Serialize)]
pub struct UsageStats {
    // Totals
    pub total_pages: i64,
    pub total_folders: i64,
    pub total_schedules: i64,
    pub total_focus_sessions: i64,
    pub total_focus_minutes: i64,
    pub total_completed: i64,
    pub total_words: i64,

    // Pages by status
    pub pages_by_status: Vec<StatusCount>,

    // Weekly activity (last 12 weeks)
    pub weekly_activity: Vec<WeekActivity>,

    // Feature adoption
    pub has_folders: bool,
    pub has_schedules: bool,
    pub has_recurring: bool,
    pub has_focus_sessions: bool,
    pub has_subtasks: bool,
    pub has_tags: bool,
    pub has_priorities: bool,
    pub has_reminders: bool,
    pub has_calendar_sync: bool,

    // Milestones
    pub first_page_date: Option<String>,
}

/// Rich usage stats for the Settings > Data panel. All queries are local — no telemetry.
///
/// Perf note: this fans out into ~14 sequential queries on every Settings open.
/// Acceptable for now (Settings is rarely open and the DB is local), but a
/// single CTE-based query would be the obvious next step if this ever shows
/// up in a profile.
#[tauri::command]
pub async fn get_usage_stats(state: tauri::State<'_, DbState>) -> AppResult<UsageStats> {
    let pool = state.get_pool().await?;
    get_usage_stats_impl(&pool).await
}

pub(crate) async fn get_usage_stats_impl(pool: &sqlx::SqlitePool) -> AppResult<UsageStats> {
    // ── Totals ────────────────────────────────────────────────────────────────
    let total_pages: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL")
            .fetch_one(pool)
            .await?;

    let total_folders: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM folders WHERE deleted_at IS NULL")
            .fetch_one(pool)
            .await?;

    let total_schedules: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM page_schedules")
        .fetch_one(pool)
        .await?;

    let total_focus_sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM focus_sessions")
        .fetch_one(pool)
        .await?;

    let total_focus_minutes: i64 =
        sqlx::query_scalar("SELECT COALESCE(SUM(duration_s), 0) / 60 FROM focus_sessions")
            .fetch_one(pool)
            .await?;

    let total_completed: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL AND status = 'done'",
    )
    .fetch_one(pool)
    .await?;

    // Word count: sum of words in content_text across all pages
    let total_words: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(LENGTH(content_text) - LENGTH(REPLACE(content_text, ' ', '')) + 1), 0) \
         FROM pages WHERE deleted_at IS NULL AND content_text != ''"
    ).fetch_one(pool).await?;

    // ── Pages by status ───────────────────────────────────────────────────────
    let status_rows = sqlx::query(
        "SELECT status, COUNT(*) as count FROM pages WHERE deleted_at IS NULL GROUP BY status ORDER BY count DESC"
    ).fetch_all(pool).await?;

    let pages_by_status: Vec<StatusCount> = status_rows
        .iter()
        .map(|row| StatusCount {
            status: row.try_get::<String, _>("status").unwrap_or_default(),
            count: row.try_get::<i64, _>("count").unwrap_or(0),
        })
        .collect();

    // ── Weekly activity (last 12 weeks) ───────────────────────────────────────
    // Tracks pages created, pages edited (updated_at != created_at), and pages completed per week.
    //
    // Weeks key on their Monday via `date(X, '-6 days', 'weekday 1')`. The
    // reverse — `'weekday 1'` then back a week — is what you reach for first and
    // it is wrong on Mondays: SQLite's `weekday` modifier is a no-op when the
    // date already is that weekday, so a Monday walks back to the week before
    // and every Monday's activity lands in the previous bucket.
    let week_rows = sqlx::query(
        "WITH RECURSIVE weeks(n) AS ( \
           SELECT 0 UNION ALL SELECT n+1 FROM weeks WHERE n < 11 \
         ), \
         week_starts AS ( \
           SELECT date('now', '-' || (n * 7) || ' days', '-6 days', 'weekday 1') AS week_start \
           FROM weeks \
         ) \
         SELECT \
           ws.week_start, \
           COALESCE(cr.created, 0) AS created, \
           COALESCE(ed.edited, 0) AS edited, \
           COALESCE(co.completed, 0) AS completed, \
           COALESCE(fs.focus_minutes, 0) AS focus_minutes \
         FROM week_starts ws \
         LEFT JOIN ( \
           SELECT date(created_at, '-6 days', 'weekday 1') AS w, COUNT(*) AS created \
           FROM pages WHERE deleted_at IS NULL \
           GROUP BY w \
         ) cr ON cr.w = ws.week_start \
         LEFT JOIN ( \
           SELECT date(updated_at, '-6 days', 'weekday 1') AS w, COUNT(*) AS edited \
           FROM pages WHERE deleted_at IS NULL AND updated_at != created_at \
           GROUP BY w \
         ) ed ON ed.w = ws.week_start \
         LEFT JOIN ( \
           SELECT date(completed_at, '-6 days', 'weekday 1') AS w, COUNT(*) AS completed \
           FROM pages WHERE deleted_at IS NULL AND completed_at IS NOT NULL \
           GROUP BY w \
         ) co ON co.w = ws.week_start \
         LEFT JOIN ( \
           SELECT date(started_at, '-6 days', 'weekday 1') AS w, \
                  SUM(duration_s) / 60 AS focus_minutes \
           FROM focus_sessions \
           GROUP BY w \
         ) fs ON fs.w = ws.week_start \
         ORDER BY ws.week_start ASC",
    )
    .fetch_all(pool)
    .await?;

    let weekly_activity: Vec<WeekActivity> = week_rows
        .iter()
        .map(|row| {
            let week_start: String = row.try_get("week_start").unwrap_or_default();
            // Format "2026-03-23" → "Mar 23"
            let label = if week_start.len() >= 10 {
                let month = match &week_start[5..7] {
                    "01" => "Jan",
                    "02" => "Feb",
                    "03" => "Mar",
                    "04" => "Apr",
                    "05" => "May",
                    "06" => "Jun",
                    "07" => "Jul",
                    "08" => "Aug",
                    "09" => "Sep",
                    "10" => "Oct",
                    "11" => "Nov",
                    "12" => "Dec",
                    _ => "???",
                };
                let day = &week_start[8..10];
                format!("{} {}", month, day)
            } else {
                week_start
            };
            WeekActivity {
                week: label,
                created: row.try_get("created").unwrap_or(0),
                edited: row.try_get("edited").unwrap_or(0),
                completed: row.try_get("completed").unwrap_or(0),
                focus_minutes: row.try_get("focus_minutes").unwrap_or(0),
            }
        })
        .collect();

    // ── Feature adoption ──────────────────────────────────────────────────────
    let has_folders = total_folders > 0;
    let has_schedules = total_schedules > 0;

    let has_recurring: bool =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM page_recurrence_rules")
            .fetch_one(pool)
            .await?
            > 0;

    let has_focus_sessions = total_focus_sessions > 0;

    let has_subtasks: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pages WHERE parent_id IS NOT NULL AND deleted_at IS NULL",
    )
    .fetch_one(pool)
    .await?
        > 0;

    let has_tags: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL AND tags != '[]' AND tags != ''",
    )
    .fetch_one(pool)
    .await?
        > 0;

    let has_priorities: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL AND priority != 0",
    )
    .fetch_one(pool)
    .await?
        > 0;

    // Explicit per-page leads only. Whether reminders actually *fire* also depends
    // on the notifications toggle and the global default lead, both of which live
    // in frontend settings — the panel combines the two.
    let has_reminders: bool = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM page_reminders")
        .fetch_one(pool)
        .await?
        > 0;

    // Connecting is the adoption signal, not mirroring: a user who connected an
    // empty calendar has used the feature. Dormant rows count for the same reason.
    let has_calendar_sync: bool =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sync_account")
            .fetch_one(pool)
            .await?
            > 0;

    // ── Milestones ────────────────────────────────────────────────────────────
    let first_page_date: Option<String> =
        sqlx::query_scalar("SELECT MIN(created_at) FROM pages WHERE deleted_at IS NULL")
            .fetch_one(pool)
            .await?;

    Ok(UsageStats {
        total_pages,
        total_folders,
        total_schedules,
        total_focus_sessions,
        total_focus_minutes,
        total_completed,
        total_words,
        pages_by_status,
        weekly_activity,
        has_folders,
        has_schedules,
        has_recurring,
        has_focus_sessions,
        has_subtasks,
        has_tags,
        has_priorities,
        has_reminders,
        has_calendar_sync,
        first_page_date,
    })
}
