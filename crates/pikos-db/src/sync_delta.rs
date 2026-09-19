//! The provider-agnostic sync contract: `SyncDelta` plus the `CalendarProvider`
//! trait. Both are designed from the CalDAV and Google specs together, so adding
//! the second provider is additive — it fills the existing contract rather than
//! reshaping it. Everything provider-specific (auth, HTTP, parsing) lives behind
//! the trait; the shared reconciler turns a `SyncDelta` into page writes.

use crate::error::AppResult;
use crate::sync::{SyncAccountRow, SyncCalendarRow};

/// Opaque incremental cursor — Google `syncToken` / CalDAV `sync-token`. The
/// reconciler never interprets it; it round-trips through the engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncToken(pub String);

/// A calendar discovered on an account, before the user opts in.
#[derive(Debug, Clone)]
pub struct RemoteCalendar {
    /// Provider's calendar identifier (stored as `sync_calendar.calendar_id`).
    pub calendar_id: String,
    pub display_name: String,
    /// Provider's own colour, if any — mapped onto the Pikos palette at setup,
    /// never rendered raw.
    pub color: Option<String>,
}

/// Identity + calendar-owned content shared by every event shape. The schedule
/// lives separately ([`EventSchedule`]) because occurrence deltas carry a
/// schedule without the rest.
#[derive(Debug, Clone)]
pub struct EventCore {
    /// Dedup identity: CalDAV resource href / Google event id (NOT the ICS UID).
    pub external_id: String,
    /// RFC 5545 UID — links a series' parts and re-links a dormant page.
    pub ical_uid: String,
    /// Provider etag / CalDAV getetag. The reconciler no-ops when it's unchanged.
    pub etag: Option<String>,
    pub title: String,
    /// Calendar-owned fields below are carried by the contract and consumed by
    /// the content/mirror reconcile pass (seeded into the body / mirror columns).
    pub description: Option<String>,
    pub location: Option<String>,
    pub attendees: Vec<String>,
}

/// One occurrence's wall-clock placement. `start`/`end` are source-zone
/// wall-clock; a date-only value (`YYYY-MM-DD`) means all-day, a date-time
/// (`YYYY-MM-DDTHH:MM:SS`) means timed — the same inference Pikos already uses.
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
/// A distinct type so that decrement is a compiler-enforced transition rather
/// than a convention. A provider's only job is to carry the raw value in here;
/// the reconciler owns the conversion.
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

/// Whether a bundle's `exdates` + `overrides` are the series' whole truth, or
/// only the slice this one resource could see. Decides whether the reconciler may
/// rewrite the series' occurrence deltas wholesale or must carry the stored ones
/// forward — get it wrong for Google and every cancelled occurrence resurrects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OccurrenceFidelity {
    /// The bundle carries the complete set. CalDAV always (one href holds the
    /// master plus every RECURRENCE-ID override under one UID); Google only on a
    /// full enumerate, where the master and all its child events arrive together.
    Complete,
    /// A master-only view. Google's cancellations and moved instances are separate
    /// child event resources, so an incremental delta carrying just the master —
    /// or a targeted `fetch_event` for orphan resolution — sees none of them.
    /// Stored exdates and overrides must survive the rewrite; the next full
    /// enumerate is what restores truth if the two ever drift.
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

/// A whole event in one piece: a single event when `recurrence` is `None`, a
/// series bundle (`master + overrides + exdates`) when `Some`. CalDAV always
/// produces this (one resource = whole series); Google when the master is in the
/// delta.
#[derive(Debug, Clone)]
pub struct EventUpsert {
    pub core: EventCore,
    /// Base occurrence schedule (the master, for a series).
    pub schedule: EventSchedule,
    pub recurrence: Option<Recurrence>,
}

