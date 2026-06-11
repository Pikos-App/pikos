use super::*;
use crate::pool::{insert_test_page, test_pool, TestPage};

async fn reminder_count(pool: &sqlx::SqlitePool, page_id: &str) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM page_reminders WHERE page_id = ?")
        .bind(page_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn seed_page(pool: &sqlx::SqlitePool, id: &str) {
    insert_test_page(pool, TestPage::new(id, id)).await.unwrap();
}

#[tokio::test]
async fn create_persists_and_returns_row() {
    let pool = test_pool().await;
    seed_page(&pool, "p1").await;

    let r = create_page_reminder(&pool, "p1", 10).await.unwrap();

    assert_eq!(r.page_id, "p1");
    assert_eq!(r.minutes_before, 10);
    assert!(!r.id.is_empty());
    assert!(!r.created_at.is_empty());
    // The returned row is actually in the table.
    assert_eq!(reminder_count(&pool, "p1").await, 1);
}

#[tokio::test]
async fn list_returns_reminders_sorted_by_minutes_before() {
    let pool = test_pool().await;
    seed_page(&pool, "p1").await;

    // Insert out of order.
    create_page_reminder(&pool, "p1", 60).await.unwrap();
    create_page_reminder(&pool, "p1", 0).await.unwrap();
    create_page_reminder(&pool, "p1", 15).await.unwrap();

    let reminders = list_page_reminders(&pool, "p1").await.unwrap();
    let minutes: Vec<i64> = reminders.iter().map(|r| r.minutes_before).collect();
    assert_eq!(minutes, vec![0, 15, 60]);
}

#[tokio::test]
async fn list_is_scoped_to_the_page() {
    let pool = test_pool().await;
    seed_page(&pool, "p1").await;
    seed_page(&pool, "p2").await;

    create_page_reminder(&pool, "p1", 10).await.unwrap();
    create_page_reminder(&pool, "p2", 30).await.unwrap();

    let p1 = list_page_reminders(&pool, "p1").await.unwrap();
    assert_eq!(p1.len(), 1);
    assert_eq!(p1[0].minutes_before, 10);
}

#[tokio::test]
async fn list_is_empty_when_no_reminders() {
    let pool = test_pool().await;
    seed_page(&pool, "p1").await;
    assert!(list_page_reminders(&pool, "p1").await.unwrap().is_empty());
}

#[tokio::test]
async fn accepts_zero_and_none_sentinel_minutes() {
    let pool = test_pool().await;
    seed_page(&pool, "p1").await;

    // 0 = "at start", -1 = "no reminders" sentinel (migration 007 widened the
    // CHECK to allow -1). Both must insert cleanly.
    create_page_reminder(&pool, "p1", 0).await.unwrap();
    create_page_reminder(&pool, "p1", -1).await.unwrap();

    let minutes: Vec<i64> = list_page_reminders(&pool, "p1")
        .await
        .unwrap()
        .iter()
        .map(|r| r.minutes_before)
        .collect();
    assert_eq!(minutes, vec![-1, 0]);
}

#[tokio::test]
async fn delete_one_removes_only_that_reminder() {
    let pool = test_pool().await;
    seed_page(&pool, "p1").await;

    let keep = create_page_reminder(&pool, "p1", 10).await.unwrap();
    let drop = create_page_reminder(&pool, "p1", 30).await.unwrap();

    delete_page_reminder(&pool, &drop.id).await.unwrap();

    let remaining = list_page_reminders(&pool, "p1").await.unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].id, keep.id);
}

#[tokio::test]
async fn delete_all_clears_one_page_only() {
    let pool = test_pool().await;
    seed_page(&pool, "p1").await;
    seed_page(&pool, "p2").await;

    create_page_reminder(&pool, "p1", 10).await.unwrap();
    create_page_reminder(&pool, "p1", 60).await.unwrap();
    create_page_reminder(&pool, "p2", 15).await.unwrap();

    delete_page_reminders(&pool, "p1").await.unwrap();

    assert_eq!(reminder_count(&pool, "p1").await, 0);
    assert_eq!(reminder_count(&pool, "p2").await, 1);
}

#[tokio::test]
async fn deleting_the_page_cascades_to_its_reminders() {
    let pool = test_pool().await;
    seed_page(&pool, "p1").await;
    create_page_reminder(&pool, "p1", 10).await.unwrap();

    // page_reminders.page_id has ON DELETE CASCADE; test_pool enables FKs.
    sqlx::query("DELETE FROM pages WHERE id = ?")
        .bind("p1")
        .execute(&pool)
        .await
        .unwrap();

    assert_eq!(reminder_count(&pool, "p1").await, 0);
}
