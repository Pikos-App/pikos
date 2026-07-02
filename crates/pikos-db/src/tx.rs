//! Write-transaction resilience for the multi-connection WAL pool.
//!
//! `busy_timeout` (set on the pool) makes a writer WAIT when another writer holds
//! the write lock — but ONLY when the waiting connection isn't already holding a
//! read. Two cases slip past it, both handled by [`retry_on_busy`]:
//!
//! - `SQLITE_BUSY_SNAPSHOT` (extended code 517): a *deferred* transaction reads —
//!   taking a read snapshot — another connection commits a write, and the first
//!   transaction's later write is rejected because its snapshot is stale.
//! - Plain `SQLITE_BUSY` (5) on a lock *upgrade*: a deferred transaction that has
//!   already read (holding a read lock) then tries to write while another
//!   connection holds the write lock. SQLite returns BUSY **immediately without
//!   invoking the busy handler** — waiting could deadlock — so `busy_timeout`
//!   never kicks in. Measured: a 200-row recompute batch holds the write lock
//!   ~20ms, but a completion racing it burns all 8 retries in microseconds if
//!   they don't back off. Hence the backoff below.
//!
//! This is the systemic counterpart to "fold concurrent writes into one
//! transaction": any read-then-write writer that can run concurrently with
//! another writer should go through [`retry_on_busy`] so a lost snapshot race
//! self-heals instead of surfacing as a dropped write.

use crate::error::{AppError, AppResult};

/// Upper bound on attempts for a write that keeps losing the WAL write race.
/// Each attempt re-reads fresh state, so convergence only needs one attempt to
/// see no concurrent commit; under the app's handful-of-writers concurrency a
/// retry or two always suffices. The bound exists so a pathological livelock
/// surfaces as an error instead of hanging.
const WRITE_TX_MAX_ATTEMPTS: u32 = 8;

/// True for the transient busy/locked conditions a retry can clear: SQLITE_BUSY
/// (5) and SQLITE_LOCKED (6), including their extended variants (e.g. 517
/// BUSY_SNAPSHOT, 262 LOCKED_SHAREDCACHE). sqlx surfaces the *extended* result
/// code as a decimal string; the primary code is its low byte.
pub fn is_retryable_busy(err: &AppError) -> bool {
    let AppError::Db(sqlx::Error::Database(db)) = err else {
        return false;
    };
    db.code()
        .and_then(|c| c.parse::<i32>().ok())
        .is_some_and(|code| matches!(code & 0xFF, 5 | 6))
}

/// Base backoff before the first retry; doubles each attempt, capped at
/// [`RETRY_BACKOFF_CAP`]. An immediate upgrade-BUSY (see module docs) returns with
/// no I/O wait, so without an explicit sleep the retries spin through faster than
/// the lock-holder can commit. The full 8-attempt schedule (2·2⁰…capped) spans
/// ~190ms — comfortably past a recompute batch's ~20ms hold, while still
/// surfacing a genuine livelock as an error rather than hanging.
const RETRY_BACKOFF_BASE: std::time::Duration = std::time::Duration::from_millis(2);
const RETRY_BACKOFF_CAP: std::time::Duration = std::time::Duration::from_millis(64);

/// Run a self-contained write attempt, retrying from scratch on a transient
/// busy/snapshot conflict.
///
/// `attempt` MUST open and commit its own transaction on each call so a retry
/// re-reads fresh state (a stale snapshot is exactly what we're recovering
/// from). It is invoked up to [`WRITE_TX_MAX_ATTEMPTS`] times, backing off
/// between tries so the racing writer can commit and release the lock.
/// Non-retryable errors, and the final busy error once attempts are exhausted,
/// propagate.
pub async fn retry_on_busy<F, Fut, T>(mut attempt: F) -> AppResult<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = AppResult<T>>,
{
    let mut tries = 0u32;
    loop {
        match attempt().await {
            Err(e) if tries + 1 < WRITE_TX_MAX_ATTEMPTS && is_retryable_busy(&e) => {
                let backoff = (RETRY_BACKOFF_BASE * 2u32.pow(tries)).min(RETRY_BACKOFF_CAP);
                tokio::time::sleep(backoff).await;
                tries += 1;
                continue;
            }
            result => return result,
        }
    }
}

#[cfg(test)]
#[path = "tx_tests.rs"]
mod tx_tests;
