//! A calendar server for the bridge lane: a test says what upstream now holds, and
//! the real sync engine and reconciler run against it. The lane has no network, so
//! without this every row about a change arriving from the calendar stays manual.
//!
//! Events are named by title, the way a test sees them. A title that matches a page
//! in the calendar re-delivers that event under its stored identity; any other
//! title is a new event upstream. Fields a test leaves out are carried from what
//! the page already stores, so a description-only change moves nothing else.

use std::collections::HashMap;

use chrono::{Duration, NaiveDate};
use serde::Deserialize;
use sqlx::SqlitePool;

use pikos_calendar_sync::commands::{refresh_account, resync_account, upsert_calendars};
use pikos_db::error::{AppError, AppResult};
use pikos_db::sync::{SyncAccountRow, SyncCalendarRow};
use pikos_db::sync_delta::{
    CalendarProvider, EventCore, EventSchedule, EventUpsert, ExclusiveEnd, OccurrenceFidelity,
    OccurrenceOverride, Recurrence, RemoteCalendar, Removal, SyncDelta, SyncToken, UpsertItem,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamEvent {
    title: String,
    new_title: Option<String>,
    description: Option<String>,
    location: Option<String>,
    attendees: Option<Vec<String>>,
    start: Option<String>,
    /// As the provider sends it: exclusive for an all-day event.
    end: Option<String>,
    timezone: Option<String>,
    rrule: Option<String>,
    #[serde(default)]
    exdates: Vec<String>,
    #[serde(default)]
    overrides: Vec<UpstreamOverride>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamOverride {
    original: String,
    start: String,
    end: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamCalendar {
    calendar_id: String,
    display_name: String,
    color: Option<String>,
}

/// Hands each calendar the delta a test scripted for it, and every other calendar
/// an empty incremental one, so a pass touches only what the test named.
struct Scripted {
    deltas: HashMap<String, SyncDelta>,
}

const CURSOR: &str = "e2e-bridge";

impl CalendarProvider for Scripted {
    async fn list_calendars(&self, _account: &SyncAccountRow) -> AppResult<Vec<RemoteCalendar>> {
        Err(AppError::Invalid(
            "the bridge discovers through upstream_discover".into(),
        ))
    }

    async fn sync(
        &self,
        calendar: &SyncCalendarRow,
        _since: Option<SyncToken>,
    ) -> AppResult<SyncDelta> {
        Ok(self
            .deltas
            .get(&calendar.calendar_id)
            .cloned()
            .unwrap_or_else(|| SyncDelta {
                next_token: Some(SyncToken(CURSOR.into())),
                ..Default::default()
            }))
    }

    async fn fetch_event(
        &self,
        _calendar: &SyncCalendarRow,
        event_ref: &str,
    ) -> AppResult<EventUpsert> {
        Err(AppError::NotFound(format!(
            "no scripted master for {event_ref}"
        )))
    }

    async fn current_sync_token(
        &self,
        _calendar: &SyncCalendarRow,
    ) -> AppResult<Option<SyncToken>> {
        Ok(Some(SyncToken(CURSOR.into())))
    }
}

/// One poll of `calendar`'s account against the scripted upstream. `refresh` runs
/// the panel's "Refresh from calendar" instead, which drops the cursors first.
pub async fn sync(
    pool: &SqlitePool,
    calendar: &str,
    events: Vec<UpstreamEvent>,
    removals: Vec<String>,
    refresh: bool,
) -> AppResult<()> {
    let (account_id, calendar_id) = calendar_by_name(pool, calendar).await?;
    let mut upserts = Vec::with_capacity(events.len());
    for event in events {
        upserts.push(UpsertItem::Event(
            to_upsert(pool, &account_id, &calendar_id, event).await?,
        ));
    }
    let mut gone = Vec::with_capacity(removals.len());
    for title in removals {
        let (external_id, _) = linked(pool, &account_id, &calendar_id, &title)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("no synced page titled {title}")))?;
        gone.push(Removal { external_id });
    }
    let delta = SyncDelta {
        upserts,
        removals: gone,
        next_token: Some(SyncToken(CURSOR.into())),
        ..Default::default()
    };
    let provider = Scripted {
        deltas: HashMap::from([(calendar_id, delta)]),
    };
    if refresh {
        refresh_account(pool, &provider, &account_id).await?;
    } else {
        resync_account(pool, &provider, &account_id).await?;
    }
    Ok(())
}

/// Re-discover the account's calendars, as reconnecting does: a known calendar keeps
/// its row, an unknown one arrives switched off.
pub async fn discover(pool: &SqlitePool, calendars: Vec<UpstreamCalendar>) -> AppResult<()> {
    let (account_id,) = sqlx::query_as::<_, (String,)>("SELECT id FROM sync_account LIMIT 1")
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("no calendar account to discover on".into()))?;
    let remote: Vec<RemoteCalendar> = calendars
        .into_iter()
        .map(|c| RemoteCalendar {
            calendar_id: c.calendar_id,
            display_name: c.display_name,
            color: c.color,
        })
        .collect();
    upsert_calendars(pool, &account_id, &remote).await?;
    Ok(())
}