/// A single changed or cancelled occurrence whose master is **not** in this
/// delta — Google's incremental `syncToken` can deliver one alone. Applied
/// against the already-stored rule; if no rule exists yet the reconciler emits a
/// missing-master signal rather than buffering or synthesizing one.
#[derive(Debug, Clone)]
pub struct OccurrenceDelta {
    /// The series this occurrence belongs to.
    pub ical_uid: String,
    /// Provider handle to fetch the master if it turns out to be orphaned
    /// (Google `recurringEventId`). Used by the engine's targeted `fetch_event`.
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

/// Two upsert shapes, as the providers actually deliver them.
#[derive(Debug, Clone)]
pub enum UpsertItem {
    /// A whole event or series.
    Event(EventUpsert),
    /// A lone occurrence change against an existing series.
    Occurrence(OccurrenceDelta),
}

/// A whole event gone upstream (Google `status:cancelled` without a recurrence
/// ref / CalDAV removed href). Carried by the contract; the lifecycle pass turns
/// it into detach-if-owned or hard-delete.
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
    /// True when this delta is a full re-enumerate of the collection (initial
    /// backfill, or a self-healed token rejection — CalDAV `403`, Google `410`).
    /// Drives the `full_resync` UI signal and the `last_full_sync_at` stamp. Can't
    /// be derived from its siblings: a CalDAV full enumerate has `next_token =
    /// None` but a Google one has `Some` (it carries `nextSyncToken`), and
    /// Google's full enumerate deliberately leaves `authoritative_from` unset —
    /// so neither can stand in for "was this full."
    pub full_enumerate: bool,
    /// Query window-start date (`YYYY-MM-DD`), set only by a full authoritative
    /// enumerate; its presence marks `upserts` the complete set for `[start, ∞)`
    /// and tells the engine to sweep absent pages (see `reconciler::sweep_absent`).
    /// `None` on an incremental delta, whose removals arrive explicitly.
    pub authoritative_from: Option<String>,
    /// External ids that WERE present upstream this enumerate but couldn't be turned
    /// into an upsert (unparseable body, or a multiget entry missing calendar-data).
    /// The sweep spares these — a resource we failed to parse is live, not deleted,
    /// and treating it as absent would permanently delete its mirror (incremental
    /// sync never re-delivers an unchanged event). Only consumed alongside
    /// `authoritative_from`; ignored on an incremental delta (no sweep runs).
    pub unresolved_present: Vec<String>,
}

/// One implementation per provider (CalDAV, then Google). Auth, HTTP, and parsing
/// live entirely behind it; the reconciler downstream is shared and provider-blind.
///
/// `async fn` in a trait is allowed here deliberately: there is no implementor
/// yet, and the dispatch strategy (static enum vs `dyn`) is settled when the
/// first provider lands. No `Send` bound is pinned until then.
#[allow(async_fn_in_trait)]
pub trait CalendarProvider {
    /// Enumerate the account's calendars (autodiscovery for CalDAV).
    async fn list_calendars(&self, account: &SyncAccountRow) -> AppResult<Vec<RemoteCalendar>>;

    /// Incremental sync from `since` (or a full backfill when `None`).
    async fn sync(
        &self,
        calendar: &SyncCalendarRow,
        since: Option<SyncToken>,
    ) -> AppResult<SyncDelta>;

    /// Targeted single-event fetch for orphan-master resolution — NOT a
    /// full-series re-fetch. `event_ref` is the provider handle from an
    /// [`OccurrenceDelta::series_ref`].
    async fn fetch_event(
        &self,
        calendar: &SyncCalendarRow,
        event_ref: &str,
    ) -> AppResult<EventUpsert>;

    /// Capture the collection's current incremental cursor after a backfill that
    /// carried none. A time-bounded backfill (CalDAV `calendar-query`) returns no
    /// sync-token, so the engine calls this once afterwards to bootstrap the
    /// cursor; an incremental [`sync`](Self::sync) already returns its own
    /// `next_token` and never needs it. Returns `None` when the provider has no
    /// separate cursor to fetch — Google's backfill already carries
    /// `nextSyncToken`, and a server without `sync-collection` has none at all
    /// (the engine then keeps re-enumerating until the ctag path lands).
    async fn current_sync_token(&self, calendar: &SyncCalendarRow) -> AppResult<Option<SyncToken>>;

    /// The collection's opaque change-tag (CalDAV `getctag`), for token-less
    /// servers that lack `sync-collection`. Unchanged since the last full
    /// enumerate ⇒ the poll can skip re-enumerating. Defaults to `None` — a
    /// provider with a real incremental cursor (Google `syncToken`, a
    /// `sync-collection` server) never needs it, and a `None` here means the
    /// engine simply never skips.
    async fn current_ctag(&self, _calendar: &SyncCalendarRow) -> AppResult<Option<String>> {
        Ok(None)
    }
}
