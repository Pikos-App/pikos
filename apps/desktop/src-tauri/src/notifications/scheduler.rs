//! Background notification scheduler.
//!
//! Runs as a Tokio task on the Tauri async runtime (not JS setInterval),
//! so it stays alive even when the webview is backgrounded or throttled.
//! Ticks once per minute, aligned to the clock minute boundary, and queries
//! SQLite for due reminders, firing OS desktop notifications.

use std::time::Duration;

use chrono::Timelike;
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
    /// Overdue alerts — fire once per day for pages past their scheduled end.
    pub overdue_alerts: bool,
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
    // Wait for DB to be connected before starting the scheduler loop.
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

    // Request notification permission on startup. On macOS this triggers
    // the OS permission dialog if not yet determined.
    match app.notification().request_permission() {
        Ok(state) => eprintln!("[notifications] permission: {state:?}"),
        Err(e) => eprintln!("[notifications] permission request failed: {e}"),
    }

    // Tick once per minute, aligned to the clock minute boundary.
    eprintln!("[notifications] scheduler started, DB ready");
    loop {
        let now = chrono::Local::now();
        let secs_until_next_minute = 60 - now.second() as u64;
        let nanos_offset = now.nanosecond() as u64;
        let wait = Duration::from_secs(secs_until_next_minute)
            - Duration::from_nanos(nanos_offset.min(secs_until_next_minute * 1_000_000_000));
        tokio::time::sleep(wait).await;

        eprintln!("[notifications] tick at {}", chrono::Local::now().format("%H:%M:%S"));
        match check_and_fire(&app).await {
            Ok(()) => {}
            Err(e) => eprintln!("[notifications] error: {e}"),
        }
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

#[derive(sqlx::FromRow)]
struct OverduePage {
    page_id: String,
}

/// Check if the current local time falls within quiet hours.
fn is_quiet_hours(settings: &NotificationSettings) -> bool {
    if !settings.quiet_hours_enabled {
        return false;
    }

    let now = chrono::Local::now().format("%H:%M").to_string();
    let start = &settings.quiet_hours_start;
    let end = &settings.quiet_hours_end;

    if start <= end {
        &now >= start && &now < end
    } else {
        &now >= start || &now < end
    }
}

/// Query for due reminders and fire OS notifications.
async fn check_and_fire(app: &AppHandle) -> Result<(), String> {
    let settings = {
        let state = app.state::<NotificationSettingsState>();
        let guard = state.0.lock().await;
        guard.clone()
    };

    if !settings.enabled {
        eprintln!("[notifications] disabled, skipping");
        return Ok(());
    }

    if is_quiet_hours(&settings) {
        eprintln!("[notifications] quiet hours, skipping");
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
    // Use space separator to match SQLite's datetime() output format.
    // datetime() returns 'YYYY-MM-DD HH:MM:SS' — BETWEEN comparisons are
    // lexicographic, so both sides must use the same separator.
    let now_ts = now.format("%Y-%m-%d %H:%M:%S").to_string();
    let window_start = (now - chrono::Duration::seconds(60))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    let today = now.format("%Y-%m-%d").to_string();

    eprintln!("[notifications] checking window [{window_start}] to [{now_ts}], default_min={}", settings.default_minutes_before);

    // 1. Fire reminders for pages with explicit page_reminders rows
    fire_explicit_reminders(app, &pool, &window_start, &now_ts).await?;

    // 2. Fire default reminders for scheduled pages without explicit reminders
    fire_default_reminders(app, &pool, &settings, &window_start, &now_ts).await?;

    // 3. Overdue alerts
    if settings.overdue_alerts {
        fire_overdue_alerts(app, &pool, &now_ts, &today).await?;
    }

    Ok(())
}

/// Pages that have rows in page_reminders — use those specific lead times.
async fn fire_explicit_reminders(
    app: &AppHandle,
    pool: &SqlitePool,
    window_start: &str,
    now_ts: &str,
) -> Result<(), String> {
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
    .map_err(|e| e.to_string())?;

    eprintln!("[notifications] explicit reminders found: {}", due.len());
    for row in due {
        eprintln!("[notifications]   firing for '{}' (schedule={}, mins_before={})", row.title, row.schedule_id, row.minutes_before);
        fire_reminder(app, pool, &row).await?;
    }

    Ok(())
}

/// Pages without page_reminders rows — use the global default lead time.
async fn fire_default_reminders(
    app: &AppHandle,
    pool: &SqlitePool,
    settings: &NotificationSettings,
    window_start: &str,
    now_ts: &str,
) -> Result<(), String> {
    let minutes = settings.default_minutes_before;

    let due: Vec<DueReminder> = sqlx::query_as(
        "SELECT ps.id AS schedule_id, ps.page_id, p.title,
                ps.scheduled_start, ? AS minutes_before
         FROM page_schedules ps
         JOIN pages p ON p.id = ps.page_id
         WHERE p.status != 'done'
           AND p.deleted_at IS NULL
           AND ps.status != 'done'
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
    .await
    .map_err(|e| e.to_string())?;

    eprintln!("[notifications] default reminders found: {}", due.len());
    for row in due {
        eprintln!("[notifications]   firing for '{}' (schedule={}, mins_before={})", row.title, row.schedule_id, row.minutes_before);
        fire_reminder(app, pool, &row).await?;
    }

    Ok(())
}

/// Overdue alerts: one summary notification per cycle.
///
/// Only items overdue within the last 24 hours are eligible — older items are
/// noise (the user already knows they're overdue). All eligible items are
/// summarized in a single notification regardless of count, then logged so
/// they don't re-notify today.
async fn fire_overdue_alerts(
    app: &AppHandle,
    pool: &SqlitePool,
    now_ts: &str,
    today: &str,
) -> Result<(), String> {
    let recent_cutoff = (chrono::Local::now() - chrono::Duration::minutes(5))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    let stale_cutoff = (chrono::Local::now() - chrono::Duration::hours(24))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();

    let overdue: Vec<OverduePage> = sqlx::query_as(
        "SELECT DISTINCT ps.page_id
         FROM page_schedules ps
         JOIN pages p ON p.id = ps.page_id
         WHERE p.status != 'done'
           AND p.deleted_at IS NULL
           AND ps.status != 'done'
           AND datetime(ps.scheduled_start) < datetime(?)
           AND datetime(ps.scheduled_start) >= datetime(?)
           AND datetime(p.created_at) < datetime(?)
           AND NOT EXISTS (
             SELECT 1 FROM notification_log nl
             WHERE nl.page_id = ps.page_id
               AND nl.type = 'overdue'
               AND date(nl.fired_at) = ?
           )
         ORDER BY ps.scheduled_start DESC",
    )
    .bind(now_ts)
    .bind(&stale_cutoff)
    .bind(&recent_cutoff)
    .bind(today)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    if overdue.is_empty() {
        return Ok(());
    }

    // Log every page so we don't re-notify today.
    for row in &overdue {
        let log_id = uuid::Uuid::new_v4().to_string();
        let fired_at = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        sqlx::query(
            "INSERT INTO notification_log (id, page_id, schedule_id, type, fired_at)
             VALUES (?, ?, NULL, 'overdue', ?)",
        )
        .bind(&log_id)
        .bind(&row.page_id)
        .bind(&fired_at)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }

    let count = overdue.len();
    let title = if count == 1 {
        "1 item overdue".to_string()
    } else {
        format!("{count} items overdue")
    };
    deliver(app, &title, "Open Pikos to review.");

    Ok(())
}

// ─── Delivery ────────────────────────────────────────────────────────────────

/// Send an OS desktop notification via tauri-plugin-notification.
/// Requires a properly signed app bundle — unsigned dev builds will
/// silently drop notifications. Use osascript fallback for dev testing.
fn deliver(app: &AppHandle, title: &str, body: &str) {
    match app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .sound("default")
        .group("pikos-reminders")
        .show()
    {
        Ok(()) => eprintln!("[notifications] delivered: {title}"),
        Err(e) => eprintln!("[notifications] delivery failed: {e}"),
    }
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

async fn fire_reminder(
    app: &AppHandle,
    pool: &SqlitePool,
    row: &DueReminder,
) -> Result<(), String> {
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
    .await
    .map_err(|e| e.to_string())?;

    deliver(app, &row.title, &body);

    Ok(())
}

/// Prune notification_log entries older than 30 days.
pub async fn prune_notification_log(pool: &SqlitePool) -> Result<(), String> {
    let cutoff = (chrono::Local::now() - chrono::Duration::days(30))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    sqlx::query("DELETE FROM notification_log WHERE datetime(fired_at) < datetime(?)")
        .bind(&cutoff)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
