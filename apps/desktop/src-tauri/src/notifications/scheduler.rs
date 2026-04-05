//! Background notification scheduler.
//!
//! Runs as a Tokio task on the Tauri async runtime (not JS setInterval),
//! so it stays alive even when the webview is backgrounded or throttled.
//! Every 30 seconds it queries SQLite for due reminders and fires OS
//! desktop notifications via `tauri-plugin-notification`.

use std::time::Duration;

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
        Ok(granted) => Ok(granted),
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
    let mut interval = tokio::time::interval(Duration::from_secs(30));
    loop {
        interval.tick().await;
        if let Err(e) = check_and_fire(&app).await {
            eprintln!("notification scheduler error: {e}");
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
    title: String,
    scheduled_start: String,
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
        state.0.lock().await.clone()
    };

    if !settings.enabled {
        return Ok(());
    }

    if is_quiet_hours(&settings) {
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
    let now_ts = now.format("%Y-%m-%dT%H:%M:%S").to_string();
    let window_start = (now - chrono::Duration::seconds(30))
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string();
    let today = now.format("%Y-%m-%d").to_string();

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

    for row in due {
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

    for row in due {
        fire_reminder(app, pool, &row).await?;
    }

    Ok(())
}

/// Overdue alerts: once per (page_id, calendar_date).
async fn fire_overdue_alerts(
    app: &AppHandle,
    pool: &SqlitePool,
    now_ts: &str,
    today: &str,
) -> Result<(), String> {
    let recent_cutoff = (chrono::Local::now() - chrono::Duration::minutes(5))
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string();

    let overdue: Vec<OverduePage> = sqlx::query_as(
        "SELECT DISTINCT ps.page_id, p.title, ps.scheduled_start
         FROM page_schedules ps
         JOIN pages p ON p.id = ps.page_id
         WHERE p.status != 'done'
           AND p.deleted_at IS NULL
           AND ps.status != 'done'
           AND ps.scheduled_start < ?
           AND p.created_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM notification_log nl
             WHERE nl.page_id = ps.page_id
               AND nl.type = 'overdue'
               AND date(nl.fired_at) = ?
           )",
    )
    .bind(now_ts)
    .bind(&recent_cutoff)
    .bind(today)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    for row in overdue {
        let time_str = format_time_from_iso(&row.scheduled_start);
        let body = if time_str.is_empty() {
            "Overdue".to_string()
        } else {
            format!("Overdue · was scheduled for {time_str}")
        };

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

        deliver(app, &row.title, &body);
    }

    Ok(())
}

// ─── Delivery ────────────────────────────────────────────────────────────────

/// Send an OS desktop notification.
fn deliver(app: &AppHandle, title: &str, body: &str) {
    let _ = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show();
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
    let fired_at = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
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
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(30))
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    sqlx::query("DELETE FROM notification_log WHERE fired_at < ?")
        .bind(&cutoff)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
