//! Pool-based queries behind the desktop notification scheduler, which owns timing,
//! quiet hours, settings and OS delivery.
//!
//! These functions return `sqlx::Error`, not `AppResult`: the scheduler logs a
//! content-free error class via `classify_sqlx`, because the sqlx `Display` output can
//! echo SQL fragments and parameter values such as titles.

use std::collections::HashSet;

use pikos_recurrence::{zoned, WallClock};
use sqlx::SqlitePool;

/// Recurrence-derivation failures reach the scheduler as a content-free `sqlx::Error`
/// (see the module doc); a real DB error carries through as itself.
fn derivation_error(e: crate::error::AppError) -> sqlx::Error {
    match e {
        crate::error::AppError::Db(e) => e,
        _ => sqlx::Error::Protocol("recurrence derivation failed".into()),
    }
}

/// The span one scheduler tick owes reminders for, half-open as `(start, end]`.
///
/// Every arm reads this rather than deriving `end - 60s`, so two arms can't disagree and
/// collect one reminder twice. Half-open matters at the edge: a reminder on a whole minute
/// (every UI reminder) lands exactly on a tick, and a closed span would put it in that
/// tick's window and the next one's. A delivery survives that on its dedup row; a
/// quiet-hours suppression writes none, so the silenced reminder would be listed twice.
///
/// `start` is floored by the previous tick's end, not fixed 60 seconds back: tokio's timer
/// doesn't advance while the machine sleeps, so after a wake two ticks can land seconds
/// apart. It is still capped at 60 seconds, so a wake delivers nothing for the hours slept.
#[derive(Clone, Copy, Debug)]
pub struct ReminderWindow {
    start_local: chrono::NaiveDateTime,
    end_local: chrono::NaiveDateTime,
    start_utc: chrono::DateTime<chrono::Utc>,
    end_utc: chrono::DateTime<chrono::Utc>,
}

/// SQLite's `datetime()` output format, which the wall-clock bounds are compared against
/// lexicographically — so both sides must use the space separator, not `T`.
const SQL_DATETIME: &str = "%Y-%m-%d %H:%M:%S";

impl ReminderWindow {
    /// `end` is this tick's clock. `previous_end` is the last *finished* tick's, absent on
    /// the first tick of a run and after a tick that failed — which leaves its span open so
    /// its reminders are retried rather than skipped.
    pub fn ending_at(
        end: chrono::DateTime<chrono::Local>,
        previous_end: Option<chrono::DateTime<chrono::Local>>,
    ) -> Self {
        let floor = end - chrono::Duration::seconds(60);
        let start = previous_end.filter(|p| *p > floor).unwrap_or(floor);
        Self {
            start_local: start.naive_local(),
            end_local: end.naive_local(),
            start_utc: start.to_utc(),
            end_utc: end.to_utc(),
        }
    }

    /// `(now, now + horizon]` with no 60-second cap, on `zone`'s clock: the phone plans every
    /// reminder over days and hands each to the OS, where the desktop ticks.
    pub fn ahead(
        now: chrono::DateTime<chrono::Utc>,
        zone: chrono_tz::Tz,
        horizon: chrono::Duration,
    ) -> Self {
        let end = now + horizon;
        Self {
            start_local: now.with_timezone(&zone).naive_local(),
            end_local: end.with_timezone(&zone).naive_local(),
            start_utc: now,
            end_utc: end,
        }
    }

    /// The same span with its wall-clock and its instant stated independently, which the
    /// device's own zone otherwise ties together. Tests pin both so a machine that is not on
    /// UTC reads the same fixtures.
    #[cfg(test)]
    pub(crate) fn for_test(
        end_local: chrono::NaiveDateTime,
        end_utc: chrono::DateTime<chrono::Utc>,
    ) -> Self {
        let minute = chrono::Duration::seconds(60);
        Self {
            start_local: end_local - minute,
            end_local,
            start_utc: end_utc - minute,
            end_utc,
        }
    }

    /// The bounds as SQLite `datetime()` strings, for the wall-clock arms.
    fn wall_bounds(&self) -> (String, String) {
        (
            self.start_local.format(SQL_DATETIME).to_string(),
            self.end_local.format(SQL_DATETIME).to_string(),
        )
    }

