//! The provider-agnostic sync contract: `SyncDelta` plus the `CalendarProvider` trait.
//! Everything provider-specific (auth, HTTP, parsing) lives behind the trait; the shared
//! reconciler turns a `SyncDelta` into page writes.

use crate::error::AppResult;
use crate::sync::{SyncAccountRow, SyncCalendarRow};

/// Opaque incremental cursor (Google `syncToken`, CalDAV `sync-token`); the reconciler never
/// interprets it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncToken(pub String);

/// A calendar discovered on an account, before the user opts in.
#[derive(Debug, Clone)]
pub struct RemoteCalendar {
    /// Provider's calendar identifier (stored as `sync_calendar.calendar_id`).
    pub calendar_id: String,
    pub display_name: String,
    /// Provider's own colour, mapped onto the Pikos palette at setup, never rendered raw.
    pub color: Option<String>,
}

/// Identity and calendar-owned content shared by every event shape. The schedule is separate
/// ([`EventSchedule`]) because occurrence deltas carry one without the rest.
#[derive(Debug, Clone)]
pub struct EventCore {
    /// Dedup identity: CalDAV resource href / Google event id (NOT the ICS UID).
    pub external_id: String,
    /// RFC 5545 UID — links a series' parts and re-links a dormant page.
    pub ical_uid: String,
    /// Provider etag / CalDAV getetag. The reconciler no-ops when it's unchanged.
    pub etag: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub attendees: Vec<String>,
}

/// One occurrence's wall-clock placement. `start` and `end` are source-zone wall-clock; a
/// date-only value means all-day, a date-time means timed.
#[derive(Debug, Clone)]
pub struct EventSchedule {
    pub start: String,
    pub end: ExclusiveEnd,
    /// IANA source zone; `None` for all-day (no meaningful zone).
    pub timezone: Option<String>,
}

/// An end exactly as the provider sent it. All-day ends are **exclusive** on the
/// wire in both providers (RFC 5545 `DTEND`, Google `end.date`): a single Jun 15
/// event has `end = Jun 16`, where Pikos stores the inclusive last covered day.
///
/// A distinct type so the decrement is compiler-enforced. A provider only carries the raw
/// value in; the reconciler owns the conversion.
#[derive(Debug, Clone)]
pub struct ExclusiveEnd(Option<String>);

impl ExclusiveEnd {
    pub fn new(end: Option<String>) -> Self {
        Self(end)
    }

    pub fn as_deref(&self) -> Option<&str> {
        self.0.as_deref()
    }
}

/// Whether a bundle's `exdates` and `overrides` are the series' whole truth or only the slice
/// one resource could see. It decides whether the reconciler rewrites the occurrence deltas
/// wholesale or carries the stored ones forward; wrong for Google, every cancelled occurrence
/// resurrects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OccurrenceFidelity {
    /// The complete set. CalDAV always (one href holds the master and every override); Google
    /// only on a full enumerate, where the master and its child events arrive together.
    Complete,
    /// A master-only view. Google's cancellations and moved instances are separate child
    /// resources, so an incremental delta with just the master, or a `fetch_event`, sees none
    /// of them. Stored exdates and overrides must survive the rewrite; the next full enumerate
    /// restores truth if they drift.
    MasterOnly,
}

/// The recurrence half of a series bundle. Absent on a single event.
#[derive(Debug, Clone)]
pub struct Recurrence {
    /// Raw RRULE string, stored as-is so no lossy parse round-trip drops fields.
    pub rrule: String,
    /// Excluded occurrence dates (source-zone wall-clock).
    pub exdates: Vec<String>,
    /// Modified instances, keyed by the original rrule date they replace.
    pub overrides: Vec<OccurrenceOverride>,
    /// How much of the series' occurrence deltas the two fields above represent.
    pub fidelity: OccurrenceFidelity,
}

/// A modified instance inside a series bundle.
#[derive(Debug, Clone)]
pub struct OccurrenceOverride {
    /// The rrule date this instance replaces (source-zone wall-clock).
    pub original_date: String,
    pub schedule: EventSchedule,
}

/// A single event when `recurrence` is `None`, a series bundle (master, overrides, exdates)
/// when `Some`. CalDAV always produces this; Google when the master is in the delta.
#[derive(Debug, Clone)]
pub struct EventUpsert {
    pub core: EventCore,
    /// Base occurrence schedule (the master, for a series).
    pub schedule: EventSchedule,
    pub recurrence: Option<Recurrence>,
}

