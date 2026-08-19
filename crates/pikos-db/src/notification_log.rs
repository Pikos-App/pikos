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

use std::collections::HashSet;

use pikos_recurrence::{zoned, WallClock};
use sqlx::SqlitePool;

/// Recurrence-derivation failures reach the scheduler as a content-free
/// `sqlx::Error` (see the module doc); a real DB error carries through as itself.
/// The derivations isolate per-series rule failures internally, so nothing else
/// is expected here.
fn derivation_error(e: crate::error::AppError) -> sqlx::Error {
    match e {
        crate::error::AppError::Db(e) => e,
        _ => sqlx::Error::Protocol("recurrence derivation failed".into()),
    }
}

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
    // Dedup keys per-(schedule, lead), not per-schedule — else the first lead to
    // fire would suppress every other lead. Encoded as `<id>#<minutes>` in
    // schedule_id, matching the recurring path's `page_id@start#lead` scheme; the
    // scheduler logs this composite verbatim, so the NOT EXISTS below matches per-lead.
    sqlx::query_as(
        "SELECT ps.id || '#' || pr.minutes_before AS schedule_id, ps.page_id, p.title,
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
           AND (
             ps.timezone IS NULL
             OR NOT EXISTS (
               SELECT 1 FROM page_sync sy
               WHERE sy.page_id = ps.page_id AND sy.sync_state = 'active'
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM notification_log nl
             WHERE nl.schedule_id = ps.id || '#' || pr.minutes_before
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
           AND (
             ps.timezone IS NULL
             OR NOT EXISTS (
               SELECT 1 FROM page_sync sy
               WHERE sy.page_id = ps.page_id AND sy.sync_state = 'active'
             )
           )
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

// ─── Synced (absolute-time) reminders ────────────────────────────────────────
//
// Synced events are absolute, not floating: their `scheduled_start` is a
// source-zone wall-clock, so a reminder must fire on the absolute INSTANT, not
// when the device-local wall-clock happens to read the same digits. The naive
// `due_*` queries above interpret `scheduled_start` as device-local, so they
// exclude *zoned* active-synced pages and this path handles them instead. A
// zone-less synced event (a floating CalDAV DTSTART) is device-local by
// definition and stays on the naive path — both its explicit and its
// default-lead arm, or it would fall through every query and never remind.
//
// Origin does not change the lead time: every page notifies at the user's global
// default unless it carries an explicit reminder, and an explicit `-1` still means
// "never". Provider alarms are deliberately never ingested — the mirror is
// read-only, so an imported per-event lead would be one the user could not edit.
// Synced *recurring* occurrences fire through `due_recurring_reminders` (rule
// enumeration) and their per-instance overrides through
// `due_synced_override_reminders` (materialized rows) — both resolve the same
// source-zone → absolute instant.
//
// SQLite can't resolve IANA zones, so the SQL is only a coarse ±15h prefilter
// (covers every real zone offset) and the exact absolute-window check runs in
// Rust via chrono-tz.

#[derive(sqlx::FromRow)]
struct SyncedReminderRow {
    schedule_id: String,
    page_id: String,
    title: String,
    scheduled_start: String,
    minutes_before: i64,
    timezone: String,
}

/// Source-zone wall-clock + lead time → the absolute UTC instant the reminder
/// should fire. `None` only on an unparseable zone/timestamp or a wall-clock that
/// doesn't exist in the zone (a spring-forward gap, which never fires) — the
/// reading [`zoned::wall_clock_instant`] states once for every layer that stores
/// an instant, including the reconciler's zone shifts.
pub(crate) fn synced_fire_instant(
    wall_clock: &str,
    timezone: &str,
    minutes_before: i64,
) -> Option<chrono::DateTime<chrono::Utc>> {
    let wall = WallClock::parse(wall_clock).filter(|w| !w.is_all_day())?;
    let zone: chrono_tz::Tz = timezone.parse().ok()?;
    let instant = zoned::wall_clock_instant(zone, wall.as_datetime())?;
    Some(instant - chrono::Duration::minutes(minutes_before))
}

/// Synced one-off events whose absolute fire instant lands in
/// `(now_utc - 60s, now_utc]`, at their explicit reminder lead or — when they have
/// none — the global `default_minutes`. All-day, done, recurring, and already-fired
/// are excluded.
pub async fn due_synced_reminders(
    pool: &SqlitePool,
    now_utc: chrono::DateTime<chrono::Utc>,
    default_minutes: i64,
) -> Result<Vec<DueReminder>, sqlx::Error> {
    let lo = (now_utc - chrono::Duration::hours(15))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    let hi = (now_utc + chrono::Duration::hours(15))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    let rows: Vec<SyncedReminderRow> = sqlx::query_as(
        // Per-lead dedup key (`<id>#<minutes>`) — see due_explicit_reminders.
        "SELECT ps.id || '#' || COALESCE(pr.minutes_before, ?1) AS schedule_id, ps.page_id, p.title,
                ps.scheduled_start, COALESCE(pr.minutes_before, ?1) AS minutes_before, ps.timezone
         FROM page_schedules ps
         JOIN pages p ON p.id = ps.page_id
         JOIN page_sync sy ON sy.page_id = ps.page_id AND sy.sync_state = 'active'
         LEFT JOIN page_reminders pr ON pr.page_id = ps.page_id
         WHERE p.status != 'done'
           AND p.deleted_at IS NULL
           AND ps.status != 'done'
           AND COALESCE(pr.minutes_before, ?1) >= 0
           AND ps.scheduled_start LIKE '%T%'
           AND ps.timezone IS NOT NULL
           AND ps.rule_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM page_recurrence_rules r WHERE r.page_id = ps.page_id)
           AND datetime(ps.scheduled_start, '-' || COALESCE(pr.minutes_before, ?1) || ' minutes')
               BETWEEN ?2 AND ?3
           AND NOT EXISTS (
             SELECT 1 FROM notification_log nl
             WHERE nl.schedule_id = ps.id || '#' || COALESCE(pr.minutes_before, ?1)
               AND nl.type = 'reminder'
           )",
    )
    .bind(default_minutes)
    .bind(&lo)
    .bind(&hi)
    .fetch_all(pool)
    .await?;

    let window_lo = now_utc - chrono::Duration::seconds(60);
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let fire =
                synced_fire_instant(&row.scheduled_start, &row.timezone, row.minutes_before)?;
            (fire > window_lo && fire <= now_utc).then_some(DueReminder {
                schedule_id: row.schedule_id,
                page_id: row.page_id,
                title: row.title,
                scheduled_start: row.scheduled_start,
                minutes_before: row.minutes_before,
            })
        })
        .collect())
}

