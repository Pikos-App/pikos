//! The CalDAV sync orchestration: turn a calendar collection + a stored
//! sync-token into a normalized [`SyncDelta`], and refetch a single resource.
//!
//! Incremental path: a `sync-collection` REPORT (RFC 6578) returns changed hrefs
//! (+ deletions as response-level `404`s) and the next sync-token; the changed
//! hrefs are bodied via `calendar-multiget` and parsed by [`super::ics`]. A
//! **`403`** answer means the token is stale (`DAV:valid-sync-token`) — we match
//! the status, not the error wording, and fall back to a full re-enumerate.
//!
//! Backfill path (no token yet, or after a `403`): a `calendar-query` REPORT
//! time-bounded to ~1 week before now, requesting `calendar-data` inline so no
//! second round-trip is needed. It carries no sync-token; bootstrapping the first
//! token is the engine's job, so a backfill `SyncDelta` has `next_token =
//! None`.

use chrono::Utc;
use pikos_db::sync_delta::{Removal, SyncDelta, SyncToken, UpsertItem};

use super::error::CaldavError;
use super::ics;
use super::report_xml::{parse_report, ReportEntry};
use super::transport::DavTransport;

/// Multiget at most this many hrefs per REPORT — keeps a busy delta off one giant
/// request without a per-resource round-trip.
const MULTIGET_BATCH: usize = 75;

const DELETED: u16 = 404;

/// Incremental sync from `since`, or a time-bounded backfill when it's `None`.
pub(crate) async fn sync_calendar<T: DavTransport>(
    transport: &T,
    calendar_url: &str,
    since: Option<&SyncToken>,
) -> Result<SyncDelta, CaldavError> {
    let Some(token) = since else {
        return backfill(transport, calendar_url).await;
    };

    let resp = transport
        .report(calendar_url, "0", &sync_collection_body(&token.0))
        .await?;
    match resp.status {
        207 => {}
        // Stale token (DAV:valid-sync-token): discard it and re-enumerate the window.
        403 => return backfill(transport, calendar_url).await,
        401 => return Err(CaldavError::Unauthorized),
        other => return Err(CaldavError::UnexpectedStatus(other)),
    }

    let report = parse_report(&resp.body)?;
    let (present, removals) = split_present(report.entries);
    // Incremental deltas don't sweep, so `unresolved` has no consumer — drop it.
    let (upserts, _unresolved) = resolve_upserts(transport, calendar_url, present).await?;
    Ok(SyncDelta {
        upserts,
        removals,
        next_token: report.sync_token.map(SyncToken),
        ..Default::default()
    })
}

/// Capture the collection's current sync-token via an empty-token
/// `sync-collection` REPORT (RFC 6578 initial sync). We read **only** the
/// trailing token — the response also carries the whole collection, but the
/// preceding `calendar-query` backfill already reconciled those, so we discard
/// the entries. This bootstraps the incremental cursor the time-bounded backfill
/// can't supply. A server without `sync-collection` answers `403`/`405`/`501` →
/// `None` (no cursor to capture; the engine keeps re-enumerating until the
/// ctag-diff fallback lands).
pub(crate) async fn current_sync_token<T: DavTransport>(
    transport: &T,
    calendar_url: &str,
) -> Result<Option<SyncToken>, CaldavError> {
    let resp = transport
        .report(calendar_url, "0", &sync_collection_body(""))
        .await?;
    match resp.status {
        207 => Ok(parse_report(&resp.body)?.sync_token.map(SyncToken)),
        403 | 405 | 501 => Ok(None),
        401 => Err(CaldavError::Unauthorized),
        other => Err(CaldavError::UnexpectedStatus(other)),
    }
}

/// The collection's `getctag` (calendarserver change-tag) via a Depth-0 PROPFIND.
/// Lets a token-less poll skip re-enumerating when the collection is unchanged. A
/// server without the property or PROPFIND support answers `403`/`404`/`405`/`501`
/// → `None`, so the engine keeps enumerating rather than trusting an absent tag.
pub(crate) async fn current_ctag<T: DavTransport>(
    transport: &T,
    calendar_url: &str,
) -> Result<Option<String>, CaldavError> {
    let resp = transport.propfind(calendar_url, "0", GETCTAG_BODY).await?;
    match resp.status {
        207 => Ok(super::xml::parse_ctag(&resp.body)?),
        403 | 404 | 405 | 501 => Ok(None),
        401 => Err(CaldavError::Unauthorized),
        other => Err(CaldavError::UnexpectedStatus(other)),
    }
}

/// Refetch one resource (CalDAV's `fetch_event`: a trivial single-href
/// `calendar-multiget`). CalDAV never orphans a master, so this is only the
/// generic single-resource refetch, never a series reconstruction.
pub(crate) async fn fetch_one<T: DavTransport>(
    transport: &T,
    calendar_url: &str,
    href: &str,
) -> Result<pikos_db::sync_delta::EventUpsert, CaldavError> {
    let entries = multiget(transport, calendar_url, &[href.to_string()]).await?;
    let entry = entries
        .into_iter()
        .find(|e| e.calendar_data.is_some())
        .ok_or_else(|| CaldavError::Protocol(format!("resource not found: {href}")))?;
    ics::parse_resource(
        &entry.href,
        entry.etag.as_deref(),
        entry.calendar_data.as_deref().unwrap_or_default(),
    )
}