async fn calendar_by_name(pool: &SqlitePool, name: &str) -> AppResult<(String, String)> {
    sqlx::query_as::<_, (String, String)>(
        "SELECT account_id, calendar_id FROM sync_calendar WHERE display_name = ?",
    )
    .bind(name)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("no calendar named {name}")))
}

/// The upstream identity of the calendar's page with this title, and the page.
async fn linked(
    pool: &SqlitePool,
    account_id: &str,
    calendar_id: &str,
    title: &str,
) -> AppResult<Option<(String, String)>> {
    Ok(sqlx::query_as::<_, (String, String)>(
        "SELECT ps.external_id, ps.page_id FROM page_sync ps JOIN pages p ON p.id = ps.page_id
         WHERE ps.account_id = ? AND ps.calendar_id = ? AND p.title = ? AND p.deleted_at IS NULL",
    )
    .bind(account_id)
    .bind(calendar_id)
    .bind(title)
    .fetch_optional(pool)
    .await?)
}

async fn to_upsert(
    pool: &SqlitePool,
    account_id: &str,
    calendar_id: &str,
    ev: UpstreamEvent,
) -> AppResult<EventUpsert> {
    let existing = linked(pool, account_id, calendar_id, &ev.title).await?;
    let stored = match &existing {
        Some((_, page_id)) => Some(stored_event(pool, page_id).await?),
        None => None,
    };
    let external_id = existing
        .map(|(id, _)| id)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let carried = stored.unwrap_or_default();

    let start = ev
        .start
        .or(carried.start)
        .ok_or_else(|| AppError::Invalid(format!("{} needs a start", ev.title)))?;
    let end = ev.end.or(carried.end);
    let timezone = ev.timezone.or(carried.timezone);
    let recurrence = ev.rrule.map(|rrule| Recurrence {
        rrule,
        exdates: ev.exdates,
        overrides: ev
            .overrides
            .into_iter()
            .map(|o| OccurrenceOverride {
                original_date: o.original,
                schedule: EventSchedule {
                    start: o.start,
                    end: ExclusiveEnd::new(Some(o.end)),
                    timezone: timezone.clone(),
                },
            })
            .collect(),
        fidelity: OccurrenceFidelity::Complete,
    });

    Ok(EventUpsert {
        core: EventCore {
            ical_uid: external_id.clone(),
            external_id,
            // Fresh every time: an unchanged etag is the reconciler's cue to skip.
            etag: Some(uuid::Uuid::new_v4().to_string()),
            title: ev.new_title.unwrap_or(ev.title),
            description: ev.description,
            location: ev.location.or(carried.location),
            attendees: ev.attendees.or(carried.attendees).unwrap_or_default(),
        },
        schedule: EventSchedule {
            start,
            end: ExclusiveEnd::new(end),
            timezone,
        },
        recurrence,
    })
}

#[derive(Default)]
struct StoredEvent {
    start: Option<String>,
    end: Option<String>,
    timezone: Option<String>,
    location: Option<String>,
    attendees: Option<Vec<String>>,
}

/// What upstream last sent for a single event, read back from the page. Pikos keeps
/// an all-day end inclusive, so it goes back out a day later, as the wire has it.
async fn stored_event(pool: &SqlitePool, page_id: &str) -> AppResult<StoredEvent> {
    let (start, end, timezone) =
        sqlx::query_as::<_, (Option<String>, Option<String>, Option<String>)>(
            "SELECT scheduled_start, scheduled_end, timezone FROM page_schedules
         WHERE page_id = ? AND original_date IS NULL ORDER BY created_at LIMIT 1",
        )
        .bind(page_id)
        .fetch_optional(pool)
        .await?
        .unwrap_or_default();
    let (location, attendees) = sqlx::query_as::<_, (Option<String>, Option<String>)>(
        "SELECT mirror_location, mirror_attendees FROM page_sync WHERE page_id = ?",
    )
    .bind(page_id)
    .fetch_one(pool)
    .await?;
    let end = end.map(|e| match NaiveDate::parse_from_str(&e, "%Y-%m-%d") {
        Ok(day) => (day + Duration::days(1)).format("%Y-%m-%d").to_string(),
        Err(_) => e,
    });
    Ok(StoredEvent {
        start,
        end,
        timezone,
        location,
        attendees: attendees.and_then(|a| serde_json::from_str(&a).ok()),
    })
}
