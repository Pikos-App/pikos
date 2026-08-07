//! Layer-1 discovery tests. Most run over recorded Radicale fixtures (captured
//! 2026-06-19 from radicale 3.3.3 with htpasswd basic auth); `04_*` is
//! hand-authored to mimic an iCloud-style cross-host calendar-home redirect,
//! which a single local server can't produce. No network.

use super::super::error::CaldavError;
use super::super::transport::{DavResponse, DavTransport};
use super::{discover_calendars, propfind_follow, resolve};
use url::Url;

const PRINCIPAL: &str =
    include_str!("../../tests/fixtures/caldav/discovery/01_current_user_principal.xml");
const HOME: &str = include_str!("../../tests/fixtures/caldav/discovery/02_calendar_home_set.xml");
const ENUM: &str = include_str!("../../tests/fixtures/caldav/discovery/03_enumerate_calendars.xml");
const HOME_REMOTE: &str =
    include_str!("../../tests/fixtures/caldav/discovery/04_calendar_home_set_remote.xml");
const UNAUTH: &str = include_str!("../../tests/fixtures/caldav/discovery/00_unauthorized.txt");

#[derive(Debug)]
enum Mode {
    /// `.well-known` 301s to `/` (real Radicale behavior).
    Ok,
    /// Wrong credentials — every authed request 401s.
    Unauthorized,
    /// `.well-known` 404s; discovery must fall back to the entered URL.
    NoWellKnown,
    /// `calendar-home-set` points at a different host (iCloud partition style).
    CrossHostHome,
}

struct FixtureTransport {
    mode: Mode,
}

impl DavTransport for FixtureTransport {
    async fn propfind(
        &self,
        url: &str,
        depth: &str,
        _body: &str,
    ) -> Result<DavResponse, CaldavError> {
        let u = Url::parse(url).unwrap();
        let host = u.host_str().unwrap_or("").to_string();
        let path = u.path().to_string();
        let resp = match (&self.mode, host.as_str(), path.as_str(), depth) {
            (Mode::NoWellKnown, _, "/.well-known/caldav", _) => status(404),
            (_, _, "/.well-known/caldav", _) => redirect("/"),
            (Mode::Unauthorized, _, "/", _) => unauthorized(),
            (_, _, "/", _) => ok(PRINCIPAL),
            (Mode::CrossHostHome, "127.0.0.1", "/testuser/", "0") => ok(HOME_REMOTE),
            (Mode::CrossHostHome, "p42-caldav.icloud.com", _, "1") => ok(ENUM),
            (_, _, "/testuser/", "0") => ok(HOME),
            (_, _, "/testuser/", "1") => ok(ENUM),
            other => panic!("unexpected discovery request: {other:?}"),
        };
        Ok(resp)
    }

    async fn report(
        &self,
        url: &str,
        _depth: &str,
        _body: &str,
    ) -> Result<DavResponse, CaldavError> {
        panic!("discovery never issues a REPORT (got {url})");
    }
}

fn ok(body: &str) -> DavResponse {
    DavResponse {
        status: 207,
        location: None,
        body: body.into(),
    }
}

fn status(status: u16) -> DavResponse {
    DavResponse {
        status,
        location: None,
        body: String::new(),
    }
}

fn redirect(location: &str) -> DavResponse {
    DavResponse {
        status: 301,
        location: Some(location.into()),
        body: String::new(),
    }
}

fn unauthorized() -> DavResponse {
    DavResponse {
        status: 401,
        location: None,
        body: UNAUTH.into(),
    }
}

async fn discover(mode: Mode) -> Result<Vec<pikos_db::sync_delta::RemoteCalendar>, CaldavError> {
    discover_calendars(&FixtureTransport { mode }, "http://127.0.0.1:5232/").await
}

#[tokio::test]
async fn discovers_only_vevent_calendars() {
    let calendars = discover(Mode::Ok).await.unwrap();

    // Work (VEVENT) is kept; the VTODO calendar and the home collection are filtered out.
    assert_eq!(calendars.len(), 1, "got: {calendars:?}");
    let work = &calendars[0];
    assert_eq!(work.display_name, "Work");
    assert_eq!(work.color.as_deref(), Some("#FF5733FF"));
    assert!(
        work.calendar_id.ends_with("/testuser/work-calendar/"),
        "calendar_id should be the resolved collection URL, got {}",
        work.calendar_id
    );
}

