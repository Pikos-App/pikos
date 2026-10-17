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

#[tokio::test]
async fn the_transport_state_round_trips_and_marks_the_fetch() {
    let pool = test_pool().await;
    start(&pool).await.unwrap();

    super::set_engine_state(&pool, b"engine bytes")
        .await
        .unwrap();

    assert_eq!(
        super::engine_state(&pool).await.unwrap().as_deref(),
        Some(&b"engine bytes"[..])
    );
    let fetched: Option<String> =
        sqlx::query_scalar("SELECT last_fetch_at FROM replica_meta WHERE id = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(fetched.is_some());
}

#[tokio::test]
async fn the_device_that_started_sync_keeps_its_id() {
    let pool = test_pool().await;
    let id = start(&pool).await.unwrap().device_id.unwrap();
    super::set_engine_state(&pool, b"state").await.unwrap();

    let claimed = super::claim_device(&pool, Some(&id)).await.unwrap();

    assert_eq!(claimed.as_deref(), Some(id.as_str()));
    assert!(super::engine_state(&pool).await.unwrap().is_some());
}

#[tokio::test]
async fn a_copied_workspace_runs_as_a_new_device_and_keeps_its_clocks() {
    let pool = test_pool().await;
    let id = start(&pool).await.unwrap().device_id.unwrap();
    insert_test_page(&pool, TestPage::new("p1", "Groceries"))
        .await
        .unwrap();
    super::set_engine_state(&pool, b"state").await.unwrap();
    let before = meta(&pool).await.unwrap();

    let elsewhere = super::claim_device(&pool, Some("another-device"))
        .await
        .unwrap();
    let nothing_outside = super::claim_device(&pool, None).await.unwrap();

    assert_ne!(elsewhere.as_deref(), Some(id.as_str()));
    assert_ne!(
        nothing_outside, elsewhere,
        "nothing kept outside reads as a copy too"
    );
    assert_eq!(super::engine_state(&pool).await.unwrap(), None);
    let after = meta(&pool).await.unwrap();
    assert_eq!(after.hlc, before.hlc);
    assert!(
        pending(&pool).await > 0,
        "what was waiting to send still is"
    );
}

#[tokio::test]
async fn a_device_that_never_started_has_nothing_to_claim() {
    let pool = test_pool().await;

    assert_eq!(super::claim_device(&pool, None).await.unwrap(), None);
}

#[tokio::test]
async fn tombstones_and_holds_past_retention_are_forgotten_and_newer_ones_kept() {
    let pool = test_pool().await;
    start(&pool).await.unwrap();
    let old = pikos_replica::Hlc::new(1_000, 0).to_string();
    let recent = meta(&pool).await.unwrap().hlc.to_string();
    for (key, tomb) in [("gone-long-ago", &old), ("gone-recently", &recent)] {
        sqlx::query(
            "INSERT INTO replica_clocks (entity, key, clocks, tomb) VALUES ('page', ?, ?, ?)",
        )
        .bind(key)
        .bind(tomb.repeat(11))
        .bind(tomb)
        .execute(&pool)
        .await
        .unwrap();
    }
    for (name, since) in [("remind:old", &old), ("remind:recent", &recent)] {
        sqlx::query(
            "INSERT INTO replica_pen (name, record, since, reason) VALUES (?, '{}', ?, 'deleted_parent')",
        )
        .bind(name)
        .bind(since)
        .execute(&pool)
        .await
        .unwrap();
    }

    let forgotten = super::expire(&pool).await.unwrap();

    let clocks: Vec<String> = sqlx::query_scalar("SELECT key FROM replica_clocks ORDER BY key")
        .fetch_all(&pool)
        .await
        .unwrap();
    let held: Vec<String> = sqlx::query_scalar("SELECT name FROM replica_pen ORDER BY name")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(clocks, vec!["gone-recently"]);
    assert_eq!(held, vec!["remind:recent"]);
    assert_eq!(
        forgotten,
        vec![pikos_replica::RecordName::live(
            pikos_replica::Entity::Page,
            "gone-long-ago"
        )],
        "the transport deletes the forgotten tombstone from its store too"
    );
}

#[tokio::test]
async fn starting_queues_the_workspace_already_there_for_its_first_upload() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Groceries"))
        .await
        .unwrap();
    insert_test_page(&pool, TestPage::new("event", "Dentist"))
        .await
        .unwrap();
    insert_test_page_sync(&pool, "event", "active")
        .await
        .unwrap();

    start(&pool).await.unwrap();

    let queued: Vec<String> =
        sqlx::query_scalar("SELECT entity || ':' || key FROM replica_ops ORDER BY entity, key")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        queued,
        vec!["body:p1", "page:p1"],
        "the calendar's page stays local"
    );
}

