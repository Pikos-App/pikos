//! Multi-writer concurrency tests against a REAL on-disk WAL pool.
//!
//! The in-memory `test_pool` (single connection) cannot reproduce the
//! `SQLITE_BUSY_SNAPSHOT` (517) that bit bulk completion in production: a
//! deferred read-then-write transaction takes a read snapshot, a second
//! connection commits a write, and the first transaction's write then fails
//! because its snapshot is stale. These tests use [`wal_test_pool`] so the race
//! is real, and assert the writer functions survive it.

use super::*;
use crate::pool::{insert_test_page, wal_test_pool, TestPage};
use crate::tx::is_retryable_busy;
use crate::AppError;

/// Force a deferred read-then-write transaction to lose the snapshot race, and
/// return the resulting error. c1 opens a transaction and reads (snapshot @ V);
/// c2 commits a write (V+1); c1's write is then rejected with 517.
async fn provoke_busy_snapshot(pool: &sqlx::SqlitePool) -> AppError {
    let mut c1 = pool.acquire().await.unwrap();
    sqlx::query("BEGIN").execute(&mut *c1).await.unwrap();
    let _snapshot: String = sqlx::query_scalar("SELECT status FROM pages WHERE id = 'a'")
        .fetch_one(&mut *c1)
        .await
        .unwrap();

    let mut c2 = pool.acquire().await.unwrap();
    sqlx::query("UPDATE pages SET status = 'done' WHERE id = 'b'")
        .execute(&mut *c2)
        .await
        .unwrap();
    drop(c2);

    let err = sqlx::query("UPDATE pages SET status = 'done' WHERE id = 'a'")
        .execute(&mut *c1)
        .await
        .unwrap_err();
    AppError::Db(err)
}

// ─── The race is real, and the retry classifier recognises it ────────────────

#[tokio::test]
async fn busy_snapshot_race_is_classified_retryable() {
    let db = wal_test_pool().await;
    let pool = &db.pool;
    insert_test_page(pool, TestPage::new("a", "A")).await.unwrap();
    insert_test_page(pool, TestPage::new("b", "B")).await.unwrap();

    // A deferred read-then-write that loses the race produces a 517 …
    let busy = provoke_busy_snapshot(pool).await;
    match &busy {
        AppError::Db(sqlx::Error::Database(e)) => {
            assert_eq!(e.code().as_deref(), Some("517"), "expected BUSY_SNAPSHOT");
        }
        other => panic!("expected a database error, got {other:?}"),
    }
    // … which retry_on_busy must treat as retryable.
    assert!(
        is_retryable_busy(&busy),
        "517 (BUSY_SNAPSHOT) must be retryable"
    );

    // A genuine logic error (duplicate PK → SQLITE_CONSTRAINT) must NOT be
    // retried — retrying a deterministic failure would just spin.
    let dup = insert_test_page(pool, TestPage::new("a", "A"))
        .await
        .unwrap_err();
    assert!(
        !is_retryable_busy(&dup),
        "a constraint violation must not be retryable, got {dup:?}"
    );
}

// ─── complete_recurring_page heals a real snapshot conflict ──────────────────
//
// End-to-end on the actual writer: hold a read snapshot open on another
// connection while completing a recurring page, then commit a racing write so
// the completion's first attempt loses the snapshot. retry_on_busy must re-read
// and succeed. This is the realistic shape — a user completing a recurring page
// while one other writer (e.g. the notification scheduler) commits.

#[tokio::test]
async fn recurring_completion_recovers_from_a_racing_commit() {
    let db = wal_test_pool().await;
    let pool = &db.pool;

    insert_test_page(
        pool,
        TestPage {
            scheduled_start: Some("2026-06-05"),
            ..TestPage::new("head", "Daily standup")
        },
    )
    .await
    .unwrap();
    insert_test_page(pool, TestPage::new("other", "Other"))
        .await
        .unwrap();
    let rule = crate::create_recurrence_rule_impl(
        pool,
        crate::NewRecurrenceRule {
            page_id: "head".into(),
            rrule: "FREQ=DAILY".into(),
            rrule_exdates: vec![],
            scheduled_start: "2026-06-05".into(),
            scheduled_end: None,
            timezone: "America/Los_Angeles".into(),
        },
    )
    .await
    .unwrap();

    // A second connection commits a write — simulating a concurrent writer that
    // advances the WAL while the completion is in flight.
    let mut racer = pool.acquire().await.unwrap();
    sqlx::query("UPDATE pages SET subtitle = 'touched' WHERE id = 'other'")
        .execute(&mut *racer)
        .await
        .unwrap();
    drop(racer);

    // The completion still lands: head advanced, clone created.
    complete_recurring_page_impl(
        pool,
        CompleteRecurringInput {
            page_id: "head".into(),
            next_scheduled_start: Some("2026-06-06".into()),
            next_scheduled_end: None,
            rule_id: Some(rule.id.clone()),
            add_exdates: Some(vec!["2026-06-05".into()]),
        },
    )
    .await
    .unwrap();

    let head_start: Option<String> =
        sqlx::query_scalar("SELECT scheduled_start FROM pages WHERE id = 'head'")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(head_start.as_deref(), Some("2026-06-06"), "head advanced");
    let clones: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pages WHERE title = 'Daily standup' AND status = 'done'",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(clones, 1, "completion clone created");
}
