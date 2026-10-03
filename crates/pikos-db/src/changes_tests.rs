use super::*;
use crate::pool::{insert_test_page, test_pool, TestPage};

/// Tables nothing a view shows comes from, or that every quiet poll would stamp.
const UNCOUNTED: &[&str] = &[
    "focus_sessions",
    "folder_counts",
    "notification_log",
    "page_reminders",
    "tag_counts",
    "title_key_version",
];

async fn seq(pool: &SqlitePool) -> i64 {
    change_state(pool).await.unwrap().seq
}

async fn row_seq(pool: &SqlitePool, id: &str) -> i64 {
    sqlx::query_scalar("SELECT row_seq FROM pages WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn every_table_a_view_reads_counts_its_changes_and_no_other_does() {
    let pool = test_pool().await;
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'pages_fts%'
           AND name NOT IN ('_sqlx_migrations', 'change_counter', 'change_writers')",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let triggers: Vec<String> =
        sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'trigger'")
            .fetch_all(&pool)
            .await
            .unwrap();
    for table in &tables {
        for event in ["insert", "update", "delete"] {
            let name = format!("change_on_{table}_{event}");
            let counted = triggers.contains(&name);
            assert_eq!(
                counted,
                !UNCOUNTED.contains(&table.as_str()),
                "{name}: a new table either counts its changes or joins UNCOUNTED, with a reason"
            );
        }
    }
}

#[tokio::test]
async fn a_page_write_moves_the_counter_and_stamps_the_page() {
    let pool = test_pool().await;
    let before = change_state(&pool).await.unwrap();
    insert_test_page(&pool, TestPage::new("p1", "Groceries"))
        .await
        .unwrap();
    let inserted = seq(&pool).await;
    assert!(inserted > before.seq);
    assert_eq!(row_seq(&pool, "p1").await, inserted);

    sqlx::query("UPDATE pages SET title = 'Groceries, Saturday' WHERE id = 'p1'")
        .execute(&pool)
        .await
        .unwrap();
    let updated = seq(&pool).await;
    assert_eq!(
        updated,
        inserted + 1,
        "the row_seq stamp itself doesn't count"
    );
    assert_eq!(row_seq(&pool, "p1").await, updated);

    let after = change_state(&pool).await.unwrap();
    assert_eq!(
        after.seq - after.own_changes,
        before.seq - before.own_changes
    );
}

#[tokio::test]
async fn a_child_row_stamps_its_page() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Standup"))
        .await
        .unwrap();
    let before = row_seq(&pool, "p1").await;
    sqlx::query(
        "INSERT INTO page_schedules (id, page_id, scheduled_start, status, created_at)
         VALUES ('s1', 'p1', '2026-06-15T09:00:00', 'not_started', '2026-06-01T00:00:00')",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert!(row_seq(&pool, "p1").await > before);
    assert_eq!(row_seq(&pool, "p1").await, seq(&pool).await);
}

#[tokio::test]
async fn a_quiet_sync_poll_counts_nothing() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Meeting"))
        .await
        .unwrap();
    let now = crate::now_iso();
    for sql in [
        "INSERT INTO sync_account (id, provider, display_name, auth_kind, created_at, updated_at)
         VALUES ('a1', 'caldav', 'Fastmail', 'basic', ?1, ?1)",
        "INSERT INTO sync_calendar (id, account_id, calendar_id, display_name, enabled, created_at, updated_at)
         VALUES ('c1', 'a1', 'cal', 'Work', 1, ?1, ?1)",
        "INSERT INTO page_sync (id, page_id, account_id, provider, calendar_id, external_id, ical_uid, created_at)
         VALUES ('s1', 'p1', 'a1', 'caldav', 'cal', '/ev.ics', 'uid-1', ?1)",
    ] {
        sqlx::query(sql).bind(&now).execute(&pool).await.unwrap();
    }
    let before = seq(&pool).await;
    for sql in [
        "UPDATE sync_calendar SET last_synced_at = ?1, sync_token = 'tok-2', ctag = 'c2'",
        "UPDATE sync_account SET updated_at = ?1, reconnect_needed = 0",
        "UPDATE page_sync SET last_synced_at = ?1, etag = 'v1', sync_state = 'active'",
    ] {
        sqlx::query(sql).bind(&now).execute(&pool).await.unwrap();
    }
    assert_eq!(seq(&pool).await, before);

    sqlx::query("UPDATE sync_calendar SET enabled = 0")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        seq(&pool).await,
        before + 1,
        "turning a calendar off is a change a person sees"
    );
}

#[tokio::test]
async fn opening_a_page_leaves_the_search_index_alone() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Groceries"))
        .await
        .unwrap();
    let segments = || async {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM pages_fts_data")
            .fetch_one(&pool)
            .await
            .unwrap()
    };
    let before = segments().await;
    for _ in 0..3 {
        sqlx::query("UPDATE pages SET last_opened_at = ? WHERE id = 'p1'")
            .bind(crate::now_iso())
            .execute(&pool)
            .await
            .unwrap();
    }
    assert_eq!(segments().await, before);
}

#[tokio::test]
async fn a_new_epoch_keeps_the_count() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Groceries"))
        .await
        .unwrap();
    let before = change_state(&pool).await.unwrap();
    new_epoch(&pool).await.unwrap();
    let after = change_state(&pool).await.unwrap();
    assert_ne!(after.epoch, before.epoch);
    assert_eq!(after.seq, before.seq);
}

#[tokio::test]
async fn a_writer_quiet_for_a_day_is_pruned_and_this_one_is_kept() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Groceries"))
        .await
        .unwrap();
    sqlx::query("INSERT INTO change_writers VALUES ('gone', 5, unixepoch() - 2 * 86400), ('recent', 2, unixepoch())")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE change_writers SET last_change_at = 0 WHERE writer = ?")
        .bind(writer_id())
        .execute(&pool)
        .await
        .unwrap();
    prune_writers(&pool).await.unwrap();
    let mut left: Vec<String> = sqlx::query_scalar("SELECT writer FROM change_writers")
        .fetch_all(&pool)
        .await
        .unwrap();
    left.sort();
    let mut expected = vec!["recent".to_string(), writer_id().to_string()];
    expected.sort();
    assert_eq!(left, expected);
}
