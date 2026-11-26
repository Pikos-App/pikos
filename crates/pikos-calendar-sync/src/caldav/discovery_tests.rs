//! Most run over recorded Radicale fixtures; `04_*` and `05_*` are hand-authored for an
//! iCloud-style cross-host calendar-home redirect and the Cyrus/Fastmail enumeration shape,
//! which a local radicale doesn't produce.

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
const ENUM_CYRUS: &str =
    include_str!("../../tests/fixtures/caldav/discovery/05_enumerate_calendars_cyrus.xml");

#[derive(Debug)]
enum Mode {
    Ok,
    Unauthorized,
    NoWellKnown,
    CrossHostHome,
    NoComponentSet,
    /// Cyrus/Fastmail shape: prefixed `D:` namespace, opaque UUID collection
    /// names, and the props split across a 200 and a 404 propstat.
    CyrusShape,
}

const ENUM_NO_COMPONENTS: &str = r#"<?xml version='1.0' encoding='utf-8'?>
<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <response><href>/testuser/plain/</href><propstat><prop>
    <resourcetype><C:calendar /><collection /></resourcetype>
    <displayname>Plain</displayname>
  </prop><status>HTTP/1.1 200 OK</status></propstat></response>
</multistatus>"#;

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
            (Mode::NoComponentSet, _, "/testuser/", "1") => ok(ENUM_NO_COMPONENTS),
            (Mode::CyrusShape, _, "/testuser/", "1") => ok(ENUM_CYRUS),
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

/// RFC 4791 reads an absent component set as "supports everything"; treating it as empty
/// would drop the calendar, and the user would see none with nothing to explain why.
#[tokio::test]
async fn a_calendar_with_no_declared_components_is_kept() {
    let calendars = discover(Mode::NoComponentSet).await.unwrap();

    assert_eq!(calendars.len(), 1, "got: {calendars:?}");
    assert_eq!(calendars[0].display_name, "Plain");
}

/// Fastmail lists every calendar under an opaque UUID, so the URL-segment fallback is the
/// visible symptom of a name that never arrived; this pins that the shape itself parses, so
/// the name is missing upstream rather than dropped here.
#[tokio::test]
async fn a_uuid_named_collection_still_takes_its_displayname() {
    let calendars = discover(Mode::CyrusShape).await.unwrap();

    assert_eq!(calendars.len(), 1, "got: {calendars:?}");
    assert_eq!(calendars[0].display_name, "Personal");
}

/// An empty `<displayname/>` and an absent one both parse to `None`; without tracking the
/// element separately the diagnostic can't say which a server did, and they need different fixes.
#[test]
fn an_empty_displayname_is_distinguishable_from_an_absent_one() {
    let with_empty = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response><D:href>/c/</D:href><D:propstat><D:prop>
    <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
    <D:displayname/>
  </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
</D:multistatus>"#;
    let without = with_empty.replace("<D:displayname/>", "");

    let seen = super::super::xml::parse_calendars(with_empty).unwrap();
    let absent = super::super::xml::parse_calendars(&without).unwrap();

    assert!(seen[0].display_name.is_none() && absent[0].display_name.is_none());
    assert!(seen[0].display_name_seen, "an empty element still appeared");
    assert!(!absent[0].display_name_seen, "nothing appeared");
}

/// Dropping the CDATA event makes the name indistinguishable from an empty element.
#[test]
fn a_cdata_wrapped_displayname_is_read() {
    let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response><D:href>/c/</D:href><D:propstat><D:prop>
    <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
    <D:displayname><![CDATA[Personal & Work]]></D:displayname>
  </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
</D:multistatus>"#;
    let cals = super::super::xml::parse_calendars(xml).unwrap();
    assert_eq!(cals[0].display_name.as_deref(), Some("Personal & Work"));
}

