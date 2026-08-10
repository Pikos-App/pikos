//! Layer-1 Google sync tests: recorded Calendar API responses → asserted
//! [`SyncDelta`]. Fixtures are hand-authored against the documented `events.list`
//! / `events.get` / `calendarList.list` shapes (no live account), covering the
//! series regrouping, both cancelled branches, and the orphaned instance.
//! No network — the transport replays a scripted queue and records its queries.

use std::cell::RefCell;
use std::collections::VecDeque;

use super::super::error::GoogleError;
use super::super::transport::{GoogleResponse, GoogleTransport};
use super::*;
use pikos_db::sync_delta::{OccurrenceKind, UpsertItem};

const BACKFILL: &str = include_str!("../../tests/fixtures/google/00_backfill.json");
const INCREMENTAL: &str = include_str!("../../tests/fixtures/google/01_incremental.json");
const ORPHAN_MASTER: &str = include_str!("../../tests/fixtures/google/02_orphan_master.json");
const CALENDAR_LIST: &str = include_str!("../../tests/fixtures/google/03_calendar_list.json");
const PAGE_1: &str = include_str!("../../tests/fixtures/google/04_paged_page1.json");
const PAGE_2: &str = include_str!("../../tests/fixtures/google/05_paged_page2.json");

const CAL: &str = "alex@example.com";

/// One recorded request: the path, and its query as key/value pairs.
type Call = (String, Vec<(String, String)>);

#[derive(Default)]
struct Replay {
    responses: RefCell<VecDeque<(u16, String)>>,
    /// Recorded per call, so a test can assert what was actually asked for.
    calls: RefCell<Vec<Call>>,
}

impl Replay {
    fn with(mut pairs: Vec<(u16, &str)>) -> Self {
        let this = Self::default();
        for (status, body) in pairs.drain(..) {
            this.responses
                .borrow_mut()
                .push_back((status, body.to_string()));
        }
        this
    }

    fn ok(body: &str) -> Self {
        Self::with(vec![(200, body)])
    }

    fn query_of(&self, call: usize, key: &str) -> Option<String> {
        self.calls.borrow()[call]
            .1
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
    }

    fn call_count(&self) -> usize {
        self.calls.borrow().len()
    }
}

