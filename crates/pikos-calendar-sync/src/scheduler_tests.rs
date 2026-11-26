//! Scheduler tests: the trigger loop driven by a scripted
//! [`TriggerSource`] and a scripted provider against a temp SQLite DB.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;
use std::time::{Duration, Instant};

use sqlx::SqlitePool;

use pikos_db::error::{AppError, AppResult};
use pikos_db::sync::{SyncAccountRow, SyncCalendarRow};
use pikos_db::sync_delta::{
    CalendarProvider, EventUpsert, RemoteCalendar, SyncDelta, SyncToken, UpsertItem,
};
use pikos_db::test_pool;

use super::{run_sync_loop, SchedulerConfig, SyncTrigger, TriggerSource};
use crate::test_support::{self, page_count, seed_calendar, set_account_provider, CalSeed};

struct ScriptedTriggers(VecDeque<SyncTrigger>);

impl TriggerSource for ScriptedTriggers {
    async fn next(&mut self) -> Option<SyncTrigger> {
        self.0.pop_front()
    }
}

fn triggers(list: &[SyncTrigger]) -> ScriptedTriggers {
    ScriptedTriggers(list.iter().copied().collect())
}

/// Shared across the per-account instances the factory hands out, so a multi-pass
/// sequence stays deterministic although every pass builds a fresh provider.
#[derive(Clone, Default)]
struct Shared {
    sync: Rc<RefCell<VecDeque<AppResult<SyncDelta>>>>,
    calls: Rc<Cell<usize>>,
}

impl Shared {
    fn with_sync(self, d: AppResult<SyncDelta>) -> Self {
        self.sync.borrow_mut().push_back(d);
        self
    }
}

impl CalendarProvider for Shared {
    async fn list_calendars(&self, _account: &SyncAccountRow) -> AppResult<Vec<RemoteCalendar>> {
        Ok(vec![])
    }

    async fn sync(
        &self,
        _calendar: &SyncCalendarRow,
        _since: Option<SyncToken>,
    ) -> AppResult<SyncDelta> {
        self.calls.set(self.calls.get() + 1);
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
        unreachable!("no orphan masters scripted")
    }

    async fn current_sync_token(
        &self,
        _calendar: &SyncCalendarRow,
    ) -> AppResult<Option<SyncToken>> {
        Ok(None)
    }
}

fn event(external_id: &str, uid: &str) -> UpsertItem {
    test_support::event(external_id, uid, "v1", "Lunch")
}

fn delta(upserts: Vec<UpsertItem>) -> SyncDelta {
    test_support::delta(upserts, Some("t1"))
}

async fn seed_account(pool: &SqlitePool, account_id: &str, folder_id: &str) {
    seed_calendar(
        pool,
        CalSeed {
            account_id,
            cal_row_id: &format!("{account_id}-cal"),
            calendar_id: &format!("https://dav.example/{account_id}/"),
            display_name: "Cal",
            folder_id,
            folder_name: "Cal",
            link_folder: true,
            sync_token: None,
        },
    )
    .await;
}

async fn drive(
    pool: &SqlitePool,
    list: &[SyncTrigger],
    provider: &Shared,
    min_focus_gap: Duration,
) -> (usize, Vec<bool>, Vec<usize>) {
    let starts = Cell::new(0usize);
    let changed: RefCell<Vec<bool>> = RefCell::new(vec![]);
    let errors: RefCell<Vec<usize>> = RefCell::new(vec![]);
    run_sync_loop(
        triggers(list),
        || async { Some(pool.clone()) },
        |_account| provider.clone(),
        SchedulerConfig { min_focus_gap },
        || starts.set(starts.get() + 1),
        |report| {
            changed.borrow_mut().push(report.changed);
            errors.borrow_mut().push(report.errors.len());
        },
    )
    .await;
    (starts.get(), changed.into_inner(), errors.into_inner())
}

const GAP: Duration = Duration::from_secs(60);

#[tokio::test]
async fn interval_pass_applies_delta_and_reports_changed() {
    let pool = test_pool().await;
    seed_account(&pool, "acc1", "f1").await;

    let provider = Shared::default().with_sync(Ok(delta(vec![event("/e1.ics", "u1")])));
    let (starts, changed, errors) = drive(&pool, &[SyncTrigger::Interval], &provider, GAP).await;

    assert_eq!(starts, 1);
    assert_eq!(changed, vec![true]);
    assert_eq!(errors, vec![0]);
    assert_eq!(page_count(&pool).await, 1);
}

#[tokio::test]
async fn empty_poll_reports_unchanged() {
    let pool = test_pool().await;
    seed_account(&pool, "acc1", "f1").await;

    let provider = Shared::default().with_sync(Ok(delta(vec![])));
    let (_, changed, _) = drive(&pool, &[SyncTrigger::Interval], &provider, GAP).await;

    assert_eq!(changed, vec![false]);
}

