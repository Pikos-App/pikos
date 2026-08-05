//! The Google sync orchestration: turn a calendar id + a stored `syncToken` into
//! a normalized [`SyncDelta`], enumerate the account's calendars, and refetch a
//! single event.
//!
//! Incremental path: `events.list` with `syncToken`. Google answers **`410
//! Gone`** once a token is too old to expand, which is the documented signal to
//! discard it and re-enumerate — the same shape CalDAV's stale-token `403` takes.
//!
//! Backfill path (no token yet, or after a `410`): `events.list` time-bounded to
//! ~a week back. Unlike CalDAV's, a Google backfill **does** carry its own
//! `nextSyncToken`, so the engine's post-backfill bootstrap has nothing to do.
//!
//! `singleEvents=false` throughout — the classic mistake here is fetching expanded
//! instances, which have no master to map onto `page_recurrence_rules`. It must
//! also stay identical between the backfill and the incremental polls that follow,
//! or Google rejects the token.

use chrono::Utc;

use pikos_db::sync_delta::{EventUpsert, OccurrenceFidelity, RemoteCalendar, SyncDelta, SyncToken};

use super::error::GoogleError;
use super::events;
use super::model::{ApiErrorResponse, CalendarListResponse, Event, EventsResponse};
use super::transport::GoogleTransport;

use pikos_db::sync::BACKFILL_DAYS;

/// Page size for the list endpoints. Google caps `events.list` at 2500; a smaller
/// page keeps any single response bounded without adding many round-trips.
const PAGE_SIZE: &str = "250";

/// Guards against a malformed `nextPageToken` loop — a paging bug would otherwise
/// spin against the API indefinitely.
const MAX_PAGES: usize = 100;

const GONE: u16 = 410;
const NOT_FOUND: u16 = 404;
const UNAUTHORIZED: u16 = 401;
const FORBIDDEN: u16 = 403;
const TOO_MANY_REQUESTS: u16 = 429;

/// `error.errors[].reason` values that mean "you may not do this" rather than
/// "slow down". Google overloads `403` for both, and they need opposite handling:
/// only these end the account's sync, everything else backs off and retries.
const PERMISSION_REASONS: [&str; 4] = [
    "forbidden",
    "insufficientPermissions",
    "authError",
    "accessNotConfigured",
];

/// Incremental sync from `since`, or a time-bounded backfill when it's `None` or
/// the token has expired.
pub(crate) async fn sync_calendar<T: GoogleTransport>(
    transport: &T,
    calendar_id: &str,
    since: Option<&SyncToken>,
) -> Result<SyncDelta, GoogleError> {
    let Some(token) = since else {
        return backfill(transport, calendar_id).await;
    };

    let base = vec![
        ("syncToken", token.0.clone()),
        ("singleEvents", "false".to_string()),
        ("showDeleted", "true".to_string()),
        ("maxResults", PAGE_SIZE.to_string()),
    ];
    let pages = match collect_pages(transport, &events_path(calendar_id), base).await {
        Ok(pages) => pages,
        Err(GoogleError::UnexpectedStatus(GONE)) => return backfill(transport, calendar_id).await,
        Err(e) => return Err(e),
    };

    // Incremental bundles are master-only: a series' cancellations and moved
    // instances are separate resources that need not be in this delta.
    Ok(reduce(pages, OccurrenceFidelity::MasterOnly, false))
}

