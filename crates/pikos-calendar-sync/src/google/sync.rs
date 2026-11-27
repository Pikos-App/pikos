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

/// Page size for the list endpoints. Google caps `events.list` at 2500; 250 keeps
/// each response bounded without adding many round-trips.
const PAGE_SIZE: &str = "250";

/// Guards against a malformed `nextPageToken` looping against the API forever.
const MAX_PAGES: usize = 100;

const GONE: u16 = 410;
const NOT_FOUND: u16 = 404;
const UNAUTHORIZED: u16 = 401;
const FORBIDDEN: u16 = 403;
const TOO_MANY_REQUESTS: u16 = 429;

/// `error.errors[].reason` values meaning refusal, not throttling — Google
/// overloads `403` for both. Only these end the account's sync; everything else
/// backs off and retries.
const PERMISSION_REASONS: [&str; 4] = [
    "forbidden",
    "insufficientPermissions",
    "authError",
    "accessNotConfigured",
];

/// `error.errors[].reason` values Google documents for throttling. Anything outside both lists
/// is still backed off, and logged, so a reason that should end the sync can be seen.
const RATE_LIMIT_REASONS: [&str; 5] = [
    "rateLimitExceeded",
    "userRateLimitExceeded",
    "quotaExceeded",
    "dailyLimitExceeded",
    "calendarUsageLimitsExceeded",
];

// What an `UnexpectedStatus` names in place of the path, which holds the calendar id.
const OP_EVENTS_LIST: &str = "events.list";
const OP_EVENTS_GET: &str = "events.get";
const OP_CALENDAR_LIST: &str = "calendarList.list";

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
        Err(GoogleError::UnexpectedStatus { status: GONE, .. }) => {
            return backfill(transport, calendar_id).await
        }
        Err(e) => return Err(e),
    };

    // Incremental bundles are master-only — a series' cancellations and moves
    // arrive as separate resources, not in this delta.
    Ok(reduce(pages, OccurrenceFidelity::MasterOnly, false))
}

/// Full re-enumerate of the visible window. `showDeleted` makes this authoritative
/// for a series: a cancelled instance is its own resource, so without it the
/// enumerate would silently drop every EXDATE.
///
/// Deliberately skips `authoritative_from`, keeping the full-enumerate sweep off.
/// The sweep spares a recurring page only when its RRULE has a readable `UNTIL`,
/// and it's unverified whether Google filters a master by its own dates or its
/// expansion — sweeping here risks detaching or deleting an open-ended series.
/// Safe to skip: `showDeleted=true` already reports real removals as
/// `status: cancelled`, the gap the sweep exists to close for CalDAV. Worst case
/// is a stale mirror on a long-dormant calendar — visible and recoverable, not
/// silent loss.
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

