use std::collections::BTreeSet;

use super::synced_rows;
use crate::{insert_test_folder, insert_test_page, insert_test_page_sync, test_pool, TestPage};

async fn names(pool: &sqlx::SqlitePool) -> BTreeSet<String> {
    synced_rows(pool)
        .await
        .unwrap()
        .into_iter()
        .map(|r| r.name.to_string())
        .collect()
}

async fn exec(pool: &sqlx::SqlitePool, sql: &str) {
    sqlx::query(sql).execute(pool).await.unwrap();
}

#[tokio::test]
async fn the_calendar_layer_stays_on_each_device() {
    let pool = test_pool().await;
    for (id, state) in [
        ("mirror", Some("active")),
        ("trashed-mirror", Some("tombstoned")),
    ]
    .into_iter()
    .chain([("detached", Some("detached")), ("mine", None)])
    {
        insert_test_page(&pool, TestPage::new(id, id))
            .await
            .unwrap();
        if let Some(state) = state {
            insert_test_page_sync(&pool, id, state).await.unwrap();
        }
        exec(
            &pool,
            &format!(
                "INSERT INTO page_reminders (id, page_id, minutes_before, created_at)
                 VALUES ('r-{id}', '{id}', 10, 'x')"
            ),
        )
        .await;
    }
    insert_test_page(&pool, TestPage::new("clone", "Standup, done"))
        .await
        .unwrap();
    exec(
        &pool,
        "INSERT INTO completed_set (page_id, occurrence_date, clone_id) VALUES ('mirror', '2026-10-16', 'clone')",
    )
    .await;
    insert_test_folder(&pool, "cal-folder", "Work calendar")
        .await
        .unwrap();
    exec(
        &pool,
        "UPDATE folders SET is_external_calendar = 1 WHERE id = 'cal-folder'",
    )
    .await;
    insert_test_folder(&pool, "mine-folder", "Home")
        .await
        .unwrap();

    let synced = names(&pool).await;

    let expected: BTreeSet<String> = [
        "page:detached",
        "body:detached",
        "remind:r-detached",
        "page:mine",
        "body:mine",
        "remind:r-mine",
        "folder:mine-folder",
    ]
    .map(String::from)
    .into();
    assert_eq!(synced, expected);
}
