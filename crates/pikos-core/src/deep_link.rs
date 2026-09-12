//! `pikos://` URL parsing.
//!
//! Port of `apps/desktop/src/shared/deep-link/parseDeepLink.ts`. iOS needs the
//! identical grammar for App Intents, widget taps and notification handling, so
//! a link that works on desktop works on the phone and vice versa.
//!
//! Unknown or malformed input yields `None`; callers treat that as a no-op
//! rather than an error, because a deep link is usually arriving from outside
//! the app and being noisy about a bad one helps nobody.

use url::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepLink {
    /// `pikos://page/<uuid>`
    Page { page_id: String },
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
    Inbox,
}

impl SmartView {
    pub fn as_str(self) -> &'static str {
        match self {
            SmartView::Today => "today",
            SmartView::Inbox => "inbox",
        }
    }
}

/// Case-insensitive canonical UUID check, matching the TypeScript regex.
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

/// Parse a `pikos://` URL into an action.
pub fn parse_deep_link(raw: &str) -> Option<DeepLink> {
    let url = Url::parse(raw).ok()?;
    if url.scheme() != "pikos" {
        return None;
    }

    // The TypeScript joins host and pathname before splitting, because host
    // parsing for non-special schemes differs between URL implementations —
    // `pikos://today` yields host "today" in some and an empty host with path
    // "/today" in others. Joining makes the parse independent of which.
    let host = url.host_str().unwrap_or("");
    let path = format!("{host}{}", url.path());
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();

    let (head, rest) = segments.split_first()?;

    match *head {
        "page" => {
            let id = rest.first()?;
            // Note the asymmetry with the arms below, which reject trailing
            // segments: `pikos://page/<uuid>/extra` resolves to the page. That
            // is the desktop behaviour, reproduced deliberately rather than
            // tidied — the corpus pins it, and changing it here would make the
            // two platforms disagree.
            if !is_uuid(id) {
                return None;
            }
            Some(DeepLink::Page {
                page_id: (*id).to_string(),
            })
        }
        "today" | "inbox" => {
            if !rest.is_empty() {
                return None;
            }
            Some(DeepLink::View {
                view_id: if *head == "today" {
                    SmartView::Today
                } else {
                    SmartView::Inbox
                },
            })
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

/// Percent-decoded value of a query parameter, or empty when absent — matching
/// `URLSearchParams.get(k) ?? ""`.
fn query_param(url: &Url, key: &str) -> String {
    url.query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default()
}