    /// Whether an absolute fire instant falls inside the span.
    pub fn holds_utc(&self, fire: chrono::DateTime<chrono::Utc>) -> bool {
        fire > self.start_utc && fire <= self.end_utc
    }

    /// Whether a device-local fire wall-clock falls inside the span.
    pub fn holds_local(&self, fire: chrono::NaiveDateTime) -> bool {
        fire > self.start_local && fire <= self.end_local
    }

    pub fn start_local(&self) -> chrono::NaiveDateTime {
        self.start_local
    }

    pub fn start_utc(&self) -> chrono::DateTime<chrono::Utc> {
        self.start_utc
    }

    /// This tick's clock, for the arms that enumerate around "now".
    pub fn end_local(&self) -> chrono::NaiveDateTime {
        self.end_local
    }

    /// This tick's clock as an instant.
    pub fn end_utc(&self) -> chrono::DateTime<chrono::Utc> {
        self.end_utc
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
/// `(window_start, now_ts]`. All-day events (no `T` in `scheduled_start`) are excluded, as
/// they'd fire at midnight minus N. Already-fired reminders are skipped by their dedup row.
pub async fn due_explicit_reminders(
    pool: &SqlitePool,
    window: &ReminderWindow,
) -> Result<Vec<DueReminder>, sqlx::Error> {
    let (window_start, now_ts) = window.wall_bounds();
    // Dedup keys per (schedule, lead), or the first lead to fire would suppress the rest.
    // Encoded as `<id>#<minutes>` in schedule_id, like the recurring `page_id@start#lead`.
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
           AND datetime(ps.scheduled_start, '-' || pr.minutes_before || ' minutes') > ?
           AND datetime(ps.scheduled_start, '-' || pr.minutes_before || ' minutes') <= ?
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
    .bind(&window_start)
    .bind(&now_ts)
    .fetch_all(pool)
    .await
}

/// The `page_reminders.minutes_before` value that means "the day before, at
/// [`DAY_BEFORE_HOUR`]:00 local" rather than a lead time in minutes.
///
/// An all-day page has no start time for a lead to anchor on, which is why every timed
/// arm skips it. The sentinel sits beside `-1` ("never remind") in the same column, so an
/// all-day reminder is still one `page_reminders` row; [`due_day_before_reminders`]
/// resolves it against the date. Every lead-time arm filters `minutes_before >= 0`, so it
/// is never read as a two-minute lead.
pub const DAY_BEFORE_MINUTES: i64 = -2;

/// Local hour a [`DAY_BEFORE_MINUTES`] reminder fires on the preceding day.
const DAY_BEFORE_HOUR: i64 = 9;

/// All-day pages carrying an explicit [`DAY_BEFORE_MINUTES`] reminder whose
/// 09:00-on-D-1 anchor lands in `(window_start, now_ts]`.
///
/// Device-local wall-clock throughout, like [`due_explicit_reminders`]: the anchor comes
/// from the event's date, so no source zone shifts it. Active-synced rows stay on this
/// path because the absolute arms exclude all-day, which would leave them no arm. Rule-backed
/// series are out of scope, as the enumeration only walks timed series.
///
/// Dedups on `<id>#-2`, the explicit arm's per-lead composite, so a moved all-day row
/// re-arms through [`clear_reminder_log_tx`].
pub async fn due_day_before_reminders(
    pool: &SqlitePool,
    window: &ReminderWindow,
) -> Result<Vec<DueReminder>, sqlx::Error> {
    let (window_start, now_ts) = window.wall_bounds();
    // sql-ok: DAY_BEFORE_MINUTES and DAY_BEFORE_HOUR are compile-time constants
    sqlx::query_as(&format!(
        "SELECT ps.id || '#' || pr.minutes_before AS schedule_id, ps.page_id, p.title,
                ps.scheduled_start, pr.minutes_before
         FROM page_schedules ps
         JOIN pages p ON p.id = ps.page_id
         JOIN page_reminders pr ON pr.page_id = ps.page_id
         WHERE p.status != 'done'
           AND p.deleted_at IS NULL
           AND ps.status != 'done'
           AND pr.minutes_before = {DAY_BEFORE_MINUTES}
           AND ps.scheduled_start NOT LIKE '%T%'
           AND NOT (
             ps.rule_id IS NULL
             AND EXISTS (SELECT 1 FROM page_recurrence_rules r WHERE r.page_id = ps.page_id)
           )
           AND datetime(date(ps.scheduled_start), '-1 day', '+{DAY_BEFORE_HOUR} hours') > ?
           AND datetime(date(ps.scheduled_start), '-1 day', '+{DAY_BEFORE_HOUR} hours') <= ?
           AND NOT EXISTS (
             SELECT 1 FROM notification_log nl
             WHERE nl.schedule_id = ps.id || '#' || pr.minutes_before
               AND nl.type = 'reminder'
           )"
    ))
    .bind(&window_start)
    .bind(&now_ts)
    .fetch_all(pool)
    .await
}

/// Pages *without* `page_reminders` rows — use the global `default_minutes`
/// lead time. All-day events and already-fired reminders are excluded as above.
pub async fn due_default_reminders(
    pool: &SqlitePool,
    default_minutes: i64,
    window: &ReminderWindow,
) -> Result<Vec<DueReminder>, sqlx::Error> {
    let (window_start, now_ts) = window.wall_bounds();
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
           AND datetime(ps.scheduled_start, '-' || ? || ' minutes') > ?
           AND datetime(ps.scheduled_start, '-' || ? || ' minutes') <= ?
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
    .bind(&window_start)
    .bind(default_minutes)
    .bind(&now_ts)
    .fetch_all(pool)
    .await
}

// Synced events are absolute, not floating: `scheduled_start` is a source-zone
// wall-clock, so a reminder must fire on the absolute instant, not when the device-local
// clock reads the same digits. The naive `due_*` queries above read it as device-local,
// so they exclude zoned active-synced pages and this path handles them. A zone-less
// synced event (a floating CalDAV DTSTART) is device-local and stays on the naive path,
// explicit and default-lead arms alike, or it would never remind.
//
// Origin does not change the lead time: every page notifies at the global default unless
// it carries an explicit reminder, and `-1` still means "never". Provider alarms are
// never ingested, because the mirror is read-only and an imported lead couldn't be edited.
// Synced recurring occurrences fire through `due_recurring_reminders` and their overrides
// through `due_synced_override_reminders`, on the same source-zone to instant basis.
//
// SQLite can't resolve IANA zones, so the SQL is a coarse +-15h prefilter (every real
// offset) and the exact window check runs in Rust via chrono-tz.

#[derive(sqlx::FromRow)]
struct SyncedReminderRow {
    schedule_id: String,
    page_id: String,
    title: String,
    scheduled_start: String,
    minutes_before: i64,
    timezone: String,
}

/// Source-zone wall-clock plus lead time as the absolute UTC instant to fire. `None` on an
/// unparseable zone or timestamp, or a wall-clock in a spring-forward gap (which never
/// fires), as [`zoned::wall_clock_instant`] reads it for every layer storing an instant.
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

/// When a reminder fires, in whichever frame the arm that found it resolves.
///
/// A native page floats, so its fire is a device wall-clock; a synced page is pinned to a
/// source zone, so its fire is an instant. The desktop tick compares each against the
/// matching "now"; the phone converts an instant into the device's wall clock and needs to
/// know which it was given.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FireAt {
    Local(chrono::NaiveDateTime),
    Absolute(chrono::DateTime<chrono::Utc>),
}

/// A due reminder with when it fires, so a caller looking ahead over days can order them;
/// the tick that only asks "now?" drops the instant.
#[derive(Clone, Debug)]
pub struct ReminderFire {
    pub reminder: DueReminder,
    pub fire_at: FireAt,
}

/// Synced one-off events whose absolute fire instant lands in the tick's window, at their
/// explicit lead or the global `default_minutes`. All-day, done, recurring and
/// already-fired are excluded.
pub async fn due_synced_reminders(
    pool: &SqlitePool,
    window: &ReminderWindow,
    default_minutes: i64,
) -> Result<Vec<DueReminder>, sqlx::Error> {
    let fires = synced_reminders_firing_in(pool, window, default_minutes).await?;
    Ok(fires.into_iter().map(|fire| fire.reminder).collect())
}

/// [`due_synced_reminders`] with each fire's instant kept, for a caller planning ahead.
pub async fn synced_reminders_firing_in(
    pool: &SqlitePool,
    window: &ReminderWindow,
    default_minutes: i64,
) -> Result<Vec<ReminderFire>, sqlx::Error> {
    let prefilter_lo = (window.start_utc() - chrono::Duration::hours(15))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    let prefilter_hi = (window.end_utc() + chrono::Duration::hours(15))
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
    .bind(&prefilter_lo)
    .bind(&prefilter_hi)
    .fetch_all(pool)
    .await?;

    Ok(resolve_synced_fires(rows, window))
}

/// The exact window check behind both synced arms, carrying each instant out.
fn resolve_synced_fires(
    rows: Vec<SyncedReminderRow>,
    window: &ReminderWindow,
) -> Vec<ReminderFire> {
    rows.into_iter()
        .filter_map(|row| {
            let fire =
                synced_fire_instant(&row.scheduled_start, &row.timezone, row.minutes_before)?;
            window.holds_utc(fire).then_some(ReminderFire {
                reminder: DueReminder {
                    schedule_id: row.schedule_id,
                    page_id: row.page_id,
                    title: row.title,
                    scheduled_start: row.scheduled_start,
                    minutes_before: row.minutes_before,
                },
                fire_at: FireAt::Absolute(fire),
            })
        })
        .collect()
}

/// Synced recurring per-instance overrides (a moved instance or a RECURRENCE-ID edit) are
/// `page_schedules` rows carrying the series `rule_id` and a source zone. They aren't rule
/// occurrences, so the recurring enumeration excludes their `original_date` and every other
/// `due_*` path drops them. Fires each at its own moved instant, like a synced one-off,
/// with the series' explicit reminders or the global `default_minutes`. Completed and
/// skipped occurrences are keyed on `original_date`. Dedups on the real row id, so it can't
/// collide with the enumeration's synthetic keys. Zoned only: a floating override is served
/// by `due_explicit_reminders`.
pub async fn due_synced_override_reminders(
    pool: &SqlitePool,
    window: &ReminderWindow,
    default_minutes: i64,
) -> Result<Vec<DueReminder>, sqlx::Error> {
    let fires = synced_override_reminders_firing_in(pool, window, default_minutes).await?;
    Ok(fires.into_iter().map(|fire| fire.reminder).collect())
}

/// [`due_synced_override_reminders`] with each fire's instant kept.
pub async fn synced_override_reminders_firing_in(
    pool: &SqlitePool,
    window: &ReminderWindow,
    default_minutes: i64,
) -> Result<Vec<ReminderFire>, sqlx::Error> {
    let prefilter_lo = (window.start_utc() - chrono::Duration::hours(15))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    let prefilter_hi = (window.end_utc() + chrono::Duration::hours(15))
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
    .bind(&prefilter_lo)
    .bind(&prefilter_hi)
    .fetch_all(pool)
    .await?;

    Ok(resolve_synced_fires(rows, window))
}

// rrule-backed pages have no per-occurrence `page_schedules` row, so their reminders come
// from enumerating the rule (the queries above skip a recurring page's stale
// `rule_id IS NULL` anchor). Each occurrence dedups on a synthetic `page_id@start[#lead]`,
// so completing or skipping one suppresses its reminder without touching the others.

/// The scheduler's seam over [`crate::recurrence_derive::occurrences_with_open_reminder_window`]:
/// owns the `max_lead` bound and maps errors through [`derivation_error`].
pub async fn due_recurring_reminders(
    pool: &SqlitePool,
    window: &ReminderWindow,
    default_minutes: i64,
) -> Result<Vec<DueReminder>, sqlx::Error> {
    let max_explicit: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(minutes_before), 0) FROM page_reminders")
            .fetch_one(pool)
            .await?;
    let max_lead = default_minutes.max(max_explicit).max(0);
    crate::recurrence_derive::occurrences_with_open_reminder_window(
        pool,
        window,
        default_minutes,
        max_lead,
    )
    .await
    .map_err(derivation_error)
}

