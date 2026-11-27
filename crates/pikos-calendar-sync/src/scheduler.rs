//! The poll scheduler: turns platform triggers (window focus, interval timer,
//! explicit pokes) into sync passes over every account. The trigger stream is
//! behind [`TriggerSource`], so a mobile driver can swap in its own wakeups
//! without touching this loop.
//!
//! The loop never dies on a failing pass: account-level errors are collected
//! into the [`PassReport`] for the driver to log.

use std::time::{Duration, Instant};

use sqlx::SqlitePool;

use pikos_db::error::AppError;
use pikos_db::sync::SyncAccountRow;
use pikos_db::sync_commands::pollable_account_rows_impl;
use pikos_db::sync_delta::CalendarProvider;

use crate::commands::sync_account_calendars;

#[cfg(test)]
#[path = "scheduler_tests.rs"]
mod scheduler_tests;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncTrigger {
    /// The app window gained focus. Delayed, never dropped, by
    /// [`SchedulerConfig::min_focus_gap`].
    Focus,
    Interval,
    /// An explicit request — a calendar was just enabled and needs its initial
    /// backfill now. Never debounced.
    Poke,
}

#[allow(async_fn_in_trait)]
pub trait TriggerSource {
    async fn next(&mut self) -> Option<SyncTrigger>;
}

pub struct SchedulerConfig {
    /// A `Focus` trigger this soon after the last completed pass waits out the
    /// remainder and then runs, rather than being dropped, so a change made in the
    /// provider a few seconds earlier is visible on return. `Interval` and `Poke`
    /// never wait.
    ///
    /// The cost is that an alt-tab burst runs one pass per focus event, spaced by
    /// this gap. An unchanged etag or sync token writes nothing, so those are the
    /// cheapest request a provider serves.
    pub min_focus_gap: Duration,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            // Short enough that flipping back from another calendar app picks up the
            // change just made there; long enough to absorb an alt-tab burst.
            min_focus_gap: Duration::from_secs(15),
        }
    }
}

/// What one pass did, for the driver's reload signal + logging.
#[derive(Debug, Default)]
pub struct PassReport {
    pub changed: bool,
    /// Failures the pass carried on past. Transport/credential failures are engine
    /// *outcomes*, not errors, so anything here is a bug or a server answer sync
    /// doesn't handle.
    pub errors: Vec<PassError>,
}

#[derive(Debug)]
pub struct PassError {
    pub account_id: String,
    /// The `sync_calendar` row id, or `None` when the account itself couldn't be read.
    pub calendar_id: Option<String>,
    pub error: AppError,
}

/// Run the scheduler until the trigger stream ends.
///
/// - `pool_for_pass` re-resolves the DB pool per pass; `None` (not connected yet,
///   mid workspace-switch) drops the trigger.
/// - `provider_for` takes the whole account row so it can branch on `provider`.
/// - `on_pass_start` / `on_pass_end` bracket every pass, so the driver can suppress
///   its DB-file watcher around the engine's writes.
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
                let since = at.elapsed();
                if since < config.min_focus_gap {
                    tokio::time::sleep(config.min_focus_gap - since).await;
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

async fn run_pass<P, F>(pool: &SqlitePool, provider_for: &F) -> PassReport
where
    P: CalendarProvider,
    F: Fn(&SyncAccountRow) -> P,
{
    let mut report = PassReport::default();
    let accounts = match pollable_account_rows_impl(pool).await {
        Ok(a) => a,
        Err(error) => {
            report.errors.push(PassError {
                account_id: "<account enumeration>".into(),
                calendar_id: None,
                error,
            });
            return report;
        }
    };

    for account in &accounts {
        let provider = provider_for(account);
        match sync_account_calendars(pool, &provider, &account.id).await {
            Ok(pass) => {
                report.changed |= pass.results.iter().any(|r| r.changed);
                report
                    .errors
                    .extend(pass.failures.into_iter().map(|f| PassError {
                        account_id: account.id.clone(),
                        calendar_id: Some(f.calendar_id),
                        error: f.error,
                    }));
            }
            Err(error) => report.errors.push(PassError {
                account_id: account.id.clone(),
                calendar_id: None,
                error,
            }),
        }
    }
    report
}
