//! Background notification scheduler.
//!
//! Runs as a Tokio task, not JS setInterval, so it survives a backgrounded or throttled
//! webview. Ticks once per minute on the clock minute boundary.
//!
//! Two delivery paths:
//! 1. Per-reminder, at `scheduled_start - minutes_before` for timed events. All-day events are
//!    excluded: they'd fire at midnight-minus-N.
//! 2. Daily summary, once per local day, at quiet-hours-end or 07:00+ without quiet hours.
//!    It is also the catch-up for reminders that would have fired during quiet hours.

use std::collections::HashSet;
use std::time::Duration;

use chrono::{Datelike, NaiveDate, Timelike};
use pikos_db::DueReminder;
use sqlx::SqlitePool;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::db::DbState;

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettings {
    pub enabled: bool,
    pub default_minutes_before: i64,
    /// Daily summary: one notification per day with today's schedule + overdue.
    pub overdue_alerts: bool,
    /// HH:MM, 24h. Inside quiet hours the summary defers to the first non-quiet tick after it
    /// (quiet hours can be daytime, e.g. a focus block).
    pub summary_time: String, // e.g. "07:00"
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

pub struct NotificationSettingsState(pub tokio::sync::Mutex<NotificationSettings>);

impl NotificationSettingsState {
    pub fn new() -> Self {
        NotificationSettingsState(tokio::sync::Mutex::new(NotificationSettings::default()))
    }
}

#[derive(Clone, Default)]
struct SchedulerRuntime {
    /// Fast-path dedup; the DB marker row is the source of truth across restarts.
    last_summary_date: Option<NaiveDate>,
    /// Where the last successful tick's window ended. Tokio's timer doesn't advance while
    /// the machine sleeps, so after a wake two ticks can fall seconds apart and both collect
    /// a reminder in the overlap. Only a finished tick sets it, so a failed one's reminders
    /// are retried rather than skipped.
    last_window_end: Option<chrono::DateTime<chrono::Local>>,
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

#[tauri::command]
pub async fn update_notification_settings(
    state: tauri::State<'_, NotificationSettingsState>,
    settings: NotificationSettings,
) -> crate::error::AppResult<()> {
    *state.0.lock().await = settings;
    Ok(())
}

/// Tauri command: request OS notification permission. Returns true if granted. macOS
/// never asks again once notifications are turned off, so there it opens Pikos's page
/// in System Settings, and the panel's check on returning to the window sees the change.
#[tauri::command]
pub async fn request_notification_permission(
    app: tauri::AppHandle,
) -> crate::error::AppResult<bool> {
    #[cfg(target_os = "macos")]
    {
        let blocked = crate::notifications::macos::notifications_off().await;
        if blocked {
            open_settings_page(&app)?;
        }

        Ok(!blocked)
    }
    #[cfg(not(target_os = "macos"))]
    match app.notification().request_permission() {
        Ok(state) => Ok(state == tauri_plugin_notification::PermissionState::Granted),
        Err(e) => Err(crate::error::AppError::Internal(e.to_string())),
    }
}

/// Tauri command: check current notification permission status. On macOS it asks the
/// system, as a tick does: the plugin's desktop answer is always granted, so a denial in
/// System Settings never reached the panel's blocked banner.
#[tauri::command]
pub async fn check_notification_permission(app: tauri::AppHandle) -> crate::error::AppResult<bool> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        Ok(!crate::notifications::macos::notifications_off().await)
    }
    #[cfg(not(target_os = "macos"))]
    match app.notification().permission_state() {
        Ok(state) => Ok(state == tauri_plugin_notification::PermissionState::Granted),
        Err(e) => Err(crate::error::AppError::Internal(e.to_string())),
    }
}

