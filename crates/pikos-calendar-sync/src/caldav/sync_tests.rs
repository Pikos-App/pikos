//! Layer-1 CalDAV sync tests: recorded REPORT responses → asserted [`SyncDelta`].
//! Fixtures were captured 2026-06-19 from radicale 3.3.3 (basic auth, the seeded
//! work-calendar corpus: a zoned timed event, an all-day single, a multi-day
//! all-day span, and a recurring series carrying a TZID + UTC EXDATE, a moved
//! `RECURRENCE-ID` override, and a `STATUS:CANCELLED` override). No network — the
//! transport replays the fixtures, dispatching on the REPORT body.

use super::super::error::CaldavError;
use super::super::report_xml::parse_report;
use super::super::transport::{DavResponse, DavTransport};
use super::*;
use pikos_db::sync_delta::{EventUpsert, UpsertItem};

const INITIAL: &str = include_str!("../../tests/fixtures/caldav/sync/00_sync_collection_initial.xml");
const MULTIGET_ALL: &str = include_str!("../../tests/fixtures/caldav/sync/01_multiget_all.xml");
const BACKFILL: &str = include_str!("../../tests/fixtures/caldav/sync/02_calendar_query_backfill.xml");
const DELTA: &str = include_str!("../../tests/fixtures/caldav/sync/03_sync_collection_delta.xml");
const MULTIGET_CHANGED: &str = include_str!("../../tests/fixtures/caldav/sync/04_multiget_changed.xml");
const STALE: &str = include_str!("../../tests/fixtures/caldav/sync/05_sync_collection_stale_token.xml");

const CAL: &str = "http://127.0.0.1:5232/testuser/work-calendar/";

#[derive(Clone, Copy)]
enum Mode {
    /// sync-collection returns the whole corpus (etags only) → multiget all four.
    Full,
    /// sync-collection returns one changed + one deleted href → multiget the change.
    Delta,
    /// sync-collection 403s `valid-sync-token` → falls back to a calendar-query.
    Stale,
}

struct FixtureTransport {
    mode: Mode,
}

impl DavTransport for FixtureTransport {
    async fn propfind(&self, url: &str, _: &str, _: &str) -> Result<DavResponse, CaldavError> {
        panic!("sync never issues a PROPFIND (got {url})");
    }

    async fn report(&self, _url: &str, _depth: &str, body: &str) -> Result<DavResponse, CaldavError> {
        let resp = if body.contains("calendar-multiget") {
            match self.mode {
                Mode::Delta => ok(MULTIGET_CHANGED),
                _ => ok(MULTIGET_ALL),
            }
        } else if body.contains("calendar-query") {
            ok(BACKFILL)
        } else if body.contains("sync-collection") {
            match self.mode {
                Mode::Full => ok(INITIAL),
                Mode::Delta => ok(DELTA),
                Mode::Stale => DavResponse { status: 403, location: None, body: STALE.into() },
            }
        } else {
            panic!("unexpected REPORT body: {body}");
        };
        Ok(resp)
    }
}

fn ok(body: &str) -> DavResponse {
    DavResponse { status: 207, location: None, body: body.into() }
}

async fn run(mode: Mode, since: Option<&str>) -> SyncDelta {
    let t = FixtureTransport { mode };
    sync_calendar(&t, CAL, since.map(|s| SyncToken(s.to_string())).as_ref())
        .await
        .unwrap()
}

// ─── helpers ────────────────────────────────────────────────────────────────────

fn events(delta: &SyncDelta) -> Vec<&EventUpsert> {
    delta
        .upserts
        .iter()
        .filter_map(|u| match u {
            UpsertItem::Event(e) => Some(e),
            _ => None,
        })
        .collect()
}

fn by_uid<'a>(delta: &'a SyncDelta, uid: &str) -> &'a EventUpsert {
    events(delta)
        .into_iter()
        .find(|e| e.core.ical_uid == uid)
        .unwrap_or_else(|| panic!("no event with uid {uid}"))
}

