//! Write-transaction resilience for the multi-connection WAL pool.
//!
//! `busy_timeout` (set on the pool) already makes a writer WAIT when another
//! writer holds the write lock — it just blocks, then proceeds. What it does
//! NOT cover is `SQLITE_BUSY_SNAPSHOT` (extended code 517): a *deferred*
//! transaction reads — taking a read snapshot — another connection commits a
//! write, and the first transaction's later write is then rejected because its
//! snapshot is stale. SQLite requires the whole transaction to be rolled back
//! and retried. That is what [`retry_on_busy`] does.
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

/// Run a self-contained write attempt, retrying from scratch on a transient
/// busy/snapshot conflict.
///
/// `attempt` MUST open and commit its own transaction on each call so a retry
/// re-reads fresh state (a stale snapshot is exactly what we're recovering
/// from). It is invoked up to [`WRITE_TX_MAX_ATTEMPTS`] times. Every attempt
/// awaits real DB I/O, so the loop yields to the runtime between tries — the
/// racing writer makes progress without an explicit sleep. Non-retryable
/// errors, and the final busy error once attempts are exhausted, propagate.
pub async fn retry_on_busy<F, Fut, T>(mut attempt: F) -> AppResult<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = AppResult<T>>,
{
    let mut tries = 0u32;
    loop {
        match attempt().await {
            Err(e) if tries + 1 < WRITE_TX_MAX_ATTEMPTS && is_retryable_busy(&e) => {
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