impl GoogleTransport for Replay {
    async fn get(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<GoogleResponse, GoogleError> {
        self.calls.borrow_mut().push((
            path.to_string(),
            query
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
        ));
        let (status, body) = self
            .responses
            .borrow_mut()
            .pop_front()
            .expect("scripted response");
        Ok(GoogleResponse { status, body })
    }
}

fn event(delta: &SyncDelta, external_id: &str) -> EventUpsert {
    delta
        .upserts
        .iter()
        .find_map(|i| match i {
            UpsertItem::Event(ev) if ev.core.external_id == external_id => Some(ev.clone()),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no event upsert for {external_id}"))
}

fn occurrences(delta: &SyncDelta) -> Vec<pikos_db::sync_delta::OccurrenceDelta> {
    delta
        .upserts
        .iter()
        .filter_map(|i| match i {
            UpsertItem::Occurrence(o) => Some(o.clone()),
            _ => None,
        })
        .collect()
}

// ─── backfill ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn backfill_carries_its_own_token() {
    let t = Replay::ok(BACKFILL);
    let delta = sync_calendar(&t, CAL, None).await.unwrap();

    assert_eq!(
        delta.next_token.as_ref().map(|t| t.0.as_str()),
        Some("TOKEN-1")
    );
    assert_eq!(t.query_of(0, "singleEvents").as_deref(), Some("false"));
    assert_eq!(t.query_of(0, "showDeleted").as_deref(), Some("true"));
    assert!(t.query_of(0, "timeMin").is_some());
}

#[tokio::test]
async fn no_google_delta_ever_arms_the_sweep() {
    let backfill = Replay::ok(BACKFILL);
    let full = sync_calendar(&backfill, CAL, None).await.unwrap();
    let incremental_t = Replay::ok(INCREMENTAL);
    let incremental = sync_calendar(&incremental_t, CAL, Some(&SyncToken("TOKEN-1".into())))
        .await
        .unwrap();

    // See `backfill`'s doc — Google opts out of the sweep by leaving
    // `authoritative_from` unset even on a full enumerate.
    for delta in [&full, &incremental] {
        assert!(delta.authoritative_from.is_none());
    }
    // `full_enumerate` and `authoritative_from` are separate signals; Google sets
    // only the former.
    assert!(full.full_enumerate && !incremental.full_enumerate);
    assert!(
        full.removals.is_empty() && incremental.removals.len() == 1,
        "removals are the deletion signal, not absence from an enumerate"
    );
}

#[tokio::test]
async fn backfill_maps_a_timed_event_to_source_zone_wall_clock() {
    let t = Replay::ok(BACKFILL);
    let delta = sync_calendar(&t, CAL, None).await.unwrap();
    let ev = event(&delta, "ev-single");

    assert_eq!(ev.core.ical_uid, "uid-single@google.com");
    assert_eq!(ev.core.title, "Design review");
    assert_eq!(ev.core.location.as_deref(), Some("Studio B"));
    assert_eq!(
        ev.core.attendees,
        vec!["sam@example.com", "kai@example.com"]
    );
    assert_eq!(ev.schedule.start, "2026-06-10T14:00:00");
    assert_eq!(ev.schedule.end.as_deref(), Some("2026-06-10T15:00:00"));
    assert_eq!(ev.schedule.timezone.as_deref(), Some("America/New_York"));
}

#[tokio::test]
async fn backfill_carries_the_all_day_end_raw_exclusive() {
    let t = Replay::ok(BACKFILL);
    let delta = sync_calendar(&t, CAL, None).await.unwrap();
    let ev = event(&delta, "ev-allday");

    assert_eq!(ev.schedule.start, "2026-06-15");
    // Jun 15–17 inclusive arrives as end=Jun 18; see `ExclusiveEnd` for why
    // nothing decrements it here.
    assert_eq!(ev.schedule.end.as_deref(), Some("2026-06-18"));
    assert!(ev.schedule.timezone.is_none(), "all-day carries no zone");
}

#[tokio::test]
async fn backfill_regroups_a_series_from_its_separate_resources() {
    let t = Replay::ok(BACKFILL);
    let delta = sync_calendar(&t, CAL, None).await.unwrap();
    let ev = event(&delta, "ev-series");
    let rec = ev.recurrence.expect("series bundle");

    assert_eq!(rec.rrule, "FREQ=WEEKLY;BYDAY=MO");
    assert_eq!(
        rec.fidelity,
        OccurrenceFidelity::Complete,
        "a full enumerate carries every child, so the occurrence set is whole"
    );
    // One EXDATE line, one cancelled child event — both cancel one occurrence,
    // both must land as EXDATEs.
    assert_eq!(
        rec.exdates,
        vec!["2026-06-29T09:00:00", "2026-06-15T09:00:00"]
    );
    assert_eq!(rec.overrides.len(), 1);
    assert_eq!(rec.overrides[0].original_date, "2026-06-08T09:00:00");
    assert_eq!(rec.overrides[0].schedule.start, "2026-06-08T11:00:00");
    // The instances folded into the master; none leaked out as standalone events.
    assert_eq!(delta.upserts.len(), 3);
    assert!(delta.removals.is_empty());
}

// ─── incremental: the cancelled split + orphans ───────────────────────────────

#[tokio::test]
async fn incremental_bundles_are_master_only() {
    let t = Replay::ok(INCREMENTAL);
    let delta = sync_calendar(&t, CAL, Some(&SyncToken("TOKEN-1".into())))
        .await
        .unwrap();
    let rec = event(&delta, "ev-series").recurrence.expect("series");

    assert_eq!(t.query_of(0, "syncToken").as_deref(), Some("TOKEN-1"));
    assert!(
        t.query_of(0, "timeMin").is_none(),
        "Google rejects a syncToken combined with timeMin"
    );
    assert_eq!(rec.fidelity, OccurrenceFidelity::MasterOnly);
    assert!(rec.exdates.is_empty());
    assert!(rec.overrides.is_empty());
}

#[tokio::test]
async fn cancelled_instance_becomes_an_occurrence_cancel_not_a_removal() {
    let t = Replay::ok(INCREMENTAL);
    let delta = sync_calendar(&t, CAL, Some(&SyncToken("TOKEN-1".into())))
        .await
        .unwrap();

    let cancel = occurrences(&delta)
        .into_iter()
        .find(|o| matches!(o.kind, OccurrenceKind::Cancel))
        .expect("a cancelled instance");
    assert_eq!(cancel.ical_uid, "uid-standup@google.com");
    assert_eq!(cancel.series_ref, "ev-standup");
    assert_eq!(cancel.original_date, "2026-06-22T09:00:00");
    assert!(
        !delta
            .removals
            .iter()
            .any(|r| r.external_id.contains("standup")),
        "an instance cancellation is never an event removal"
    );
}

#[tokio::test]
async fn cancelled_event_without_a_recurrence_ref_becomes_a_removal() {
    let t = Replay::ok(INCREMENTAL);
    let delta = sync_calendar(&t, CAL, Some(&SyncToken("TOKEN-1".into())))
        .await
        .unwrap();

    assert_eq!(delta.removals.len(), 1);
    assert_eq!(delta.removals[0].external_id, "ev-single");
}

#[tokio::test]
async fn moved_instance_without_its_master_becomes_an_occurrence_modify() {
    let t = Replay::ok(INCREMENTAL);
    let delta = sync_calendar(&t, CAL, Some(&SyncToken("TOKEN-1".into())))
        .await
        .unwrap();

    let modify = occurrences(&delta)
        .into_iter()
        .find(|o| matches!(o.kind, OccurrenceKind::Modify(_)))
        .expect("a moved instance");
    assert_eq!(modify.series_ref, "ev-retro");
    assert_eq!(modify.original_date, "2026-06-24T10:00:00");
    match modify.kind {
        OccurrenceKind::Modify(s) => assert_eq!(s.start, "2026-06-24T16:00:00"),
        _ => unreachable!(),
    }
}

// ─── stale token + targeted fetch ─────────────────────────────────────────────

#[tokio::test]
async fn a_gone_token_falls_back_to_a_full_enumerate() {
    let t = Replay::with(vec![(410, ""), (200, BACKFILL)]);
    let delta = sync_calendar(&t, CAL, Some(&SyncToken("STALE".into())))
        .await
        .unwrap();

    assert_eq!(t.call_count(), 2);
    assert!(
        t.query_of(1, "timeMin").is_some(),
        "the retry is a backfill"
    );
    assert_eq!(
        delta.next_token.as_ref().map(|t| t.0.as_str()),
        Some("TOKEN-1")
    );
    // Recovery carries both a fresh cursor and a full enumerate — a combination
    // `next_token.is_none()` alone couldn't detect.
    assert!(delta.full_enumerate);
}

#[tokio::test]
async fn fetch_one_resolves_an_orphan_master() {
    let t = Replay::ok(ORPHAN_MASTER);
    let ev = fetch_one(&t, CAL, "ev-standup").await.unwrap();

    assert_eq!(ev.core.ical_uid, "uid-standup@google.com");
    assert_eq!(ev.schedule.start, "2026-06-20T09:00:00");
    let rec = ev.recurrence.expect("the master is recurring");
    assert_eq!(rec.rrule, "FREQ=DAILY;COUNT=10");
    assert_eq!(rec.fidelity, OccurrenceFidelity::MasterOnly);
}

#[tokio::test]
async fn fetch_one_maps_404_to_not_found_so_the_engine_drops_the_orphan() {
    let t = Replay::with(vec![(404, "")]);
    let err = fetch_one(&t, CAL, "ev-gone").await.unwrap_err();

    assert!(matches!(err, GoogleError::NotFound));
}

#[tokio::test]
async fn a_user_supplied_calendar_id_is_percent_encoded_into_the_path() {
    let t = Replay::ok(BACKFILL);
    sync_calendar(&t, "team+odd id@group.calendar.google.com", None)
        .await
        .unwrap();

    let path = t.calls.borrow()[0].0.clone();
    assert_eq!(
        path,
        "/calendars/team%2Bodd%20id%40group.calendar.google.com/events"
    );
}

// ─── paging ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_series_split_across_pages_still_folds_into_one_bundle() {
    let t = Replay::with(vec![(200, PAGE_1), (200, PAGE_2)]);
    let delta = sync_calendar(&t, CAL, None).await.unwrap();

    assert_eq!(t.query_of(1, "pageToken").as_deref(), Some("PAGE-2"));
    assert_eq!(delta.upserts.len(), 1);
    let rec = event(&delta, "ev-series").recurrence.expect("series");
    assert_eq!(rec.overrides.len(), 1);
    assert_eq!(rec.overrides[0].original_date, "2026-06-08T09:00:00");
    assert_eq!(
        delta.next_token.as_ref().map(|t| t.0.as_str()),
        Some("TOKEN-PAGED")
    );
}

// ─── rate limiting ────────────────────────────────────────────────────────────

fn quota_error(reason: &str) -> String {
    format!(
        r#"{{"error":{{"code":403,"message":"blocked","errors":[{{"domain":"usageLimits","reason":"{reason}"}}]}}}}"#
    )
}

#[tokio::test]
async fn a_rate_limited_poll_backs_off_without_touching_the_cursor() {
    let body = quota_error("rateLimitExceeded");
    let t = Replay::with(vec![(403, &body)]);
    let err = sync_calendar(&t, CAL, Some(&SyncToken("TOKEN-1".into())))
        .await
        .unwrap_err();

    // RateLimited maps to AppError::Network → Offline: the cursor stays put and
    // the next poll retries. Reading it as a credential failure would flag the
    // account and force a re-authorization over a quota blip.
    assert!(matches!(err, GoogleError::RateLimited));
    assert!(matches!(
        pikos_db::error::AppError::from(err),
        pikos_db::error::AppError::Network(_)
    ));
}

#[tokio::test]
async fn a_429_is_a_rate_limit_without_reading_the_body() {
    let t = Replay::with(vec![(429, "")]);
    let err = sync_calendar(&t, CAL, None).await.unwrap_err();
    assert!(matches!(err, GoogleError::RateLimited));
}

#[tokio::test]
async fn a_permission_403_ends_the_sync_instead_of_backing_off() {
    let body = quota_error("insufficientPermissions");
    let t = Replay::with(vec![(403, &body)]);
    let err = sync_calendar(&t, CAL, None).await.unwrap_err();

    assert!(matches!(err, GoogleError::Revoked));
}

#[tokio::test]
async fn an_unreadable_403_backs_off_rather_than_demanding_a_reconnect() {
    let t = Replay::with(vec![(403, "<html>nope</html>")]);
    let err = sync_calendar(&t, CAL, None).await.unwrap_err();

    assert!(matches!(err, GoogleError::RateLimited));
}

// ─── calendar list ────────────────────────────────────────────────────────────

#[tokio::test]
async fn calendar_list_prefers_the_users_own_name_and_drops_removed_entries() {
    let t = Replay::ok(CALENDAR_LIST);
    let cals = list_calendars(&t).await.unwrap();

    assert_eq!(cals.len(), 2, "a deleted entry is not a syncable calendar");
    assert_eq!(cals[0].calendar_id, "alex@example.com");
    assert_eq!(cals[0].color.as_deref(), Some("#9fe1e7"));
    // summaryOverride is the user's own rename of a shared calendar.
    assert_eq!(cals[1].display_name, "Design Team");
}

#[tokio::test]
async fn the_primary_calendar_id_labels_the_account() {
    let t = Replay::ok(CALENDAR_LIST);
    let (_, primary) = list_calendars_for_connect(&t).await.unwrap();

    // This becomes the account's display_name, the key a reconnect matches a
    // dormant account by — get it wrong and reconnecting duplicates the account
    // instead of re-linking its detached pages.
    assert_eq!(primary, "alex@example.com");
}

const NO_PRIMARY: &str = r#"{
  "kind": "calendar#calendarList",
  "items": [
    {
      "kind": "calendar#calendarListEntry",
      "id": "team123@group.calendar.google.com",
      "summary": "Team Calendar",
      "accessRole": "reader"
    }
  ]
}"#;

// Not a cosmetic label — see `GoogleError::NoPrimaryCalendar`.
#[tokio::test]
async fn a_list_without_a_primary_refuses_the_connect() {
    let t = Replay::ok(NO_PRIMARY);
    let err = list_calendars_for_connect(&t).await.unwrap_err();

    assert!(matches!(err, GoogleError::NoPrimaryCalendar));
}

#[tokio::test]
async fn a_list_without_a_primary_still_enumerates_for_a_routine_sync() {
    let t = Replay::ok(NO_PRIMARY);
    let cals = list_calendars(&t).await.unwrap();

    assert_eq!(cals.len(), 1);
}