/// The largest lead any reminder could have. The recurring enumeration widens its window
/// by it, so an occurrence whose reminder fires inside the window is found even when the
/// occurrence itself is past it.
pub async fn max_reminder_lead(
    pool: &SqlitePool,
    default_minutes: i64,
) -> Result<i64, sqlx::Error> {
    let max_explicit: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(minutes_before), 0) FROM page_reminders")
            .fetch_one(pool)
            .await?;
    Ok(default_minutes.max(max_explicit).max(0))
}

/// Whether the daily-summary marker (`type='overdue'`, no `page_id` or `schedule_id`) was
/// already inserted on `date`.
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
/// ([`crate::recurrence_derive::recurring_pages_in_window`]) or a materialised override
/// lands there; the two partition the series. Its stale anchor row counts for neither.
pub async fn today_scheduled_count(pool: &SqlitePool, date: &str) -> Result<i64, sqlx::Error> {
    // A day either side, then the viewer's day decides, as `list_pages_today` reads it.
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT ps.page_id, ps.scheduled_start, ps.timezone
         FROM page_schedules ps
         JOIN pages p ON p.id = ps.page_id
         WHERE p.status != 'done'
           AND p.deleted_at IS NULL
           AND ps.status != 'done'
           AND date(ps.scheduled_start) BETWEEN date(?1, '-1 day') AND date(?1, '+1 day')
           AND (ps.rule_id IS NOT NULL
                OR NOT EXISTS (SELECT 1 FROM page_recurrence_rules r WHERE r.page_id = p.id))",
    )
    .bind(date)
    .fetch_all(pool)
    .await?;
    let mut pages: HashSet<String> = rows
        .into_iter()
        .filter(|(_, start, zone)| crate::sync::viewer_day_of(start, zone.as_deref()) == date)
        .map(|(page_id, _, _)| page_id)
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