/// Tauri command: open Pikos's page in System Settings → Notifications. Opened from
/// Rust because the webview's opener scope admits only web, mail and phone links.
#[tauri::command]
pub async fn open_notification_settings(app: tauri::AppHandle) -> crate::error::AppResult<()> {
    #[cfg(target_os = "macos")]
    open_settings_page(&app)?;
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_settings_page(app: &tauri::AppHandle) -> crate::error::AppResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let url = format!(
        "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id={}",
        app.config().identifier
    );
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| crate::error::AppError::Internal(e.to_string()))
}

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
        tokio::time::sleep(until_next_minute(chrono::Local::now())).await;

        if let Err(e) = check_and_fire(&app).await {
            // Tick failure is recoverable — next tick retries. Surface as
            // warn so a recurring underlying issue is visible. Pass the
            // sqlx error class only — the Display output can echo SQL
            // fragments and parameter values back into the log.
            log::warn!("scheduler_tick_failed kind={}", classify_sqlx(&e));
        }
    }
}

fn until_next_minute(now: chrono::DateTime<chrono::Local>) -> Duration {
    let secs = 60 - now.second() as u64;
    let nanos = now.nanosecond() as u64;
    Duration::from_secs(secs) - Duration::from_nanos(nanos.min(secs * 1_000_000_000))
}

pub(super) use pikos_db::error::classify_sqlx;

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
/// Once per local day, when overdue_alerts is on, it is not quiet, and `summary_time` has
/// passed. A summary time inside quiet hours defers to the first non-quiet tick after it,
/// overnight or daytime: 07:00 with 22:00–10:00 quiet defers to 10:00.
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

struct DueBatch {
    reminders: Vec<DueReminder>,
    /// None of `reminders` may be delivered; they are carried so each can be recorded as a suppression.
    quiet: bool,
    summary: DueSummary,
}

#[derive(Debug, PartialEq)]
enum DueSummary {
    NotDue,
    /// Deliver nothing, and consume the day in memory so the rest of it stays query-free.
    AlreadyLogged,
    /// Zero counts suppress the notification, not the marker, or every later tick re-runs the counts.
    Due {
        today_count: i64,
        overdue_count: i64,
    },
}

/// Quiet hours mark the batch `quiet` rather than emptying it: nothing in a quiet
/// batch is ever delivered (the caller reads `quiet` in one place), but the
/// reminders are still resolved so each can be logged as a suppression; without
/// that, the user's only evidence is the notification that never came. They
/// resurface in the next summary as overdue. The summary is evaluated above the
/// gate because it defers rather than skips; `should_fire_daily_summary` owns
/// that rule.
async fn collect_due(
    pool: &SqlitePool,
    settings: &NotificationSettings,
    runtime: &SchedulerRuntime,
    now: &chrono::DateTime<chrono::Local>,
) -> Result<DueBatch, sqlx::Error> {
    let now_quiet = is_quiet_hours(settings, now);

    let summary = if should_fire_daily_summary(runtime, settings, now_quiet, now) {
        collect_daily_summary(pool, now).await?
    } else {
        DueSummary::NotDue
    };

    let window = pikos_db::ReminderWindow::ending_at(*now, runtime.last_window_end);
    let minutes = settings.default_minutes_before;

    let mut reminders = pikos_db::due_explicit_reminders(pool, &window).await?;
    reminders.extend(pikos_db::due_default_reminders(pool, minutes, &window).await?);
    reminders.extend(pikos_db::due_day_before_reminders(pool, &window).await?);
    reminders.extend(pikos_db::due_recurring_reminders(pool, &window, minutes).await?);
    reminders.extend(pikos_db::due_synced_reminders(pool, &window, minutes).await?);
    reminders.extend(pikos_db::due_synced_override_reminders(pool, &window, minutes).await?);

    // Backstop: the six partition the schedules by construction, and nothing
    // logs between them, so an overlap would deliver twice.
    let mut seen = HashSet::new();
    reminders.retain(|r| seen.insert(r.schedule_id.clone()));

    Ok(DueBatch {
        reminders,
        quiet: now_quiet,
        summary,
    })
}

async fn collect_daily_summary(
    pool: &SqlitePool,
    now: &chrono::DateTime<chrono::Local>,
) -> Result<DueSummary, sqlx::Error> {
    let today = now.format("%Y-%m-%d").to_string();
    if pikos_db::daily_summary_fired_on(pool, &today).await? {
        return Ok(DueSummary::AlreadyLogged);
    }

    let now_ts = now.format("%Y-%m-%d %H:%M:%S").to_string();
    let stale_cutoff = (*now - chrono::Duration::hours(24))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();

    Ok(DueSummary::Due {
        today_count: pikos_db::today_scheduled_count(pool, &today).await?,
        overdue_count: pikos_db::overdue_count(
            pool,
            &now_ts,
            &stale_cutoff,
            now.with_timezone(&chrono::Utc),
        )
        .await?,
    })
}