/// Dropping a second focus trigger would leave a change made in the provider seconds
/// after a pass invisible until the next app switch or the five-minute poll.
#[tokio::test]
async fn focus_inside_the_gap_waits_instead_of_being_dropped() {
    const SHORT_GAP: Duration = Duration::from_millis(40);
    let pool = test_pool().await;
    seed_account(&pool, "acc1", "f1").await;

    let provider = Shared::default()
        .with_sync(Ok(delta(vec![])))
        .with_sync(Ok(delta(vec![])));
    let started = Instant::now();
    let (starts, ..) = drive(
        &pool,
        &[SyncTrigger::Focus, SyncTrigger::Focus],
        &provider,
        SHORT_GAP,
    )
    .await;

    assert_eq!(starts, 2, "the second focus still gets its pass");
    assert_eq!(provider.calls.get(), 2);
    assert!(
        started.elapsed() >= SHORT_GAP,
        "it waited the gap out rather than polling twice back to back"
    );
}

#[tokio::test]
async fn poke_bypasses_focus_gap() {
    let pool = test_pool().await;
    seed_account(&pool, "acc1", "f1").await;

    let provider = Shared::default()
        .with_sync(Ok(delta(vec![])))
        .with_sync(Ok(delta(vec![event("/e1.ics", "u1")])));
    let (starts, changed, _) = drive(
        &pool,
        &[SyncTrigger::Focus, SyncTrigger::Poke],
        &provider,
        GAP,
    )
    .await;

    assert_eq!(starts, 2);
    assert_eq!(changed, vec![false, true]);
}

#[tokio::test]
async fn interval_bypasses_focus_gap() {
    let pool = test_pool().await;
    seed_account(&pool, "acc1", "f1").await;

    let provider = Shared::default()
        .with_sync(Ok(delta(vec![])))
        .with_sync(Ok(delta(vec![])));
    let (starts, ..) = drive(
        &pool,
        &[SyncTrigger::Focus, SyncTrigger::Interval],
        &provider,
        GAP,
    )
    .await;

    assert_eq!(starts, 2);
}

#[tokio::test]
async fn account_error_does_not_abort_pass() {
    let pool = test_pool().await;
    seed_account(&pool, "acc1", "f1").await;
    seed_account(&pool, "acc2", "f2").await;

    let failing = Shared::default().with_sync(Err(AppError::Internal("boom".into())));
    let healthy = Shared::default().with_sync(Ok(delta(vec![event("/e1.ics", "u1")])));

    let changed = RefCell::new(vec![]);
    let errors = RefCell::new(vec![]);
    run_sync_loop(
        triggers(&[SyncTrigger::Interval]),
        || async { Some(pool.clone()) },
        |account: &SyncAccountRow| {
            if account.id == "acc1" {
                failing.clone()
            } else {
                healthy.clone()
            }
        },
        SchedulerConfig { min_focus_gap: GAP },
        || {},
        |report| {
            changed.borrow_mut().push(report.changed);
            errors.borrow_mut().push(report.errors.len());
        },
    )
    .await;

    assert_eq!(
        changed.into_inner(),
        vec![true],
        "healthy account still syncs"
    );
    assert_eq!(errors.into_inner(), vec![1]);
    assert_eq!(healthy.calls.get(), 1);
    assert_eq!(page_count(&pool).await, 1);
}

