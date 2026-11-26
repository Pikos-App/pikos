//! Multi-writer tests against a real on-disk WAL pool: the single-connection `test_pool` can't
//! reproduce `SQLITE_BUSY_SNAPSHOT`, where a deferred read-then-write transaction's snapshot goes
//! stale after another connection commits. [`wal_test_pool`] makes the race real.

use super::*;
use crate::pool::{insert_test_page, wal_test_pool, TestPage};
use crate::tx::is_retryable_busy;
use crate::AppError;

/// Forces a deferred read-then-write transaction to lose the snapshot race and returns the
/// error: c1 reads, c2 commits, then c1's write is rejected with 517.
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

#[tokio::test]
async fn busy_snapshot_race_is_classified_retryable() {
    let db = wal_test_pool().await;
    let pool = &db.pool;
    insert_test_page(pool, TestPage::new("a", "A"))
        .await
        .unwrap();
    insert_test_page(pool, TestPage::new("b", "B"))
        .await
        .unwrap();

    let busy = provoke_busy_snapshot(pool).await;
    match &busy {
        AppError::Db(sqlx::Error::Database(e)) => {
            assert_eq!(e.code().as_deref(), Some("517"), "expected BUSY_SNAPSHOT");
        }
        other => panic!("expected a database error, got {other:?}"),
    }
    assert!(
        is_retryable_busy(&busy),
        "517 (BUSY_SNAPSHOT) must be retryable"
    );

    // A deterministic failure (duplicate PK) must not be retried; it would just spin.
    let dup = insert_test_page(pool, TestPage::new("a", "A"))
        .await
        .unwrap_err();
    assert!(
        !is_retryable_busy(&dup),
        "a constraint violation must not be retryable, got {dup:?}"
    );
}

// Why the editor's write needs the retry is on `apply_page_update`. A single held lock is the
// wrong way to test it, since the busy handler waits that out with or without the retry; it
// takes another writer committing repeatedly (a teardown retrying, a sync poll batching) to
// catch the editor mid-upgrade.
//
// Reproduction is probabilistic: red about 3 runs in 8 without `retry_on_busy` on the editor
// path, green 8 of 8 with it. Weak as a detector, stable as a gate; running several suites
// concurrently while looping `teardown_heals_a_racing_editor_write` is the stronger signal.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_editor_write_survives_a_concurrent_writer() {
    let db = wal_test_pool().await;
    let pool = db.pool.clone();
    insert_test_page(&pool, TestPage::new("a", "A"))
        .await
        .unwrap();

    // Churn as long as the editor writes: a fixed count finishes early and leaves the editor's
    // tail uncontended, so the test would pass with the bug present.
    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let churn_done = done.clone();
    let churn_pool = pool.clone();
    let churn = tokio::spawn(async move {
        let mut i = 0u32;
        while !churn_done.load(std::sync::atomic::Ordering::Relaxed) {
            i += 1;
            // Raw BEGIN/COMMIT on a pooled connection would return it to the pool mid-transaction
            // on the first BUSY and poison the next caller.
            crate::tx::retry_on_busy(|| async {
                let mut tx = churn_pool.begin().await?;
                let _snapshot: String =
                    sqlx::query_scalar("SELECT title FROM pages WHERE id = 'a'")
                        .fetch_one(&mut *tx)
                        .await?;
                sqlx::query("UPDATE pages SET subtitle = ? WHERE id = 'a'")
                    .bind(i.to_string())
                    .execute(&mut *tx)
                    .await?;
                tx.commit().await?;
                Ok::<(), AppError>(())
            })
            .await
            .expect("churn writer must not surface SQLITE_BUSY");
        }
    });

    for i in 0..500 {
        update_page_impl(
            &pool,
            "a".to_string(),
            PageUpdate {
                content: Some(crate::build_tiptap_doc(&format!("edit {i}"))),
                ..Default::default()
            },
        )
        .await
        .expect("editor write must not surface SQLITE_BUSY");
    }
    done.store(true, std::sync::atomic::Ordering::Relaxed);
    churn.await.unwrap();

    let text: Option<String> = sqlx::query_scalar("SELECT content_text FROM pages WHERE id = 'a'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(text.as_deref(), Some("edit 499"), "the last edit landed");
}

