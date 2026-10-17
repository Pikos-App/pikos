use pikos_replica::merge::Value;
use pikos_replica::{Entity, RecordName};

use super::{build, pending, sent};
use crate::replica::start;
use crate::{insert_test_page, insert_test_page_sync, test_pool, TestPage};

async fn started() -> sqlx::SqlitePool {
    let pool = test_pool().await;
    start(&pool).await.unwrap();
    pool
}

fn page(id: &str) -> RecordName {
    RecordName::live(Entity::Page, id)
}

#[tokio::test]
async fn a_record_is_built_from_the_row_as_it_is_now() {
    let pool = started().await;
    insert_test_page(&pool, TestPage::new("p1", "Groceries"))
        .await
        .unwrap();
    sqlx::query("UPDATE pages SET title = 'Groceries, Saturday' WHERE id = 'p1'")
        .execute(&pool)
        .await
        .unwrap();

    let built = build(&pool, &[page("p1")]).await.unwrap();

    assert_eq!(
        built[0].fields.get("title_0"),
        Some(&Value::Text("Groceries, Saturday".into()))
    );
    assert!(!built[0].fields.contains_key("tomb"));
}

#[tokio::test]
async fn an_edit_made_while_a_record_was_in_flight_stays_pending() {
    let pool = started().await;
    insert_test_page(&pool, TestPage::new("p1", "Groceries"))
        .await
        .unwrap();
    let built = build(&pool, &[page("p1")]).await.unwrap();

    sqlx::query("UPDATE pages SET title = 'Edited mid-flight' WHERE id = 'p1'")
        .execute(&pool)
        .await
        .unwrap();
    let still = sent(&pool, &[(page("p1"), built[0].clock)]).await.unwrap();

    assert_eq!(still, vec![page("p1")]);
    assert!(pending(&pool, 10).await.unwrap().contains(&page("p1")));
}

#[tokio::test]
async fn a_sent_record_leaves_the_queue() {
    let pool = started().await;
    insert_test_page(&pool, TestPage::new("p1", "Groceries"))
        .await
        .unwrap();
    let built = build(&pool, &[page("p1")]).await.unwrap();

    let still = sent(&pool, &[(page("p1"), built[0].clock)]).await.unwrap();

    assert!(still.is_empty());
    assert!(!pending(&pool, 10).await.unwrap().contains(&page("p1")));
}

#[tokio::test]
async fn a_calendar_page_is_dropped_from_the_queue_unbuilt() {
    let pool = started().await;
    insert_test_page(&pool, TestPage::new("event", "Dentist"))
        .await
        .unwrap();
    insert_test_page_sync(&pool, "event", "active")
        .await
        .unwrap();

    let built = build(&pool, &[page("event")]).await.unwrap();

    assert!(built.is_empty());
    assert!(!pending(&pool, 10).await.unwrap().contains(&page("event")));
}

#[tokio::test]
async fn a_purged_page_builds_its_tombstone_and_its_cascaded_children_build_nothing() {
    let pool = started().await;
    insert_test_page(&pool, TestPage::new("p1", "Groceries"))
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO page_reminders (id, page_id, minutes_before, created_at) VALUES ('r1', 'p1', 5, 'x')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM pages WHERE id = 'p1'")
        .execute(&pool)
        .await
        .unwrap();
    let reminder = RecordName::live(Entity::Reminder, "r1");

    let built = build(&pool, &[page("p1"), reminder.clone()]).await.unwrap();

    assert_eq!(built.len(), 1);
    assert_eq!(built[0].name, page("p1"));
    assert!(built[0].fields.contains_key("tomb"));
    assert!(
        !built[0].fields.contains_key("title_0"),
        "a tombstone carries no values"
    );
    assert!(!pending(&pool, 10).await.unwrap().contains(&reminder));
}

#[tokio::test]
async fn the_transports_metadata_is_kept_and_built_with_the_record() {
    let pool = started().await;
    insert_test_page(&pool, TestPage::new("p1", "Groceries"))
        .await
        .unwrap();

    super::save_system_fields(&pool, &[(page("p1"), b"change tag".to_vec())])
        .await
        .unwrap();
    let built = build(&pool, &[page("p1")]).await.unwrap();

    assert_eq!(built[0].system_fields.as_deref(), Some(&b"change tag"[..]));
}