#[tokio::test]
async fn wrong_password_fails_cleanly() {
    let err = discover(Mode::Unauthorized).await.unwrap_err();
    assert!(matches!(err, CaldavError::Unauthorized), "got {err:?}");
}

#[tokio::test]
async fn falls_back_to_base_url_when_well_known_absent() {
    let calendars = discover(Mode::NoWellKnown).await.unwrap();
    assert_eq!(calendars.len(), 1, "got: {calendars:?}");
    assert_eq!(calendars[0].display_name, "Work");
}

#[tokio::test]
async fn follows_cross_host_home_set() {
    let calendars = discover(Mode::CrossHostHome).await.unwrap();
    assert_eq!(calendars.len(), 1, "got: {calendars:?}");
    let host = Url::parse(&calendars[0].calendar_id)
        .unwrap()
        .host_str()
        .unwrap()
        .to_string();
    assert_eq!(host, "p42-caldav.icloud.com");
}

#[test]
fn resolve_does_not_downgrade_https_to_http() {
    let base = Url::parse("https://caldav.example.com/").unwrap();
    let from = Url::parse("https://caldav.example.com/principals/me/").unwrap();
    let resolved = resolve(&base, &from, "http://caldav.example.com/calendars/me/").unwrap();
    assert_eq!(
        resolved.as_str(),
        "https://caldav.example.com/calendars/me/"
    );
}

// ─── propfind_follow redirect machinery ───────────────────────────────────────

/// A transport answering every PROPFIND with the same scripted status + location.
struct FixedResponse {
    status: u16,
    location: Option<String>,
}
impl DavTransport for FixedResponse {
    async fn propfind(&self, _: &str, _: &str, _: &str) -> Result<DavResponse, CaldavError> {
        Ok(DavResponse {
            status: self.status,
            location: self.location.clone(),
            body: String::new(),
        })
    }
    async fn report(&self, _: &str, _: &str, _: &str) -> Result<DavResponse, CaldavError> {
        panic!("discovery never issues a REPORT");
    }
}

#[tokio::test]
async fn redirect_without_a_location_is_a_protocol_error() {
    let base = Url::parse("https://caldav.example.com/").unwrap();
    let t = FixedResponse {
        status: 302,
        location: None,
    };
    let result = propfind_follow(&t, &base, base.clone(), "0", "<b/>").await;
    assert!(
        matches!(result, Err(CaldavError::Protocol(_))),
        "a Location-less redirect can't be followed"
    );
}

#[tokio::test]
async fn a_redirect_loop_stops_after_the_cap() {
    let base = Url::parse("https://caldav.example.com/").unwrap();
    // Always bounces to a new path → never resolves to a 207.
    let t = FixedResponse {
        status: 301,
        location: Some("/next".into()),
    };
    match propfind_follow(&t, &base, base.clone(), "0", "<b/>").await {
        Err(CaldavError::Protocol(m)) => assert!(m.contains("too many redirects"), "got: {m}"),
        _ => panic!("expected a too-many-redirects Protocol error"),
    }
}

/// 301 → an http:// target on the first hit, 207 thereafter.
struct DowngradeThenOk {
    hits: std::sync::Mutex<u32>,
}
impl DavTransport for DowngradeThenOk {
    async fn propfind(&self, _: &str, _: &str, _: &str) -> Result<DavResponse, CaldavError> {
        let mut n = self.hits.lock().unwrap();
        *n += 1;
        if *n == 1 {
            Ok(DavResponse {
                status: 301,
                location: Some("http://caldav.example.com/principal/".into()),
                body: String::new(),
            })
        } else {
            Ok(DavResponse {
                status: 207,
                location: None,
                body: "<ok/>".into(),
            })
        }
    }
    async fn report(&self, _: &str, _: &str, _: &str) -> Result<DavResponse, CaldavError> {
        panic!("discovery never issues a REPORT");
    }
}

#[tokio::test]
async fn a_redirect_that_downgrades_to_http_is_re_upgraded() {
    let base = Url::parse("https://caldav.example.com/").unwrap();
    let t = DowngradeThenOk {
        hits: std::sync::Mutex::new(0),
    };
    let followed = propfind_follow(&t, &base, base.clone(), "0", "<b/>")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        followed.final_url.as_str(),
        "https://caldav.example.com/principal/",
        "an https base re-applies TLS to an http redirect target"
    );
}
