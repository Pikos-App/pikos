//! Breadth gate for the module invariant: every user-facing writer survives a
//! concurrent writer. One round drives each of them against a writer that holds
//! the WAL write lock in a loop, so a command left on a raw transaction surfaces
//! as a BUSY here instead of as a dropped write in the app.
//!
//! Why the retry is needed at all is on `apply_page_update`; the editor path's
//! own reproduction is in `pages_concurrency_tests`.

use super::retry_on_busy;
use crate::pages::pages_tests::new_page;
use crate::pool::{insert_test_page, wal_test_pool, TestPage};
use crate::{now_iso, AppError};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Churn duty cycle: hold the write lock across a yield point, then idle. Tuned
/// as a pair against a deliberately unwrapped writer — enough pressure to catch
/// one (red 7 runs in 8 for a read-then-write writer, 4 in 8 for a write-first
/// one), enough idle that a correctly retried writer still lands inside its
/// deadline. Both halves are load-bearing: committing straight after the write
/// leaves a window too narrow to catch anything, and looping with no gap makes a
/// lock hog no real writer resembles — that starves even correct writers past the
/// deadline, so the test fails on healthy code.
const HOLD: Duration = Duration::from_micros(100);
const GAP: Duration = Duration::from_micros(400);

/// A disabled calendar with its account — the state `toggle_sync_calendar_impl`
/// enables from.
async fn insert_disabled_calendar(pool: &sqlx::SqlitePool, account_id: &str, calendar_id: &str) {
    let now = now_iso();
    sqlx::query(
        "INSERT INTO sync_account (id, provider, display_name, auth_kind, created_at, updated_at)
         VALUES (?, 'caldav', 'Concurrency test', 'basic', ?, ?)",
    )
    .bind(account_id)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO sync_calendar
         (id, account_id, calendar_id, display_name, enabled, created_at, updated_at)
         VALUES (?, ?, 'remote-cal', 'Remote', 0, ?, ?)",
    )
    .bind(calendar_id)
    .bind(account_id)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_user_facing_writer_survives_a_concurrent_writer() {
    let db = wal_test_pool().await;
    let pool = db.pool.clone();
    insert_test_page(&pool, TestPage::new("churn", "Churn"))
        .await
        .unwrap();
    insert_disabled_calendar(&pool, "acct", "cal").await;

    let done = Arc::new(AtomicBool::new(false));
    let churn_done = done.clone();
    let churn_pool = pool.clone();
    let churn = tokio::spawn(async move {
        let mut i = 0u32;
        while !churn_done.load(Ordering::Relaxed) {
            i += 1;
            retry_on_busy(|| async {
                let mut tx = churn_pool.begin().await?;
                let _snapshot: String =
                    sqlx::query_scalar("SELECT title FROM pages WHERE id = 'churn'")
                        .fetch_one(&mut *tx)
                        .await?;
                sqlx::query("UPDATE pages SET subtitle = ? WHERE id = 'churn'")
                    .bind(i.to_string())
                    .execute(&mut *tx)
                    .await?;
                tokio::time::sleep(HOLD).await;
                tx.commit().await?;
                Ok::<(), AppError>(())
            })
            .await
            .expect("churn writer must not surface SQLITE_BUSY");
            tokio::time::sleep(GAP).await;
        }
    });

    for i in 0..25 {
        let page = crate::create_page_impl(&pool, new_page(&format!("page {i}")))
            .await
            .expect("create_page");
        let folder = crate::create_folder_impl(
            &pool,
            crate::NewFolder {
                name: format!("folder {i}"),
                parent_id: None,
                color: None,
                icon: None,
            },
        )
        .await
        .expect("create_folder");

        let schedule = crate::create_page_schedule_impl(
            &pool,
            crate::NewPageSchedule {
                page_id: page.id.clone(),
                scheduled_start: "2026-06-05T09:00:00".into(),
                scheduled_end: None,
                timezone: None,
                rule_id: None,
                original_date: None,
            },
        )
        .await
        .expect("create_page_schedule");
        crate::update_page_schedule_impl(
            &pool,
            schedule.id.clone(),
            crate::PageScheduleUpdate {
                scheduled_start: Some("2026-06-06T09:00:00".into()),
                ..Default::default()
            },
        )
        .await
        .expect("update_page_schedule");
        crate::delete_page_schedule_impl(&pool, schedule.id)
            .await
            .expect("delete_page_schedule");

        let rule = crate::create_recurrence_rule_impl(
            &pool,
            crate::NewRecurrenceRule {
                page_id: page.id.clone(),
                rrule: "FREQ=DAILY".into(),
                rrule_exdates: vec![],
                scheduled_start: "2026-06-05".into(),
                scheduled_end: None,
                timezone: "America/Los_Angeles".into(),
            },
        )
        .await
        .expect("create_recurrence_rule");
        crate::update_recurrence_rule_impl(
            &pool,
            rule.id.clone(),
            crate::RecurrenceRuleUpdate {
                rrule: Some("FREQ=WEEKLY".into()),
                ..Default::default()
            },
        )
        .await
        .expect("update_recurrence_rule");
        crate::delete_recurrence_rule_impl(&pool, &rule.id)
            .await
            .expect("delete_recurrence_rule");

        crate::reorder_pages_impl(&pool, None, std::slice::from_ref(&page.id))
            .await
            .expect("reorder_pages");
        crate::soft_delete_page_impl(&pool, &page.id)
            .await
            .expect("soft_delete_page");
        crate::restore_page_impl(&pool, &page.id)
            .await
            .expect("restore_page");

        crate::reorder_folders_impl(&pool, std::slice::from_ref(&folder.id))
            .await
            .expect("reorder_folders");
        crate::soft_delete_folder_impl(&pool, folder.id.clone())
            .await
            .expect("soft_delete_folder");
        crate::restore_folder_impl(&pool, folder.id.clone())
            .await
            .expect("restore_folder");
        crate::delete_folder_impl(&pool, folder.id)
            .await
            .expect("delete_folder");

        crate::toggle_sync_calendar_impl(&pool, "cal", true, Some("#4285F4"))
            .await
            .expect("toggle_sync_calendar");
    }

    done.store(true, Ordering::Relaxed);
    churn.await.unwrap();
}
