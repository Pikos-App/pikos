//! Layer-3 sync-engine integration tests: the engine driven against a temp
//! SQLite DB and a scripted [`CalendarProvider`] (no network). Covers the
//! contract the engine owns on top of the reconciler — cursor storage, the
//! post-backfill token bootstrap, token-reject convergence, offline/reconnect
//! classification, orphan-master resolution (incl. the 404 drop), partial-failure
//! idempotency, reconciler-vs-editor write contention, and backfill throughput.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use sqlx::SqlitePool;

use pikos_db::error::{AppError, AppResult};
use pikos_db::reconciler::{reconcile, ReconcileContext};
use pikos_db::sync::{SyncAccountRow, SyncCalendarRow};
use pikos_db::sync_delta::{
    CalendarProvider, EventCore, EventSchedule, EventUpsert, OccurrenceDelta, OccurrenceFidelity,
    OccurrenceKind, Recurrence, Removal, SyncDelta, SyncToken, UpsertItem,
};
use pikos_db::{insert_test_page, now_iso, test_pool, PageUpdate, TestPage};

use super::{sync_calendar, SyncOutcome, FORCE_FULL_INTERVAL_HOURS};
use crate::test_support::{delta, event, page_count, seed_calendar, CalSeed};

const ACCOUNT: &str = "acc1";
const CAL: &str = "cal1";
const CAL_ID: &str = "https://dav.example/cal/";
const FOLDER: &str = "f1";

// ─── scripted provider ──────────────────────────────────────────────────────────

/// A `CalendarProvider` whose responses are scripted per test. Each method pops
/// its next queued response in call order, so a test drives a multi-poll sequence
/// deterministically. Single-task by construction (tests use `tokio::join!`, not
/// `spawn`), so the interior `RefCell`s never cross threads.
#[derive(Default)]
struct Scripted {
    sync: RefCell<VecDeque<AppResult<SyncDelta>>>,
    fetch: RefCell<VecDeque<AppResult<EventUpsert>>>,
    bootstrap: RefCell<VecDeque<AppResult<Option<SyncToken>>>>,
    ctag: RefCell<VecDeque<AppResult<Option<String>>>>,
    /// The `since` cursor each `sync` call received, for assertions.
    sync_since: RefCell<Vec<Option<SyncToken>>>,
}

impl Scripted {
    fn with_sync(self, d: AppResult<SyncDelta>) -> Self {
        self.sync.borrow_mut().push_back(d);
        self
    }
    fn with_fetch(self, e: AppResult<EventUpsert>) -> Self {
        self.fetch.borrow_mut().push_back(e);
        self
    }
    fn with_bootstrap(self, t: SyncToken) -> Self {
        self.bootstrap.borrow_mut().push_back(Ok(Some(t)));
        self
    }
    fn with_bootstrap_err(self) -> Self {
        self.bootstrap
            .borrow_mut()
            .push_back(Err(AppError::Internal("bootstrap down".into())));
        self
    }
    fn with_ctag(self, c: Option<&str>) -> Self {
        self.ctag.borrow_mut().push_back(Ok(c.map(String::from)));
        self
    }
    fn sync_calls(&self) -> usize {
        self.sync_since.borrow().len()
    }
}

impl CalendarProvider for Scripted {
    async fn list_calendars(
        &self,
        _account: &SyncAccountRow,
    ) -> AppResult<Vec<pikos_db::sync_delta::RemoteCalendar>> {
        Ok(vec![])
    }

    async fn sync(
        &self,
        _calendar: &SyncCalendarRow,
        since: Option<SyncToken>,
    ) -> AppResult<SyncDelta> {
        self.sync_since.borrow_mut().push(since);
        self.sync
            .borrow_mut()
            .pop_front()
            .expect("scripted sync response")
    }

    async fn fetch_event(
        &self,
        _calendar: &SyncCalendarRow,
        _event_ref: &str,
    ) -> AppResult<EventUpsert> {
        self.fetch
            .borrow_mut()
            .pop_front()
            .expect("scripted fetch response")
    }

    async fn current_sync_token(
        &self,
        _calendar: &SyncCalendarRow,
    ) -> AppResult<Option<SyncToken>> {
        self.bootstrap.borrow_mut().pop_front().unwrap_or(Ok(None))
    }

    async fn current_ctag(&self, _calendar: &SyncCalendarRow) -> AppResult<Option<String>> {
        self.ctag.borrow_mut().pop_front().unwrap_or(Ok(None))
    }
}

// ─── builders ─────────────────────────────────────────────────────────────────

fn account() -> SyncAccountRow {
    SyncAccountRow {
        id: ACCOUNT.into(),
        provider: "caldav".into(),
        display_name: "Fastmail".into(),
        auth_kind: "basic".into(),
        reconnect_needed: false,
        created_at: now_iso(),
        updated_at: now_iso(),
    }
}

/// A single non-recurring event at an explicit date, for the full-enumerate sweep
/// (a pre-window event's occurrence precedes the query window).
fn dated_event(external_id: &str, uid: &str, title: &str, start: &str, end: &str) -> UpsertItem {
    UpsertItem::Event(EventUpsert {
        core: EventCore {
            external_id: external_id.into(),
            ical_uid: uid.into(),
            etag: Some("v1".into()),
            title: title.into(),
            description: None,
            location: None,
            attendees: vec![],
        },
        schedule: EventSchedule {
            start: start.into(),
            end: Some(end.into()),
            timezone: Some("America/New_York".into()),
        },
        recurrence: None,
    })
}

