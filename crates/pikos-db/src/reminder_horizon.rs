//! Every reminder that will fire in the next N days, placed on the device's own clock.
//!
//! A phone can't run the desktop's per-minute "what is due now" loop, as iOS suspends the
//! process, so it computes what fires over a horizon, hands each to the OS, and recomputes when
//! the workspace changes. This composes the same six `due_*` arms over a forward window, so a
//! reminder rings on the phone for the reasons it rings on the desktop, with the shared rules
//! (done pages, all-day anchors, floating vs zoned, skipped occurrences, the `-1` sentinel) in
//! those arms and not copied.
//!
//! It adds placement: each arm knows its fire in its own frame (a native wall clock, a synced
//! absolute instant) and the OS wants a wall-clock date in the device's zone, so the caller names
//! its zone and every fire comes out as `YYYY-MM-DDTHH:MM:SS` on it.
//!
//! Quiet hours are not applied: on iOS the Focus modes are that control, system-wide, and a
//! second copy at schedule time would silence a reminder Focus would have let through.

use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use sqlx::SqlitePool;

use crate::error::AppResult;
use crate::notification_log::{
    due_day_before_reminders, due_default_reminders, due_explicit_reminders, max_reminder_lead,
    synced_override_reminders_firing_in, synced_reminders_firing_in, DueReminder, FireAt,
    ReminderFire, ReminderWindow, DAY_BEFORE_MINUTES,
};
use crate::recurrence_derive::occurrences_with_reminders_firing_in;

/// A reminder that will fire inside the horizon, placed on the device's clock.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpcomingReminder {
    /// The key the desktop logs when it fires this reminder: a schedule row id with the lead
    /// appended, or `page@start[#lead]` for a rule's occurrence. Distinct per occurrence and
    /// lead, so the OS notification is identified by it.
    pub key: String,
    pub page_id: String,
    pub title: String,
    /// The occurrence's start as stored (device-local for native, source-zone for synced), for
    /// wording, not placement.
    pub scheduled_start: String,
    pub minutes_before: i64,
    /// When it fires, on the device's clock: `YYYY-MM-DDTHH:MM:SS`.
    pub fire_at: String,
}

/// The local hour a day-before reminder fires on the preceding day, as in
/// [`due_day_before_reminders`].
const DAY_BEFORE_HOUR: u32 = 9;

const WALL_FMT: &str = "%Y-%m-%dT%H:%M:%S";

/// Every reminder firing in `(now, now + horizon]`, soonest first.
///
/// `device_zone` is the phone's zone, in which native wall clocks are read and every fire is
/// placed. A calendar-owned page resolves through its source zone, so a 15:00 Berlin meeting
/// reminds a phone in New York at 09:00 minus the lead.
///
/// Already-fired reminders are excluded by the `notification_log` row, which a phone never
/// writes since the OS delivers, so nothing is excluded on that account. That is intended: the
/// phone re-plans the whole horizon each change and the OS keeps one notification per key.
pub async fn upcoming_reminders(
    pool: &SqlitePool,
    now_utc: DateTime<Utc>,
    device_zone: chrono_tz::Tz,
    horizon: Duration,
    default_minutes: i64,
) -> AppResult<Vec<UpcomingReminder>> {
    let window = ReminderWindow::ahead(now_utc, device_zone, horizon);
    let mut fires: Vec<ReminderFire> = Vec::new();

    // The three wall-clock arms return no instant, so it is rebuilt by the arithmetic the SQL selected on.
    for row in due_explicit_reminders(pool, &window).await? {
        fires.extend(lead_fire(row));
    }
    for row in due_default_reminders(pool, default_minutes, &window).await? {
        fires.extend(lead_fire(row));
    }
    for row in due_day_before_reminders(pool, &window).await? {
        fires.extend(day_before_fire(row));
    }

    let max_lead = max_reminder_lead(pool, default_minutes).await?;
    fires.extend(
        occurrences_with_reminders_firing_in(pool, &window, default_minutes, max_lead).await?,
    );
    fires.extend(synced_reminders_firing_in(pool, &window, default_minutes).await?);
    fires.extend(synced_override_reminders_firing_in(pool, &window, default_minutes).await?);

    // The six arms partition the schedules; this dedup is a backstop against an overlap delivering twice.
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

/// An all-day row's fire: 09:00 the day before, the only anchor such a page has.
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