// End to end on the real writer: a racing write commits while a recurring page is being
// completed, so the first attempt loses the snapshot and retry_on_busy must re-read and
// succeed, as when the notification scheduler commits mid-completion.

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
    // Completion derives the head advance via recompute, so a rule is required.
    crate::create_recurrence_rule_impl(
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

    let mut racer = pool.acquire().await.unwrap();
    sqlx::query("UPDATE pages SET subtitle = 'touched' WHERE id = 'other'")
        .execute(&mut *racer)
        .await
        .unwrap();
    drop(racer);

    complete_recurring_page_impl(
        pool,
        CompleteRecurringInput {
            page_id: "head".into(),
            occurrence_date: None,
            scheduled_start: None,
            scheduled_end: None,
            expected_occurrence_date: None,
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

// A native head carries no occurrence key, so both writers resolve the date off
// `pages.scheduled_start` in their own transaction; serialized, the second completes the
// following occurrence, consuming two for one gesture. The desktop's in-flight guard is
// per-webview and can't see the CLI.

async fn daily_head_at(pool: &sqlx::SqlitePool, start: &str) {
    insert_test_page(
        pool,
        TestPage {
            scheduled_start: Some(start),
            ..TestPage::new("head", "Daily standup")
        },
    )
    .await
    .unwrap();
    crate::create_recurrence_rule_impl(
        pool,
        crate::NewRecurrenceRule {
            page_id: "head".into(),
            rrule: "FREQ=DAILY".into(),
            rrule_exdates: vec![],
            scheduled_start: start.into(),
            scheduled_end: None,
            timezone: "America/Los_Angeles".into(),
        },
    )
    .await
    .unwrap();
}

fn complete_expecting(occurrence: &str) -> CompleteRecurringInput {
    CompleteRecurringInput {
        page_id: "head".into(),
        occurrence_date: None,
        scheduled_start: None,
        scheduled_end: None,
        expected_occurrence_date: Some(occurrence.into()),
    }
}

#[tokio::test]
async fn a_second_writer_on_the_same_occurrence_does_not_advance_twice() {
    let db = wal_test_pool().await;
    let pool = &db.pool;
    daily_head_at(pool, "2026-06-05").await;

    let first = complete_recurring_page_impl(pool, complete_expecting("2026-06-05"))
        .await
        .unwrap();
    let second = complete_recurring_page_impl(pool, complete_expecting("2026-06-05"))
        .await
        .unwrap();

    assert_eq!(
        second.clone.id, first.clone.id,
        "the loser of the race gets the winner's clone, not one of its own"
    );
    assert_eq!(
        second.head.scheduled_start.as_deref(),
        Some("2026-06-06"),
        "head advanced exactly one occurrence"
    );
    let clones: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pages WHERE title = 'Daily standup' AND status = 'done'",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(clones, 1, "one occurrence completed, one clone");
}

#[tokio::test]
async fn a_head_that_moved_for_another_reason_is_a_conflict() {
    let db = wal_test_pool().await;
    let pool = &db.pool;
    daily_head_at(pool, "2026-06-05").await;
    crate::skip_occurrence_impl(
        pool,
        crate::SkipOccurrenceInput {
            page_id: "head".into(),
            occurrence_date: "2026-06-05".into(),
        },
    )
    .await
    .unwrap();

    let err = complete_recurring_page_impl(pool, complete_expecting("2026-06-05"))
        .await
        .unwrap_err();

    assert!(
        matches!(err, AppError::Conflict(_)),
        "a dismissed occurrence is not a lost race — refuse rather than complete 06-06"
    );
}

#[tokio::test]
async fn an_unguarded_completion_keeps_deriving_the_occurrence_itself() {
    let db = wal_test_pool().await;
    let pool = &db.pool;
    daily_head_at(pool, "2026-06-05").await;

    let result = complete_recurring_page_impl(
        pool,
        CompleteRecurringInput {
            page_id: "head".into(),
            occurrence_date: None,
            scheduled_start: None,
            scheduled_end: None,
            expected_occurrence_date: None,
        },
    )
    .await
    .unwrap();

    assert_eq!(result.head.scheduled_start.as_deref(), Some("2026-06-06"));
}