/// `YYYY-MM-DDTHH:MM:SS`, so two wall-clock values compare as their instants do whether they
/// were written with a space or a `T`, or without seconds.
fn to_the_second(wall: &str) -> String {
    let wall = wall.replacen(' ', "T", 1);
    if wall.len() == 16 {
        format!("{wall}:00")
    } else {
        wall.chars().take(19).collect()
    }
}

/// A page created this recently is part of an import batch, not the user's backlog: a
/// connect lands dozens of past-dated events at once, overdue to no one.
const IMPORT_SKIP_MINUTES: i64 = 5;

/// Count of distinct timed, not-done pages overdue in `[stale_cutoff, now_ts)`,
/// excluding pages created within [`IMPORT_SKIP_MINUTES`] of `now_utc`.
///
/// The window bounds are local wall-clock, matching `scheduled_start`; `now_utc` is the
/// same instant in UTC because the recency cutoff is compared against `created_at`, which
/// is UTC ([`crate::now_iso`]). One `now` in both clocks swallowed real overdue pages west
/// of UTC and never skipped an import east of it.
///
/// Origin doesn't matter: a synced page is completable, and ticking it clears the count.
///
/// Recurring occurrences are enumerated as in [`today_scheduled_count`]: a series whose
/// head lapsed days ago still owes the occurrences since.
pub async fn overdue_count(
    pool: &SqlitePool,
    now_ts: &str,
    stale_cutoff: &str,
    now_utc: chrono::DateTime<chrono::Utc>,
) -> Result<i64, sqlx::Error> {
    let recent_cutoff = (now_utc - chrono::Duration::minutes(IMPORT_SKIP_MINUTES))
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    // A day either side, then each start on the viewer's clock decides.
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT ps.page_id, ps.scheduled_start, ps.timezone
         FROM page_schedules ps
         JOIN pages p ON p.id = ps.page_id
         WHERE p.status != 'done'
           AND p.deleted_at IS NULL
           AND datetime(p.created_at) < datetime(?1)
           AND ps.status != 'done'
           AND ps.scheduled_start LIKE '%T%'
           AND datetime(ps.scheduled_start) < datetime(?2, '+1 day')
           AND datetime(ps.scheduled_start) >= datetime(?3, '-1 day')
           AND (ps.rule_id IS NOT NULL
                OR NOT EXISTS (SELECT 1 FROM page_recurrence_rules r WHERE r.page_id = p.id))",
    )
    .bind(&recent_cutoff)
    .bind(now_ts)
    .bind(stale_cutoff)
    .fetch_all(pool)
    .await?;
    let (now, stale) = (to_the_second(now_ts), to_the_second(stale_cutoff));
    let mut pages: HashSet<String> = rows
        .into_iter()
        .filter(|(_, start, zone)| {
            let local = to_the_second(&crate::sync::viewer_wall_clock(start, zone.as_deref()));
            local < now && local >= stale
        })
        .map(|(page_id, _, _)| page_id)
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

