//! `multistatus` parsing for the sync REPORTs — `sync-collection` and
//! `calendar-multiget`. Namespace-aware for the same reason as the discovery
//! parser ([`super::xml`]): a server's prefixes need not match the request's, so
//! elements are matched by resolved namespace URI + local name.
//!
//! Two response shapes share this parser:
//! - **`sync-collection`**: each `<response>` is a changed resource (an `href` +
//!   a `200` propstat carrying `getetag`) or a deletion (an `href` + a
//!   **response-level** `404 <status>`, no propstat). The trailing
//!   `<sync-token>` is the next cursor.
//! - **`calendar-multiget`**: each `<response>` carries the resource's
//!   `calendar-data` (the ICS body) alongside its `getetag`, under a `200`
//!   propstat.

use super::error::CaldavError;
use quick_xml::events::Event;
use quick_xml::name::ResolveResult;
use quick_xml::NsReader;

const NS_DAV: &[u8] = b"DAV:";
const NS_CALDAV: &[u8] = b"urn:ietf:params:xml:ns:caldav";

/// One `<response>` reduced to what the sync path reads.
pub(crate) struct ReportEntry {
    pub href: String,
    /// A response-level `<status>` (outside any propstat) — a `404` here marks a
    /// resource deleted from the collection. `None` when the resource is present.
    pub response_status: Option<u16>,
    pub etag: Option<String>,
    /// The raw ICS body, present only on a `calendar-multiget` response.
    pub calendar_data: Option<String>,
}

pub(crate) struct ReportResult {
    pub entries: Vec<ReportEntry>,
    /// The collection's next `sync-token` (`sync-collection` only).
    pub sync_token: Option<String>,
}

/// Where the next `Text` event belongs. `CalendarData` accumulates raw (the ICS
/// body must survive byte-for-byte); the rest are trimmed.
#[derive(PartialEq)]
enum Capture {
    None,
    Href,
    Etag,
    Status,
    CalendarData,
    SyncToken,
}

struct Parse {
    entries: Vec<ReportEntry>,
    sync_token: Option<String>,
    cur: Option<ReportEntry>,
    in_prop: bool,
    in_propstat: bool,
    /// Props buffered for the open propstat, committed only if its status is 2xx.
    pstat_etag: Option<String>,
    pstat_data: Option<String>,
    pstat_ok: Option<bool>,
    status_text: String,
    capture: Capture,
}

impl Parse {
    fn new() -> Self {
        Self {
            entries: Vec::new(),
            sync_token: None,
            cur: None,
            in_prop: false,
            in_propstat: false,
            pstat_etag: None,
            pstat_data: None,
            pstat_ok: None,
            status_text: String::new(),
            capture: Capture::None,
        }
    }

    fn open(&mut self, ns: &[u8], local: &[u8]) {
        match (ns, local) {
            (NS_DAV, b"response") => {
                self.cur = Some(ReportEntry {
                    href: String::new(),
                    response_status: None,
                    etag: None,
                    calendar_data: None,
                });
            }
            (NS_DAV, b"propstat") => {
                self.in_propstat = true;
                self.pstat_etag = None;
                self.pstat_data = None;
                self.pstat_ok = None;
            }
            (NS_DAV, b"prop") => self.in_prop = true,
            // href outside a prop is the response's own resource href.
            (NS_DAV, b"href") if !self.in_prop => self.capture = Capture::Href,
            (NS_DAV, b"getetag") => self.capture = Capture::Etag,
            (NS_CALDAV, b"calendar-data") => self.capture = Capture::CalendarData,
            (NS_DAV, b"status") => self.capture = Capture::Status,
            (NS_DAV, b"sync-token") => self.capture = Capture::SyncToken,
            _ => {}
        }
    }

    fn text(&mut self, raw: &str) {
        match self.capture {
            // The ICS body must survive verbatim — no trim, accumulate as-is.
            Capture::CalendarData => self.pstat_data.get_or_insert_with(String::new).push_str(raw),
            Capture::None => {}
            _ => {
                let t = raw.trim();
                if t.is_empty() {
                    return;
                }
                match self.capture {
                    Capture::Href => {
                        if let Some(c) = self.cur.as_mut() {
                            c.href.push_str(t);
                        }
                    }
                    Capture::Etag => self.pstat_etag.get_or_insert_with(String::new).push_str(t),
                    Capture::Status => self.status_text.push_str(t),
                    Capture::SyncToken => {
                        self.sync_token.get_or_insert_with(String::new).push_str(t)
                    }
                    _ => {}
                }
            }
        }
    }

