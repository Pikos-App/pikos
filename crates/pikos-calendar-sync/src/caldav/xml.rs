//! WebDAV `multistatus` parsing for the discovery chain.
//!
//! Namespace-aware on purpose: a server's response prefixes need not match the
//! request's (Radicale answers a `d:`-prefixed query with the default `DAV:`
//! namespace and `C:`/`CS:`/`ICAL:` prefixes), so elements are matched by
//! resolved namespace URI + local name, never by raw prefix. Each `<response>`
//! can carry several `<propstat>` blocks at different statuses — a missing prop
//! comes back under a `404` block — so props are buffered per `propstat` and
//! kept only when that block's status is 2xx.

use super::error::CaldavError;
use quick_xml::events::{BytesStart, Event};
use quick_xml::name::ResolveResult;
use quick_xml::NsReader;

const NS_DAV: &[u8] = b"DAV:";
const NS_CALDAV: &[u8] = b"urn:ietf:params:xml:ns:caldav";
const NS_APPLE: &[u8] = b"http://apple.com/ns/ical/";
const NS_CALSRV: &[u8] = b"http://calendarserver.org/ns/";

/// One `<response>`, reduced to the props the discovery chain reads.
#[derive(Default)]
struct RawResponse {
    /// Response-level href (the resource the entry describes).
    href: String,
    /// `<current-user-principal><href>` — present only on the principal query.
    principal_href: Option<String>,
    /// `<calendar-home-set><href>` — present only on the home query.
    home_href: Option<String>,
    is_calendar: bool,
    display_name: Option<String>,
    color: Option<String>,
    components: Vec<String>,
    /// `<cs:getctag>` — the collection change-tag, present only on a ctag PROPFIND.
    ctag: Option<String>,
}

/// A calendar collection discovered in an enumeration, before VEVENT filtering.
pub(crate) struct RawCalendar {
    pub href: String,
    pub display_name: Option<String>,
    pub color: Option<String>,
    /// `supported-calendar-component-set` comp names; empty when the server omits
    /// the prop (RFC default: all components supported).
    pub components: Vec<String>,
}

pub(crate) fn parse_principal_href(xml: &str) -> Result<Option<String>, CaldavError> {
    Ok(parse_multistatus(xml)?
        .into_iter()
        .find_map(|r| r.principal_href))
}

pub(crate) fn parse_home_set_href(xml: &str) -> Result<Option<String>, CaldavError> {
    Ok(parse_multistatus(xml)?.into_iter().find_map(|r| r.home_href))
}

/// The collection's `getctag`, taken only from a 2xx propstat (an unsupported
/// prop comes back under a 404 block and is dropped). `None` when absent.
pub(crate) fn parse_ctag(xml: &str) -> Result<Option<String>, CaldavError> {
    Ok(parse_multistatus(xml)?.into_iter().find_map(|r| r.ctag))
}

pub(crate) fn parse_calendars(xml: &str) -> Result<Vec<RawCalendar>, CaldavError> {
    Ok(parse_multistatus(xml)?
        .into_iter()
        .filter(|r| r.is_calendar)
        .map(|r| RawCalendar {
            href: r.href,
            display_name: r.display_name,
            color: r.color,
            components: r.components,
        })
        .collect())
}

/// What text the next `Text` event belongs to. Set on a `Start`, cleared on the
/// matching `End`; never set on an `Empty` (no text, nothing to clear it).
#[derive(PartialEq)]
enum Capture {
    None,
    ResponseHref,
    PrincipalHref,
    HomeHref,
    DisplayName,
    Color,
    Ctag,
    Status,
}

/// Accumulates one parse. Props live in `pbuf` until their `<propstat>` closes,
/// then merge into `cur` only if the block's status was 2xx.
struct Parse {
    responses: Vec<RawResponse>,
    cur: Option<RawResponse>,
    pbuf: PropBuf,
    propstat_ok: Option<bool>,
    status_text: String,
    in_prop: bool,
    in_resourcetype: bool,
    in_compset: bool,
    in_principal: bool,
    in_homeset: bool,
    capture: Capture,
}

#[derive(Default)]
struct PropBuf {
    principal_href: Option<String>,
    home_href: Option<String>,
    is_calendar: bool,
    display_name: Option<String>,
    color: Option<String>,
    components: Vec<String>,
    ctag: Option<String>,
}

impl Parse {
    fn new() -> Self {
        Self {
            responses: Vec::new(),
            cur: None,
            pbuf: PropBuf::default(),
            propstat_ok: None,
            status_text: String::new(),
            in_prop: false,
            in_resourcetype: false,
            in_compset: false,
            in_principal: false,
            in_homeset: false,
            capture: Capture::None,
        }
    }