/// Full re-enumerate of the visible window. `showDeleted` is what makes this
/// authoritative for a *series*: a cancelled instance is its own resource, so
/// without it the enumerate would silently drop every EXDATE.
///
/// **Deliberately not `authoritative_from`, so the full-enumerate sweep stays
/// off.** The sweep deletes stored pages absent from the enumerate, sparing a
/// recurring one only when its RRULE carries a readable `UNTIL` — so an open-ended
/// weekly series would be swept if a `timeMin`-bounded list omits it. Whether
/// Google filters a recurring master by its own start/end or by its expansion is
/// unverified, and being wrong detaches or deletes live series. It costs little to
/// skip: `showDeleted=true` means this enumerate carries real removals as
/// `status: cancelled` items, which is the gap the sweep exists to close for
/// CalDAV. The residual risk runs the safe way — Google eventually purges very old
/// cancelled events, so a long-dormant calendar may keep a stale mirror, which is
/// visible and recoverable rather than silent loss.
async fn backfill<T: GoogleTransport>(
    transport: &T,
    calendar_id: &str,
) -> Result<SyncDelta, GoogleError> {
    let window_start = Utc::now() - chrono::Duration::days(BACKFILL_DAYS);
    let base = vec![
        ("timeMin", window_start.to_rfc3339()),
        ("singleEvents", "false".to_string()),
        ("showDeleted", "true".to_string()),
        ("maxResults", PAGE_SIZE.to_string()),
    ];
    let pages = collect_pages(transport, &events_path(calendar_id), base).await?;

    Ok(reduce(pages, OccurrenceFidelity::Complete, true))
}

/// Targeted single-event fetch for orphan-master resolution — one `events.get`,
/// never a full-series expansion. Maps a `404` to [`GoogleError::NotFound`].
///
/// `events.get` carries no calendar-level `timeZone` to fall back on, so an event
/// without its own would resolve as floating here but zoned via `events.list`.
/// Only recurring masters reach this path, and Google requires a `timeZone` on
/// those, so the two agree in practice.
pub(crate) async fn fetch_one<T: GoogleTransport>(
    transport: &T,
    calendar_id: &str,
    event_id: &str,
) -> Result<EventUpsert, GoogleError> {
    let path = format!("{}/{}", events_path(calendar_id), encode_segment(event_id));
    let resp = transport.get(&path, &[]).await?;
    check_status(resp.status, &resp.body)?;
    let event: Event = serde_json::from_str(&resp.body)
        .map_err(|e| GoogleError::Protocol(format!("malformed event: {e}")))?;

    // Fetched alone, so whatever occurrence deltas the series carries are not here.
    let grouped = events::group(vec![event], None, OccurrenceFidelity::MasterOnly);
    grouped
        .upserts
        .into_iter()
        .find_map(|item| match item {
            pikos_db::sync_delta::UpsertItem::Event(ev) => Some(ev),
            _ => None,
        })
        .ok_or(GoogleError::NotFound)
}

/// The account's calendars. `accessRole` is deliberately not filtered on — a
/// reader-only calendar syncs exactly like an owned one, since nothing is written
/// back.
pub(crate) async fn list_calendars<T: GoogleTransport>(
    transport: &T,
) -> Result<Vec<RemoteCalendar>, GoogleError> {
    Ok(list_calendars_with_primary(transport).await?.0)
}

/// Also returns the primary calendar's id, which **is** the account's email
/// address — the account label at connect time. Reading it here avoids adding
/// `openid`/`email` to [`super::config::SCOPES`], which would widen the verified
/// consent screen for one string.
pub(crate) async fn list_calendars_with_primary<T: GoogleTransport>(
    transport: &T,
) -> Result<(Vec<RemoteCalendar>, Option<String>), GoogleError> {
    let mut out = Vec::new();
    let mut primary = None;
    let mut page_token: Option<String> = None;

    for _ in 0..MAX_PAGES {
        let mut query = vec![("maxResults", PAGE_SIZE.to_string())];
        if let Some(t) = &page_token {
            query.push(("pageToken", t.clone()));
        }
        let resp = transport.get("/users/me/calendarList", &query).await?;
        check_status(resp.status, &resp.body)?;
        let parsed: CalendarListResponse = serde_json::from_str(&resp.body)
            .map_err(|e| GoogleError::Protocol(format!("malformed calendarList: {e}")))?;

        for c in parsed.items.into_iter().filter(|c| !c.deleted) {
            if c.primary {
                primary = Some(c.id.clone());
            }
            out.push(RemoteCalendar {
                display_name: c
                    .summary_override
                    .or(c.summary)
                    .unwrap_or_else(|| c.id.clone()),
                calendar_id: c.id,
                color: c.background_color,
            });
        }

        page_token = parsed.next_page_token;
        if page_token.is_none() {
            return Ok((out, primary));
        }
    }
    Err(GoogleError::Protocol(
        "calendarList paging did not terminate".into(),
    ))
}