/// A recurring master, returned by a scripted `fetch_event` to resolve an orphan.
fn master(external_id: &str, uid: &str) -> EventUpsert {
    EventUpsert {
        core: EventCore {
            external_id: external_id.into(),
            ical_uid: uid.into(),
            etag: Some("m-etag".into()),
            title: "Standup".into(),
            description: None,
            location: None,
            attendees: vec![],
        },
        schedule: EventSchedule {
            start: "2026-06-20T09:00:00".into(),
            end: Some("2026-06-20T09:15:00".into()),
            timezone: Some("America/New_York".into()),
        },
        recurrence: Some(Recurrence {
            fidelity: OccurrenceFidelity::Complete,
            rrule: "FREQ=DAILY;COUNT=5".into(),
            exdates: vec![],
            overrides: vec![],
        }),
    }
}

/// A lone modified occurrence whose master is absent from the delta.
fn orphan_occurrence(uid: &str, series_ref: &str) -> UpsertItem {
    UpsertItem::Occurrence(OccurrenceDelta {
        ical_uid: uid.into(),
        series_ref: series_ref.into(),
        original_date: "2026-06-21T09:00:00".into(),
        kind: OccurrenceKind::Modify(EventSchedule {
            start: "2026-06-21T11:00:00".into(),
            end: Some("2026-06-21T11:15:00".into()),
            timezone: Some("America/New_York".into()),
        }),
    })
}

/// A full authoritative enumerate: no cursor, `full_enumerate` set (drives the
/// `full_resync` signal + `last_full_sync_at` stamp), and `authoritative_from` set
/// so the engine sweeps stored pages absent from `upserts`.
fn full_enumerate(upserts: Vec<UpsertItem>, window_start: &str) -> SyncDelta {
    SyncDelta {
        upserts,
        authoritative_from: Some(window_start.into()),
        full_enumerate: true,
        ..Default::default()
    }
}

// ─── DB setup + queries ─────────────────────────────────────────────────────────

/// `link_folder: false` asserts the engine uses its `FOLDER` argument, not the
/// stored calendar link the scheduler polls by.
async fn seed(pool: &SqlitePool, sync_token: Option<&str>) {
    seed_calendar(
        pool,
        CalSeed {
            account_id: ACCOUNT,
            cal_row_id: CAL,
            calendar_id: CAL_ID,
            display_name: "Work",
            folder_id: FOLDER,
            folder_name: "Work",
            link_folder: false,
            sync_token,
        },
    )
    .await;
}