async fn reconnect_needed(pool: &SqlitePool, account_id: &str) -> bool {
    sqlx::query_scalar("SELECT reconnect_needed FROM sync_account WHERE id = ?")
        .bind(account_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn reconnect_needed_account_is_skipped_until_manual_resync() {
    let pool = test_pool().await;
    seed_account(&pool, "acc1", "f1").await;

    // Pass 1: the app password is revoked → the engine maps it to ReconnectNeeded,
    // which flags the account (an outcome, not a reported error).
    let provider = Shared::default().with_sync(Err(AppError::Invalid("revoked".into())));
    let report = super::run_pass(&pool, &|_: &SyncAccountRow| provider.clone()).await;
    assert!(
        report.errors.is_empty(),
        "reconnect-needed is an outcome, not an error"
    );
    assert_eq!(provider.calls.get(), 1, "polled once");
    assert!(
        reconnect_needed(&pool, "acc1").await,
        "flagged after the rejection"
    );

    // Pass 2: the flagged account is skipped — no provider call (its scripted queue
    // is empty, so a stray poll would panic).
    super::run_pass(&pool, &|_: &SyncAccountRow| provider.clone()).await;
    assert_eq!(provider.calls.get(), 1, "flagged account not polled again");

    let good = Shared::default().with_sync(Ok(delta(vec![event("/e1.ics", "u1")])));
    crate::commands::resync_account(&pool, &good, "acc1")
        .await
        .unwrap();
    assert!(
        !reconnect_needed(&pool, "acc1").await,
        "a clean resync cleared the flag"
    );

    let provider = Shared::default().with_sync(Ok(delta(vec![])));
    super::run_pass(&pool, &|_: &SyncAccountRow| provider.clone()).await;
    assert_eq!(
        provider.calls.get(),
        1,
        "account polled again after reconnect"
    );
}

#[tokio::test]
async fn missing_pool_skips_pass() {
    let pool = test_pool().await;
    seed_account(&pool, "acc1", "f1").await;

    let provider = Shared::default().with_sync(Ok(delta(vec![event("/e1.ics", "u1")])));

    let starts = Cell::new(0usize);
    let pool_available = Cell::new(false);
    run_sync_loop(
        triggers(&[SyncTrigger::Interval, SyncTrigger::Interval]),
        || {
            let available = pool_available.replace(true);
            let pool = pool.clone();
            async move { available.then_some(pool) }
        },
        |_account| provider.clone(),
        SchedulerConfig { min_focus_gap: GAP },
        || starts.set(starts.get() + 1),
        |_| {},
    )
    .await;

    assert_eq!(
        starts.get(),
        1,
        "first trigger dropped, second runs once connected"
    );
    assert_eq!(page_count(&pool).await, 1);
}

/// A fixed `CaldavProvider` would speak CalDAV at Google.
#[tokio::test]
async fn every_account_is_polled_through_its_own_provider() {
    let pool = test_pool().await;
    seed_account(&pool, "a-dav", "f-dav").await;
    seed_account(&pool, "a-goog", "f-goog").await;
    set_account_provider(&pool, "a-goog", pikos_db::sync::PROVIDER_GOOGLE).await;

    let provider = Shared::default()
        .with_sync(Ok(delta(vec![event("/one.ics", "uid-1")])))
        .with_sync(Ok(delta(vec![event("/two.ics", "uid-2")])));
    let seen: RefCell<Vec<(String, String)>> = RefCell::new(vec![]);

    run_sync_loop(
        triggers(&[SyncTrigger::Interval]),
        || async { Some(pool.clone()) },
        |account| {
            seen.borrow_mut()
                .push((account.id.clone(), account.provider.clone()));
            provider.clone()
        },
        SchedulerConfig { min_focus_gap: GAP },
        || {},
        |_| {},
    )
    .await;

    let mut seen = seen.into_inner();
    seen.sort();
    assert_eq!(
        seen,
        vec![
            ("a-dav".to_string(), "caldav".to_string()),
            ("a-goog".to_string(), "google".to_string()),
        ]
    );
    assert_eq!(page_count(&pool).await, 2, "both accounts synced");
}

#[derive(Clone, Default)]
struct Counting(Rc<Cell<usize>>);

impl CalendarProvider for Counting {
    async fn list_calendars(&self, _account: &SyncAccountRow) -> AppResult<Vec<RemoteCalendar>> {
        self.0.set(self.0.get() + 1);
        Ok(vec![])
    }

    async fn sync(
        &self,
        _calendar: &SyncCalendarRow,
        _since: Option<SyncToken>,
    ) -> AppResult<SyncDelta> {
        self.0.set(self.0.get() + 1);
        Ok(delta(vec![]))
    }

    async fn fetch_event(
        &self,
        _calendar: &SyncCalendarRow,
        _event_ref: &str,
    ) -> AppResult<EventUpsert> {
        self.0.set(self.0.get() + 1);
        Err(AppError::NotFound("scripted".into()))
    }

    async fn current_sync_token(
        &self,
        _calendar: &SyncCalendarRow,
    ) -> AppResult<Option<SyncToken>> {
        self.0.set(self.0.get() + 1);
        Ok(None)
    }
}

// qa: PRIV-02
#[tokio::test]
async fn once_every_account_is_disconnected_polling_reaches_no_provider() {
    let pool = test_pool().await;
    seed_account(&pool, "a-dav", "f-dav").await;
    seed_account(&pool, "a-goog", "f-goog").await;
    set_account_provider(&pool, "a-goog", pikos_db::sync::PROVIDER_GOOGLE).await;
    for id in ["a-dav", "a-goog"] {
        crate::commands::disconnect_account(&pool, test_support::memory_keychain(), id)
            .await
            .unwrap();
    }
    let provider = Counting::default();

    run_sync_loop(
        triggers(&[SyncTrigger::Interval, SyncTrigger::Interval]),
        || async { Some(pool.clone()) },
        |_account| provider.clone(),
        SchedulerConfig { min_focus_gap: GAP },
        || {},
        |_| {},
    )
    .await;

    assert_eq!(
        provider.0.get(),
        0,
        "an idle poll after disconnect asked a provider for something"
    );
}
