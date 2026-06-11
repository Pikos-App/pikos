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
use pikos_db::DueReminder;
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
) -> crate::error::AppResult<()> {
    *state.0.lock().await = settings;
    Ok(())
}

/// Tauri command: request OS notification permission. Returns true if granted.
#[tauri::command]
pub async fn request_notification_permission(
    app: tauri::AppHandle,
) -> crate::error::AppResult<bool> {
    match app.notification().request_permission() {
        Ok(state) => Ok(state == tauri_plugin_notification::PermissionState::Granted),
        Err(e) => Err(crate::error::AppError::Internal(e.to_string())),
    }
}

/// Tauri command: check current notification permission status.
#[tauri::command]
pub async fn check_notification_permission(app: tauri::AppHandle) -> crate::error::AppResult<bool> {
    match app.notification().permission_state() {
        Ok(state) => Ok(state == tauri_plugin_notification::PermissionState::Granted),
        Err(e) => Err(crate::error::AppError::Internal(e.to_string())),
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
    fire_recurring_reminders(app, &pool, &settings, &window_start, &now_ts).await?;

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
    let due = pikos_db::due_explicit_reminders(pool, window_start, now_ts).await?;

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

    let due = pikos_db::due_default_reminders(pool, minutes, window_start, now_ts).await?;

    for row in due {
        fire_reminder(app, pool, &row).await?;
    }

    Ok(())
}

/// Recurring (rrule-backed) pages — reminders fire off the advancing head
/// (`pages.scheduled_start`), not the stale page_schedules anchor row. Honors
/// per-page `page_reminders` lead times when present, else the global default.
async fn fire_recurring_reminders(
    app: &AppHandle,
    pool: &SqlitePool,
    settings: &NotificationSettings,
    window_start: &str,
    now_ts: &str,
) -> Result<(), sqlx::Error> {
    let explicit = pikos_db::due_recurring_explicit_reminders(pool, window_start, now_ts).await?;
    for row in explicit {
        fire_reminder(app, pool, &row).await?;
    }

    let minutes = settings.default_minutes_before;
    let default =
        pikos_db::due_recurring_default_reminders(pool, minutes, window_start, now_ts).await?;
    for row in default {
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
    if pikos_db::daily_summary_fired_on(pool, &today).await? {
        return Ok(false);
    }

    let now_ts = now.format("%Y-%m-%d %H:%M:%S").to_string();
    let stale_cutoff = (*now - chrono::Duration::hours(24))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    let recent_cutoff = (*now - chrono::Duration::minutes(5))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();

    let today_count = pikos_db::today_scheduled_count(pool, &today).await?;

    let overdue_count =
        pikos_db::overdue_count(pool, &now_ts, &stale_cutoff, &recent_cutoff).await?;

    // Insert marker row (local time, consistent with date(fired_at)=today above).
    pikos_db::log_daily_summary(pool, &now_ts).await?;

    if today_count == 0 && overdue_count == 0 {
        return Ok(false);
    }

    let title = format_summary_title(now);
    let body = format_summary_body(today_count, overdue_count);
    deliver(app, &title, &body);

    Ok(true)
}

// ─── Delivery ────────────────────────────────────────────────────────────────

/// Send an OS desktop notification.
///
/// On macOS we deliver via the modern UserNotifications framework
/// (`notifications::macos`) so the banner shows even when Pikos is the
/// frontmost app — the tauri-plugin-notification path uses the legacy
/// NSUserNotification API, which macOS suppresses in the foreground. If the UN
/// path is unavailable (unbundled `tauri dev` binary), we fall through to the
/// plugin. All other platforms use the plugin directly.
///
/// Requires a properly signed app bundle — unsigned dev builds will
/// silently drop notifications. Use osascript fallback for dev testing.
fn deliver(app: &AppHandle, title: &str, body: &str) {
    #[cfg(target_os = "macos")]
    {
        if crate::notifications::macos::deliver(title, body) {
            return;
        }
    }

    if let Ok(()) = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .sound("default")
        .group("pikos-reminders")
        .show()
    {}
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

    // Log to prevent re-firing.
    let fired_at = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    pikos_db::log_reminder_fired(pool, &row.page_id, &row.schedule_id, &fired_at).await?;

    deliver(app, &row.title, &body);

    // Reminder actually fired — meaningful audit anchor at INFO. Empty
    // ticks are silent (most ticks find nothing).
    //
    // Diagnostic fields help explain "fired for a completed page" reports
    // without logging any user content (no titles). The tell:
    // - has_rule=true with schedule_start != page_start → recurring drift: the
    //   head advanced but the reminder keyed off a stale page_schedules row.
    // - status=done would mean a TOCTOU between the due query and now.
    // Best-effort: a failed diagnostic read must not stop delivery.
    match pikos_db::reminder_fire_diagnostics(pool, &row.page_id).await {
        Ok(Some(diag)) => {
            let drift = diag.has_rule != 0
                && diag.page_scheduled_start.as_deref() != Some(row.scheduled_start.as_str());
            log::info!(
                "notification_fired type=reminder page_id={} schedule_id={} minutes_before={} \
                 schedule_start={} page_start={} has_rule={} status={} completed={} drift={}",
                row.page_id,
                row.schedule_id,
                row.minutes_before,
                row.scheduled_start,
                diag.page_scheduled_start.as_deref().unwrap_or("none"),
                diag.has_rule != 0,
                diag.status,
                diag.completed_at.is_some(),
                drift,
            );
        }
        Ok(None) => {
            log::info!(
                "notification_fired type=reminder page_id={} schedule_id={} (page vanished before diagnostics)",
                row.page_id,
                row.schedule_id
            );
        }
        Err(e) => {
            log::info!(
                "notification_fired type=reminder page_id={} schedule_id={} (diagnostics failed kind={})",
                row.page_id,
                row.schedule_id,
                classify_sqlx(&e)
            );
        }
    }

    Ok(())
}

/// Prune notification_log entries older than 30 days so the table can't grow
/// unboundedly. Run once per pool open (see `db::open_pool`).
pub async fn prune_notification_log(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let cutoff = (chrono::Local::now() - chrono::Duration::days(30))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    pikos_db::prune_notification_log(pool, &cutoff).await
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