/// The text handler trims every fragment, so a name split around an entity would lose the
/// spaces beside it.
#[test]
fn an_escaped_ampersand_keeps_the_spaces_around_it() {
    let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response><D:href>/c/</D:href><D:propstat><D:prop>
    <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
    <D:displayname>Work &amp; Life</D:displayname>
  </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
</D:multistatus>"#;
    let cals = super::super::xml::parse_calendars(xml).unwrap();
    assert_eq!(cals[0].display_name.as_deref(), Some("Work & Life"));
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
    let t = FixedResponse {
        status: 301,
        location: Some("/next".into()),
    };
    match propfind_follow(&t, &base, base.clone(), "0", "<b/>").await {
        Err(CaldavError::Protocol(m)) => assert!(m.contains("too many redirects"), "got: {m}"),
        _ => panic!("expected a too-many-redirects Protocol error"),
    }
}

/// Every PROPFIND carries Basic auth, so a redirect elsewhere would be handed the username and
/// password for wherever it points.
#[tokio::test]
async fn a_redirect_off_the_account_s_domain_is_refused() {
    let base = Url::parse("https://caldav.example.com/").unwrap();
    let t = FixedResponse {
        status: 302,
        location: Some("https://harvester.example.net/caldav/".into()),
    };
    match propfind_follow(&t, &base, base.clone(), "0", "<b/>").await {
        Err(CaldavError::Protocol(m)) => {
            assert!(m.contains("harvester.example.net"), "got: {m}");
        }
        _ => panic!("expected the redirect to be refused"),
    }
}

#[tokio::test]
async fn a_redirect_to_a_partition_of_the_same_domain_is_followed() {
    let base = Url::parse("https://caldav.icloud.com/").unwrap();
    let t = RedirectThen207 {
        location: "https://p42-caldav.icloud.com/123/principal/".into(),
        hits: std::sync::Mutex::new(0),
    };

    let followed = propfind_follow(&t, &base, base.clone(), "0", "<b/>")
        .await
        .unwrap()
        .expect("a 207 after the hop");

    assert_eq!(followed.final_url.host_str(), Some("p42-caldav.icloud.com"));
}

/// A same-domain hop followed by one that leaves: vetting only the first `Location` would hand
/// the account's Basic auth to the second.
#[tokio::test]
async fn a_redirect_that_leaves_the_domain_on_a_later_hop_is_refused() {
    let base = Url::parse("https://caldav.example.com/").unwrap();
    let t = TwoHops {
        first: "https://p42-caldav.example.com/principal/".into(),
        second: "https://harvester.example.net/caldav/".into(),
        hits: std::sync::Mutex::new(0),
    };

    match propfind_follow(&t, &base, base.clone(), "0", "<b/>").await {
        Err(CaldavError::Protocol(m)) => {
            assert!(m.contains("harvester.example.net"), "got: {m}");
        }
        _ => panic!("expected the second hop to be refused"),
    }
    assert_eq!(*t.hits.lock().unwrap(), 2, "the first hop must be followed");
}

struct TwoHops {
    first: String,
    second: String,
    hits: std::sync::Mutex<u32>,
}
impl DavTransport for TwoHops {
    async fn propfind(&self, _: &str, _: &str, _: &str) -> Result<DavResponse, CaldavError> {
        let mut n = self.hits.lock().unwrap();
        *n += 1;
        Ok(DavResponse {
            status: 301,
            location: Some(if *n == 1 {
                self.first.clone()
            } else {
                self.second.clone()
            }),
            body: String::new(),
        })
    }
    async fn report(&self, _: &str, _: &str, _: &str) -> Result<DavResponse, CaldavError> {
        panic!("discovery never issues a REPORT");
    }
}

struct RedirectThen207 {
    location: String,
    hits: std::sync::Mutex<u32>,
}
impl DavTransport for RedirectThen207 {
    async fn propfind(&self, _: &str, _: &str, _: &str) -> Result<DavResponse, CaldavError> {
        let mut n = self.hits.lock().unwrap();
        *n += 1;
        if *n == 1 {
            return Ok(DavResponse {
                status: 301,
                location: Some(self.location.clone()),
                body: String::new(),
            });
        }
        Ok(DavResponse {
            status: 207,
            location: None,
            body: "<multistatus xmlns=\"DAV:\"/>".into(),
        })
    }
    async fn report(&self, _: &str, _: &str, _: &str) -> Result<DavResponse, CaldavError> {
        panic!("discovery never issues a REPORT");
    }
}

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
