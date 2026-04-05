//! Background notification scheduler.
//!
//! Runs as a Tokio task on the Tauri async runtime (not JS setInterval),
//! so it stays alive even when the webview is backgrounded or throttled.
//! Every 30 seconds it queries SQLite for due reminders and fires OS
//! desktop notifications via `tauri-plugin-notification`.

use std::time::Duration;

use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::db::DbState;

/// Notification settings passed from the frontend via a Tauri event.
/// Stored in an `Arc<Mutex<>>` so the scheduler can read them.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettings {
    pub enabled: bool,
    /// Default lead time in minutes (0 = at start, 5, 10, 15, 30).
    pub default_minutes_before: i64,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        NotificationSettings {
            enabled: true,
            default_minutes_before: 10,
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

/// Tauri command: frontend calls this whenever notification settings change.
#[tauri::command]
pub async fn update_notification_settings(
    state: tauri::State<'_, NotificationSettingsState>,
    settings: NotificationSettings,
) -> Result<(), String> {
    *state.0.lock().await = settings;
    Ok(())
}

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

#[derive(sqlx::FromRow)]
struct DueReminder {
    schedule_id: String,
    page_id: String,
    title: String,
    subtitle: Option<String>,
    scheduled_start: String,
    minutes_before: i64,
}

/// Query for due reminders and fire OS notifications.
async fn check_and_fire(app: &AppHandle) -> Result<(), String> {
    // Read current settings
    let settings = {
        let state = app.state::<NotificationSettingsState>();
        state.0.lock().await.clone()
    };

    if !settings.enabled {
        return Ok(());
    }

    // Get the DB pool — may not be connected yet (app still loading)
    let pool = {
        let db_state = app.state::<DbState>();
        match db_state.get_pool().await {
            Ok(p) => p,
            Err(_) => return Ok(()), // DB not connected yet, skip this tick
        }
    };

    let now = chrono::Utc::now();
    let now_ts = now.format("%Y-%m-%dT%H:%M:%S").to_string();
    let window_start = (now - chrono::Duration::seconds(30))
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string();

    // 1. Fire reminders for pages with explicit page_reminders rows
    fire_explicit_reminders(app, &pool, &window_start, &now_ts).await?;

    // 2. Fire default reminders for scheduled pages without explicit reminders
    fire_default_reminders(app, &pool, &settings, &window_start, &now_ts).await?;

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
        "SELECT ps.id AS schedule_id, ps.page_id, p.title, p.subtitle,
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
        fire_notification(app, pool, &row).await?;
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
        "SELECT ps.id AS schedule_id, ps.page_id, p.title, p.subtitle,
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
        fire_notification(app, pool, &row).await?;
    }

    Ok(())
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
    // Try to parse "YYYY-MM-DDTHH:MM:SS" and format as "h:MMam/pm"
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(scheduled_start, "%Y-%m-%dT%H:%M:%S") {
        let hour = dt.time().format("%l:%M%P").to_string();
        hour.trim().to_string()
    } else {
        // All-day event — no time to show
        String::new()
    }
}

async fn fire_notification(
    app: &AppHandle,
    pool: &SqlitePool,
    row: &DueReminder,
) -> Result<(), String> {
    // Build notification body
    let lead = format_lead_time(row.minutes_before);
    let time_str = format_time_from_iso(&row.scheduled_start);
    let body = if time_str.is_empty() {
        format!("Starts {lead}")
    } else {
        format!("Starts {lead} · {time_str}")
    };

    // Fire OS notification
    let _ = app
        .notification()
        .builder()
        .title(&row.title)
        .body(&body)
        .show();

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

    // Emit event to frontend (for future in-app banner support)
    let _ = app.emit("notification:fired", serde_json::json!({
        "pageId": row.page_id,
        "title": row.title,
        "body": body,
    }));

    Ok(())
}