// ─── backfill (calendar-query, inline calendar-data) ────────────────────────────

#[tokio::test]
async fn backfill_enumerates_the_window_with_no_token_or_removals() {
    let delta = run(Mode::Full, None).await;
    assert_eq!(events(&delta).len(), 4, "all four seeded resources");
    assert!(delta.removals.is_empty(), "a full enumerate has no removals");
    assert!(delta.next_token.is_none(), "backfill leaves token bootstrap to the engine");
}

#[tokio::test]
async fn timed_event_maps_identity_schedule_and_mirror_fields() {
    let delta = run(Mode::Full, None).await;
    let m = by_uid(&delta, "meeting-1@pikos.test");
    assert_eq!(m.core.external_id, "/testuser/work-calendar/meeting.ics", "href is the dedup id");
    assert_eq!(m.core.title, "Product sync");
    assert_eq!(m.core.description.as_deref(), Some("Bring the roadmap drafts."));
    assert_eq!(m.core.location.as_deref(), Some("Room 4B"));
    assert_eq!(m.core.attendees, vec!["alex@pikos.test", "sam@pikos.test"], "mailto: stripped");
    assert_eq!(m.schedule.start, "2026-06-15T09:00:00");
    assert_eq!(m.schedule.end.as_deref(), Some("2026-06-15T09:30:00"));
    assert_eq!(m.schedule.timezone.as_deref(), Some("America/New_York"));
    assert!(m.recurrence.is_none());
}

#[tokio::test]
async fn all_day_end_is_carried_raw_exclusive() {
    let delta = run(Mode::Full, None).await;

    // Single all-day: provider carries DTEND raw (the next day); the reconciler
    // owns the decrement — the provider must NOT pre-subtract.
    let h = by_uid(&delta, "holiday-1@pikos.test");
    assert_eq!(h.schedule.start, "2026-06-15");
    assert_eq!(h.schedule.end.as_deref(), Some("2026-06-16"), "raw exclusive, not decremented");
    assert_eq!(h.schedule.timezone, None, "all-day carries no zone");

    // Multi-day span: Jun 15–17 inclusive arrives as DTEND Jun 18, carried raw.
    let t = by_uid(&delta, "trip-1@pikos.test");
    assert_eq!((t.schedule.start.as_str(), t.schedule.end.as_deref()), ("2026-06-15", Some("2026-06-18")));
}

#[tokio::test]
async fn recurring_series_folds_master_overrides_and_cancellation() {
    let delta = run(Mode::Full, None).await;
    let s = by_uid(&delta, "standup@pikos.test");
    assert_eq!(s.schedule.start, "2026-06-01T09:00:00");
    assert_eq!(s.schedule.end.as_deref(), Some("2026-06-01T09:30:00"));
    assert_eq!(s.schedule.timezone.as_deref(), Some("America/New_York"));

    let rec = s.recurrence.as_ref().expect("series carries a recurrence");
    // Raw RRULE: every field preserved (no lossy round-trip) and UNTIL kept as the
    // wire UTC token — the reconciler, not the provider, rewrites it to wall-clock.
    assert!(rec.rrule.contains("FREQ=WEEKLY"), "got {}", rec.rrule);
    assert!(rec.rrule.contains("BYDAY=MO"), "BYDAY preserved: {}", rec.rrule);
    assert!(rec.rrule.contains("UNTIL=20260831T130000Z"), "UNTIL kept raw with Z: {}", rec.rrule);

    // One moved override (RECURRENCE-ID), keyed by the original wall-clock date.
    assert_eq!(rec.overrides.len(), 1);
    let ov = &rec.overrides[0];
    assert_eq!(ov.original_date, "2026-06-08T09:00:00");
    assert_eq!(ov.schedule.start, "2026-06-08T11:00:00");
    assert_eq!(ov.schedule.end.as_deref(), Some("2026-06-08T11:30:00"));
    assert_eq!(ov.schedule.timezone.as_deref(), Some("America/New_York"));

    // EXDATEs, every instant normalized to source-zone wall-clock:
    //  - the TZID EXDATE is already source wall-clock (literal),
    //  - the UTC EXDATE 13:00Z on Jul 6 (EDT, UTC-4) converts to 09:00,
    //  - the STATUS:CANCELLED override becomes a cancellation, not a moved instance.
    let mut exdates = rec.exdates.clone();
    exdates.sort();
    assert_eq!(
        exdates,
        vec!["2026-06-15T09:00:00", "2026-06-22T09:00:00", "2026-07-06T09:00:00"],
        "TZID literal + UTC-converted + cancelled override, all bare wall-clock"
    );
}