/// The daily summary's today and overdue counts at `now`, for the e2e bridge, which runs no
/// scheduler. None once today's summary has been logged.
#[cfg(feature = "e2e-bridge")]
pub(crate) async fn daily_summary_counts(
    pool: &SqlitePool,
    now: &chrono::DateTime<chrono::Local>,
) -> Result<Option<(i64, i64)>, sqlx::Error> {
    Ok(match collect_daily_summary(pool, now).await? {
        DueSummary::Due {
            today_count,
            overdue_count,
        } => Some((today_count, overdue_count)),
        DueSummary::NotDue | DueSummary::AlreadyLogged => None,
    })
}

/// Internal fns return `sqlx::Error` directly so the log site can use `classify_sqlx`
/// without echoing parameter values through Display.
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

    // Linux and Windows have no authorization read, so they always deliver.
    #[cfg(target_os = "macos")]
    let notifications_off = crate::notifications::macos::notifications_off().await;
    #[cfg(not(target_os = "macos"))]
    let notifications_off = false;

    let runtime_state = app.state::<SchedulerRuntimeState>();
    let mut runtime = runtime_state.lock().await.clone();
    let result = tick(
        &pool,
        &settings,
        &mut runtime,
        chrono::Local::now(),
        notifications_off,
        &mut |title, body, log_id| deliver(app, title, body, log_id),
    )
    .await;
    // Written back on failure too: a summary already marked stays marked, and the window
    // stays open because only a finished tick moves it.
    *runtime_state.lock().await = runtime;
    result
}

/// With `notifications_off`, a due reminder is logged as not shown rather than handed to a
/// system that would drop it.
async fn tick(
    pool: &SqlitePool,
    settings: &NotificationSettings,
    runtime: &mut SchedulerRuntime,
    now: chrono::DateTime<chrono::Local>,
    notifications_off: bool,
    show: &mut impl FnMut(&str, &str, &str),
) -> Result<(), sqlx::Error> {
    let batch = collect_due(pool, settings, runtime, &now).await?;

    match batch.summary {
        DueSummary::NotDue => {}
        DueSummary::AlreadyLogged => runtime.last_summary_date = Some(now.date_naive()),
        DueSummary::Due {
            today_count,
            overdue_count,
        } => {
            // Local time, consistent with the date(fired_at) dedup read.
            let now_ts = now.format("%Y-%m-%d %H:%M:%S").to_string();
            let log_id = pikos_db::log_daily_summary(pool, &now_ts).await?;
            if today_count > 0 || overdue_count > 0 {
                show(
                    &format_summary_title(&now),
                    &format_summary_body(today_count, overdue_count),
                    &log_id,
                );
            }
            runtime.last_summary_date = Some(now.date_naive());
        }
    }

    let not_shown = if batch.quiet {
        Some(pikos_db::NotShown::QuietHours)
    } else if notifications_off {
        Some(pikos_db::NotShown::NotificationsOff)
    } else {
        None
    };

    for row in &batch.reminders {
        match not_shown {
            Some(reason) => record_not_shown(pool, row, &now, reason).await?,
            None => fire_reminder(pool, row, &now, show).await?,
        }
    }

    runtime.last_window_end = Some(now);
    Ok(())
}

/// macOS delivers via UserNotifications (`notifications::macos`) so the banner shows while
/// Pikos is frontmost, falling back to the plugin for an unbundled dev binary; other
/// platforms use the plugin.
///
/// `log_id` becomes the notification's OS identifier on the UserNotifications path, so a
/// click can find its row (see `notifications::click`); the plugin takes no identifier.
///
/// Needs a signed app bundle: unsigned dev builds silently drop notifications.
fn deliver(app: &AppHandle, title: &str, body: &str, log_id: &str) {
    #[cfg(target_os = "macos")]
    {
        if crate::notifications::macos::deliver(title, body, log_id) {
            return;
        }
    }
    if let Err(e) = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .sound("default")
        .group("pikos-reminders")
        .show()
    {
        // The row is already logged as fired; this line is what says nobody saw it.
        log::warn!("notification_show_failed log_id={log_id} error={e}");
    }
}

