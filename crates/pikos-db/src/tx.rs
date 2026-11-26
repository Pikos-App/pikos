//! Write-transaction resilience for the multi-connection WAL pool.
//!
//! `busy_timeout` makes a writer wait for the write lock, but only when its connection isn't
//! already holding a read. Two cases slip past it, both handled by [`retry_on_busy`]:
//!
//! - `SQLITE_BUSY_SNAPSHOT` (517): a deferred transaction reads, another connection commits,
//!   and the first's later write is rejected because its snapshot is stale.
//! - Plain `SQLITE_BUSY` (5) on a lock upgrade: a deferred transaction that has read then
//!   writes while another connection holds the write lock. SQLite returns BUSY immediately
//!   without invoking the busy handler, since waiting could deadlock. A 200-row recompute
//!   batch holds the lock about 20 ms, but a racing completion burns all 8 retries in
//!   microseconds without a backoff.
//!
//! The retry is bounded by [`WRITE_TX_DEADLINE`], so a writer that reads first and loses to a
//! longer hold still fails. One opening with `BEGIN IMMEDIATE` takes the write lock before its
//! first read, which `busy_timeout` does wait for.
//!
//! Every user-facing writer goes through [`retry_on_busy`], none exempt: none owns the write
//! lock alone, and a sync poll or calendar teardown can commit between any two statements.

use crate::error::{AppError, AppResult};

/// How long a write may keep losing the WAL write race before giving up. Wall-clock, not a
/// retry count: holds stretch on a loaded machine while a fixed number of backoffs still
/// elapses in about 190 ms, so a count is weakest exactly when contention is worst. Sized well
/// past a reconcile-sized batch (200 recomputes, about 20 ms idle).
const WRITE_TX_DEADLINE: std::time::Duration = std::time::Duration::from_millis(750);

/// A livelock backstop; the deadline is the real bound. High enough never to bind first under
/// the capped backoff.
const WRITE_TX_MAX_ATTEMPTS: u32 = 32;

/// True for the transient busy and locked conditions a retry can clear: SQLITE_BUSY (5) and
/// SQLITE_LOCKED (6) with their extended variants. sqlx surfaces the extended code as a decimal
/// string; the primary code is its low byte.
pub fn is_retryable_busy(err: &AppError) -> bool {
    let AppError::Db(sqlx::Error::Database(db)) = err else {
        return false;
    };
    db.code()
        .and_then(|c| c.parse::<i32>().ok())
        .is_some_and(|code| matches!(code & 0xFF, 5 | 6))
}

/// Base backoff before the first retry; doubles each attempt, capped at [`RETRY_BACKOFF_CAP`].
/// An upgrade-BUSY returns without waiting, so retries would otherwise spin faster than the
/// lock-holder can commit.
const RETRY_BACKOFF_BASE: std::time::Duration = std::time::Duration::from_millis(2);
const RETRY_BACKOFF_CAP: std::time::Duration = std::time::Duration::from_millis(64);

/// Runs a self-contained write attempt, retrying from scratch on a transient busy or snapshot
/// conflict until [`WRITE_TX_DEADLINE`] elapses or [`WRITE_TX_MAX_ATTEMPTS`] trips.
/// Non-retryable errors, and the final busy error once the budget is spent, propagate.
///
/// `attempt` must open and commit its own transaction each call, so a retry re-reads fresh
/// state. The deadline is checked before sleeping, so no sleep runs past it just to fail.
pub async fn retry_on_busy<F, Fut, T>(mut attempt: F) -> AppResult<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = AppResult<T>>,
{
    // tokio's clock, so the deadline honours a paused test clock like the `sleep` below.
    let started = tokio::time::Instant::now();
    let mut tries = 0u32;
    loop {
        match attempt().await {
            Err(e) if is_retryable_busy(&e) => {
                let backoff = (RETRY_BACKOFF_BASE * 2u32.pow(tries.min(16))).min(RETRY_BACKOFF_CAP);
                if tries + 1 >= WRITE_TX_MAX_ATTEMPTS
                    || started.elapsed() + backoff >= WRITE_TX_DEADLINE
                {
                    return Err(e);
                }
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

#[cfg(test)]
#[path = "tx_writers_tests.rs"]
mod tx_writers_tests;