// ─── incremental sync-collection ────────────────────────────────────────────────

#[tokio::test]
async fn incremental_delta_applies_change_removal_and_advances_token() {
    let delta = run(Mode::Delta, Some("http://radicale.org/ns/sync/OLD")).await;

    // The lone changed href is bodied via multiget and upserted.
    let evs = events(&delta);
    assert_eq!(evs.len(), 1, "only the changed resource");
    let m = evs[0];
    assert_eq!(m.core.ical_uid, "meeting-1@pikos.test");
    assert_eq!(m.core.title, "Product sync (rescheduled)");
    assert_eq!(m.schedule.start, "2026-06-15T10:00:00", "rescheduled time picked up");

    // The 404'd href is a whole-event removal.
    assert_eq!(delta.removals.len(), 1);
    assert_eq!(delta.removals[0].external_id, "/testuser/work-calendar/trip.ics");

    // The trailing sync-token becomes the next cursor.
    let token = delta.next_token.as_ref().expect("delta advances the token");
    assert!(token.0.contains("30f466c6"), "next sync-token stored: {}", token.0);
}

#[tokio::test]
async fn full_via_sync_collection_multigets_all_changed_hrefs() {
    // sync-collection that lists the whole corpus (etags only) → multiget bodies.
    let delta = run(Mode::Full, Some("http://radicale.org/ns/sync/SOME")).await;
    assert_eq!(events(&delta).len(), 4);
    assert!(delta.removals.is_empty());
    assert!(delta.next_token.is_some(), "incremental carries the token forward");
}

#[tokio::test]
async fn stale_token_falls_back_to_full_reenumerate() {
    // A 403 valid-sync-token must trigger a bounded re-enumerate, not error out.
    let delta = run(Mode::Stale, Some("http://radicale.org/ns/sync/STALE")).await;
    assert_eq!(events(&delta).len(), 4, "recovered the full window");
    assert!(delta.removals.is_empty());
    assert!(delta.next_token.is_none(), "re-enumerate re-bootstraps the token");
}

// ─── sync-collection multistatus shape ──────────────────────────────────────────

#[tokio::test]
async fn report_parser_splits_changes_from_deletions() {
    let report = parse_report(DELTA).unwrap();
    let deleted: Vec<_> = report
        .entries
        .iter()
        .filter(|e| e.response_status == Some(404))
        .map(|e| e.href.as_str())
        .collect();
    assert_eq!(deleted, vec!["/testuser/work-calendar/trip.ics"], "404 is a deletion");
    let changed: Vec<_> = report
        .entries
        .iter()
        .filter(|e| e.response_status.is_none())
        .map(|e| e.href.as_str())
        .collect();
    assert_eq!(changed, vec!["/testuser/work-calendar/meeting.ics"]);
    assert!(report.sync_token.unwrap().contains("30f466c6"));
}

// ─── fetch_event (single-resource refetch) ──────────────────────────────────────

#[tokio::test]
async fn fetch_one_refetches_a_single_resource() {
    let t = FixtureTransport { mode: Mode::Delta };
    let ev = fetch_one(&t, CAL, "/testuser/work-calendar/meeting.ics").await.unwrap();
    assert_eq!(ev.core.ical_uid, "meeting-1@pikos.test");
    assert_eq!(ev.schedule.start, "2026-06-15T10:00:00");
}
