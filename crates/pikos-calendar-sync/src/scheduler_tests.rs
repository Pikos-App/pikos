//! Layer-3 scheduler tests: the trigger loop driven by a scripted
//! [`TriggerSource`] and a scripted provider against a temp SQLite DB. Covers
//! the policy the scheduler owns — focus debounce, poke/interval bypass, the
//! changed-flag aggregation the reload signal hangs off, per-account error
//! isolation, and the no-pool skip.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;
use std::time::Duration;

use sqlx::SqlitePool;

use pikos_db::error::{AppError, AppResult};
use pikos_db::sync::{SyncAccountRow, SyncCalendarRow};
use pikos_db::sync_delta::{
    CalendarProvider, EventCore, EventSchedule, EventUpsert, RemoteCalendar, SyncDelta, SyncToken,
    UpsertItem,
};
use pikos_db::{insert_test_folder, now_iso, test_pool};

use super::{run_sync_loop, SchedulerConfig, SyncTrigger, TriggerSource};

// ─── scripted trigger source ────────────────────────────────────────────────────

struct ScriptedTriggers(VecDeque<SyncTrigger>);

impl TriggerSource for ScriptedTriggers {
    async fn next(&mut self) -> Option<SyncTrigger> {
        self.0.pop_front()
    }
}

fn triggers(list: &[SyncTrigger]) -> ScriptedTriggers {
    ScriptedTriggers(list.iter().copied().collect())
}

// ─── scripted provider ──────────────────────────────────────────────────────────

/// Scripted responses shared across the per-account instances the provider
/// factory hands out — each `sync` call pops the next queued response, so a
/// multi-pass sequence is deterministic even though every pass constructs a
/// fresh provider.
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

    async fn current_sync_token(&self, _calendar: &SyncCalendarRow) -> AppResult<Option<SyncToken>> {
        Ok(None)
    }
}

// ─── builders + seed ────────────────────────────────────────────────────────────

fn event(external_id: &str, uid: &str) -> UpsertItem {
    UpsertItem::Event(EventUpsert {
        core: EventCore {
            external_id: external_id.into(),
            ical_uid: uid.into(),
            etag: Some("v1".into()),
            title: "Lunch".into(),
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

fn delta(upserts: Vec<UpsertItem>) -> SyncDelta {
    SyncDelta {
        upserts,
        removals: vec![],
        next_token: Some(SyncToken("t1".into())),
    }
}

/// One account with one enabled, folder-linked calendar — the shape
/// `resync_account` polls.
async fn seed_account(pool: &SqlitePool, account_id: &str, folder_id: &str) {
    insert_test_folder(pool, folder_id, "Cal").await.unwrap();
    let now = now_iso();
    sqlx::query(
        "INSERT INTO sync_account (id, provider, display_name, auth_kind, created_at, updated_at)
         VALUES (?, 'caldav', 'Test', 'basic', ?, ?)",
    )
    .bind(account_id)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO sync_calendar
         (id, account_id, calendar_id, display_name, color, enabled, folder_id, sync_token,
          ctag, last_full_sync_at, last_synced_at, created_at, updated_at)
         VALUES (?, ?, ?, 'Cal', NULL, 1, ?, NULL, NULL, NULL, NULL, ?, ?)",
    )
    .bind(format!("{account_id}-cal"))
    .bind(account_id)
    .bind(format!("https://dav.example/{account_id}/"))
    .bind(folder_id)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
}

async fn page_count(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM pages")
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Drive the loop with a scripted trigger list and one shared provider; return
/// `(pass_starts, per-pass changed flags, per-pass error counts)`.
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

// ─── tests ──────────────────────────────────────────────────────────────────────

/// An interval trigger runs a pass end-to-end: the delta lands as a page and the
/// report carries `changed: true` (the driver's reload signal).
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

/// An empty poll — the common case every ~5 minutes — reports `changed: false`
/// so the driver doesn't reload the frontend for nothing.
#[tokio::test]
async fn empty_poll_reports_unchanged() {
    let pool = test_pool().await;
    seed_account(&pool, "acc1", "f1").await;

    let provider = Shared::default().with_sync(Ok(delta(vec![])));
    let (_, changed, _) = drive(&pool, &[SyncTrigger::Interval], &provider, GAP).await;

    assert_eq!(changed, vec![false]);
}

/// A second focus trigger inside `min_focus_gap` is skipped — alt-tabbing must
/// not hammer the provider.
#[tokio::test]
async fn focus_debounced_within_gap() {
    let pool = test_pool().await;
    seed_account(&pool, "acc1", "f1").await;

    let provider = Shared::default().with_sync(Ok(delta(vec![])));
    let (starts, ..) =
        drive(&pool, &[SyncTrigger::Focus, SyncTrigger::Focus], &provider, GAP).await;

    assert_eq!(starts, 1, "second focus inside the gap must be skipped");
    assert_eq!(provider.calls.get(), 1);
}

/// A poke (calendar just enabled) bypasses the focus gap — the newly-enabled
/// calendar needs its initial backfill immediately.
#[tokio::test]
async fn poke_bypasses_focus_gap() {
    let pool = test_pool().await;
    seed_account(&pool, "acc1", "f1").await;

    let provider = Shared::default()
        .with_sync(Ok(delta(vec![])))
        .with_sync(Ok(delta(vec![event("/e1.ics", "u1")])));
    let (starts, changed, _) =
        drive(&pool, &[SyncTrigger::Focus, SyncTrigger::Poke], &provider, GAP).await;

    assert_eq!(starts, 2);
    assert_eq!(changed, vec![false, true]);
}

/// Interval triggers are never debounced (the timer already paces them).
#[tokio::test]
async fn interval_bypasses_focus_gap() {
    let pool = test_pool().await;
    seed_account(&pool, "acc1", "f1").await;

    let provider = Shared::default()
        .with_sync(Ok(delta(vec![])))
        .with_sync(Ok(delta(vec![])));
    let (starts, ..) =
        drive(&pool, &[SyncTrigger::Focus, SyncTrigger::Interval], &provider, GAP).await;

    assert_eq!(starts, 2);
}

/// One account failing (a genuine `Err`, not an offline outcome) must not stop
/// the other account's poll — the error is reported, the pass continues.
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

    assert_eq!(changed.into_inner(), vec![true], "healthy account still syncs");
    assert_eq!(errors.into_inner(), vec![1]);
    assert_eq!(healthy.calls.get(), 1);
    assert_eq!(page_count(&pool).await, 1);
}

/// No pool (app not connected yet / mid workspace-switch) → the trigger is
/// dropped without a pass; the loop stays alive for the next trigger.
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

    assert_eq!(starts.get(), 1, "first trigger dropped, second runs once connected");
    assert_eq!(page_count(&pool).await, 1);
}
