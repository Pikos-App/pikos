//! Serde shapes for the slice of the Calendar API v3 responses sync reads.
//!
//! Nearly everything is optional by necessity: a cancelled event in an
//! incremental delta arrives as little more than `id` + `status`, and Google is
//! free to add fields, so unknown keys are ignored rather than rejected.

use serde::Deserialize;

/// `events.list` / `events.get` response.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EventsResponse {
    #[serde(default)]
    pub items: Vec<Event>,
    pub next_page_token: Option<String>,
    pub next_sync_token: Option<String>,
    /// The calendar's own zone — the fallback when a timed event carries no
    /// `timeZone` of its own (Google omits it for events in the calendar default).
    pub time_zone: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Event {
    pub id: String,
    /// RFC 5545 UID. Shared by a recurring master and its exception instances,
    /// which is what lets an orphaned occurrence name its series.
    #[serde(rename = "iCalUID")]
    pub ical_uid: Option<String>,
    pub etag: Option<String>,
    /// `confirmed` / `tentative` / `cancelled`. Absent is treated as confirmed.
    pub status: Option<String>,
    pub summary: Option<String>,
    pub description: Option<String>,
    pub location: Option<String>,
    #[serde(default)]
    pub attendees: Vec<Attendee>,
    pub start: Option<EventDateTime>,
    pub end: Option<EventDateTime>,
    /// RRULE / EXDATE / RDATE lines, each with its iCalendar property prefix.
    #[serde(default)]
    pub recurrence: Vec<String>,
    /// Set on an exception instance: the `id` of the master it belongs to.
    pub recurring_event_id: Option<String>,
    /// Set on an exception instance: the series date this instance replaces.
    pub original_start_time: Option<EventDateTime>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Attendee {
    pub email: Option<String>,
}

/// Google's date-or-datetime union. `date` means all-day; `date_time` is RFC 3339
/// with an offset, and `time_zone` names the IANA zone that offset came from.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EventDateTime {
    pub date: Option<String>,
    pub date_time: Option<String>,
    pub time_zone: Option<String>,
}

/// Google's error envelope. Only `reason` is read — it's what separates a quota
/// blip from a permission refusal behind a shared `403`.
#[derive(Debug, Deserialize)]
pub(crate) struct ApiErrorResponse {
    error: Option<ApiError>,
}

#[derive(Debug, Deserialize)]
struct ApiError {
    #[serde(default)]
    errors: Vec<ApiErrorItem>,
}

#[derive(Debug, Deserialize)]
struct ApiErrorItem {
    reason: Option<String>,
}

impl ApiErrorResponse {
    pub(crate) fn reasons(&self) -> Vec<String> {
        self.error
            .iter()
            .flat_map(|e| e.errors.iter())
            .filter_map(|i| i.reason.clone())
            .collect()
    }
}

/// `calendarList.list` response.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CalendarListResponse {
    #[serde(default)]
    pub items: Vec<CalendarListEntry>,
    pub next_page_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CalendarListEntry {
    pub id: String,
    pub summary: Option<String>,
    /// The user's own rename of a shared calendar; takes precedence over `summary`.
    pub summary_override: Option<String>,
    pub background_color: Option<String>,
    /// Set when the user removed the calendar from their list in an incremental
    /// `calendarList` delta.
    #[serde(default)]
    pub deleted: bool,
    /// The account's own calendar; its `id` is the signed-in email address.
    #[serde(default)]
    pub primary: bool,
}
