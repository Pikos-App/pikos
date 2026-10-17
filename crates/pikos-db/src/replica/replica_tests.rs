use super::{forget, holds_only_seed, meta, record_seed, set_paused, start, Uncaptured};
use crate::{insert_test_folder, insert_test_page, insert_test_page_sync, test_pool, TestPage};

async fn seeded_workspace() -> sqlx::SqlitePool {
    let pool = test_pool().await;
    insert_test_folder(&pool, "start", "Start here")
        .await
        .unwrap();
    insert_test_page(
        &pool,
        TestPage {
            folder_id: Some("start"),
            ..TestPage::new("welcome", "Welcome to Pikos")
        },
    )
    .await
    .unwrap();
    record_seed(&pool).await.unwrap();
    pool
}

#[tokio::test]
async fn a_workspace_with_only_its_first_run_pages_holds_only_the_seed() {
    let pool = seeded_workspace().await;

    sqlx::query("UPDATE pages SET last_opened_at = 'now' WHERE id = 'welcome'")
        .execute(&pool)
        .await
        .unwrap();

    assert!(
        holds_only_seed(&pool).await.unwrap(),
        "opening a page isn't using it"
    );
}

#[tokio::test]
async fn editing_a_first_run_page_or_adding_one_is_work_to_keep() {
    let edited = seeded_workspace().await;
    let added = seeded_workspace().await;

    sqlx::query("UPDATE pages SET title = 'My page' WHERE id = 'welcome'")
        .execute(&edited)
        .await
        .unwrap();
    insert_test_page(&added, TestPage::new("p1", "Groceries"))
        .await
        .unwrap();

    assert!(!holds_only_seed(&edited).await.unwrap());
    assert!(!holds_only_seed(&added).await.unwrap());
}

#[tokio::test]
async fn a_connected_calendar_is_not_work_to_keep() {
    let pool = seeded_workspace().await;

    insert_test_page(&pool, TestPage::new("event", "Dentist"))
        .await
        .unwrap();
    insert_test_page_sync(&pool, "event", "active")
        .await
        .unwrap();

    assert!(holds_only_seed(&pool).await.unwrap());
}

#[tokio::test]
async fn a_workspace_never_seeded_holds_only_the_seed_while_empty() {
    let pool = test_pool().await;

    assert!(holds_only_seed(&pool).await.unwrap());
    insert_test_page(&pool, TestPage::new("p1", "Groceries"))
        .await
        .unwrap();
    assert!(!holds_only_seed(&pool).await.unwrap());
}

async fn pending(pool: &sqlx::SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM replica_ops")
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_workspace_has_an_id_from_its_creation_and_no_device_until_sync_starts() {
    let pool = test_pool().await;

    let before = meta(&pool).await.unwrap();

    assert_eq!(before.workspace_id.len(), 36);
    assert_eq!(before.workspace_id.as_bytes()[14], b'4', "a version 4 UUID");
    assert_eq!(before.device_id, None);
    assert!(!before.started);
    assert_eq!(before.base_clock, None);
}

#[tokio::test]
async fn starting_mints_a_device_and_a_base_clock_once() {
    let pool = test_pool().await;

    let first = start(&pool).await.unwrap();
    let again = start(&pool).await.unwrap();

    assert!(first.started);
    assert!(first.device_id.is_some());
    assert_eq!(first.base_clock, Some(first.hlc));
    assert_eq!(again, first, "starting twice changes nothing");
}

#[tokio::test]
async fn nothing_is_captured_before_sync_first_starts() {
    let pool = test_pool().await;

    insert_test_page(&pool, TestPage::new("p1", "Groceries"))
        .await
        .unwrap();

    assert_eq!(pending(&pool).await, 0);
}

#[tokio::test]
async fn a_paused_device_keeps_capturing() {
    let pool = test_pool().await;
    start(&pool).await.unwrap();
    set_paused(&pool, true).await.unwrap();

    insert_test_page(&pool, TestPage::new("p1", "Groceries"))
        .await
        .unwrap();

    assert!(meta(&pool).await.unwrap().paused);
    assert!(pending(&pool).await > 0);
}

#[tokio::test]
async fn forgetting_drops_the_clocks_and_stops_capture_but_keeps_the_clock_moving_forward() {
    let pool = test_pool().await;
    start(&pool).await.unwrap();
    insert_test_page(&pool, TestPage::new("p1", "Groceries"))
        .await
        .unwrap();
    let before = meta(&pool).await.unwrap();

    forget(&pool).await.unwrap();
    insert_test_page(&pool, TestPage::new("p2", "Laundry"))
        .await
        .unwrap();

    let after = meta(&pool).await.unwrap();
    let clocks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM replica_clocks")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(pending(&pool).await, 0);
    assert_eq!(clocks, 0);
    assert!(!after.started);
    assert_eq!(after.device_id, None);
    assert_eq!(after.workspace_id, before.workspace_id);
    assert_eq!(after.hlc, before.hlc);

    let rejoined = start(&pool).await.unwrap();
    assert_ne!(
        rejoined.device_id, before.device_id,
        "it rejoins as a new device"
    );
    assert!(rejoined.hlc > before.hlc);
}

#[tokio::test]
async fn resetting_a_workspace_forgets_sync_rather_than_sending_its_deletes() {
    let pool = test_pool().await;
    start(&pool).await.unwrap();
    insert_test_page(&pool, TestPage::new("p1", "Groceries"))
        .await
        .unwrap();

    crate::export::reset_workspace(&pool).await.unwrap();

    assert_eq!(pending(&pool).await, 0);
    assert!(!meta(&pool).await.unwrap().started);
}

#[tokio::test]
async fn an_uncaptured_transaction_writes_without_capture_and_leaves_no_marker() {
    let pool = test_pool().await;
    start(&pool).await.unwrap();

    let mut tx = Uncaptured::begin(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO pages (id, title, created_at, updated_at) VALUES ('p1', 'From afar', 'x', 'x')",
    )
    .execute(tx.conn())
    .await
    .unwrap();
    tx.commit().await.unwrap();

    let markers: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM replica_applying")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(pending(&pool).await, 0);
    assert_eq!(markers, 0);

    sqlx::query("UPDATE pages SET title = 'Edited here' WHERE id = 'p1'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        pending(&pool).await,
        1,
        "the next local write is captured again"
    );
}

#[tokio::test]
async fn an_uncaptured_transaction_dropped_unfinished_takes_its_marker_with_it() {
    let pool = test_pool().await;
    start(&pool).await.unwrap();

    {
        let mut tx = Uncaptured::begin(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO pages (id, title, created_at, updated_at) VALUES ('p1', 'x', 'x', 'x')",
        )
        .execute(tx.conn())
        .await
        .unwrap();
    }
    insert_test_page(&pool, TestPage::new("p2", "Laundry"))
        .await
        .unwrap();

    let pages: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pages WHERE id = 'p1'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(pages, 0);
    assert!(pending(&pool).await > 0);
}
