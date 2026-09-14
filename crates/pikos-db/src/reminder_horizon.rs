//! Every reminder that will fire in the next N days, placed on the device's
//! own clock.
//!
//! The desktop asks the six `due_*` arms "what is due *now*?" every clock
//! minute. A phone cannot run that loop — iOS suspends the process within
//! seconds of backgrounding — so its model is inverted: compute what will fire
//! over a horizon, hand each one to the OS in advance, and recompute whenever
//! the workspace changes. This module is the first half of that. It composes
//! the same six arms the desktop composes, over a forward window instead of a
//! trailing one, so a reminder rings on the phone for exactly the reasons it
//! rings on the desktop — the shared rules about done pages, all-day anchors,
//! floating-versus-zoned pages, skipped occurrences and the `-1` sentinel are
//! all theirs, not a second copy.
//!
//! What it adds is placement. Each arm knows when its reminder fires in its
//! own frame — a native page's wall clock, a synced page's absolute instant —
//! and the OS wants one thing: a wall-clock date in the device's zone. So the
//! caller names its zone, and every fire comes out as `YYYY-MM-DDTHH:MM:SS` on
//! that zone's clock.
//!
//! Quiet hours are deliberately not applied here. The desktop suppresses a
//! reminder that comes due inside them; on iOS the platform's Focus modes are
//! the same control, system-wide, and applying a second copy at schedule time
//! would silence a reminder the user's Focus schedule would have let through.

use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use sqlx::SqlitePool;

use crate::error::AppResult;
use crate::notification_log::{
    due_day_before_reminders, due_default_reminders, due_explicit_reminders, max_reminder_lead,
    synced_override_reminders_firing_between, synced_reminders_firing_between, DueReminder, FireAt,
    ReminderFire, DAY_BEFORE_MINUTES,
};
use crate::recurrence_derive::occurrences_with_reminders_firing_between;

/// A reminder that will fire inside the horizon, placed on the device's clock.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpcomingReminder {
    /// The same key the desktop logs when it fires this reminder — a schedule
    /// row id with the lead appended, or `page@start[#lead]` for a rule's
    /// occurrence. Distinct per (occurrence × lead), so it is what the OS
    /// notification is identified by.
    pub key: String,
    pub page_id: String,
    pub title: String,
    /// The occurrence's own start, as stored — device-local for a native
    /// page, source-zone for a synced one. For wording, not for placement.
    pub scheduled_start: String,
    pub minutes_before: i64,
    /// When it fires, on the device's clock: `YYYY-MM-DDTHH:MM:SS`.
    pub fire_at: String,
}

/// The local hour a day-before reminder fires on the preceding day — the
/// same 09:00 [`due_day_before_reminders`] resolves the sentinel to.
const DAY_BEFORE_HOUR: u32 = 9;

const SQL_TS: &str = "%Y-%m-%d %H:%M:%S";
const WALL_FMT: &str = "%Y-%m-%dT%H:%M:%S";

/// Every reminder firing in `(now, now + horizon]`, soonest first.
///
/// `device_zone` is the zone the phone is in, which is what the wall clocks
/// of native pages are read in and what every fire is placed on. A page a
/// calendar owns is pinned to its source zone and resolved through it, so a
/// 15:00 Berlin meeting reminds a phone in New York at 09:00 minus the lead.
///
/// Already-fired reminders are excluded the way the desktop excludes them, by
/// the `notification_log` row it writes — which, on a phone that hands
/// delivery to the OS and never sees the moment it fires, means nothing is
/// excluded on that account. Correct, not an oversight: the phone re-plans
/// the whole horizon on every change and the OS keeps one notification per
/// key, so there is nothing to dedup against.
pub async fn upcoming_reminders(
    pool: &SqlitePool,
    now_utc: DateTime<Utc>,
    device_zone: chrono_tz::Tz,
    horizon: Duration,
    default_minutes: i64,
) -> AppResult<Vec<UpcomingReminder>> {
    let now_local = now_utc.with_timezone(&device_zone).naive_local();
    let end_local = now_local + horizon;
    let end_utc = now_utc + horizon;
    let now_ts = now_local.format(SQL_TS).to_string();
    let end_ts = end_local.format(SQL_TS).to_string();

    let mut fires: Vec<ReminderFire> = Vec::new();

    // The three wall-clock arms return rows without an instant; each fire is
    // reconstructed here by the same arithmetic the SQL selected on.
    for row in due_explicit_reminders(pool, &now_ts, &end_ts).await? {
        fires.extend(lead_fire(row));
    }
    for row in due_default_reminders(pool, default_minutes, &now_ts, &end_ts).await? {
        fires.extend(lead_fire(row));
    }
    for row in due_day_before_reminders(pool, &now_ts, &end_ts).await? {
        fires.extend(day_before_fire(row));
    }

    let max_lead = max_reminder_lead(pool, default_minutes).await?;
    fires.extend(
        occurrences_with_reminders_firing_between(
            pool,
            now_local,
            end_local,
            now_utc,
            end_utc,
            default_minutes,
            max_lead,
        )
        .await?,
    );
    fires.extend(synced_reminders_firing_between(pool, now_utc, end_utc, default_minutes).await?);
    fires.extend(
        synced_override_reminders_firing_between(pool, now_utc, end_utc, default_minutes).await?,
    );

    // The six partition the schedules by construction; the desktop keeps the
    // same backstop against an overlap delivering twice.
    let mut seen = std::collections::HashSet::new();
    fires.retain(|fire| seen.insert(fire.reminder.schedule_id.clone()));

    let mut placed: Vec<UpcomingReminder> = fires
        .into_iter()
        .map(|fire| {
            let at = match fire.fire_at {
                FireAt::Local(wall) => wall,
                FireAt::Absolute(instant) => instant.with_timezone(&device_zone).naive_local(),
            };
            UpcomingReminder {
                key: fire.reminder.schedule_id,
                page_id: fire.reminder.page_id,
                title: fire.reminder.title,
                scheduled_start: fire.reminder.scheduled_start,
                minutes_before: fire.reminder.minutes_before,
                fire_at: at.format(WALL_FMT).to_string(),
            }
        })
        .collect();
    placed.sort_by(|a, b| a.fire_at.cmp(&b.fire_at).then_with(|| a.key.cmp(&b.key)));
    Ok(placed)
}

/// A timed row's fire: its start minus its lead, on the clock it was stored in.
fn lead_fire(row: DueReminder) -> Option<ReminderFire> {
    let start = NaiveDateTime::parse_from_str(&row.scheduled_start, WALL_FMT).ok()?;
    let at = start - Duration::minutes(row.minutes_before);
    Some(ReminderFire {
        reminder: row,
        fire_at: FireAt::Local(at),
    })
}

/// An all-day row's fire: 09:00 on the day before, which is the only anchor
/// such a page can carry — the sentinel names it rather than a count.
fn day_before_fire(row: DueReminder) -> Option<ReminderFire> {
    debug_assert_eq!(row.minutes_before, DAY_BEFORE_MINUTES);
    let date = chrono::NaiveDate::parse_from_str(&row.scheduled_start[..10], "%Y-%m-%d").ok()?;
    let at = date.pred_opt()?.and_hms_opt(DAY_BEFORE_HOUR, 0, 0)?;
    Some(ReminderFire {
        reminder: row,
        fire_at: FireAt::Local(at),
    })
}

#[cfg(test)]
#[path = "reminder_horizon_tests.rs"]
mod reminder_horizon_tests;
