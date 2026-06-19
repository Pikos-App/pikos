//! CalDAV autodiscovery: entered base URL → `.well-known/caldav` →
//! `current-user-principal` → `calendar-home-set` → enumerate calendars. Runs
//! once per account at connect time (the engine caches the result later). Yields
//! the provider-agnostic [`RemoteCalendar`] list; only VEVENT-bearing collections
//! are kept (inbox/outbox/tasks-only calendars are dropped).

use pikos_db::sync_delta::RemoteCalendar;
use url::Url;

use super::error::CaldavError;
use super::transport::DavTransport;
use super::xml;

const WELL_KNOWN: &str = "/.well-known/caldav";
const MAX_REDIRECTS: usize = 5;

const PRINCIPAL_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>"#;

const HOME_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>"#;

const ENUM_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <ic:calendar-color/>
    <c:supported-calendar-component-set/>
  </d:prop>
</d:propfind>"#;

/// A PROPFIND whose redirects have been followed; `final_url` is the URL the 207
/// actually came from, so its hrefs resolve against the right origin.
struct Followed {
    final_url: Url,
    body: String,
}

pub(crate) async fn discover_calendars<T: DavTransport>(
    transport: &T,
    base_url: &str,
) -> Result<Vec<RemoteCalendar>, CaldavError> {
    let base = Url::parse(base_url)
        .map_err(|e| CaldavError::NotCaldav(format!("invalid server URL: {e}")))?;

    // 1. current-user-principal: try .well-known (a redirect on most servers),
    //    then fall back to the entered URL itself. RFC 6764 — some valid servers
    //    (a misconfigured Nextcloud is the classic) 404 .well-known, and a user may
    //    paste a full collection URL that already is the context path.
    let well_known = base
        .join(WELL_KNOWN)
        .map_err(|e| CaldavError::NotCaldav(e.to_string()))?;
    let (principal_from, principal) = match principal_at(transport, &base, well_known).await? {
        Some(found) => found,
        None => principal_at(transport, &base, base.clone())
            .await?
            .ok_or_else(|| {
                CaldavError::NotCaldav(
                    "no current-user-principal at .well-known or the entered URL".into(),
                )
            })?,
    };
    let principal_url = resolve(&base, &principal_from, &principal)?;

    // 2. calendar-home-set on the principal.
    let resp = propfind_follow(transport, &base, principal_url, "0", HOME_BODY)
        .await?
        .ok_or_else(|| CaldavError::NotCaldav("calendar-home-set request not found".into()))?;
    let home = xml::parse_home_set_href(&resp.body)?
        .ok_or_else(|| CaldavError::NotCaldav("no calendar-home-set in response".into()))?;
    let home_url = resolve(&base, &resp.final_url, &home)?;

    // 3. enumerate the home collection (Depth: 1).
    let resp = propfind_follow(transport, &base, home_url, "1", ENUM_BODY)
        .await?
        .ok_or_else(|| CaldavError::NotCaldav("calendar enumeration not found".into()))?;
    let mut calendars = Vec::new();
    for raw in xml::parse_calendars(&resp.body)? {
        // Absent component-set ⇒ all components supported (RFC default); keep it.
        // An explicit set without VEVENT (a tasks-only calendar) is dropped.
        if !raw.components.is_empty() && !raw.components.iter().any(|c| c == "VEVENT") {
            continue;
        }
        let calendar_url = resolve(&base, &resp.final_url, &raw.href)?;
        let display_name = raw
            .display_name
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| last_segment(&calendar_url));
        calendars.push(RemoteCalendar {
            calendar_id: calendar_url.to_string(),
            display_name,
            color: raw.color.filter(|s| !s.is_empty()),
        });
    }
    Ok(calendars)
}

/// Resolve `current-user-principal` from `start`, returning `None` when the
/// request 404s or yields no principal — the signal to try the next location.
async fn principal_at<T: DavTransport>(
    transport: &T,
    base: &Url,
    start: Url,
) -> Result<Option<(Url, String)>, CaldavError> {
    let Some(resp) = propfind_follow(transport, base, start, "0", PRINCIPAL_BODY).await? else {
        return Ok(None);
    };
    Ok(xml::parse_principal_href(&resp.body)?.map(|href| (resp.final_url, href)))
}

/// PROPFIND `start`, following `Location` redirects by hand (reqwest would turn a
/// 301/302 on a PROPFIND into a bodyless GET). Re-applies the original scheme if a
/// redirect downgrades https→http — the classic CalDAV discovery footgun. `None`
/// on a 404/405 — "not here," which the caller treats as fallback or fatal.
async fn propfind_follow<T: DavTransport>(
    transport: &T,
    base: &Url,
    start: Url,
    depth: &str,
    body: &str,
) -> Result<Option<Followed>, CaldavError> {
    let mut current = start;
    for _ in 0..=MAX_REDIRECTS {
        let resp = transport.propfind(current.as_str(), depth, body).await?;
        match resp.status {
            207 => {
                return Ok(Some(Followed { final_url: current, body: resp.body }));
            }
            404 | 405 => return Ok(None),
            301 | 302 | 307 | 308 => {
                let location = resp
                    .location
                    .ok_or_else(|| CaldavError::Protocol("redirect without Location".into()))?;
                let mut next = current
                    .join(&location)
                    .map_err(|e| CaldavError::Protocol(e.to_string()))?;
                if base.scheme() == "https" && next.scheme() == "http" {
                    let _ = next.set_scheme("https");
                }
                current = next;
            }
            401 | 403 => return Err(CaldavError::Unauthorized),
            other => return Err(CaldavError::UnexpectedStatus(other)),
        }
    }
    Err(CaldavError::Protocol("too many redirects during discovery".into()))
}

/// Resolve an href (absolute URL or origin-relative path) from a response against
/// the URL it came from, then guard against an https→http downgrade.
fn resolve(base: &Url, from: &Url, href: &str) -> Result<Url, CaldavError> {
    let mut url = from
        .join(href)
        .map_err(|e| CaldavError::Protocol(format!("bad href {href:?}: {e}")))?;
    if base.scheme() == "https" && url.scheme() == "http" {
        let _ = url.set_scheme("https");
    }
    Ok(url)
}

fn last_segment(url: &Url) -> String {
    url.path_segments()
        .and_then(|mut s| {
            // Collections end in '/', so the last non-empty segment is the name.
            s.next_back().filter(|s| !s.is_empty()).or_else(|| s.next_back())
        })
        .unwrap_or("Calendar")
        .to_string()
}

#[cfg(test)]
#[path = "discovery_tests.rs"]
mod discovery_tests;