/// How long a calendar can go without syncing before its events may have moved or gone.
/// The desktop banner uses the same hour (`NOT_SYNCING_AFTER_MS`).
pub const CALENDAR_OUT_OF_DATE_AFTER: chrono::Duration = chrono::Duration::hours(1);

/// Whether `page_id` mirrors a calendar Pikos may be out of date on: its account
/// needs signing in again, or the calendar last synced over
/// [`CALENDAR_OUT_OF_DATE_AFTER`] before `now`. A native or detached page is the
/// user's own, so it never is, and nor is a calendar that has yet to sync.
pub async fn page_calendar_out_of_date(
    pool: &SqlitePool,
    page_id: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<bool, sqlx::Error> {
    let cutoff =
        (now - CALENDAR_OUT_OF_DATE_AFTER).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    sqlx::query_scalar(
        "SELECT EXISTS (
           SELECT 1 FROM page_sync sy
           JOIN sync_account a ON a.id = sy.account_id
           JOIN sync_calendar c ON c.account_id = sy.account_id AND c.calendar_id = sy.calendar_id
           WHERE sy.page_id = ? AND sy.sync_state = 'active'
             AND (a.reconnect_needed = 1 OR julianday(c.last_synced_at) < julianday(?))
         )",
    )
    .bind(page_id)
    .bind(cutoff)
    .fetch_one(pool)
    .await
}