/// Full re-enumerate of the visible window via `calendar-query` with inline
/// `calendar-data`. No removals (the result is the authoritative set) and no
/// token.
async fn backfill<T: DavTransport>(
    transport: &T,
    calendar_url: &str,
) -> Result<SyncDelta, CaldavError> {
    let window_start = Utc::now() - chrono::Duration::days(7);
    let resp = transport
        .report(calendar_url, "1", &calendar_query_body(window_start))
        .await?;
    match resp.status {
        207 => {}
        401 | 403 => return Err(CaldavError::Unauthorized),
        other => return Err(CaldavError::UnexpectedStatus(other)),
    }
    let report = parse_report(&resp.body)?;
    let (present, _removals) = split_present(report.entries);
    let (upserts, unresolved_present) = resolve_upserts(transport, calendar_url, present).await?;
    // Authoritative set for `[window_start, ∞)`: the engine sweeps stored pages
    // absent from it, since a backfill carries no deletions of its own.
    Ok(SyncDelta {
        upserts,
        authoritative_from: Some(window_start.format("%Y-%m-%d").to_string()),
        unresolved_present,
        full_enumerate: true,
        ..Default::default()
    })
}

/// Partition report entries into present resources and deletions (a response-level
/// `404`). A deletion becomes a whole-event [`Removal`]; the reconciler decides
/// detach-vs-delete.
fn split_present(entries: Vec<ReportEntry>) -> (Vec<ReportEntry>, Vec<Removal>) {
    let mut present = Vec::new();
    let mut removals = Vec::new();
    for e in entries {
        if e.response_status == Some(DELETED) {
            removals.push(Removal {
                external_id: e.href,
            });
        } else {
            present.push(e);
        }
    }
    (present, removals)
}

/// Body-and-parse the present resources into upserts: use inline `calendar-data`
/// when the report already carried it (backfill), else `calendar-multiget` the
/// rest (sync-collection only returns etags). A resource that fails to parse is
/// skipped, not fatal — one malformed body must not sink the whole delta. Returns
/// `(upserts, unresolved)` — `unresolved` is the hrefs present but yielding no
/// upsert (see `SyncDelta::unresolved_present`).
async fn resolve_upserts<T: DavTransport>(
    transport: &T,
    calendar_url: &str,
    present: Vec<ReportEntry>,
) -> Result<(Vec<UpsertItem>, Vec<String>), CaldavError> {
    let mut bodied: Vec<ReportEntry> = Vec::new();
    let mut needs_fetch: Vec<String> = Vec::new();
    for e in present {
        if e.calendar_data.is_some() {
            bodied.push(e);
        } else {
            needs_fetch.push(e.href);
        }
    }
    for chunk in needs_fetch.chunks(MULTIGET_BATCH) {
        bodied.extend(multiget(transport, calendar_url, chunk).await?);
    }

    let mut upserts = Vec::new();
    let mut unresolved = Vec::new();
    for e in bodied {
        let parsed = e
            .calendar_data
            .as_deref()
            .and_then(|ics| ics::parse_resource(&e.href, e.etag.as_deref(), ics).ok());
        match parsed {
            Some(ev) => upserts.push(UpsertItem::Event(ev)),
            None => {
                log::warn!("caldav sync: skipping unresolvable resource {}", e.href);
                unresolved.push(e.href);
            }
        }
    }
    Ok((upserts, unresolved))
}

async fn multiget<T: DavTransport>(
    transport: &T,
    calendar_url: &str,
    hrefs: &[String],
) -> Result<Vec<ReportEntry>, CaldavError> {
    if hrefs.is_empty() {
        return Ok(vec![]);
    }
    let resp = transport
        .report(calendar_url, "1", &multiget_body(hrefs))
        .await?;
    match resp.status {
        207 => Ok(parse_report(&resp.body)?.entries),
        401 | 403 => Err(CaldavError::Unauthorized),
        other => Err(CaldavError::UnexpectedStatus(other)),
    }
}

// ─── request bodies ─────────────────────────────────────────────────────────────

const GETCTAG_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
  <d:prop><cs:getctag/></d:prop>
</d:propfind>"#;

fn sync_collection_body(token: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<d:sync-collection xmlns:d="DAV:">
  <d:sync-token>{}</d:sync-token>
  <d:sync-level>1</d:sync-level>
  <d:prop><d:getetag/></d:prop>
</d:sync-collection>"#,
        xml_escape(token)
    )
}

/// `calendar-query` bounded to `window_start` (no upper bound). The server expands
/// recurrences to test overlap, so masters recurring into the window are returned.
/// Used only for the initial/recovery enumerate.
fn calendar_query_body(window_start: chrono::DateTime<Utc>) -> String {
    let start = window_start.format("%Y%m%dT000000Z");
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="{start}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>"#
    )
}

fn multiget_body(hrefs: &[String]) -> String {
    let mut body = String::from(
        r#"<?xml version="1.0" encoding="utf-8"?>
<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
"#,
    );
    for href in hrefs {
        body.push_str("  <d:href>");
        body.push_str(&xml_escape(href));
        body.push_str("</d:href>\n");
    }
    body.push_str("</c:calendar-multiget>");
    body
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
#[path = "sync_tests.rs"]
mod sync_tests;