    fn close(&mut self, ns: &[u8], local: &[u8]) {
        match (ns, local) {
            (NS_DAV, b"href") | (NS_CALDAV, b"calendar-data") | (NS_DAV, b"sync-token") => {
                self.capture = Capture::None;
            }
            (NS_DAV, b"getetag") => self.capture = Capture::None,
            (NS_DAV, b"status") => {
                let code = parse_status_code(&self.status_text);
                if self.in_propstat {
                    self.pstat_ok = Some(code.map(is_ok).unwrap_or(false));
                } else if let Some(c) = self.cur.as_mut() {
                    // Response-level status (a bare deletion marker in sync-collection).
                    c.response_status = code;
                }
                self.status_text.clear();
                self.capture = Capture::None;
            }
            (NS_DAV, b"prop") => self.in_prop = false,
            (NS_DAV, b"propstat") => {
                if self.pstat_ok == Some(true) {
                    if let Some(c) = self.cur.as_mut() {
                        if let Some(e) = self.pstat_etag.take() {
                            c.etag = Some(e);
                        }
                        if let Some(d) = self.pstat_data.take() {
                            c.calendar_data = Some(d);
                        }
                    }
                }
                self.in_propstat = false;
                self.pstat_etag = None;
                self.pstat_data = None;
                self.pstat_ok = None;
            }
            (NS_DAV, b"response") => {
                if let Some(c) = self.cur.take() {
                    self.entries.push(c);
                }
            }
            _ => {}
        }
    }
}

pub(crate) fn parse_report(xml: &str) -> Result<ReportResult, CaldavError> {
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
                p.open(&ns, &local);
            }
            // calendar-data is occasionally emitted as a self-closing empty when
            // absent — no text, nothing to capture, just don't leave capture armed.
            Event::Empty(_) => {}
            Event::Text(t) => {
                let text = t
                    .unescape()
                    .map_err(|e| CaldavError::Protocol(e.to_string()))?;
                p.text(&text);
            }
            Event::CData(t) => {
                let text = String::from_utf8_lossy(t.as_ref()).into_owned();
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

    Ok(ReportResult { entries: p.entries, sync_token: p.sync_token })
}

fn parse_status_code(s: &str) -> Option<u16> {
    s.split_whitespace().nth(1).and_then(|c| c.parse().ok())
}

fn is_ok(code: u16) -> bool {
    (200..300).contains(&code)
}

#[cfg(test)]
mod tests {
    use super::*;

    // A multiget/sync `<response>` can split its props across propstat blocks at
    // different statuses (RFC 4918 §9.1). The recorded fixtures never exercise this
    // on the sync path, so pin it here: props are kept ONLY from a 2xx block.
    #[test]
    fn mixed_propstat_keeps_only_the_2xx_block() {
        let xml = r#"<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <response>
    <href>/cal/only-etag.ics</href>
    <propstat>
      <prop><getetag>"etag-1"</getetag></prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
    <propstat>
      <prop><C:calendar-data/></prop>
      <status>HTTP/1.1 404 Not Found</status>
    </propstat>
  </response>
  <response>
    <href>/cal/full.ics</href>
    <propstat>
      <prop>
        <getetag>"etag-2"</getetag>
        <C:calendar-data>BEGIN:VCALENDAR
END:VCALENDAR</C:calendar-data>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
    <propstat>
      <prop><displayname/></prop>
      <status>HTTP/1.1 404 Not Found</status>
    </propstat>
  </response>
</multistatus>"#;

        let result = parse_report(xml).unwrap();
        let by_href = |h: &str| result.entries.iter().find(|e| e.href == h).unwrap();

        // getetag under 200, calendar-data offered under 404 → body dropped, not the
        // empty 404 value silently adopted as the resource's ICS.
        let only_etag = by_href("/cal/only-etag.ics");
        assert_eq!(only_etag.etag.as_deref(), Some("\"etag-1\""));
        assert_eq!(only_etag.calendar_data, None);

        // A sibling 404 propstat must not discard the 2xx block's props.
        let full = by_href("/cal/full.ics");
        assert_eq!(full.etag.as_deref(), Some("\"etag-2\""));
        assert_eq!(full.calendar_data.as_deref(), Some("BEGIN:VCALENDAR\nEND:VCALENDAR"));
    }

    /// Some servers wrap the ICS body in a CDATA section. The `Event::CData` arm
    /// must capture it identically to plain text, or the resource parses to an
    /// empty body and its event silently drops.
    #[test]
    fn calendar_data_in_a_cdata_section_is_captured() {
        let xml = r#"<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <response>
    <href>/cal/cdata.ics</href>
    <propstat>
      <prop>
        <getetag>"etag-c"</getetag>
        <C:calendar-data><![CDATA[BEGIN:VCALENDAR
END:VCALENDAR]]></C:calendar-data>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
</multistatus>"#;

        let result = parse_report(xml).unwrap();
        let entry = &result.entries[0];
        assert_eq!(entry.calendar_data.as_deref(), Some("BEGIN:VCALENDAR\nEND:VCALENDAR"));
    }
}
