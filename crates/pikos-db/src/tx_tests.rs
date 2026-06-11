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