async fn record_not_shown(
    pool: &SqlitePool,
    row: &DueReminder,
    now: &chrono::DateTime<chrono::Local>,
    reason: pikos_db::NotShown,
) -> Result<(), sqlx::Error> {
    let fired_at = now.format("%Y-%m-%d %H:%M:%S").to_string();
    pikos_db::log_reminder_not_shown(pool, &row.page_id, &row.schedule_id, &fired_at, reason)
        .await?;
    log::info!(
        "notification_suppressed reason={} page_id={} schedule_id={}",
        reason.log_type(),
        row.page_id,
        row.schedule_id
    );
    Ok(())
}

fn format_lead_time(minutes: i64) -> String {
    if minutes == pikos_db::DAY_BEFORE_MINUTES {
        // The all-day anchor, not a lead: it fired at 09:00 the day before, and
        // "in 1440 min" would be both wrong and unreadable.
        "tomorrow".to_string()
    } else if minutes == 0 {
        "now".to_string()
    } else if minutes < 60 {
        format!("in {} min", minutes)
    } else if minutes % 1440 == 0 {
        // A whole number of days reads as days: "in 24 hours" is the same span said
        // less plainly.
        let days = minutes / 1440;
        if days == 1 {
            "in 1 day".to_string()
        } else {
            format!("in {} days", days)
        }
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

const NOT_SYNCING_NOTE: &str = "\nCalendar not syncing, so this may have changed";

async fn fire_reminder(
    pool: &SqlitePool,
    row: &DueReminder,
    now: &chrono::DateTime<chrono::Local>,
    show: &mut impl FnMut(&str, &str, &str),
) -> Result<(), sqlx::Error> {
    let lead = format_lead_time(row.minutes_before);
    let time_str = format_time_from_iso(&row.scheduled_start);
    let mut body = if time_str.is_empty() {
        format!("Starts {lead}")
    } else {
        format!("Starts {lead} · {time_str}")
    };
    // Still shown: a reminder flagged as maybe out of date costs less than a real
    // meeting missed.
    if pikos_db::page_calendar_out_of_date(pool, &row.page_id, now.to_utc()).await? {
        body.push_str(NOT_SYNCING_NOTE);
    }

    // Log to prevent re-firing. The row id doubles as the notification's OS
    // identifier, so a click routes back to this page (see `notifications::click`).
    let fired_at = now.format("%Y-%m-%d %H:%M:%S").to_string();
    let log_id =
        pikos_db::log_reminder_fired(pool, &row.page_id, &row.schedule_id, &fired_at).await?;

    show(&row.title, &body, &log_id);

    // Diagnostic fields explain "fired for a completed page" reports without logging content:
    // has_rule=true with schedule_start != page_start is recurring drift (the head advanced but
    // the reminder keyed off a stale row); status=done is a TOCTOU. A failed read must not stop delivery.
    match pikos_db::reminder_fire_diagnostics(pool, &row.page_id).await {
        Ok(Some(diag)) => {
            let drift = diag.has_rule != 0
                && diag.page_scheduled_start.as_deref() != Some(row.scheduled_start.as_str());
            log::info!(
                "notification_fired type=reminder log_id={log_id} page_id={} schedule_id={} \
                 minutes_before={} schedule_start={} page_start={} has_rule={} status={} \
                 completed={} drift={}",
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
                "notification_fired type=reminder log_id={log_id} page_id={} schedule_id={} (page vanished before diagnostics)",
                row.page_id,
                row.schedule_id
            );
        }
        Err(e) => {
            log::info!(
                "notification_fired type=reminder log_id={log_id} page_id={} schedule_id={} (diagnostics failed kind={})",
                row.page_id,
                row.schedule_id,
                classify_sqlx(&e)
            );
        }
    }

    Ok(())
}

pub async fn prune_notification_log(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let cutoff = (chrono::Local::now() - chrono::Duration::days(30))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    pikos_db::prune_notification_log(pool, &cutoff).await
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
