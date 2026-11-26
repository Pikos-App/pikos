//! `pikos://` URL parsing.
//!
//! iOS needs the identical grammar for App Intents, widget taps and notifications, so a link
//! works on both platforms. Unknown or malformed input yields `None`, which callers treat as
//! a no-op: the link arrives from outside, and being noisy about a bad one helps nobody.

use url::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepLink {
    /// `pikos://page/<uuid>`, or `pikos://page/<uuid>?focus=1` to open it with the focus timer
    /// running. The desktop has no focus link yet and opens the page either way.
    Page { page_id: String, focus: bool },
    /// `pikos://today` or `pikos://inbox`
    View { view_id: SmartView },
    /// `pikos://calendar` — used by notification taps.
    Calendar,
    /// `pikos://quick-add?text=…`
    QuickAdd { prefill: String },
    /// `pikos://search?q=…`
    Search { prefill: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SmartView {
    Today,
    Upcoming,
    Inbox,
}

impl SmartView {
    pub fn as_str(self) -> &'static str {
        match self {
            SmartView::Today => "today",
            SmartView::Upcoming => "upcoming",
            SmartView::Inbox => "inbox",
        }
    }
}

fn is_uuid(s: &str) -> bool {
    let groups = [8usize, 4, 4, 4, 12];
    let mut parts = s.split('-');
    for expected in groups {
        let Some(part) = parts.next() else {
            return false;
        };
        if part.len() != expected || !part.chars().all(|c| c.is_ascii_hexdigit()) {
            return false;
        }
    }
    parts.next().is_none()
}

pub fn parse_deep_link(raw: &str) -> Option<DeepLink> {
    let url = Url::parse(raw).ok()?;
    if url.scheme() != "pikos" {
        return None;
    }

    // Host and path are joined before splitting because non-special schemes parse differently
    // across URL implementations (`pikos://today` is host "today" in some, path "/today" in others).
    let host = url.host_str().unwrap_or("");
    let path = format!("{host}{}", url.path());
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();

    let (head, rest) = segments.split_first()?;

    match *head {
        "page" => {
            let id = rest.first()?;
            // Unlike the arms below, trailing segments are accepted: `pikos://page/<uuid>/extra`
            // resolves to the page, matching desktop.
            if !is_uuid(id) {
                return None;
            }
            Some(DeepLink::Page {
                page_id: (*id).to_string(),
                focus: query_param(&url, "focus") == "1",
            })
        }
        // Matched by name and exhaustively, so a new view is a compile error rather than a dead link.
        "today" | "upcoming" | "inbox" => {
            if !rest.is_empty() {
                return None;
            }
            let view_id = match *head {
                "today" => SmartView::Today,
                "upcoming" => SmartView::Upcoming,
                _ => SmartView::Inbox,
            };
            Some(DeepLink::View { view_id })
        }
        "calendar" => {
            if !rest.is_empty() {
                return None;
            }
            Some(DeepLink::Calendar)
        }
        "quick-add" => {
            if !rest.is_empty() {
                return None;
            }
            Some(DeepLink::QuickAdd {
                prefill: query_param(&url, "text"),
            })
        }
        "search" => {
            if !rest.is_empty() {
                return None;
            }
            Some(DeepLink::Search {
                prefill: query_param(&url, "q"),
            })
        }
        _ => None,
    }
}

/// Percent-decoded value of a query parameter, or empty when absent.
fn query_param(url: &Url, key: &str) -> String {
    url.query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default()
}
