//! Desktop driver for the calendar-sync scheduler: feeds the portable trigger
//! loop (`pikos_calendar_sync::run_sync_loop`) from a tokio interval, window
//! focus, and explicit pokes (calendar enable). The loop itself — debounce
//! policy, per-account passes, error isolation — lives in the crate behind the
//! `TriggerSource` seam; this file is only the platform half.

use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

use pikos_calendar_sync::{
    run_sync_loop, CaldavProvider, Keychain, PassReport, SchedulerConfig, SyncTrigger,
    TriggerSource,
};

use super::DbState;

/// Poll cadence while the app is open (spec: ~5 min; incremental tokens keep
/// each poll cheap).
const POLL_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// Watcher suppression stamped at pass start — generous so even a long initial
/// backfill stays covered; shortened to [`TRAILING_COVER`] once the pass ends.
const PASS_COVER: Duration = Duration::from_secs(10 * 60);
/// Covers the watcher's debounce tail after the pass's last write.
const TRAILING_COVER: Duration = Duration::from_secs(2);

/// Emitted after a background pass that changed page data; the frontend
/// listens and reloads (see `useSyncAppliedReload`).
const SYNC_APPLIED_EVENT: &str = "calendar-sync:applied";

/// Managed sender half of the trigger stream, so window focus and the
/// calendar-enable command can wake the loop.
pub struct SyncTriggerSender(mpsc::Sender<SyncTrigger>);

impl SyncTriggerSender {
    pub fn new() -> (Self, mpsc::Receiver<SyncTrigger>) {
        // A full buffer means a poll is already pending — dropping the extra
        // trigger is correct, so the tiny capacity + `try_send` suffice.
        let (tx, rx) = mpsc::channel(4);
        (Self(tx), rx)
    }

    fn send(&self, trigger: SyncTrigger) {
        let _ = self.0.try_send(trigger);
    }
}

/// Window gained focus → a (debounced) sync consideration.
pub fn on_focus(app: &AppHandle) {
    app.state::<SyncTriggerSender>().send(SyncTrigger::Focus);
}

/// A calendar was just enabled → immediate pass, so its initial backfill runs
/// without waiting for the interval or a manual resync.
pub fn poke(app: &AppHandle) {
    app.state::<SyncTriggerSender>().send(SyncTrigger::Poke);
}

struct DesktopTriggers {
    rx: mpsc::Receiver<SyncTrigger>,
    interval: tokio::time::Interval,
}

impl TriggerSource for DesktopTriggers {
    async fn next(&mut self) -> Option<SyncTrigger> {
        tokio::select! {
            _ = self.interval.tick() => Some(SyncTrigger::Interval),
            trigger = self.rx.recv() => trigger,
        }
    }
}

/// Main sync loop — spawned from `lib.rs` setup, runs for the app's lifetime.
pub async fn run(app: AppHandle, rx: mpsc::Receiver<SyncTrigger>) {
    // The frontend calls connect_db after mount — wait for the pool so the
    // interval's immediate first tick becomes the launch sync instead of a
    // dropped trigger.
    loop {
        if app.state::<DbState>().get_pool().await.is_ok() {
            break;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    log::info!("Calendar-sync scheduler started");

    let mut interval = tokio::time::interval(POLL_INTERVAL);
    // After a sleep/wake gap, run once and re-space — don't burst missed ticks.
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let pool_app = app.clone();
    run_sync_loop(
        DesktopTriggers { rx, interval },
        move || {
            let app = pool_app.clone();
            async move { app.state::<DbState>().get_pool().await.ok() }
        },
        // CalDAV is the only provider today; Google branches on
        // `account.provider` when it lands.
        |_account| CaldavProvider::new(Keychain::system()),
        SchedulerConfig::default(),
        || super::watch::suppress_for(PASS_COVER),
        move |report: &PassReport| {
            super::watch::suppress_for(TRAILING_COVER);
            for (account_id, e) in &report.errors {
                // Variant only — AppError's Display can echo SQL fragments or
                // user-derived values into the log.
                log::warn!(
                    "calendar_sync_pass_failed account={account_id} kind={}",
                    classify(e)
                );
            }
            if report.changed {
                log::info!("calendar_sync_applied_changes");
                let _ = app.emit(SYNC_APPLIED_EVENT, ());
            }
        },
    )
    .await;
}

fn classify(e: &pikos_db::error::AppError) -> &'static str {
    use pikos_db::error::AppError::*;
    match e {
        Db(_) => "db",
        NotFound(_) => "not_found",
        Conflict(_) => "conflict",
        Io(_) => "io",
        Serde(_) => "serde",
        Invalid(_) => "invalid",
        Network(_) => "network",
        Internal(_) => "internal",
    }
}