    /// `Start` and `Empty` share child recording; capture targets and context
    /// flags open only on `Start` (an `Empty` has no text and no closing tag).
    fn open(&mut self, ns: &[u8], local: &[u8], e: &BytesStart, is_start: bool) {
        // Recorded for both Start and Empty (resourcetype children, comps).
        if self.in_resourcetype && (ns, local) == (NS_CALDAV, b"calendar".as_ref()) {
            self.pbuf.is_calendar = true;
        }
        if self.in_compset && (ns, local) == (NS_CALDAV, b"comp".as_ref()) {
            if let Some(name) = attr(e, b"name") {
                self.pbuf.components.push(name);
            }
        }
        if !is_start {
            return;
        }
        match (ns, local) {
            (NS_DAV, b"response") => self.cur = Some(RawResponse::default()),
            (NS_DAV, b"propstat") => {
                self.pbuf = PropBuf::default();
                self.propstat_ok = None;
            }
            (NS_DAV, b"prop") => self.in_prop = true,
            (NS_DAV, b"resourcetype") => self.in_resourcetype = true,
            (NS_CALDAV, b"supported-calendar-component-set") => self.in_compset = true,
            (NS_DAV, b"current-user-principal") => self.in_principal = true,
            (NS_CALDAV, b"calendar-home-set") => self.in_homeset = true,
            (NS_DAV, b"displayname") => self.capture = Capture::DisplayName,
            (NS_APPLE, b"calendar-color") => self.capture = Capture::Color,
            (NS_CALSRV, b"getctag") => self.capture = Capture::Ctag,
            (NS_DAV, b"status") => self.capture = Capture::Status,
            (NS_DAV, b"href") => {
                self.capture = if self.in_principal {
                    Capture::PrincipalHref
                } else if self.in_homeset {
                    Capture::HomeHref
                } else if !self.in_prop {
                    Capture::ResponseHref
                } else {
                    Capture::None
                };
            }
            _ => {}
        }
    }

    fn text(&mut self, text: &str) {
        // Trim here rather than via reader config (whose API differs across
        // quick-xml versions); whitespace-only inter-element text drops out.
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        match self.capture {
            Capture::ResponseHref => {
                if let Some(c) = self.cur.as_mut() {
                    c.href.push_str(text);
                }
            }
            Capture::PrincipalHref => push_opt(&mut self.pbuf.principal_href, text),
            Capture::HomeHref => push_opt(&mut self.pbuf.home_href, text),
            Capture::DisplayName => push_opt(&mut self.pbuf.display_name, text),
            Capture::Color => push_opt(&mut self.pbuf.color, text),
            Capture::Ctag => push_opt(&mut self.pbuf.ctag, text),
            Capture::Status => self.status_text.push_str(text),
            Capture::None => {}
        }
    }

    fn close(&mut self, ns: &[u8], local: &[u8]) {
        match (ns, local) {
            (NS_DAV, b"href")
            | (NS_DAV, b"displayname")
            | (NS_APPLE, b"calendar-color")
            | (NS_CALSRV, b"getctag") => {
                self.capture = Capture::None;
            }
            (NS_DAV, b"status") => {
                self.propstat_ok = Some(status_is_ok(&self.status_text));
                self.status_text.clear();
                self.capture = Capture::None;
            }
            (NS_DAV, b"current-user-principal") => self.in_principal = false,
            (NS_CALDAV, b"calendar-home-set") => self.in_homeset = false,
            (NS_DAV, b"resourcetype") => self.in_resourcetype = false,
            (NS_CALDAV, b"supported-calendar-component-set") => self.in_compset = false,
            (NS_DAV, b"prop") => self.in_prop = false,
            (NS_DAV, b"propstat") => {
                if self.propstat_ok == Some(true) {
                    merge(self.cur.as_mut(), &mut self.pbuf);
                }
                self.pbuf = PropBuf::default();
                self.propstat_ok = None;
            }
            (NS_DAV, b"response") => {
                if let Some(c) = self.cur.take() {
                    self.responses.push(c);
                }
            }
            _ => {}
        }
    }
}

fn parse_multistatus(xml: &str) -> Result<Vec<RawResponse>, CaldavError> {
    let mut reader = NsReader::from_str(xml);
    let mut p = Parse::new();

    loop {
        let (rr, ev) = reader
            .read_resolved_event()
            .map_err(|e| CaldavError::Protocol(e.to_string()))?;
        let ns = match rr {
            ResolveResult::Bound(n) => n.into_inner().to_vec(),
            _ => Vec::new(),
        };
        match ev {
            Event::Start(e) => {
                let local = e.local_name().as_ref().to_vec();
                p.open(&ns, &local, &e, true);
            }
            Event::Empty(e) => {
                let local = e.local_name().as_ref().to_vec();
                p.open(&ns, &local, &e, false);
            }
            Event::Text(t) => {
                let text = t
                    .unescape()
                    .map_err(|e| CaldavError::Protocol(e.to_string()))?;
                p.text(&text);
            }
            Event::End(e) => {
                let local = e.local_name().as_ref().to_vec();
                p.close(&ns, &local);
            }
            Event::Eof => break,
            _ => {}
        }
    }

    Ok(p.responses)
}

fn attr(e: &BytesStart, key: &[u8]) -> Option<String> {
    e.attributes().flatten().find_map(|a| {
        (a.key.local_name().as_ref() == key)
            .then(|| String::from_utf8_lossy(a.value.as_ref()).into_owned())
    })
}

fn push_opt(field: &mut Option<String>, text: &str) {
    field.get_or_insert_with(String::new).push_str(text);
}

fn merge(cur: Option<&mut RawResponse>, pbuf: &mut PropBuf) {
    let Some(c) = cur else { return };
    if pbuf.principal_href.is_some() {
        c.principal_href = pbuf.principal_href.take();
    }
    if pbuf.home_href.is_some() {
        c.home_href = pbuf.home_href.take();
    }
    if pbuf.is_calendar {
        c.is_calendar = true;
    }
    if pbuf.display_name.is_some() {
        c.display_name = pbuf.display_name.take();
    }
    if pbuf.color.is_some() {
        c.color = pbuf.color.take();
    }
    if pbuf.ctag.is_some() {
        c.ctag = pbuf.ctag.take();
    }
    if !pbuf.components.is_empty() {
        c.components.append(&mut pbuf.components);
    }
}

fn status_is_ok(s: &str) -> bool {
    s.split_whitespace()
        .nth(1)
        .and_then(|c| c.parse::<u16>().ok())
        .map(|c| (200..300).contains(&c))
        .unwrap_or(false)
}
