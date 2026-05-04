//! Background notification scheduler.
//!
//! Runs as a Tokio task on the Tauri async runtime (not JS setInterval),
//! so it stays alive even when the webview is backgrounded or throttled.
//! Ticks once per minute, aligned to the clock minute boundary, and queries
//! SQLite for due reminders, firing OS desktop notifications.
//!
//! Two delivery paths:
//! 1. Per-reminder: fires at `scheduled_start - minutes_before` for timed events.
//!    All-day events are excluded — they'd fire at midnight-minus-N which is
//!    never what the user wants.
//! 2. Daily summary: fires once per local day with today's schedule + overdue
//!    counts. Triggered at quiet-hours-end, or at 07:00+ if quiet hours are
//!    disabled. This is also the catch-up mechanism for reminders that would
//!    have fired during quiet hours.

use std::time::Duration;

use chrono::{Datelike, NaiveDate, Timelike};
use sqlx::SqlitePool;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::db::DbState;

/// Notification settings passed from the frontend via a Tauri command.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettings {
    pub enabled: bool,
    /// Default lead time in minutes (0 = at start, 5, 10, 15, 30).
    pub default_minutes_before: i64,
    /// Daily summary — one notification per day with today's schedule + overdue.
    /// Fires at the first non-quiet tick at or after `summary_time`.
    pub overdue_alerts: bool,
    /// When the daily summary should fire (HH:MM, 24h format). If this time
    /// falls inside quiet hours, the summary is deferred to the first
    /// non-quiet tick after it (quiet hours can be daytime — e.g. a focus
    /// block — so don't assume they're overnight).
    pub summary_time: String, // e.g. "07:00"
    /// Quiet hours — suppress notifications between these times (HH:MM, 24h format).
    pub quiet_hours_enabled: bool,
    pub quiet_hours_start: String, // e.g. "22:00"
    pub quiet_hours_end: String,   // e.g. "08:00"
}

impl Default for NotificationSettings {
    fn default() -> Self {
        NotificationSettings {
            enabled: true,
            default_minutes_before: 10,
            overdue_alerts: true,
            summary_time: "07:00".to_string(),
            quiet_hours_enabled: false,
            quiet_hours_start: "22:00".to_string(),
            quiet_hours_end: "08:00".to_string(),
        }
    }
}

/// Shared state so the frontend can update notification settings at runtime.
pub struct NotificationSettingsState(pub tokio::sync::Mutex<NotificationSettings>);

impl NotificationSettingsState {
    pub fn new() -> Self {
        NotificationSettingsState(tokio::sync::Mutex::new(NotificationSettings::default()))
    }
}

/// In-memory scheduler state carried across ticks.
#[derive(Default)]
struct SchedulerRuntime {
    /// Local date of the last fired daily summary. Fast-path dedup; the DB
    /// marker row is the source of truth across restarts.
    last_summary_date: Option<NaiveDate>,
}

pub struct SchedulerRuntimeState(tokio::sync::Mutex<SchedulerRuntime>);

impl SchedulerRuntimeState {
    pub fn new() -> Self {
        SchedulerRuntimeState(tokio::sync::Mutex::new(SchedulerRuntime::default()))
    }

    async fn lock(&self) -> tokio::sync::MutexGuard<'_, SchedulerRuntime> {
        self.0.lock().await
    }
}

// ─── Commands ────────────────────────────────────────────────────────────────

/// Tauri command: frontend calls this whenever notification settings change.
#[tauri::command]
pub async fn update_notification_settings(
    state: tauri::State<'_, NotificationSettingsState>,
    settings: NotificationSettings,
) -> Result<(), String> {
    *state.0.lock().await = settings;
    Ok(())
}

/// Tauri command: request OS notification permission. Returns true if granted.
#[tauri::command]
pub async fn request_notification_permission(app: tauri::AppHandle) -> Result<bool, String> {
    match app.notification().request_permission() {
        Ok(state) => Ok(state == tauri_plugin_notification::PermissionState::Granted),
        Err(e) => Err(e.to_string()),
    }
}