async fn calendar(pool: &SqlitePool) -> SyncCalendarRow {
    sqlx::query_as::<_, SyncCalendarRow>("SELECT * FROM sync_calendar WHERE id = ?")
        .bind(CAL)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn run(pool: &SqlitePool, provider: &Scripted) -> SyncOutcome {
    let cal = calendar(pool).await;
    sync_calendar(pool, provider, &account(), &cal, FOLDER)
        .await
        .unwrap()
}

async fn override_count(pool: &SqlitePool, original_date: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM page_schedules WHERE original_date = ?")
        .bind(original_date)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn sync_state_by_uid(pool: &SqlitePool, uid: &str) -> Option<String> {
    sqlx::query_scalar("SELECT sync_state FROM page_sync WHERE ical_uid = ?")
        .bind(uid)
        .fetch_optional(pool)
        .await
        .unwrap()
}

async fn stored_token(pool: &SqlitePool) -> Option<String> {
    sqlx::query_scalar("SELECT sync_token FROM sync_calendar WHERE id = ?")
        .bind(CAL)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn stored_ctag(pool: &SqlitePool) -> Option<String> {
    sqlx::query_scalar("SELECT ctag FROM sync_calendar WHERE id = ?")
        .bind(CAL)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Seed a token-less calendar into the ctag-skip precondition: a stored ctag and a
/// `last_full_sync_at` `hours_ago` in the past (so a test can put the periodic
/// re-enumerate in or out of its window).
async fn set_ctag_state(pool: &SqlitePool, ctag: &str, hours_ago: i64) {
    let last_full = (chrono::Utc::now() - chrono::Duration::hours(hours_ago))
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    sqlx::query("UPDATE sync_calendar SET ctag = ?, last_full_sync_at = ? WHERE id = ?")
        .bind(ctag)
        .bind(&last_full)
        .bind(CAL)
        .execute(pool)
        .await
        .unwrap();
}

async fn page_updated_at(pool: &SqlitePool) -> String {
    sqlx::query_scalar("SELECT updated_at FROM pages LIMIT 1")
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn last_synced(pool: &SqlitePool) -> Option<String> {
    sqlx::query_scalar("SELECT last_synced_at FROM sync_calendar WHERE id = ?")
        .bind(CAL)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn stored_full_sync_at(pool: &SqlitePool) -> Option<String> {
    sqlx::query_scalar("SELECT last_full_sync_at FROM sync_calendar WHERE id = ?")
        .bind(CAL)
        .fetch_one(pool)
        .await
        .unwrap()
}

// ─── tests ──────────────────────────────────────────────────────────────────────

/// Initial backfill carries no cursor → the engine bootstraps one via
/// `current_sync_token` and stamps both freshness clocks. A following incremental
/// delta applies its change and stores its own `next_token`.
#[tokio::test]
async fn incremental_loop_stores_cursor() {
    let pool = test_pool().await;
    seed(&pool, None).await;

    let provider = Scripted::default()
        .with_sync(Ok(delta(vec![event("/e1.ics", "u1", "v1", "Lunch")], None)))
        .with_bootstrap(SyncToken("tok-A".into()));

    let outcome = run(&pool, &provider).await;
    assert_eq!(
        outcome,
        SyncOutcome::Synced {
            full_resync: false,
            changed: true
        }
    );
    assert_eq!(page_count(&pool).await, 1);
    assert_eq!(stored_token(&pool).await.as_deref(), Some("tok-A"));
    assert!(last_synced(&pool).await.is_some());
    // First backfill was driven from no cursor.
    assert_eq!(provider.sync_since.borrow()[0], None);

    // Incremental poll: change title, carry next_token directly.
    let provider = Scripted::default().with_sync(Ok(delta(
        vec![event("/e1.ics", "u1", "v2", "Lunch w/ Sam")],
        Some("tok-B"),
    )));
    let outcome = run(&pool, &provider).await;
    assert_eq!(
        outcome,
        SyncOutcome::Synced {
            full_resync: false,
            changed: true
        }
    );
    assert_eq!(
        page_count(&pool).await,
        1,
        "same event updates, never dupes"
    );
    assert_eq!(stored_token(&pool).await.as_deref(), Some("tok-B"));
    // The incremental sync was driven from the bootstrapped cursor.
    assert_eq!(
        provider.sync_since.borrow()[0],
        Some(SyncToken("tok-A".into()))
    );
}

/// An empty incremental delta — the common every-poll case — reports
/// `changed: false` so the scheduler doesn't signal a UI reload, while still
/// advancing the cursor and stamping freshness.
#[tokio::test]
async fn empty_incremental_delta_reports_unchanged() {
    let pool = test_pool().await;
    seed(&pool, Some("t0")).await;

    let provider = Scripted::default().with_sync(Ok(delta(vec![], Some("t1"))));
    let outcome = run(&pool, &provider).await;

    assert_eq!(
        outcome,
        SyncOutcome::Synced {
            full_resync: false,
            changed: false
        }
    );
    assert_eq!(stored_token(&pool).await.as_deref(), Some("t1"));
    assert!(last_synced(&pool).await.is_some());
}

/// A stored cursor that the provider self-heals into a full re-enumerate (no
/// `next_token`) → `full_resync`, a fresh bootstrapped cursor, and convergence
/// with no duplicate pages.
#[tokio::test]
async fn token_reject_full_resync_converges() {
    let pool = test_pool().await;
    seed(&pool, Some("stale")).await;
    // Prime an existing page so the re-enumerate must converge, not duplicate.
    let provider = Scripted::default().with_sync(Ok(delta(
        vec![event("/e1.ics", "u1", "v1", "Lunch")],
        Some("t0"),
    )));
    run(&pool, &provider).await;
    assert_eq!(page_count(&pool).await, 1);
    let updated_before = page_updated_at(&pool).await;

    // Now the stored cursor is rejected; provider returns a backfill (no token)
    // carrying the SAME event etag.
    let provider = Scripted::default()
        .with_sync(Ok(delta(vec![event("/e1.ics", "u1", "v1", "Lunch")], None)))
        .with_bootstrap(SyncToken("t-new".into()));
    let outcome = run(&pool, &provider).await;

    // Every etag no-ops, so the re-enumerate applied zero writes → `changed:false`,
    // even though the delta carried an item. No spurious frontend reload each poll.
    assert_eq!(
        outcome,
        SyncOutcome::Synced {
            full_resync: true,
            changed: false
        }
    );
    assert_eq!(
        page_count(&pool).await,
        1,
        "re-enumerate converges, no dupe"
    );
    assert_eq!(stored_token(&pool).await.as_deref(), Some("t-new"));
    // Idempotency invariant: unchanged etag → no write, so the re-enumerate doesn't
    // churn updated_at and refloat the page as "recently edited".
    assert_eq!(
        page_updated_at(&pool).await,
        updated_before,
        "unchanged-etag re-sync must not touch updated_at"
    );
}

/// Google's `410 Gone` recovery re-enumerates the whole window but — unlike CalDAV
/// — its backfill hands back a fresh `nextSyncToken`. Deriving "was this full" from
/// the cursor (`next_token.is_none()`) mislabeled it incremental: `full_resync`
/// read false and `last_full_sync_at` never got stamped. The explicit
/// `full_enumerate` marker fixes both, and the cursor still comes from the delta —
/// no bootstrap call, since Google already returned one.
#[tokio::test]
async fn full_enumerate_carrying_a_cursor_labels_full_resync_and_stamps() {
    let pool = test_pool().await;
    seed(&pool, Some("stale")).await; // a stored cursor the 410 rejected upstream

    let recovery = SyncDelta {
        upserts: vec![event("g-ev-1", "u1", "v1", "Standup")],
        next_token: Some(SyncToken("healed".into())),
        full_enumerate: true,
        ..Default::default()
    };
    let provider = Scripted::default().with_sync(Ok(recovery));
    let outcome = run(&pool, &provider).await;

    assert_eq!(
        outcome,
        SyncOutcome::Synced {
            full_resync: true,
            changed: true,
        },
        "a full enumerate off a stored cursor is a re-sync, even carrying a token",
    );
    assert_eq!(
        stored_token(&pool).await.as_deref(),
        Some("healed"),
        "cursor taken from the delta itself — no bootstrap, unlike CalDAV",
    );
    assert!(
        stored_full_sync_at(&pool).await.is_some(),
        "last_full_sync_at stamped on the full enumerate (was NULL before)",
    );
    assert_eq!(provider.sync_calls(), 1);
}

/// A transport failure is not an error — it surfaces as `Offline`, leaves the
/// cursor untouched, and doesn't stamp the freshness clock.
#[tokio::test]
async fn offline_keeps_cursor() {
    let pool = test_pool().await;
    seed(&pool, Some("keep-me")).await;

    let provider = Scripted::default().with_sync(Err(AppError::Network("dns".into())));
    let outcome = run(&pool, &provider).await;

    assert_eq!(outcome, SyncOutcome::Offline);
    assert_eq!(stored_token(&pool).await.as_deref(), Some("keep-me"));
    assert!(last_synced(&pool).await.is_none());
}

/// A credential failure maps to `ReconnectNeeded` (CalDAV flattens keychain-miss
/// and 401/403 to `AppError::Invalid`).
#[tokio::test]
async fn reconnect_needed_on_invalid() {
    let pool = test_pool().await;
    seed(&pool, None).await;

    let provider =
        Scripted::default().with_sync(Err(AppError::Invalid("credentials missing".into())));
    assert_eq!(run(&pool, &provider).await, SyncOutcome::ReconnectNeeded);
}

/// A reconnect-needed poll must not touch the stored cursor — the next sync after
/// the user re-auths resumes incrementally instead of a full re-enumerate.
#[tokio::test]
async fn reconnect_needed_preserves_the_cursor() {
    let pool = test_pool().await;
    seed(&pool, Some("t-keep")).await;

    let provider = Scripted::default().with_sync(Err(AppError::Invalid("creds".into())));
    assert_eq!(run(&pool, &provider).await, SyncOutcome::ReconnectNeeded);
    assert_eq!(
        stored_token(&pool).await.as_deref(),
        Some("t-keep"),
        "cursor preserved"
    );
}

/// A full backfill (no delta token) bootstraps the incremental cursor afterward. If
/// that bootstrap REPORT fails, the sync still succeeds with the events committed —
/// the cursor just stays null, so the next poll re-enumerates. Best-effort, never wrong.
#[tokio::test]
async fn post_backfill_bootstrap_token_failure_leaves_cursor_null() {
    let pool = test_pool().await;
    seed(&pool, None).await;

    let provider = Scripted::default()
        .with_sync(Ok(delta(vec![event("/e1.ics", "u1", "v1", "Lunch")], None)))
        .with_bootstrap_err();

    let outcome = run(&pool, &provider).await;
    assert_eq!(
        outcome,
        SyncOutcome::Synced {
            full_resync: false,
            changed: true
        }
    );
    assert_eq!(page_count(&pool).await, 1, "the backfill still committed");
    assert_eq!(
        stored_token(&pool).await,
        None,
        "failed bootstrap → cursor null → re-enumerate next poll"
    );
}

/// An occurrence delta with no stored master triggers a targeted `fetch_event`;
/// the master is applied first, then the override lands.
#[tokio::test]
async fn orphan_master_fetched_and_applied() {
    let pool = test_pool().await;
    seed(&pool, None).await;

    let provider = Scripted::default()
        .with_sync(Ok(delta(
            vec![orphan_occurrence("u-series", "series-ref-1")],
            Some("t1"),
        )))
        .with_fetch(Ok(master("/series.ics", "u-series")));

    let outcome = run(&pool, &provider).await;
    assert_eq!(
        outcome,
        SyncOutcome::Synced {
            full_resync: false,
            changed: true
        }
    );
    assert_eq!(page_count(&pool).await, 1, "the series master page");
    assert_eq!(override_count(&pool, "2026-06-21T09:00:00").await, 1);
    assert_eq!(stored_token(&pool).await.as_deref(), Some("t1"));
}

/// A `404` from the orphan fetch means the master is gone: drop the occurrence
/// delta, create nothing, and still advance the cursor (terminal, not transient).
#[tokio::test]
async fn orphan_master_404_dropped() {
    let pool = test_pool().await;
    seed(&pool, None).await;

    let provider = Scripted::default()
        .with_sync(Ok(delta(
            vec![orphan_occurrence("u-series", "series-ref-1")],
            Some("t1"),
        )))
        .with_fetch(Err(AppError::NotFound("gone".into())));

    let outcome = run(&pool, &provider).await;
    // The orphan was dropped and nothing else applied → no real write → unchanged.
    assert_eq!(
        outcome,
        SyncOutcome::Synced {
            full_resync: false,
            changed: false
        }
    );
    assert_eq!(page_count(&pool).await, 0, "no synthesized page");
    assert_eq!(override_count(&pool, "2026-06-21T09:00:00").await, 0);
    assert_eq!(stored_token(&pool).await.as_deref(), Some("t1"));
}

/// A full authoritative enumerate carrying a lone occurrence (master absent)
/// fetches the master to resolve it — and the sweep must spare that just-created
/// master, not detach/delete it in the same pass. Arms for Google, which
/// emits lone occurrences in a full enumerate; CalDAV never does today.
#[tokio::test]
async fn full_enumerate_spares_a_resolved_orphan_master_from_the_sweep() {
    let pool = test_pool().await;
    seed(&pool, None).await;

    let provider = Scripted::default()
        .with_sync(Ok(full_enumerate(
            vec![orphan_occurrence("u-series", "series-ref-1")],
            "2026-06-15",
        )))
        .with_fetch(Ok(master("/series.ics", "u-series")))
        .with_bootstrap(SyncToken("tok".into()));

    let outcome = run(&pool, &provider).await;

    assert_eq!(
        outcome,
        SyncOutcome::Synced {
            full_resync: false,
            changed: true
        }
    );
    assert_eq!(
        page_count(&pool).await,
        1,
        "the fetched master survives its own pass"
    );
    assert_eq!(
        sync_state_by_uid(&pool, "u-series").await.as_deref(),
        Some("active"),
        "resolved master not swept",
    );
    assert_eq!(
        override_count(&pool, "2026-06-21T09:00:00").await,
        1,
        "the override landed"
    );
}

/// A transient orphan-fetch failure must not advance the cursor; the next poll
/// re-delivers the same delta and converges, with no duplicate of the event that
/// did commit on the first pass.
#[tokio::test]
async fn partial_failure_is_idempotent() {
    let pool = test_pool().await;
    seed(&pool, Some("t0")).await;

    let batch = || {
        delta(
            vec![
                event("/e1.ics", "u1", "v1", "Lunch"),
                orphan_occurrence("u-series", "series-ref-1"),
            ],
            Some("t1"),
        )
    };

    // Run 1: the plain event commits, the orphan fetch fails transiently.
    let provider = Scripted::default()
        .with_sync(Ok(batch()))
        .with_fetch(Err(AppError::Network("timeout".into())));
    assert_eq!(run(&pool, &provider).await, SyncOutcome::Offline);
    assert_eq!(page_count(&pool).await, 1, "plain event committed");
    assert_eq!(
        stored_token(&pool).await.as_deref(),
        Some("t0"),
        "cursor not advanced on partial failure"
    );

    // Run 2: same delta re-delivered, fetch now succeeds.
    let provider = Scripted::default()
        .with_sync(Ok(batch()))
        .with_fetch(Ok(master("/series.ics", "u-series")));
    assert_eq!(
        run(&pool, &provider).await,
        SyncOutcome::Synced {
            full_resync: false,
            changed: true
        }
    );
    assert_eq!(
        page_count(&pool).await,
        2,
        "event re-applied (no dupe) + series master"
    );
    assert_eq!(override_count(&pool, "2026-06-21T09:00:00").await, 1);
    assert_eq!(stored_token(&pool).await.as_deref(), Some("t1"));
}

/// A reconciler mirror-write and a user editor-write hitting the DB concurrently
/// both land with no `SQLITE_BUSY` surfaced — exercised on a real multi-connection
/// WAL pool (the `:memory:` single-connection pool can't reproduce contention).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn write_contention_converges() {
    let db = wal_db().await;
    let pool = &db.pool;
    seed(pool, None).await;

    // Prime a synced page the user will edit while the reconciler re-mirrors it.
    let ctx = ReconcileContext {
        account_id: ACCOUNT.into(),
        calendar_id: CAL_ID.into(),
        provider: "caldav".into(),
        folder_id: FOLDER.into(),
    };
    reconcile(
        pool,
        &ctx,
        &delta(vec![event("/e1.ics", "u1", "v1", "Title")], None),
    )
    .await
    .unwrap();
    let page_id: String = sqlx::query_scalar("SELECT id FROM pages LIMIT 1")
        .fetch_one(pool)
        .await
        .unwrap();

    // Reconciler mirror-write (new etag → title update) races the user's body edit
    // on two real worker threads — the only setup that can actually surface the 517
    // (`SQLITE_BUSY_SNAPSHOT`) that one cooperative task can't.
    let mirror_pool = pool.clone();
    let mirror = tokio::spawn(async move {
        let d = delta(vec![event("/e1.ics", "u1", "v2", "New Title")], None);
        // Model the engine's retry-safe mirror write.
        pikos_db::tx::retry_on_busy(|| reconcile(&mirror_pool, &ctx, &d)).await
    });
    let edit_pool = pool.clone();
    let pid = page_id.clone();
    let edit = tokio::spawn(async move {
        pikos_db::update_page_impl(
            &edit_pool,
            pid,
            PageUpdate {
                content_text: Some("my notes".into()),
                ..Default::default()
            },
        )
        .await
    });
    let (mirror_res, edit_res) = tokio::join!(mirror, edit);
    mirror_res
        .unwrap()
        .expect("mirror write must not surface SQLITE_BUSY");
    edit_res
        .unwrap()
        .expect("editor write must not surface SQLITE_BUSY");

    // Both effects converge: the mirror title and the user's body coexist.
    let (title, body): (String, Option<String>) =
        sqlx::query_as("SELECT title, content_text FROM pages WHERE id = ?")
            .bind(&page_id)
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(title, "New Title");
    assert_eq!(body.as_deref(), Some("my notes"));
}

/// A one-off-heavy backfill (~5k events) ingests in one poll and creates every
/// page. Asserts completion + count; render stays windowed elsewhere, so only the
/// write path is exercised here.
#[tokio::test]
async fn backfill_throughput() {
    let pool = test_pool().await;
    seed(&pool, None).await;

    const N: usize = 5000;
    let upserts: Vec<UpsertItem> = (0..N)
        .map(|i| event(&format!("/e{i}.ics"), &format!("u{i}"), "v1", "Event"))
        .collect();

    let provider = Scripted::default()
        .with_sync(Ok(delta(upserts, None)))
        .with_bootstrap(SyncToken("done".into()));

    assert_eq!(
        run(&pool, &provider).await,
        SyncOutcome::Synced {
            full_resync: false,
            changed: true
        }
    );
    assert_eq!(page_count(&pool).await, N as i64);
}

/// The >200 tail sub-delta the only other large test skips. `backfill_throughput`
/// has 0 occurrences/removals so it hits `reconcile_batched`'s early return; a real
/// poll can deliver >200 mixed changes. Here the tail's orphan occurrence's master
/// sits in an EARLIER event batch (committed to the DB before the tail runs), so it
/// resolves from storage — no cross-delta missing-master fetch — and a removal in
/// the same tail detaches its owned page.
#[tokio::test]
async fn batched_tail_resolves_override_from_a_prior_batch_and_detaches_a_removal() {
    let pool = test_pool().await;
    seed(&pool, None).await;

    // A pre-existing owned page the big delta removes → detach, not hard-delete.
    let provider = Scripted::default().with_sync(Ok(delta(
        vec![event("/rm.ics", "u-rm", "v1", "Old")],
        Some("t1"),
    )));
    run(&pool, &provider).await;
    sqlx::query("UPDATE page_sync SET user_modified = 1 WHERE ical_uid = 'u-rm'")
        .execute(&pool)
        .await
        .unwrap();

    // 251 upserts (> RECONCILE_BATCH) = 249 plain events + the recurring master the
    // tail's occurrence references + that orphan occurrence; plus one removal. The
    // master lands in the second event batch, before the occurrence+removal tail.
    const N: usize = 249;
    let mut upserts: Vec<UpsertItem> = (0..N)
        .map(|i| event(&format!("/e{i}.ics"), &format!("u{i}"), "v1", "Event"))
        .collect();
    upserts.push(UpsertItem::Event(master("/series.ics", "u-series")));
    upserts.push(orphan_occurrence("u-series", "series-ref-1"));

    // A scripted fetch that MUST go unconsumed: consuming it would mean the tail
    // couldn't see the just-committed master and fell back to a targeted re-fetch.
    let provider = Scripted::default()
        .with_sync(Ok(SyncDelta {
            upserts,
            removals: vec![Removal {
                external_id: "/rm.ics".into(),
            }],
            next_token: Some(SyncToken("t2".into())),
            ..Default::default()
        }))
        .with_fetch(Ok(master("/UNEXPECTED.ics", "u-series")));

    let outcome = run(&pool, &provider).await;
    assert_eq!(
        outcome,
        SyncOutcome::Synced {
            full_resync: false,
            changed: true
        }
    );

    assert_eq!(
        provider.fetch.borrow().len(),
        1,
        "no missing-master fetch fired"
    );
    assert_eq!(
        override_count(&pool, "2026-06-21T09:00:00").await,
        1,
        "override resolved against the in-delta master"
    );
    assert_eq!(
        sync_state_by_uid(&pool, "u-rm").await.as_deref(),
        Some("detached"),
        "owned page removed in the tail detached, not deleted",
    );
    // 249 plain + 1 master + 1 detached-but-kept owned page.
    assert_eq!(page_count(&pool).await, N as i64 + 2);
}

/// A large backfill commits in batches, so a user edit issued mid-ingest slips
/// between batches instead of waiting for the whole backfill. On a real WAL pool,
/// race the backfill against one edit and assert the edit lands well inside the
/// backfill's window — a single-transaction backfill would make it wait for the
/// entire ingest. The property is temporal, so this asserts a ratio with a wide
/// margin (the edit waits at most one ~200-row batch out of ~20).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn backfill_does_not_block_interactive_writes() {
    let db = wal_db().await;
    let pool = &db.pool;
    seed(pool, None).await;

    // A page the user edits while the backfill runs.
    insert_test_page(
        pool,
        TestPage {
            folder_id: Some(FOLDER),
            ..TestPage::new("p-edit", "Note")
        },
    )
    .await
    .unwrap();

    const N: usize = 4000;
    let upserts: Vec<UpsertItem> = (0..N)
        .map(|i| event(&format!("/e{i}.ics"), &format!("u{i}"), "v1", "Event"))
        .collect();
    let provider = Scripted::default()
        .with_sync(Ok(delta(upserts, None)))
        .with_bootstrap(SyncToken("done".into()));

    let cal = calendar(pool).await;
    let acct = account();

    let mut edit_elapsed = std::time::Duration::ZERO;
    let started = std::time::Instant::now();
    let backfill = async {
        sync_calendar(pool, &provider, &acct, &cal, FOLDER)
            .await
            .unwrap()
    };
    let edit = async {
        // Let the backfill grab the write lock first, then time one edit.
        tokio::task::yield_now().await;
        let t = std::time::Instant::now();
        pikos_db::update_page_impl(
            pool,
            "p-edit".into(),
            PageUpdate {
                content_text: Some("edited mid-sync".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        edit_elapsed = t.elapsed();
    };
    let (outcome, ()) = tokio::join!(backfill, edit);
    let backfill_elapsed = started.elapsed();

    assert_eq!(
        outcome,
        SyncOutcome::Synced {
            full_resync: false,
            changed: true
        }
    );
    assert_eq!(page_count(pool).await, N as i64 + 1);
    assert!(
        edit_elapsed * 2 < backfill_elapsed,
        "edit {edit_elapsed:?} should land well inside backfill {backfill_elapsed:?}"
    );
}

// ─── removals ───────────────────────────────────────────────────────────────────

/// A removal in the delta runs through the lifecycle path (here: a bare mirror →
/// hard delete), confirming the engine carries removals through to the reconciler.
#[tokio::test]
async fn removal_flows_through() {
    let pool = test_pool().await;
    seed(&pool, None).await;
    let provider = Scripted::default().with_sync(Ok(delta(
        vec![event("/e1.ics", "u1", "v1", "Lunch")],
        Some("t1"),
    )));
    run(&pool, &provider).await;
    assert_eq!(page_count(&pool).await, 1);

    let provider = Scripted::default().with_sync(Ok(SyncDelta {
        removals: vec![Removal {
            external_id: "/e1.ics".into(),
        }],
        next_token: Some(SyncToken("t2".into())),
        ..Default::default()
    }));
    run(&pool, &provider).await;
    assert_eq!(page_count(&pool).await, 0, "bare mirror hard-deleted");
}

/// A backfill carries no per-event removals, so a stale-token gap (or a server
/// without `sync-collection`) would otherwise leave an upstream-deleted event as a
/// permanent ghost. The full-enumerate sweep closes that: an event absent from the
/// authoritative set is removed — but a pre-window event, legitimately outside the
/// time-bounded query, must survive.
#[tokio::test]
async fn full_resync_sweeps_deleted_but_spares_pre_window() {
    let pool = test_pool().await;
    seed(&pool, None).await;

    // Initial backfill: an in-window event that later vanishes upstream, plus a
    // pre-window event the query window (start 2026-06-24) never covers.
    let provider = Scripted::default()
        .with_sync(Ok(full_enumerate(
            vec![
                dated_event(
                    "/live.ics",
                    "live",
                    "Team lunch",
                    "2026-06-28T12:00:00",
                    "2026-06-28T13:00:00",
                ),
                dated_event(
                    "/old.ics",
                    "old",
                    "Q1 kickoff",
                    "2026-05-01T09:00:00",
                    "2026-05-01T10:00:00",
                ),
            ],
            "2026-06-24",
        )))
        .with_bootstrap(SyncToken("tok-A".into()));
    run(&pool, &provider).await;
    assert_eq!(page_count(&pool).await, 2);

    // Stale-token gap: the event was deleted upstream during the gap, so the
    // re-enumerate returns neither it (deleted) nor the pre-window event (out of
    // range). Only the deleted one should go.
    let provider = Scripted::default()
        .with_sync(Ok(full_enumerate(vec![], "2026-06-24")))
        .with_bootstrap(SyncToken("tok-B".into()));
    let outcome = run(&pool, &provider).await;

    // Sweep-only pass: no upserts, no explicit removals, yet a page was deleted →
    // `changed:true` so the scheduler emits the reload (else a ghost until an
    // unrelated resync).
    assert_eq!(
        outcome,
        SyncOutcome::Synced {
            full_resync: true,
            changed: true
        }
    );
    assert_eq!(
        page_count(&pool).await,
        1,
        "deleted event swept, pre-window kept"
    );
    assert_eq!(
        sync_state_by_uid(&pool, "live").await,
        None,
        "deleted mirror gone"
    );
    assert_eq!(
        sync_state_by_uid(&pool, "old").await.as_deref(),
        Some("active"),
        "pre-window event survives the sweep"
    );
}

/// The sweep runs the normal own-vs-delete lifecycle: an owned page (here
/// user-modified) detaches rather than hard-deletes, keeping its dormant identity
/// for a later resync re-link.
#[tokio::test]
async fn full_resync_sweep_detaches_owned_page() {
    let pool = test_pool().await;
    seed(&pool, None).await;

    let provider = Scripted::default()
        .with_sync(Ok(full_enumerate(
            vec![dated_event(
                "/mine.ics",
                "mine",
                "Planning",
                "2026-06-28T09:00:00",
                "2026-06-28T10:00:00",
            )],
            "2026-06-24",
        )))
        .with_bootstrap(SyncToken("tok-A".into()));
    run(&pool, &provider).await;
    sqlx::query("UPDATE page_sync SET user_modified = 1 WHERE ical_uid = 'mine'")
        .execute(&pool)
        .await
        .unwrap();

    // Deleted upstream; the re-enumerate no longer carries it.
    let provider = Scripted::default()
        .with_sync(Ok(full_enumerate(vec![], "2026-06-24")))
        .with_bootstrap(SyncToken("tok-B".into()));
    run(&pool, &provider).await;

    assert_eq!(page_count(&pool).await, 1, "owned page kept");
    assert_eq!(
        sync_state_by_uid(&pool, "mine").await.as_deref(),
        Some("detached"),
        "owned page detached, not deleted"
    );
}

/// R3: a resource present upstream but unparseable this pass (tracked in
/// `unresolved_present`) must survive the authoritative sweep — treating it as
/// absent would permanently delete a live event's mirror, since incremental sync
/// never re-delivers an unchanged event.
#[tokio::test]
async fn full_enumerate_spares_unresolved_pages_from_the_sweep() {
    let pool = test_pool().await;
    seed(&pool, None).await;

    let provider = Scripted::default()
        .with_sync(Ok(full_enumerate(
            vec![dated_event(
                "/ev.ics",
                "ev",
                "Standup",
                "2026-06-28T09:00:00",
                "2026-06-28T10:00:00",
            )],
            "2026-06-24",
        )))
        .with_bootstrap(SyncToken("tok-A".into()));
    run(&pool, &provider).await;
    assert_eq!(page_count(&pool).await, 1);

    // Re-enumerate: the event is still live but its body failed to parse, so it's
    // absent from upserts yet listed in unresolved_present.
    let mut enumerate = full_enumerate(vec![], "2026-06-24");
    enumerate.unresolved_present = vec!["/ev.ics".into()];
    let provider = Scripted::default()
        .with_sync(Ok(enumerate))
        .with_bootstrap(SyncToken("tok-B".into()));
    let outcome = run(&pool, &provider).await;

    assert_eq!(
        page_count(&pool).await,
        1,
        "unparseable-but-live event spared, not swept"
    );
    assert_eq!(
        sync_state_by_uid(&pool, "ev").await.as_deref(),
        Some("active"),
        "mirror intact"
    );
    assert_eq!(
        outcome,
        SyncOutcome::Synced {
            full_resync: true,
            changed: false
        }
    );
}

/// A full authoritative enumerate whose single event is unchanged (same etag) and
/// whose sweep removes nothing → zero real writes → `changed:false`. The delta is
/// non-empty, so the old delta-size heuristic would have fired a spurious reload
/// on this pass — every poll of a token-less server hits exactly this shape.
#[tokio::test]
async fn all_etag_noop_full_enumerate_reports_unchanged() {
    let pool = test_pool().await;
    seed(&pool, None).await;

    let enumerate = || {
        Scripted::default()
            .with_sync(Ok(full_enumerate(
                vec![dated_event(
                    "/e1.ics",
                    "u1",
                    "Lunch",
                    "2026-06-28T12:00:00",
                    "2026-06-28T13:00:00",
                )],
                "2026-06-24",
            )))
            .with_bootstrap(SyncToken("tok".into()))
    };
    run(&pool, &enumerate()).await;

    let outcome = run(&pool, &enumerate()).await;
    assert_eq!(
        outcome,
        SyncOutcome::Synced {
            full_resync: true,
            changed: false
        }
    );
    assert_eq!(page_count(&pool).await, 1, "no dupe, no churn");
}

// ─── ctag precheck (token-less servers) ─────────────────────────────────────────

#[tokio::test]
async fn unchanged_ctag_skips_the_enumerate() {
    let pool = test_pool().await;
    seed(&pool, None).await;
    set_ctag_state(&pool, "ctag-1", 0).await;

    // Same ctag + a recent full sync → nothing to do; sync() must not be called.
    let provider = Scripted::default().with_ctag(Some("ctag-1"));
    let outcome = run(&pool, &provider).await;

    assert_eq!(
        outcome,
        SyncOutcome::Synced {
            full_resync: false,
            changed: false
        }
    );
    assert_eq!(
        provider.sync_calls(),
        0,
        "an unchanged ctag must not enumerate"
    );
    assert_eq!(page_count(&pool).await, 0);
}

#[tokio::test]
async fn changed_ctag_enumerates_and_stores_the_new_ctag() {
    let pool = test_pool().await;
    seed(&pool, None).await;
    set_ctag_state(&pool, "ctag-1", 0).await;

    let provider = Scripted::default()
        .with_ctag(Some("ctag-2"))
        .with_sync(Ok(full_enumerate(
            vec![dated_event(
                "/e1.ics",
                "u1",
                "Lunch",
                "2026-06-28T12:00:00",
                "2026-06-28T13:00:00",
            )],
            "2026-06-24",
        )));
    let outcome = run(&pool, &provider).await;

    assert_eq!(
        outcome,
        SyncOutcome::Synced {
            full_resync: false,
            changed: true
        }
    );
    assert_eq!(provider.sync_calls(), 1, "a moved ctag must enumerate");
    assert_eq!(page_count(&pool).await, 1);
    assert_eq!(
        stored_ctag(&pool).await.as_deref(),
        Some("ctag-2"),
        "the new ctag is persisted"
    );
}

#[tokio::test]
async fn periodic_backstop_enumerates_despite_a_matching_ctag() {
    let pool = test_pool().await;
    seed(&pool, None).await;
    // Ctag matches, but the last full sync is older than the safety interval.
    set_ctag_state(&pool, "ctag-1", FORCE_FULL_INTERVAL_HOURS + 1).await;

    let provider = Scripted::default()
        .with_ctag(Some("ctag-1"))
        .with_sync(Ok(full_enumerate(vec![], "2026-06-24")));
    let outcome = run(&pool, &provider).await;

    assert_eq!(
        provider.sync_calls(),
        1,
        "an overdue full sync enumerates even on a matching ctag"
    );
    assert_eq!(
        outcome,
        SyncOutcome::Synced {
            full_resync: false,
            changed: false
        }
    );
}

#[tokio::test]
async fn first_poll_without_a_stored_ctag_enumerates_and_captures_it() {
    let pool = test_pool().await;
    seed(&pool, None).await; // ctag + last_full_sync_at both NULL

    let provider = Scripted::default()
        .with_ctag(Some("ctag-1"))
        .with_sync(Ok(full_enumerate(vec![], "2026-06-24")));
    run(&pool, &provider).await;

    assert_eq!(provider.sync_calls(), 1, "no stored ctag → must enumerate");
    assert_eq!(
        stored_ctag(&pool).await.as_deref(),
        Some("ctag-1"),
        "first ctag captured"
    );
}

// ─── temp WAL pool ──────────────────────────────────────────────────────────────

/// A real on-disk WAL pool (production pragmas, multiple connections) for the
/// contention test — the only place a `SQLITE_BUSY` can actually arise. The file
/// (+ `-wal`/`-shm`) is removed when the guard drops.
struct TempDb {
    pool: SqlitePool,
    path: PathBuf,
}

impl Drop for TempDb {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_file(self.path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(self.path.with_extension("sqlite-shm"));
    }
}

async fn wal_db() -> TempDb {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!("pikos-engine-{}-{n}.sqlite", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let pool = pikos_db::open_pool(path.to_str().unwrap())
        .await
        .expect("open wal test pool");
    TempDb { pool, path }
}
