//! The poll scheduler: turns platform triggers (window focus, interval timer,
//! explicit pokes) into sync passes over every account. The trigger stream is
//! behind [`TriggerSource`] — the platform seam the spec mandates (mirrors the
//! keychain's `CredentialStore`): the desktop driver feeds it focus events + a
//! tokio interval, while a mobile driver swaps in BGTaskScheduler/WorkManager
//! wakeups without touching this loop.
//!
//! The loop never dies on a failing pass: account-level errors are collected
//! into the [`PassReport`] for the driver to log, and transport/credential
//! failures are already non-error outcomes at the engine layer.

use std::time::{Duration, Instant};

use sqlx::SqlitePool;

use pikos_db::error::AppError;
use pikos_db::sync::SyncAccountRow;
use pikos_db::sync_delta::CalendarProvider;

use crate::commands::resync_account;

#[cfg(test)]
#[path = "scheduler_tests.rs"]
mod scheduler_tests;

/// Why the scheduler woke.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncTrigger {
    /// The app window gained focus. Debounced by [`SchedulerConfig::min_focus_gap`].
    Focus,
    /// The periodic timer fired.
    Interval,
    /// An explicit request — a calendar was just enabled and needs its initial
    /// backfill now. Never debounced.
    Poke,
}

/// The platform seam. `next` resolves when the platform wants a sync considered;
/// returning `None` ends the loop (trigger senders gone / platform shutdown).
#[allow(async_fn_in_trait)]
pub trait TriggerSource {
    async fn next(&mut self) -> Option<SyncTrigger>;
}

pub struct SchedulerConfig {
    /// A `Focus` trigger within this gap of the last completed pass is skipped —
    /// rapid app-switching must not hammer the providers. `Interval`/`Poke`
    /// always run.
    pub min_focus_gap: Duration,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            min_focus_gap: Duration::from_secs(60),
        }
    }
}

/// What one pass did, for the driver's reload signal + logging.
#[derive(Debug, Default)]
pub struct PassReport {
    /// Some calendar's poll applied data changes — the driver should tell the
    /// frontend to reload.
    pub changed: bool,
    /// Per-account failures (`account_id`, error). Transport/credential failures
    /// are engine *outcomes*, not errors — anything here is a genuine bug worth a
    /// log line. The pass continues past a failing account.
    pub errors: Vec<(String, AppError)>,
}

/// Run the scheduler until the trigger stream ends.
///
/// - `pool_for_pass` re-resolves the DB pool per pass (`None` = not connected
///   yet / mid workspace-switch → the trigger is dropped, no pass runs).
/// - `provider_for` constructs the account's provider (CalDAV today; Google
///   branches on `account.provider` when it lands).
/// - `on_pass_start` / `on_pass_end` bracket every pass — the desktop driver
///   uses them to suppress its DB-file watcher around the engine's writes and
///   to emit the frontend reload signal.
pub async fn run_sync_loop<T, P, F, PoolFut, PoolFn>(
    mut triggers: T,
    pool_for_pass: PoolFn,
    provider_for: F,
    config: SchedulerConfig,
    mut on_pass_start: impl FnMut(),
    mut on_pass_end: impl FnMut(&PassReport),
) where
    T: TriggerSource,
    P: CalendarProvider,
    F: Fn(&SyncAccountRow) -> P,
    PoolFn: Fn() -> PoolFut,
    PoolFut: std::future::Future<Output = Option<SqlitePool>>,
{
    let mut last_pass: Option<Instant> = None;
    while let Some(trigger) = triggers.next().await {
        if trigger == SyncTrigger::Focus {
            if let Some(at) = last_pass {
                if at.elapsed() < config.min_focus_gap {
                    continue;
                }
            }
        }
        let Some(pool) = pool_for_pass().await else {
            continue;
        };

        on_pass_start();
        let report = run_pass(&pool, &provider_for).await;
        last_pass = Some(Instant::now());
        on_pass_end(&report);
    }
}

/// One pass: resync every account, aggregating the changed flag and collecting
/// per-account errors instead of aborting.
async fn run_pass<P, F>(pool: &SqlitePool, provider_for: &F) -> PassReport
where
    P: CalendarProvider,
    F: Fn(&SyncAccountRow) -> P,
{
    let mut report = PassReport::default();
    let accounts = match load_accounts(pool).await {
        Ok(a) => a,
        Err(e) => {
            report.errors.push(("<account enumeration>".into(), e));
            return report;
        }
    };

    for account in &accounts {
        let provider = provider_for(account);
        match resync_account(pool, &provider, &account.id).await {
            Ok(results) => report.changed |= results.iter().any(|r| r.changed),
            Err(e) => report.errors.push((account.id.clone(), e)),
        }
    }
    report
}

/// Accounts the background pass polls — excludes those flagged `reconnect_needed`
/// (a rejected credential); a manual resync clears the flag and re-includes them.
async fn load_accounts(pool: &SqlitePool) -> Result<Vec<SyncAccountRow>, AppError> {
    Ok(
        sqlx::query_as::<_, SyncAccountRow>(
            "SELECT * FROM sync_account WHERE reconnect_needed = 0",
        )
        .fetch_all(pool)
        .await?,
    )
}