/// Tauri command: check current notification permission status.
#[tauri::command]
pub async fn check_notification_permission(app: tauri::AppHandle) -> Result<bool, String> {
    match app.notification().permission_state() {
        Ok(state) => Ok(state == tauri_plugin_notification::PermissionState::Granted),
        Err(e) => Err(e.to_string()),
    }
}

// ─── Scheduler loop ──────────────────────────────────────────────────────────

/// Main scheduler loop — spawned from `lib.rs` setup.
pub async fn run(app: AppHandle) {
    // The frontend calls connect_db after mount, so we poll until it's ready.
    loop {
        {
            let db_state = app.state::<crate::db::DbState>();
            if db_state.get_pool().await.is_ok() {
                break;
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }

    log::info!("Notification scheduler started");

    // Request notification permission on startup. On macOS this triggers
    // the OS permission dialog if not yet determined. Foreign error from
    // tauri-plugin-notification can include OS-level strings — log only
    // the operation, not the message.
    if app.notification().request_permission().is_err() {
        log::warn!("notification_permission_request_failed");
    }

    loop {
        let now = chrono::Local::now();
        let secs_until_next_minute = 60 - now.second() as u64;
        let nanos_offset = now.nanosecond() as u64;
        let wait = Duration::from_secs(secs_until_next_minute)
            - Duration::from_nanos(nanos_offset.min(secs_until_next_minute * 1_000_000_000));
        tokio::time::sleep(wait).await;

        if let Err(e) = check_and_fire(&app).await {
            // Tick failure is recoverable — next tick retries. Surface as
            // warn so a recurring underlying issue is visible. Pass the
            // sqlx error class only — the Display output can echo SQL
            // fragments and parameter values back into the log.
            log::warn!("scheduler_tick_failed kind={}", classify_sqlx(&e));
        }
    }
}

/// Stable, content-free label for an `sqlx::Error`. Use at log sites instead
/// of `e.to_string()` — the Display impl can echo SQL fragments and parameter
/// values which may include user-derived data (titles, tags, search input).
fn classify_sqlx(e: &sqlx::Error) -> &'static str {
    use sqlx::Error::*;
    match e {
        Configuration(_) => "configuration",
        Database(_) => "database",
        Io(_) => "io",
        Tls(_) => "tls",
        Protocol(_) => "protocol",
        RowNotFound => "row_not_found",
        TypeNotFound { .. } => "type_not_found",
        ColumnIndexOutOfBounds { .. } => "column_index_out_of_bounds",
        ColumnNotFound(_) => "column_not_found",
        ColumnDecode { .. } => "column_decode",
        Encode(_) => "encode",
        Decode(_) => "decode",
        AnyDriverError(_) => "any_driver",
        PoolTimedOut => "pool_timed_out",
        PoolClosed => "pool_closed",
        WorkerCrashed => "worker_crashed",
        Migrate(_) => "migrate",
        _ => "other",
    }
}

#[derive(sqlx::FromRow, Clone)]
struct DueReminder {
    schedule_id: String,
    page_id: String,
    title: String,
    scheduled_start: String,
    minutes_before: i64,
}

/// Check if the current local time falls within quiet hours.
fn is_quiet_hours(settings: &NotificationSettings, now: &chrono::DateTime<chrono::Local>) -> bool {
    if !settings.quiet_hours_enabled {
        return false;
    }

    let now_str = now.format("%H:%M").to_string();
    let start = &settings.quiet_hours_start;
    let end = &settings.quiet_hours_end;

    if start <= end {
        &now_str >= start && &now_str < end
    } else {
        &now_str >= start || &now_str < end
    }
}

/// Decide whether the daily summary should fire on this tick.
///
/// Fires once per local day, gated on all of:
/// - overdue_alerts enabled
/// - not currently in quiet hours
/// - local time is at or after `summary_time`
/// - not already fired today
///
/// If `summary_time` falls inside quiet hours, this returns false until the
/// first non-quiet tick after it. Works for both overnight and daytime quiet
/// hours: a 07:00 summary with 22:00–10:00 quiet hours defers to 10:00; a
/// 14:00 summary with 13:00–15:00 quiet hours defers to 15:00.
fn should_fire_daily_summary(
    runtime: &SchedulerRuntime,
    settings: &NotificationSettings,
    now_quiet: bool,
    now: &chrono::DateTime<chrono::Local>,
) -> bool {
    if !settings.overdue_alerts || now_quiet {
        return false;
    }
    let today = now.date_naive();
    if runtime.last_summary_date == Some(today) {
        return false;
    }
    let now_hm = now.format("%H:%M").to_string();
    now_hm >= settings.summary_time
}

/// Query for due reminders and fire OS notifications.
///
/// Internal scheduler fns return `sqlx::Error` directly (not `String`) so the
/// run-loop log site can use `classify_sqlx` to log a stable error class
/// without echoing parameter values back through the sqlx Display impl.
async fn check_and_fire(app: &AppHandle) -> Result<(), sqlx::Error> {
    let settings = {
        let state = app.state::<NotificationSettingsState>();
        let guard = state.0.lock().await;
        guard.clone()
    };

    if !settings.enabled {
        return Ok(());
    }

    let pool = {
        let db_state = app.state::<DbState>();
        match db_state.get_pool().await {
            Ok(p) => p,
            Err(_) => return Ok(()),
        }
    };

    let now = chrono::Local::now();
    let now_quiet = is_quiet_hours(&settings, &now);

    // Daily summary decision uses current runtime state; we mutate after.
    let fire_summary = {
        let runtime_state = app.state::<SchedulerRuntimeState>();
        let guard = runtime_state.lock().await;
        should_fire_daily_summary(&guard, &settings, now_quiet, &now)
    };

    if fire_summary {
        // Populate last_summary_date even if nothing to report, so we don't
        // keep re-querying for the rest of the day.
        let _ = fire_daily_summary(app, &pool, &now).await?;
        let runtime_state = app.state::<SchedulerRuntimeState>();
        let mut guard = runtime_state.lock().await;
        guard.last_summary_date = Some(now.date_naive());
    }

    // During quiet hours, suppress individual per-reminder notifications.
    // They'll be surfaced via tomorrow's daily summary as overdue.
    if now_quiet {
        return Ok(());
    }

    // Use space separator to match SQLite's datetime() output format.
    // datetime() returns 'YYYY-MM-DD HH:MM:SS' — BETWEEN comparisons are
    // lexicographic, so both sides must use the same separator.
    let now_ts = now.format("%Y-%m-%d %H:%M:%S").to_string();
    let window_start = (now - chrono::Duration::seconds(60))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();

    fire_explicit_reminders(app, &pool, &window_start, &now_ts).await?;
    fire_default_reminders(app, &pool, &settings, &window_start, &now_ts).await?;

    Ok(())
}

/// Pages that have rows in page_reminders — use those specific lead times.
/// All-day events (scheduled_start like 'YYYY-MM-DD', no 'T') are excluded.
async fn fire_explicit_reminders(
    app: &AppHandle,
    pool: &SqlitePool,
    window_start: &str,
    now_ts: &str,
) -> Result<(), sqlx::Error> {
    let due: Vec<DueReminder> = sqlx::query_as(
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
    .await?;

    for row in due {
        fire_reminder(app, pool, &row).await?;
    }

    Ok(())
}

/// Pages without page_reminders rows — use the global default lead time.
/// All-day events are excluded (see `fire_explicit_reminders`).
async fn fire_default_reminders(
    app: &AppHandle,
    pool: &SqlitePool,
    settings: &NotificationSettings,
    window_start: &str,
    now_ts: &str,
) -> Result<(), sqlx::Error> {
    let minutes = settings.default_minutes_before;

    let due: Vec<DueReminder> = sqlx::query_as(
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
           AND datetime(ps.scheduled_start, '-' || ? || ' minutes')
               BETWEEN ? AND ?
           AND NOT EXISTS (
             SELECT 1 FROM notification_log nl
             WHERE nl.schedule_id = ps.id
               AND nl.type = 'reminder'
           )",
    )
    .bind(minutes)
    .bind(minutes)
    .bind(window_start)
    .bind(now_ts)
    .fetch_all(pool)
    .await?;

    for row in due {
        fire_reminder(app, pool, &row).await?;
    }

    Ok(())
}

/// Daily summary — one notification per local day. Returns true if delivered.
///
/// Dedup: a marker row in notification_log with `type='overdue'`,
/// `page_id IS NULL`, `schedule_id IS NULL`. The marker is always inserted
/// even if there's nothing to report, so we don't keep re-querying.
///
/// Counts:
/// - `today_count` — pages scheduled today (timed or all-day), status != done.
/// - `overdue_count` — timed events with scheduled_start in [now-24h, now),
///   status != done, page created > 5 minutes ago (skip import batches).
async fn fire_daily_summary(
    app: &AppHandle,
    pool: &SqlitePool,
    now: &chrono::DateTime<chrono::Local>,
) -> Result<bool, sqlx::Error> {
    let today = now.format("%Y-%m-%d").to_string();

    // Persistent dedup across restarts.
    let already_fired: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM notification_log
         WHERE type = 'overdue'
           AND page_id IS NULL
           AND schedule_id IS NULL
           AND date(fired_at) = ?",
    )
    .bind(&today)
    .fetch_one(pool)
    .await?;

    if already_fired.0 > 0 {
        return Ok(false);
    }

    let now_ts = now.format("%Y-%m-%d %H:%M:%S").to_string();
    let stale_cutoff = (*now - chrono::Duration::hours(24))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    let recent_cutoff = (*now - chrono::Duration::minutes(5))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();

    // Today's scheduled count — includes all-day and timed, dedup by page.
    let today_row: (i64,) = sqlx::query_as(
        "SELECT COUNT(DISTINCT ps.page_id)
         FROM page_schedules ps
         JOIN pages p ON p.id = ps.page_id
         WHERE p.status != 'done'
           AND p.deleted_at IS NULL
           AND ps.status != 'done'
           AND date(ps.scheduled_start) = ?",
    )
    .bind(&today)
    .fetch_one(pool)
    .await?;
    let today_count = today_row.0;

    // Overdue count — timed events only, in the last 24h.
    let overdue_row: (i64,) = sqlx::query_as(
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
    .bind(&now_ts)
    .bind(&stale_cutoff)
    .bind(&recent_cutoff)
    .fetch_one(pool)
    .await?;
    let overdue_count = overdue_row.0;

    // Insert marker row (local time, consistent with date(fired_at)=today above).
    let log_id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO notification_log (id, page_id, schedule_id, type, fired_at)
         VALUES (?, NULL, NULL, 'overdue', ?)",
    )
    .bind(&log_id)
    .bind(&now_ts)
    .execute(pool)
    .await?;

    if today_count == 0 && overdue_count == 0 {
        return Ok(false);
    }

    let title = format_summary_title(now);
    let body = format_summary_body(today_count, overdue_count);
    deliver(app, &title, &body);

    Ok(true)
}

// ─── Delivery ────────────────────────────────────────────────────────────────

/// Send an OS desktop notification via tauri-plugin-notification.
/// Requires a properly signed app bundle — unsigned dev builds will
/// silently drop notifications. Use osascript fallback for dev testing.
fn deliver(app: &AppHandle, title: &str, body: &str) {
    if let Ok(()) = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .sound("default")
        .group("pikos-reminders")
        .show() {}
}

fn format_lead_time(minutes: i64) -> String {
    if minutes == 0 {
        "now".to_string()
    } else if minutes < 60 {
        format!("in {} min", minutes)
    } else {
        let hours = minutes / 60;
        if hours == 1 {
            "in 1 hour".to_string()
        } else {
            format!("in {} hours", hours)
        }
    }
}

fn format_time_from_iso(scheduled_start: &str) -> String {
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(scheduled_start, "%Y-%m-%dT%H:%M:%S") {
        let hour = dt.time().format("%l:%M%P").to_string();
        hour.trim().to_string()
    } else {
        String::new()
    }
}

/// Pretty title for the daily summary: "Today — Sat, Apr 18"
fn format_summary_title(now: &chrono::DateTime<chrono::Local>) -> String {
    let weekday = match now.weekday() {
        chrono::Weekday::Mon => "Mon",
        chrono::Weekday::Tue => "Tue",
        chrono::Weekday::Wed => "Wed",
        chrono::Weekday::Thu => "Thu",
        chrono::Weekday::Fri => "Fri",
        chrono::Weekday::Sat => "Sat",
        chrono::Weekday::Sun => "Sun",
    };
    let month = match now.month() {
        1 => "Jan",
        2 => "Feb",
        3 => "Mar",
        4 => "Apr",
        5 => "May",
        6 => "Jun",
        7 => "Jul",
        8 => "Aug",
        9 => "Sep",
        10 => "Oct",
        11 => "Nov",
        _ => "Dec",
    };
    format!("Today — {}, {} {}", weekday, month, now.day())
}

/// Body for the daily summary. Omits zero counts.
/// "3 scheduled · 2 overdue\nOpen Pikos to review."
fn format_summary_body(today_count: i64, overdue_count: i64) -> String {
    let mut parts: Vec<String> = Vec::new();
    if today_count > 0 {
        parts.push(format!("{} scheduled", today_count));
    }
    if overdue_count > 0 {
        parts.push(format!("{} overdue", overdue_count));
    }
    if parts.is_empty() {
        return "Open Pikos to review.".to_string();
    }
    format!("{}\nOpen Pikos to review.", parts.join(" · "))
}

async fn fire_reminder(
    app: &AppHandle,
    pool: &SqlitePool,
    row: &DueReminder,
) -> Result<(), sqlx::Error> {
    let lead = format_lead_time(row.minutes_before);
    let time_str = format_time_from_iso(&row.scheduled_start);
    let body = if time_str.is_empty() {
        format!("Starts {lead}")
    } else {
        format!("Starts {lead} · {time_str}")
    };

    // Log to prevent re-firing
    let log_id = uuid::Uuid::new_v4().to_string();
    let fired_at = chrono::Local::now()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();

    sqlx::query(
        "INSERT INTO notification_log (id, page_id, schedule_id, type, fired_at)
         VALUES (?, ?, ?, 'reminder', ?)",
    )
    .bind(&log_id)
    .bind(&row.page_id)
    .bind(&row.schedule_id)
    .bind(&fired_at)
    .execute(pool)
    .await?;

    deliver(app, &row.title, &body);

    // Reminder actually fired — meaningful audit anchor at INFO. Empty
    // ticks are silent (most ticks find nothing).
    log::info!(
        "notification_fired type=reminder page_id={} schedule_id={}",
        row.page_id,
        row.schedule_id
    );

    Ok(())
}

/// Prune notification_log entries older than 30 days.
pub async fn prune_notification_log(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let cutoff = (chrono::Local::now() - chrono::Duration::days(30))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    sqlx::query("DELETE FROM notification_log WHERE datetime(fired_at) < datetime(?)")
        .bind(&cutoff)
        .execute(pool)
        .await?;
    Ok(())
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn settings_with_quiet(start: &str, end: &str) -> NotificationSettings {
        NotificationSettings {
            enabled: true,
            default_minutes_before: 10,
            overdue_alerts: true,
            summary_time: "07:00".to_string(),
            quiet_hours_enabled: true,
            quiet_hours_start: start.to_string(),
            quiet_hours_end: end.to_string(),
        }
    }

    fn local_at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> chrono::DateTime<chrono::Local> {
        chrono::Local.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    // ─── classify_sqlx ───────────────────────────────────────────────────

    #[test]
    fn classify_sqlx_returns_stable_label_without_message() {
        // Variants we'll realistically see in the scheduler. The point is
        // to confirm the label is content-free — no Display formatting, no
        // user-provided strings can leak through this helper.
        assert_eq!(classify_sqlx(&sqlx::Error::RowNotFound), "row_not_found");
        assert_eq!(classify_sqlx(&sqlx::Error::PoolTimedOut), "pool_timed_out");
        assert_eq!(classify_sqlx(&sqlx::Error::PoolClosed), "pool_closed");
        assert_eq!(classify_sqlx(&sqlx::Error::WorkerCrashed), "worker_crashed");
    }

    // ─── is_quiet_hours ──────────────────────────────────────────────────

    #[test]
    fn quiet_hours_disabled_always_false() {
        let mut s = settings_with_quiet("22:00", "08:00");
        s.quiet_hours_enabled = false;
        assert!(!is_quiet_hours(&s, &local_at(2026, 4, 18, 23, 0)));
        assert!(!is_quiet_hours(&s, &local_at(2026, 4, 18, 3, 0)));
    }

    #[test]
    fn quiet_hours_overnight_window() {
        // 22:00 → 08:00 wraps midnight
        let s = settings_with_quiet("22:00", "08:00");
        assert!(is_quiet_hours(&s, &local_at(2026, 4, 18, 22, 0))); // start inclusive
        assert!(is_quiet_hours(&s, &local_at(2026, 4, 18, 23, 30)));
        assert!(is_quiet_hours(&s, &local_at(2026, 4, 19, 2, 0)));
        assert!(is_quiet_hours(&s, &local_at(2026, 4, 19, 7, 59)));
        assert!(!is_quiet_hours(&s, &local_at(2026, 4, 19, 8, 0))); // end exclusive
        assert!(!is_quiet_hours(&s, &local_at(2026, 4, 18, 12, 0)));
        assert!(!is_quiet_hours(&s, &local_at(2026, 4, 18, 21, 59)));
    }

    #[test]
    fn quiet_hours_daytime_window() {
        // 13:00 → 15:00 same-day (e.g. afternoon focus block)
        let s = settings_with_quiet("13:00", "15:00");
        assert!(is_quiet_hours(&s, &local_at(2026, 4, 18, 13, 0)));
        assert!(is_quiet_hours(&s, &local_at(2026, 4, 18, 14, 30)));
        assert!(!is_quiet_hours(&s, &local_at(2026, 4, 18, 15, 0)));
        assert!(!is_quiet_hours(&s, &local_at(2026, 4, 18, 12, 59)));
    }

    // ─── should_fire_daily_summary ───────────────────────────────────────

    #[test]
    fn summary_blocked_when_overdue_alerts_off() {
        let mut s = settings_with_quiet("22:00", "08:00");
        s.overdue_alerts = false;
        let rt = SchedulerRuntime::default();
        assert!(!should_fire_daily_summary(
            &rt,
            &s,
            false,
            &local_at(2026, 4, 18, 8, 0)
        ));
    }

    #[test]
    fn summary_blocked_during_quiet_hours() {
        let s = settings_with_quiet("22:00", "08:00");
        let rt = SchedulerRuntime::default();
        assert!(!should_fire_daily_summary(
            &rt,
            &s,
            true,
            &local_at(2026, 4, 18, 23, 0)
        ));
    }

    #[test]
    fn summary_fires_after_quiet_hours_end_when_summary_time_passed() {
        // Summary 07:00, quiet 22:00-08:00: at 08:00 both conditions met.
        let s = settings_with_quiet("22:00", "08:00");
        let rt = SchedulerRuntime::default();
        assert!(should_fire_daily_summary(
            &rt,
            &s,
            false,
            &local_at(2026, 4, 18, 8, 0)
        ));
    }

    #[test]
    fn summary_fires_at_configured_time_when_quiet_hours_off() {
        let mut s = settings_with_quiet("22:00", "08:00");
        s.quiet_hours_enabled = false;
        s.summary_time = "09:30".to_string();
        let rt = SchedulerRuntime::default();
        assert!(should_fire_daily_summary(
            &rt,
            &s,
            false,
            &local_at(2026, 4, 18, 9, 30)
        ));
        assert!(!should_fire_daily_summary(
            &rt,
            &s,
            false,
            &local_at(2026, 4, 18, 9, 29)
        ));
    }

    #[test]
    fn summary_deferred_when_summary_time_inside_daytime_quiet_hours() {
        // Summary 14:00, quiet 13:00-15:00 (daytime focus block).
        // At 14:00 now_quiet=true → don't fire.
        // At 15:00 now_quiet=false, summary_time passed → fire.
        let mut s = settings_with_quiet("13:00", "15:00");
        s.summary_time = "14:00".to_string();
        let rt = SchedulerRuntime::default();
        assert!(!should_fire_daily_summary(
            &rt,
            &s,
            true, // caller determines now_quiet
            &local_at(2026, 4, 18, 14, 0)
        ));
        assert!(should_fire_daily_summary(
            &rt,
            &s,
            false,
            &local_at(2026, 4, 18, 15, 0)
        ));
    }

    #[test]
    fn summary_deferred_when_summary_time_inside_late_quiet_hours() {
        // Summary 09:00, quiet 22:00-10:00 (late-wake user).
        // At 09:00 now_quiet=true → don't fire. At 10:00 → fire.
        let mut s = settings_with_quiet("22:00", "10:00");
        s.summary_time = "09:00".to_string();
        let rt = SchedulerRuntime::default();
        assert!(!should_fire_daily_summary(
            &rt,
            &s,
            true,
            &local_at(2026, 4, 18, 9, 0)
        ));
        assert!(should_fire_daily_summary(
            &rt,
            &s,
            false,
            &local_at(2026, 4, 18, 10, 0)
        ));
    }

    #[test]
    fn summary_does_not_refire_same_day() {
        let s = settings_with_quiet("22:00", "08:00");
        let today = local_at(2026, 4, 18, 9, 0).date_naive();
        let rt = SchedulerRuntime {
            last_summary_date: Some(today),
        };
        assert!(!should_fire_daily_summary(
            &rt,
            &s,
            false,
            &local_at(2026, 4, 18, 9, 0)
        ));
    }

    #[test]
    fn summary_fires_next_day_after_previous() {
        let s = settings_with_quiet("22:00", "08:00");
        let yesterday = local_at(2026, 4, 17, 8, 0).date_naive();
        let rt = SchedulerRuntime {
            last_summary_date: Some(yesterday),
        };
        assert!(should_fire_daily_summary(
            &rt,
            &s,
            false,
            &local_at(2026, 4, 18, 8, 0)
        ));
    }

    // ─── format helpers ──────────────────────────────────────────────────

    #[test]
    fn lead_time_boundaries() {
        assert_eq!(format_lead_time(0), "now");
        assert_eq!(format_lead_time(5), "in 5 min");
        assert_eq!(format_lead_time(59), "in 59 min");
        assert_eq!(format_lead_time(60), "in 1 hour");
        assert_eq!(format_lead_time(120), "in 2 hours");
        assert_eq!(format_lead_time(180), "in 3 hours");
    }

    #[test]
    fn time_from_iso_valid() {
        assert_eq!(format_time_from_iso("2026-04-18T09:30:00"), "9:30am");
        assert_eq!(format_time_from_iso("2026-04-18T14:05:00"), "2:05pm");
    }

    #[test]
    fn time_from_iso_invalid() {
        assert_eq!(format_time_from_iso("2026-04-18"), ""); // all-day string
        assert_eq!(format_time_from_iso("garbage"), "");
    }

    #[test]
    fn summary_title_format() {
        // 2026-04-18 is a Saturday
        let t = format_summary_title(&local_at(2026, 4, 18, 8, 0));
        assert_eq!(t, "Today — Sat, Apr 18");
    }

    #[test]
    fn summary_body_both_counts() {
        assert_eq!(
            format_summary_body(3, 2),
            "3 scheduled · 2 overdue\nOpen Pikos to review."
        );
    }

    #[test]
    fn summary_body_today_only() {
        assert_eq!(
            format_summary_body(3, 0),
            "3 scheduled\nOpen Pikos to review."
        );
    }

    #[test]
    fn summary_body_overdue_only() {
        assert_eq!(
            format_summary_body(0, 2),
            "2 overdue\nOpen Pikos to review."
        );
    }

    #[test]
    fn summary_body_empty() {
        assert_eq!(format_summary_body(0, 0), "Open Pikos to review.");
    }
}