/// Synced recurring **per-instance overrides** (a moved instance or a
/// single-instance edit — RECURRENCE-ID) materialize as `page_schedules` rows
/// carrying the series `rule_id` + a source zone. They are not rule occurrences,
/// so the recurring enumeration never emits them (it excludes their
/// `original_date`) and every other `due_*` path drops them (rule-backed +
/// active-synced). Fire each at its own moved instant on the same source-zone →
/// absolute basis as a synced one-off, with the series' explicit reminders or —
/// when it has none — the global `default_minutes` lead (matching the
/// enumeration's synced-default). Completed/skipped occurrences are keyed on the
/// override's `original_date`. Dedups on the real row id like
/// `due_synced_reminders`, so it can't collide with the enumeration's synthetic
/// keys. Zoned only — a floating synced override with a device-local reminder is
/// already served by `due_explicit_reminders`.
pub async fn due_synced_override_reminders(
    pool: &SqlitePool,
    now_utc: chrono::DateTime<chrono::Utc>,
    default_minutes: i64,
) -> Result<Vec<DueReminder>, sqlx::Error> {
    let lo = (now_utc - chrono::Duration::hours(15))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    let hi = (now_utc + chrono::Duration::hours(15))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    let rows: Vec<SyncedReminderRow> = sqlx::query_as(
        // Per-lead dedup key (`<id>#<minutes>`) — see due_explicit_reminders.
        "SELECT ps.id || '#' || COALESCE(pr.minutes_before, ?1) AS schedule_id, ps.page_id, p.title, ps.scheduled_start,
                COALESCE(pr.minutes_before, ?1) AS minutes_before, ps.timezone
         FROM page_schedules ps
         JOIN pages p ON p.id = ps.page_id
         JOIN page_sync sy ON sy.page_id = ps.page_id AND sy.sync_state = 'active'
         LEFT JOIN page_reminders pr ON pr.page_id = ps.page_id
         WHERE p.status != 'done'
           AND p.deleted_at IS NULL
           AND ps.status != 'done'
           AND ps.scheduled_start LIKE '%T%'
           AND ps.timezone IS NOT NULL
           AND ps.rule_id IS NOT NULL
           AND ps.original_date IS NOT NULL
           AND COALESCE(pr.minutes_before, ?1) >= 0
           AND datetime(ps.scheduled_start, '-' || COALESCE(pr.minutes_before, ?1) || ' minutes')
               BETWEEN ?2 AND ?3
           AND NOT EXISTS (
             SELECT 1 FROM completed_set cs
             WHERE cs.page_id = ps.page_id
               AND cs.occurrence_date = substr(ps.original_date, 1, 10)
           )
           AND NOT EXISTS (
             SELECT 1 FROM skip_set sk
             WHERE sk.page_id = ps.page_id
               AND sk.occurrence_date = substr(ps.original_date, 1, 10)
           )
           AND NOT EXISTS (
             SELECT 1 FROM notification_log nl
             WHERE nl.schedule_id = ps.id || '#' || COALESCE(pr.minutes_before, ?1)
               AND nl.type = 'reminder'
           )",
    )
    .bind(default_minutes)
    .bind(&lo)
    .bind(&hi)
    .fetch_all(pool)
    .await?;

    let window_lo = now_utc - chrono::Duration::seconds(60);
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let fire =
                synced_fire_instant(&row.scheduled_start, &row.timezone, row.minutes_before)?;
            (fire > window_lo && fire <= now_utc).then_some(DueReminder {
                schedule_id: row.schedule_id,
                page_id: row.page_id,
                title: row.title,
                scheduled_start: row.scheduled_start,
                minutes_before: row.minutes_before,
            })
        })
        .collect())
}