/// Single-event fetch for orphan-master resolution — one `events.get`, never a
/// full-series expansion. Maps `404` to [`GoogleError::NotFound`].
///
/// `events.get` has no calendar-level `timeZone` fallback, so an unzoned event
/// would resolve floating here but zoned via `events.list`. Only recurring
/// masters reach this path, and Google requires their `timeZone`, so the two
/// agree in practice.
pub(crate) async fn fetch_one<T: GoogleTransport>(
    transport: &T,
    calendar_id: &str,
    event_id: &str,
) -> Result<EventUpsert, GoogleError> {
    let path = format!("{}/{}", events_path(calendar_id), encode_segment(event_id));
    let resp = transport.get(&path, &[]).await?;
    check_status(OP_EVENTS_GET, resp.status, &resp.body)?;
    let event: Event =
        serde_json::from_str(&resp.body).map_err(|e| malformed("malformed event", &e))?;

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

/// The account's calendars. `accessRole` isn't filtered — a reader-only calendar
/// syncs like an owned one, since nothing is written back.
pub(crate) async fn list_calendars<T: GoogleTransport>(
    transport: &T,
) -> Result<Vec<RemoteCalendar>, GoogleError> {
    Ok(list_calendars_with_primary(transport).await?.0)
}

/// Connect-time enumeration: also resolves the account's identity from the
/// primary calendar's id, refusing rather than inventing one when Google names
/// no primary (see [`GoogleError::NoPrimaryCalendar`]). [`list_calendars`] stays
/// tolerant — only a connect turns that id into an identity.
pub(crate) async fn list_calendars_for_connect<T: GoogleTransport>(
    transport: &T,
) -> Result<(Vec<RemoteCalendar>, String), GoogleError> {
    let (calendars, primary) = list_calendars_with_primary(transport).await?;
    Ok((calendars, primary.ok_or(GoogleError::NoPrimaryCalendar)?))
}

/// Also returns the primary calendar's id, which is the account's email address.
/// Reading it here avoids adding `openid`/`email` to [`super::config::SCOPES`],
/// which would widen the verified consent screen for one string.
async fn list_calendars_with_primary<T: GoogleTransport>(
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
        check_status(OP_CALENDAR_LIST, resp.status, &resp.body)?;
        let parsed: CalendarListResponse = serde_json::from_str(&resp.body)
            .map_err(|e| malformed("malformed calendarList", &e))?;

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

/// Every page of one `events.list` call. Only the final page carries
/// `nextSyncToken`, so a delta split across pages must be fully drained before
/// the cursor is trustworthy.
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
        check_status(OP_EVENTS_LIST, resp.status, &resp.body)?;
        let parsed: EventsResponse = serde_json::from_str(&resp.body)
            .map_err(|e| malformed("malformed events response", &e))?;

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

/// Flatten drained pages into one delta. Grouping runs across the whole set, so a
/// master and an instance split across pages still fold into one bundle instead
/// of producing a spurious orphan.
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

fn check_status(op: &'static str, status: u16, body: &str) -> Result<(), GoogleError> {
    match status {
        200..=299 => Ok(()),
        // Only a single-event fetch means the event is gone; a list's 404 is its calendar.
        NOT_FOUND if op == OP_EVENTS_GET => Err(GoogleError::NotFound),
        NOT_FOUND if op == OP_EVENTS_LIST => Err(GoogleError::CalendarGone),
        // The access token was just refreshed, so a 401 here means the grant
        // itself is gone, not an expiry we could retry through.
        UNAUTHORIZED => Err(GoogleError::Revoked),
        TOO_MANY_REQUESTS => Err(GoogleError::RateLimited),
        FORBIDDEN => Err(classify_forbidden(op, body)),
        other => Err(GoogleError::UnexpectedStatus { op, status: other }),
    }
}

/// Split a `403` on its `reason`. Anything not clearly a permission refusal —
/// including an unreadable body or an unrecognised reason — is treated as
/// transient: a needless retry costs one request, while a wrong `Revoked` forces
/// an unnecessary re-authorization.
fn classify_forbidden(op: &str, body: &str) -> GoogleError {
    let reasons = serde_json::from_str::<ApiErrorResponse>(body)
        .map(|e| e.reasons())
        .unwrap_or_default();
    if reasons
        .iter()
        .any(|r| PERMISSION_REASONS.contains(&r.as_str()))
    {
        return GoogleError::Revoked;
    }
    if !reasons
        .iter()
        .any(|r| RATE_LIMIT_REASONS.contains(&r.as_str()))
    {
        log::warn!(
            "google_forbidden_unrecognised op={op} reasons={} backing off",
            loggable_reasons(&reasons)
        );
    }
    GoogleError::RateLimited
}

/// Google's reasons are fixed camelCase names. Anything else in the field is cut to the
/// characters such a name uses, so a body that put text there can't carry it into the log.
fn loggable_reasons(reasons: &[String]) -> String {
    if reasons.is_empty() {
        return "none".into();
    }
    reasons
        .iter()
        .map(|r| {
            r.chars()
                .filter(char::is_ascii_alphanumeric)
                .take(64)
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// serde's message quotes the value it choked on, which in an event is its title or description,
/// so only the category and position are kept.
fn malformed(what: &str, e: &serde_json::Error) -> GoogleError {
    GoogleError::Protocol(format!(
        "{what}: {:?} at {}:{}",
        e.classify(),
        e.line(),
        e.column()
    ))
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