/// Records that a reminder fired, anchoring dedup for later ticks, and returns the row id.
/// The scheduler hands the id to the OS as the notification's identifier, so a later click
/// names the row to mark opened ([`mark_notification_opened`]) and the page to open, with
/// nothing held in memory across a restart.
pub async fn log_reminder_fired(
    pool: &SqlitePool,
    page_id: &str,
    schedule_id: &str,
    fired_at: &str,
) -> Result<String, sqlx::Error> {
    let id = crate::fresh::id();
    sqlx::query(
        "INSERT INTO notification_log (id, page_id, schedule_id, type, fired_at)
         VALUES (?, ?, ?, 'reminder', ?)",
    )
    .bind(&id)
    .bind(page_id)
    .bind(schedule_id)
    .bind(fired_at)
    .execute(pool)
    .await?;
    Ok(id)
}

/// Marks a delivered notification as opened and returns the page it named. `None` when
/// there is nothing to open: an id no row carries (a banner that outlived the 30-day
/// prune) or the page-less daily summary. `WHERE action IS NULL` keeps the first outcome,
/// so a second click is a no-op.
pub async fn mark_notification_opened(
    pool: &SqlitePool,
    id: &str,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query("UPDATE notification_log SET action = 'opened' WHERE id = ? AND action IS NULL")
        .bind(id)
        .execute(pool)
        .await?;
    sqlx::query_scalar("SELECT page_id FROM notification_log WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map(Option::flatten)
}

/// Why a due reminder was never shown, stored as its log row's `type`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotShown {
    QuietHours,
    /// The system has notifications turned off for Pikos.
    NotificationsOff,
}

impl NotShown {
    pub fn log_type(self) -> &'static str {
        match self {
            NotShown::QuietHours => "suppressed",
            NotShown::NotificationsOff => "refused",
        }
    }
}

/// Record that a reminder came due and was never delivered, and why.
///
/// Never `type='reminder'`: every dedup predicate reads that, so this row is invisible to
/// them and the reminder is dropped, with the day's summary counting the page as overdue.
/// The row lets the history panel say the reminder happened and why nobody saw it.
pub async fn log_reminder_not_shown(
    pool: &SqlitePool,
    page_id: &str,
    schedule_id: &str,
    fired_at: &str,
    reason: NotShown,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO notification_log (id, page_id, schedule_id, type, fired_at)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(crate::fresh::id())
    .bind(page_id)
    .bind(schedule_id)
    .bind(reason.log_type())
    .bind(fired_at)
    .execute(pool)
    .await?;
    Ok(())
}

