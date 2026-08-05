use super::*;
use std::cell::Cell;

// Control-flow of retry_on_busy that doesn't need a real DB. The retry-then-
// succeed path (a real 517 healed by a retry) is covered end-to-end in
// pages_concurrency_tests, which needs a live WAL pool to produce a 517.

#[tokio::test]
async fn passes_through_success_without_retrying() {
    let calls = Cell::new(0);
    let out: AppResult<u32> = retry_on_busy(|| {
        calls.set(calls.get() + 1);
        async { Ok(42) }
    })
    .await;
    assert_eq!(out.unwrap(), 42);
    assert_eq!(calls.get(), 1, "a success must not retry");
}

#[tokio::test]
async fn does_not_retry_a_non_busy_error() {
    let calls = Cell::new(0);
    let out: AppResult<u32> = retry_on_busy(|| {
        calls.set(calls.get() + 1);
        async { Err(AppError::Internal("logic bug".into())) }
    })
    .await;
    assert!(matches!(out, Err(AppError::Internal(_))));
    assert_eq!(calls.get(), 1, "a non-busy error must surface immediately");
}

#[test]
fn non_database_errors_are_never_retryable() {
    assert!(!is_retryable_busy(&AppError::NotFound("x".into())));
    assert!(!is_retryable_busy(&AppError::Internal("x".into())));
    assert!(!is_retryable_busy(&AppError::Invalid("x".into())));
}

/// A `SQLITE_BUSY` shaped like sqlx surfaces it, so the retry path is reachable
/// without a live WAL pool racing a real writer.
#[derive(Debug)]
struct FakeBusy;

impl std::fmt::Display for FakeBusy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("database is locked")
    }
}
impl std::error::Error for FakeBusy {}

impl sqlx::error::DatabaseError for FakeBusy {
    fn message(&self) -> &str {
        "database is locked"
    }
    fn code(&self) -> Option<std::borrow::Cow<'_, str>> {
        Some("5".into())
    }
    fn kind(&self) -> sqlx::error::ErrorKind {
        sqlx::error::ErrorKind::Other
    }
    fn as_error(&self) -> &(dyn std::error::Error + Send + Sync + 'static) {
        self
    }
    fn as_error_mut(&mut self) -> &mut (dyn std::error::Error + Send + Sync + 'static) {
        self
    }
    fn into_error(self: Box<Self>) -> Box<dyn std::error::Error + Send + Sync + 'static> {
        self
    }
}

fn busy() -> AppError {
    AppError::Db(sqlx::Error::Database(Box::new(FakeBusy)))
}

#[test]
fn a_plain_busy_is_retryable() {
    assert!(is_retryable_busy(&busy()));
}

/// The budget is wall-clock, not a retry count. An attempt cap converts to a
/// *shrinking* time budget on a loaded machine — the retry would give up soonest
/// exactly when lock holds are longest, which is what made the reconcile-batch
/// contention test flaky.
#[tokio::test(start_paused = true)]
async fn a_perpetually_busy_write_spends_the_deadline_not_a_fixed_attempt_count() {
    let calls = Cell::new(0);
    let started = tokio::time::Instant::now();
    let out: AppResult<u32> = retry_on_busy(|| {
        calls.set(calls.get() + 1);
        async { Err(busy()) }
    })
    .await;
    let elapsed = started.elapsed();

    assert!(
        matches!(out, Err(AppError::Db(_))),
        "the busy error surfaces"
    );
    assert!(
        calls.get() > 8,
        "must retry past the old fixed 8-attempt cap, got {}",
        calls.get()
    );
    assert!(
        elapsed <= WRITE_TX_DEADLINE,
        "must not sleep past the deadline just to fail on return, took {elapsed:?}"
    );
    assert!(
        elapsed + RETRY_BACKOFF_CAP >= WRITE_TX_DEADLINE,
        "must actually spend the budget before giving up, took {elapsed:?}"
    );
}

/// The attempt cap is a livelock backstop, so it must not be what ends a normal
/// contention wait — otherwise the deadline is decorative.
#[test]
fn the_attempt_backstop_cannot_trip_before_the_deadline() {
    let mut elapsed = std::time::Duration::ZERO;
    for tries in 0..WRITE_TX_MAX_ATTEMPTS - 1 {
        elapsed += (RETRY_BACKOFF_BASE * 2u32.pow(tries.min(16))).min(RETRY_BACKOFF_CAP);
    }
    assert!(
        elapsed >= WRITE_TX_DEADLINE,
        "the {WRITE_TX_MAX_ATTEMPTS}-attempt backstop spans only {elapsed:?}, \
         so it would end the wait before the {WRITE_TX_DEADLINE:?} deadline"
    );
}