// ─── paging + status ────────────────────────────────────────────────────────────

/// Every page of one `events.list` call. The final page carries the
/// `nextSyncToken`; earlier pages carry only a `nextPageToken`, so a delta split
/// across pages must be fully drained before the cursor is trustworthy.
async fn collect_pages<T: GoogleTransport>(
    transport: &T,
    path: &str,
    base: Vec<(&'static str, String)>,
) -> Result<Vec<EventsResponse>, GoogleError> {
    let mut pages = Vec::new();
    let mut page_token: Option<String> = None;

    for _ in 0..MAX_PAGES {
        let mut query = base.clone();
        if let Some(t) = &page_token {
            query.push(("pageToken", t.clone()));
        }
        let resp = transport.get(path, &query).await?;
        check_status(resp.status, &resp.body)?;
        let parsed: EventsResponse = serde_json::from_str(&resp.body)
            .map_err(|e| GoogleError::Protocol(format!("malformed events response: {e}")))?;

        page_token = parsed.next_page_token.clone();
        pages.push(parsed);
        if page_token.is_none() {
            return Ok(pages);
        }
    }
    Err(GoogleError::Protocol(
        "events paging did not terminate".into(),
    ))
}

/// Flatten drained pages into one delta. Grouping runs across the whole set, not
/// per page, so a master and an instance that landed on different pages still fold
/// into one bundle instead of producing a spurious orphan.
fn reduce(
    pages: Vec<EventsResponse>,
    fidelity: OccurrenceFidelity,
    full_enumerate: bool,
) -> SyncDelta {
    let next_token = pages
        .last()
        .and_then(|p| p.next_sync_token.clone())
        .map(SyncToken);
    let calendar_tz = pages.iter().find_map(|p| p.time_zone.clone());
    let items: Vec<Event> = pages.into_iter().flat_map(|p| p.items).collect();

    let grouped = events::group(items, calendar_tz.as_deref(), fidelity);
    SyncDelta {
        upserts: grouped.upserts,
        removals: grouped.removals,
        next_token,
        authoritative_from: None,
        unresolved_present: grouped.unresolved_present,
        full_enumerate,
    }
}

fn check_status(status: u16, body: &str) -> Result<(), GoogleError> {
    match status {
        200..=299 => Ok(()),
        NOT_FOUND => Err(GoogleError::NotFound),
        // The access token was refreshed immediately before this call, so a 401 is
        // the grant itself being gone rather than an expiry we can retry through.
        UNAUTHORIZED => Err(GoogleError::Revoked),
        TOO_MANY_REQUESTS => Err(GoogleError::RateLimited),
        FORBIDDEN => Err(classify_forbidden(body)),
        other => Err(GoogleError::UnexpectedStatus(other)),
    }
}

/// Split a `403` on its `reason`. Anything not clearly a permission refusal —
/// including an unreadable body or a reason Google added since — is treated as
/// transient: a needless retry costs one request, while a wrong `Revoked` flags
/// the account, drops it out of the background pass, and sends the user through a
/// re-authorization they didn't need.
fn classify_forbidden(body: &str) -> GoogleError {
    let reasons = serde_json::from_str::<ApiErrorResponse>(body)
        .map(|e| e.reasons())
        .unwrap_or_default();
    if reasons
        .iter()
        .any(|r| PERMISSION_REASONS.contains(&r.as_str()))
    {
        return GoogleError::Revoked;
    }
    GoogleError::RateLimited
}

fn events_path(calendar_id: &str) -> String {
    format!("/calendars/{}/events", encode_segment(calendar_id))
}

/// Percent-encode a path segment. Calendar and event ids are user-controlled
/// (`…@group.calendar.google.com`, base32 ids), so they can't be interpolated raw.
fn encode_segment(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                String::from(b as char)
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
#[path = "sync_tests.rs"]
mod sync_tests;