/// One row of the notification history panel: what fired, when, for which page.
///
/// `page_title` is joined in, so a renamed page reads under its current name and a deleted
/// one as `None`: the log row outlives the page, since `notification_log.page_id` carries
/// no foreign key.
#[derive(Debug, sqlx::FromRow, serde::Serialize, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields = nullable)]
pub struct NotificationHistoryEntry {
    pub id: String,
    pub page_id: Option<String>,
    pub page_title: Option<String>,
    pub schedule_id: Option<String>,
    /// `reminder` (delivered), `suppressed` (quiet hours ate it), `refused`
    /// (notifications are off for Pikos) or `overdue` (the daily summary marker).
    /// Named `kind` because `type` is a Rust keyword; the column is `type`.
    pub kind: String,
    pub fired_at: String,
    /// `opened` once the user clicks the notification through; `None` otherwise.
    pub action: Option<String>,
}

/// The notification log, newest first, capped at `limit`.
///
/// Reads the whole 30-day retention window, so the panel shows exactly what the dedup
/// ledger holds. A soft-deleted page still names itself: the row records a real delivery.
///
/// Returns `AppResult`, unlike the rest of this module, because a command calls it rather
/// than the scheduler's run loop.
pub async fn list_notification_history(
    pool: &SqlitePool,
    limit: i64,
) -> crate::error::AppResult<Vec<NotificationHistoryEntry>> {
    Ok(sqlx::query_as(
        "SELECT nl.id, nl.page_id, p.title AS page_title, nl.schedule_id,
                nl.type AS kind, nl.fired_at, nl.action
         FROM notification_log nl
         LEFT JOIN pages p ON p.id = nl.page_id
         ORDER BY datetime(nl.fired_at) DESC, nl.rowid DESC
         LIMIT ?",
    )
    .bind(limit)
    .fetch_all(pool)
    .await?)
}

/// Drops a schedule row's fired dedup anchors so its reminders re-arm at the new time.
///
/// Matches both key shapes: the bare row id (default lead) and the `<id>#<minutes>`
/// composite (explicit, synced, synced-override). Deleting only the bare id leaves explicit
/// and synced reminders pinned as fired, so a moved event never notifies until the prune.
pub(crate) async fn clear_reminder_log_tx(
    conn: &mut sqlx::SqliteConnection,
    schedule_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "DELETE FROM notification_log
         WHERE type = 'reminder' AND (schedule_id = ?1 OR schedule_id LIKE ?1 || '#%')",
    )
    .bind(schedule_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Inserts the daily-summary marker (one per local day) and returns its id, as
/// [`log_reminder_fired`] does. The summary names no page, so a click opens the calendar.
pub async fn log_daily_summary(pool: &SqlitePool, fired_at: &str) -> Result<String, sqlx::Error> {
    let id = crate::fresh::id();
    sqlx::query(
        "INSERT INTO notification_log (id, page_id, schedule_id, type, fired_at)
         VALUES (?, NULL, NULL, 'overdue', ?)",
    )
    .bind(&id)
    .bind(fired_at)
    .execute(pool)
    .await?;
    Ok(id)
}

pub async fn prune_notification_log(pool: &SqlitePool, cutoff: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM notification_log WHERE datetime(fired_at) < datetime(?)")
        .bind(cutoff)
        .execute(pool)
        .await?;
    Ok(())
}

/// A page's state when a reminder fires, for logging why one fired for a page the user
/// believes complete:
/// - `has_rule = 1` with `page_scheduled_start` differing from the firing row's
///   `scheduled_start` is recurring drift: the head advanced but the reminder keyed off a
///   stale `page_schedules` row.
/// - `status = 'done'` should be impossible, as the due queries filter it; seeing it means
///   a race between the query and this read.
#[derive(sqlx::FromRow, Debug)]
pub struct ReminderFireDiagnostics {
    pub status: String,
    pub completed_at: Option<String>,
    pub page_scheduled_start: Option<String>,
    pub has_rule: i64,
}

/// `None` if the page was deleted between the due query and this read.
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