// ─── Recurring occurrence reminders ──────────────────────────────────────────
//
// rrule-backed pages have no per-occurrence `page_schedules` row, so their
// reminders come from enumerating the rule directly rather than off a stored row
// (the page_schedules queries above deliberately skip a recurring page's stale
// `rule_id IS NULL` anchor). Native series fire on device-local wall-clock, synced
// on the source-zone → absolute instant; each occurrence dedups on a synthetic
// `page_id@start[#lead]` id, so completing or skipping one (which lands it in the
// exclusion union) suppresses its reminder without touching the others.

/// The sqlx-facing seam over [`crate::recurrence_derive::occurrences_with_open_reminder_window`]
/// for the scheduler: owns the `max_lead` bound (an upper bound over every
/// configured lead) and maps the enumeration's error through [`derivation_error`].
pub async fn due_recurring_reminders(
    pool: &SqlitePool,
    now_local: chrono::NaiveDateTime,
    now_utc: chrono::DateTime<chrono::Utc>,
    default_minutes: i64,
) -> Result<Vec<DueReminder>, sqlx::Error> {
    let max_explicit: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(minutes_before), 0) FROM page_reminders")
            .fetch_one(pool)
            .await?;
    let max_lead = default_minutes.max(max_explicit).max(0);
    crate::recurrence_derive::occurrences_with_open_reminder_window(
        pool,
        now_local,
        now_utc,
        default_minutes,
        max_lead,
    )
    .await
    .map_err(derivation_error)
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
///
/// A recurring page counts when its rule yields an occurrence on `date`
/// ([`crate::recurrence_derive::recurring_pages_in_window`]) or when a
/// materialised override lands there — the two partition the series, since the
/// override's original date is in the exclusion union. Its stale pre-rule anchor
/// row (`rule_id IS NULL`) counts for neither.
pub async fn today_scheduled_count(pool: &SqlitePool, date: &str) -> Result<i64, sqlx::Error> {
    let mut pages: HashSet<String> = sqlx::query_scalar(
        "SELECT ps.page_id
         FROM page_schedules ps
         JOIN pages p ON p.id = ps.page_id
         WHERE p.status != 'done'
           AND p.deleted_at IS NULL
           AND ps.status != 'done'
           AND date(ps.scheduled_start) = ?
           AND (ps.rule_id IS NOT NULL
                OR NOT EXISTS (SELECT 1 FROM page_recurrence_rules r WHERE r.page_id = p.id))",
    )
    .bind(date)
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();

    pages.extend(
        crate::recurrence_derive::recurring_pages_in_window(
            pool,
            &format!("{date}T00:00:00"),
            &format!("{date}T23:59:59"),
            false,
            None,
        )
        .await
        .map_err(derivation_error)?,
    );
    Ok(pages.len() as i64)
}

