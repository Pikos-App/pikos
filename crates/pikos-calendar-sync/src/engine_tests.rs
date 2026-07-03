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
    CalendarProvider, EventCore, EventSchedule, EventUpsert, OccurrenceDelta, OccurrenceKind,
    Recurrence, Removal, SyncDelta, SyncToken, UpsertItem,
};
use pikos_db::{insert_test_folder, insert_test_page, now_iso, test_pool, PageUpdate, TestPage};

use super::{sync_calendar, SyncOutcome};

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
}

// ─── builders ─────────────────────────────────────────────────────────────────

fn account() -> SyncAccountRow {
    SyncAccountRow {
        id: ACCOUNT.into(),
        provider: "caldav".into(),
        display_name: "Fastmail".into(),
        auth_kind: "basic".into(),
        created_at: now_iso(),
        updated_at: now_iso(),
    }
}

fn event(external_id: &str, uid: &str, etag: &str, title: &str) -> UpsertItem {
    UpsertItem::Event(EventUpsert {
        core: EventCore {
            external_id: external_id.into(),
            ical_uid: uid.into(),
            etag: Some(etag.into()),
            title: title.into(),
            description: None,
            location: None,
            attendees: vec![],
        },
        schedule: EventSchedule {
            start: "2026-06-20T09:00:00".into(),
            end: Some("2026-06-20T10:00:00".into()),
            timezone: Some("America/New_York".into()),
        },
        recurrence: None,
    })
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

fn delta(upserts: Vec<UpsertItem>, token: Option<&str>) -> SyncDelta {
    SyncDelta {
        upserts,
        removals: vec![],
        next_token: token.map(|t| SyncToken(t.into())),
        authoritative_from: None,
        unresolved_present: vec![],
    }
}

/// A full authoritative enumerate: no cursor, and `authoritative_from` set so the
/// engine sweeps stored pages absent from `upserts`.
fn full_enumerate(upserts: Vec<UpsertItem>, window_start: &str) -> SyncDelta {
    SyncDelta {
        upserts,
        removals: vec![],
        next_token: None,
        authoritative_from: Some(window_start.into()),
        unresolved_present: vec![],
    }
}

// ─── DB setup + queries ─────────────────────────────────────────────────────────

async fn seed(pool: &SqlitePool, sync_token: Option<&str>) {
    insert_test_folder(pool, FOLDER, "Work").await.unwrap();
    let now = now_iso();
    sqlx::query(
        "INSERT INTO sync_account (id, provider, display_name, auth_kind, created_at, updated_at)
         VALUES (?, 'caldav', 'Fastmail', 'basic', ?, ?)",
    )
    .bind(ACCOUNT)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO sync_calendar
         (id, account_id, calendar_id, display_name, color, enabled, sync_token, ctag,
          last_full_sync_at, last_synced_at, created_at, updated_at)
         VALUES (?, ?, ?, 'Work', NULL, 1, ?, NULL, NULL, NULL, ?, ?)",
    )
    .bind(CAL)
    .bind(ACCOUNT)
    .bind(CAL_ID)
    .bind(sync_token)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
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

async fn page_count(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM pages")
        .fetch_one(pool)
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
    assert_eq!(outcome, SyncOutcome::Synced { full_resync: false, changed: true });
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
    assert_eq!(outcome, SyncOutcome::Synced { full_resync: false, changed: true });
    assert_eq!(page_count(&pool).await, 1, "same event updates, never dupes");
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

    assert_eq!(outcome, SyncOutcome::Synced { full_resync: false, changed: false });
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
    let provider = Scripted::default()
        .with_sync(Ok(delta(vec![event("/e1.ics", "u1", "v1", "Lunch")], Some("t0"))));
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
    assert_eq!(outcome, SyncOutcome::Synced { full_resync: true, changed: false });
    assert_eq!(page_count(&pool).await, 1, "re-enumerate converges, no dupe");
    assert_eq!(stored_token(&pool).await.as_deref(), Some("t-new"));
    // Idempotency invariant: unchanged etag → no write, so the re-enumerate doesn't
    // churn updated_at and refloat the page as "recently edited".
    assert_eq!(
        page_updated_at(&pool).await,
        updated_before,
        "unchanged-etag re-sync must not touch updated_at"
    );
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
    assert_eq!(outcome, SyncOutcome::Synced { full_resync: false, changed: true });
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
    assert_eq!(outcome, SyncOutcome::Synced { full_resync: false, changed: false });
    assert_eq!(page_count(&pool).await, 0, "no synthesized page");
    assert_eq!(override_count(&pool, "2026-06-21T09:00:00").await, 0);
    assert_eq!(stored_token(&pool).await.as_deref(), Some("t1"));
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
        SyncOutcome::Synced { full_resync: false, changed: true }
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
    reconcile(pool, &ctx, &delta(vec![event("/e1.ics", "u1", "v1", "Title")], None))
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
        SyncOutcome::Synced { full_resync: false, changed: true }
    );
    assert_eq!(page_count(&pool).await, N as i64);
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

    assert_eq!(outcome, SyncOutcome::Synced { full_resync: false, changed: true });
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
    let provider = Scripted::default()
        .with_sync(Ok(delta(vec![event("/e1.ics", "u1", "v1", "Lunch")], Some("t1"))));
    run(&pool, &provider).await;
    assert_eq!(page_count(&pool).await, 1);

    let provider = Scripted::default().with_sync(Ok(SyncDelta {
        upserts: vec![],
        removals: vec![Removal { external_id: "/e1.ics".into() }],
        next_token: Some(SyncToken("t2".into())),
        authoritative_from: None,
        unresolved_present: vec![],
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
                dated_event("/live.ics", "live", "Team lunch", "2026-06-28T12:00:00", "2026-06-28T13:00:00"),
                dated_event("/old.ics", "old", "Q1 kickoff", "2026-05-01T09:00:00", "2026-05-01T10:00:00"),
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
    assert_eq!(outcome, SyncOutcome::Synced { full_resync: true, changed: true });
    assert_eq!(page_count(&pool).await, 1, "deleted event swept, pre-window kept");
    assert_eq!(sync_state_by_uid(&pool, "live").await, None, "deleted mirror gone");
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
            vec![dated_event("/mine.ics", "mine", "Planning", "2026-06-28T09:00:00", "2026-06-28T10:00:00")],
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
            vec![dated_event("/ev.ics", "ev", "Standup", "2026-06-28T09:00:00", "2026-06-28T10:00:00")],
            "2026-06-24",
        )))
        .with_bootstrap(SyncToken("tok-A".into()));
    run(&pool, &provider).await;
    assert_eq!(page_count(&pool).await, 1);

    // Re-enumerate: the event is still live but its body failed to parse, so it's
    // absent from upserts yet listed in unresolved_present.
    let mut enumerate = full_enumerate(vec![], "2026-06-24");
    enumerate.unresolved_present = vec!["/ev.ics".into()];
    let provider =
        Scripted::default().with_sync(Ok(enumerate)).with_bootstrap(SyncToken("tok-B".into()));
    let outcome = run(&pool, &provider).await;

    assert_eq!(page_count(&pool).await, 1, "unparseable-but-live event spared, not swept");
    assert_eq!(sync_state_by_uid(&pool, "ev").await.as_deref(), Some("active"), "mirror intact");
    assert_eq!(outcome, SyncOutcome::Synced { full_resync: true, changed: false });
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
                vec![dated_event("/e1.ics", "u1", "Lunch", "2026-06-28T12:00:00", "2026-06-28T13:00:00")],
                "2026-06-24",
            )))
            .with_bootstrap(SyncToken("tok".into()))
    };
    run(&pool, &enumerate()).await;

    let outcome = run(&pool, &enumerate()).await;
    assert_eq!(outcome, SyncOutcome::Synced { full_resync: true, changed: false });
    assert_eq!(page_count(&pool).await, 1, "no dupe, no churn");
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
    let path =
        std::env::temp_dir().join(format!("pikos-engine-{}-{n}.sqlite", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let pool = pikos_db::open_pool(path.to_str().unwrap())
        .await
        .expect("open wal test pool");
    TempDb { pool, path }
}