#[tokio::test]
async fn the_summary_counts_what_waits_to_send_and_what_waits_to_apply() {
    let pool = test_pool().await;
    start(&pool).await.unwrap();
    insert_test_page(&pool, TestPage::new("p1", "Groceries"))
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO replica_pen (name, record, since, reason) VALUES ('page:x', '{}', '0', 'newer_format')",
    )
    .execute(&pool)
    .await
    .unwrap();

    let summary = super::summary(&pool).await.unwrap();

    assert!(summary.started);
    assert!(summary.pending > 0);
    assert_eq!(summary.held, 1);
    assert!(summary.needs_update);
}

#[tokio::test]
async fn a_body_saves_while_it_is_the_one_the_editor_loaded() {
    let pool = test_pool().await;
    start(&pool).await.unwrap();
    insert_test_page(&pool, TestPage::new("p1", "Groceries"))
        .await
        .unwrap();
    let loaded = super::body_clock(&pool, "p1").await.unwrap();

    let saved =
        super::save_body_if_unchanged(&pool, "p1", "{\"type\":\"doc\"}".into(), loaded.as_deref())
            .await
            .unwrap();

    let super::BodySave::Saved { clock } = saved else {
        panic!("refused a save over the body it loaded");
    };
    assert_ne!(clock, loaded, "the save moved the body's clock");
}

#[tokio::test]
async fn a_body_that_moved_since_it_was_loaded_is_handed_back_instead_of_overwritten() {
    let pool = test_pool().await;
    start(&pool).await.unwrap();
    insert_test_page(&pool, TestPage::new("p1", "Groceries"))
        .await
        .unwrap();
    let loaded = super::body_clock(&pool, "p1").await.unwrap();
    sqlx::query("UPDATE pages SET content = '{\"from\":\"the phone\"}' WHERE id = 'p1'")
        .execute(&pool)
        .await
        .unwrap();

    let saved =
        super::save_body_if_unchanged(&pool, "p1", "{\"type\":\"doc\"}".into(), loaded.as_deref())
            .await
            .unwrap();

    let super::BodySave::Moved { content, clock } = saved else {
        panic!("saved over a body that had moved on");
    };
    assert_eq!(content, "{\"from\":\"the phone\"}");
    assert_ne!(clock, loaded);
}

#[tokio::test]
async fn with_sync_off_every_body_save_goes_through() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Groceries"))
        .await
        .unwrap();

    let saved = super::save_body_if_unchanged(&pool, "p1", "{\"type\":\"doc\"}".into(), None)
        .await
        .unwrap();

    assert_eq!(saved, super::BodySave::Saved { clock: None });
}

#[tokio::test]
async fn starting_gives_a_page_timed_only_in_its_cache_a_schedule_row_to_sync() {
    let pool = test_pool().await;
    let page = crate::create_page_impl(
        &pool,
        crate::NewPage {
            scheduled_start: Some("2030-01-01T09:00:00".into()),
            scheduled_end: Some("2030-01-01T09:30:00".into()),
            ..crate::pages::pages_tests::new_page("Standup, done")
        },
    )
    .await
    .unwrap();

    start(&pool).await.unwrap();

    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT scheduled_start, scheduled_end FROM page_schedules WHERE page_id = ?",
    )
    .bind(&page.id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![(
            "2030-01-01T09:00:00".into(),
            Some("2030-01-01T09:30:00".into())
        )]
    );
}