/// A page created this recently reads as part of an import batch rather than the
/// user's backlog — a connect lands dozens of past-dated events at once and none
/// of them are overdue to anyone.
const IMPORT_SKIP_MINUTES: i64 = 5;

/// Count of distinct timed, not-done pages overdue in `[stale_cutoff, now_ts)`,
/// excluding pages created within [`IMPORT_SKIP_MINUTES`] of `now_utc`.
///
/// The window bounds are local wall-clock, matching `scheduled_start`; `now_utc`
/// is the same instant in UTC because the recency cutoff derives from it and is
/// compared against `created_at`, which is UTC ([`crate::now_iso`]). One `now` in
/// both clocks swallowed real overdue pages west of UTC and never skipped an
/// import east of it.
///
/// Origin does not enter into it: a synced page is completable like any other, so
/// ticking it clears the count. The mirror lock blocks rescheduling, which is not
/// what overdue measures.
///
/// Recurring occurrences are enumerated for the same reason as in
/// [`today_scheduled_count`] — a series whose head lapsed days ago still owes the
/// occurrences it yielded since.
pub async fn overdue_count(
    pool: &SqlitePool,
    now_ts: &str,
    stale_cutoff: &str,
    now_utc: chrono::DateTime<chrono::Utc>,
) -> Result<i64, sqlx::Error> {
    let recent_cutoff = (now_utc - chrono::Duration::minutes(IMPORT_SKIP_MINUTES))
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    let mut pages: HashSet<String> = sqlx::query_scalar(
        "SELECT ps.page_id
         FROM page_schedules ps
         JOIN pages p ON p.id = ps.page_id
         WHERE p.status != 'done'
           AND p.deleted_at IS NULL
           AND datetime(p.created_at) < datetime(?1)
           AND ps.status != 'done'
           AND ps.scheduled_start LIKE '%T%'
           AND datetime(ps.scheduled_start) < datetime(?2)
           AND datetime(ps.scheduled_start) >= datetime(?3)
           AND (ps.rule_id IS NOT NULL
                OR NOT EXISTS (SELECT 1 FROM page_recurrence_rules r WHERE r.page_id = p.id))",
    )
    .bind(&recent_cutoff)
    .bind(now_ts)
    .bind(stale_cutoff)
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();

    // The scheduler passes SQLite's space-separated form; the engine parses ISO `T`.
    pages.extend(
        crate::recurrence_derive::recurring_pages_in_window(
            pool,
            &stale_cutoff.replace(' ', "T"),
            &now_ts.replace(' ', "T"),
            true,
            Some(&recent_cutoff),
        )
        .await
        .map_err(derivation_error)?,
    );
    Ok(pages.len() as i64)
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

/// Drop a schedule row's already-fired dedup anchors so its reminders re-arm at
/// the row's new time.
///
/// Matches both key shapes the `due_*` queries dedup on: the bare row id
/// (default lead) and the per-lead composite `<id>#<minutes>` (explicit, synced,
/// synced-override). Deleting only the bare id leaves every explicit and synced
/// reminder pinned as fired, so a moved event never notifies again until the
/// 30-day prune.
pub(crate) async fn clear_reminder_log_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    schedule_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "DELETE FROM notification_log
         WHERE type = 'reminder' AND (schedule_id = ?1 OR schedule_id LIKE ?1 || '#%')",
    )
    .bind(schedule_id)
    .execute(&mut **tx)
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