/// A changed or cancelled occurrence whose master is not in this delta, which Google's
/// incremental `syncToken` can deliver alone. Applied against the stored rule; with none, the
/// reconciler signals a missing master.
#[derive(Debug, Clone)]
pub struct OccurrenceDelta {
    /// The series this occurrence belongs to.
    pub ical_uid: String,
    /// Provider handle to fetch the master if orphaned (Google `recurringEventId`).
    pub series_ref: String,
    /// The rrule date this delta targets (source-zone wall-clock).
    pub original_date: String,
    pub kind: OccurrenceKind,
}

#[derive(Debug, Clone)]
pub enum OccurrenceKind {
    /// Modified instance → a `page_schedules` override row.
    Modify(EventSchedule),
    /// Cancelled instance → an `EXDATE` on the series.
    Cancel,
}

#[derive(Debug, Clone)]
pub enum UpsertItem {
    /// A whole event or series.
    Event(EventUpsert),
    /// A lone occurrence change against an existing series.
    Occurrence(OccurrenceDelta),
}

/// A whole event gone upstream (Google `status:cancelled` without a recurrence ref, or a
/// removed CalDAV href).
#[derive(Debug, Clone)]
pub struct Removal {
    pub external_id: String,
}

/// One sync round's result: what to upsert, what's gone, and the cursor to store.
#[derive(Debug, Clone, Default)]
pub struct SyncDelta {
    pub upserts: Vec<UpsertItem>,
    pub removals: Vec<Removal>,
    pub next_token: Option<SyncToken>,
    /// True for a full re-enumerate of the collection (initial backfill, or a self-healed
    /// token rejection: CalDAV `403`, Google `410`). Drives the `full_resync` UI signal and
    /// the `last_full_sync_at` stamp. It can't be derived from its siblings: a CalDAV full
    /// enumerate has `next_token = None`, a Google one has `Some`, and Google's leaves
    /// `authoritative_from` unset.
    pub full_enumerate: bool,
    /// Query window-start date (`YYYY-MM-DD`), set only by a full authoritative enumerate: it
    /// marks `upserts` the complete set from `start` on, and tells the engine to sweep absent
    /// pages (`reconciler::sweep_absent`). `None` on an incremental delta.
    pub authoritative_from: Option<String>,
    /// External ids present upstream this enumerate but not turned into an upsert (unparseable
    /// body, or a multiget entry missing calendar-data). The sweep spares them: treating one
    /// as absent would permanently delete its mirror, as incremental sync never re-delivers an
    /// unchanged event. Used only with `authoritative_from`.
    pub unresolved_present: Vec<String>,
}

/// One implementation per provider. Auth, HTTP and parsing live behind it; the reconciler
/// downstream is shared and provider-blind.
///
/// `async fn` in a trait is allowed because callers dispatch through a static enum, not `dyn`,
/// so no `Send` bound is pinned.
#[allow(async_fn_in_trait)]
pub trait CalendarProvider {
    async fn list_calendars(&self, account: &SyncAccountRow) -> AppResult<Vec<RemoteCalendar>>;

    /// Incremental sync from `since` (or a full backfill when `None`).
    async fn sync(
        &self,
        calendar: &SyncCalendarRow,
        since: Option<SyncToken>,
    ) -> AppResult<SyncDelta>;

    /// A targeted single-event fetch for orphan-master resolution, not a full-series re-fetch.
    /// `event_ref` is an [`OccurrenceDelta::series_ref`].
    async fn fetch_event(
        &self,
        calendar: &SyncCalendarRow,
        event_ref: &str,
    ) -> AppResult<EventUpsert>;

    /// The collection's current cursor after a backfill that carried none: a time-bounded
    /// CalDAV `calendar-query` returns no sync-token, so the engine calls this once to
    /// bootstrap it. `None` when there is no separate cursor to fetch: Google's backfill
    /// carries `nextSyncToken`, and a server without `sync-collection` has none.
    async fn current_sync_token(&self, calendar: &SyncCalendarRow) -> AppResult<Option<SyncToken>>;

    /// The collection's opaque change tag (CalDAV `getctag`), for servers lacking
    /// `sync-collection`: unchanged since the last full enumerate, the poll can skip
    /// re-enumerating. `None` by default, which means the engine never skips.
    async fn current_ctag(&self, _calendar: &SyncCalendarRow) -> AppResult<Option<String>> {
        Ok(None)
    }
}
