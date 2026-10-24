use std::collections::BTreeMap;

use pikos_replica::Entity;
use sqlx::SqlitePool;

use super::{migration_sql, triggers, MIGRATION};
use crate::replica::manifest::entity;
use crate::replica::{meta, start};
use crate::{insert_test_folder, insert_test_page, insert_test_page_sync, test_pool, TestPage};

#[derive(Debug, PartialEq, Eq)]
struct Op {
    fields: i64,
    deleted: bool,
    clock: String,
}

async fn op(pool: &SqlitePool, entity: Entity, key: &str) -> Option<Op> {
    sqlx::query_as::<_, (i64, bool, String)>(
        "SELECT fields, deleted, clock FROM replica_ops WHERE entity = ? AND key = ?",
    )
    .bind(entity.prefix())
    .bind(key)
    .fetch_optional(pool)
    .await
    .unwrap()
    .map(|(fields, deleted, clock)| Op {
        fields,
        deleted,
        clock,
    })
}

async fn clear_ops(pool: &SqlitePool) {
    sqlx::query("DELETE FROM replica_ops")
        .execute(pool)
        .await
        .unwrap();
}

/// The row's clock slots, creation first, and its tombstone clock.
async fn clocks(pool: &SqlitePool, entity: Entity, key: &str) -> (Vec<String>, Option<String>) {
    let (packed, tomb): (String, Option<String>) =
        sqlx::query_as("SELECT clocks, tomb FROM replica_clocks WHERE entity = ? AND key = ?")
            .bind(entity.prefix())
            .bind(key)
            .fetch_one(pool)
            .await
            .unwrap();
    let slots = packed
        .as_bytes()
        .chunks(20)
        .map(|c| String::from_utf8(c.to_vec()).unwrap())
        .collect();
    (slots, tomb)
}

fn bit(entity_kind: Entity, field: &str) -> i64 {
    let fields = entity(entity_kind).unwrap().fields;
    1 << fields.iter().position(|f| f.name == field).unwrap()
}

fn all_fields(entity_kind: Entity) -> i64 {
    (1 << entity(entity_kind).unwrap().fields.len()) - 1
}

async fn exec(pool: &SqlitePool, sql: &str) {
    sqlx::query(sql).execute(pool).await.unwrap();
}

async fn started_pool() -> SqlitePool {
    let pool = test_pool().await;
    start(&pool).await.unwrap();
    pool
}

#[test]
fn the_checked_in_migration_is_what_the_manifest_generates() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(MIGRATION);
    let generated = migration_sql();

    if std::env::var("UPDATE_GOLDEN").is_ok() {
        std::fs::write(&path, &generated).unwrap();
    }

    let checked_in = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        checked_in == generated,
        "{MIGRATION} is stale; regenerate with UPDATE_GOLDEN=1 cargo test -p pikos-db replica"
    );
}

#[tokio::test]
async fn the_database_has_exactly_the_generated_triggers() {
    let pool = test_pool().await;

    let installed: BTreeMap<String, String> = sqlx::query_as(
        "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'replica\\_%' ESCAPE '\\'",
    )
    .fetch_all(&pool)
    .await
    .unwrap()
    .into_iter()
    .collect();
    let generated: BTreeMap<String, String> = triggers().into_iter().collect();

    assert_eq!(installed, generated);
}

#[tokio::test]
async fn a_new_page_is_pending_whole_with_every_slot_at_one_clock() {
    let pool = started_pool().await;

    insert_test_page(&pool, TestPage::new("p1", "Groceries"))
        .await
        .unwrap();

    let page = op(&pool, Entity::Page, "p1").await.unwrap();
    let body = op(&pool, Entity::Body, "p1").await.unwrap();
    assert_eq!(page.fields, all_fields(Entity::Page));
    assert!(!page.deleted);
    assert_eq!(body.fields, all_fields(Entity::Body));
    assert_ne!(body.clock, page.clock, "each capture moves the clock");

    let (slots, tomb) = clocks(&pool, Entity::Page, "p1").await;
    assert_eq!(slots.len(), entity(Entity::Page).unwrap().fields.len() + 1);
    assert!(slots.iter().all(|s| *s == page.clock));
    assert_eq!(tomb, None);
    assert_eq!(
        meta(&pool).await.unwrap().hlc.to_string(),
        body.clock.clone().max(page.clock)
    );
}

#[tokio::test]
async fn an_edit_marks_only_the_fields_it_changed() {
    let pool = test_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Groceries"))
        .await
        .unwrap();
    let base = start(&pool).await.unwrap().base_clock.unwrap().to_string();
    clear_ops(&pool).await;

    exec(
        &pool,
        "UPDATE pages SET title = 'Groceries, Saturday', priority = 2 WHERE id = 'p1'",
    )
    .await;

    let page = op(&pool, Entity::Page, "p1").await.unwrap();
    assert_eq!(
        page.fields,
        bit(Entity::Page, "title") | bit(Entity::Page, "priority")
    );
    assert_eq!(op(&pool, Entity::Body, "p1").await, None);

    let (slots, _) = clocks(&pool, Entity::Page, "p1").await;
    let fields = entity(Entity::Page).unwrap().fields;
    for (i, field) in fields.iter().enumerate() {
        let expected = if matches!(field.name, "title" | "priority") {
            &page.clock
        } else {
            &base
        };
        assert_eq!(&slots[i + 1], expected, "{}", field.name);
    }
    assert_eq!(
        slots[0], base,
        "a row from before sync started was born at the base clock"
    );
}

#[tokio::test]
async fn a_second_edit_adds_to_the_pending_fields_and_moves_the_clock() {
    let pool = started_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Groceries"))
        .await
        .unwrap();
    clear_ops(&pool).await;

    exec(
        &pool,
        "UPDATE pages SET title = 'Groceries, Saturday' WHERE id = 'p1'",
    )
    .await;
    let first = op(&pool, Entity::Page, "p1").await.unwrap();
    exec(
        &pool,
        "UPDATE pages SET status = 'done', completed_at = '2026-10-16T09:00:00' WHERE id = 'p1'",
    )
    .await;
    let second = op(&pool, Entity::Page, "p1").await.unwrap();

    assert_eq!(
        second.fields,
        bit(Entity::Page, "title") | bit(Entity::Page, "status")
    );
    assert!(second.clock > first.clock);
}

#[tokio::test]
async fn derived_and_device_only_columns_capture_nothing() {
    let pool = started_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Groceries"))
        .await
        .unwrap();
    clear_ops(&pool).await;
    let hlc = meta(&pool).await.unwrap().hlc;

    exec(
        &pool,
        "UPDATE pages SET content_text = 'milk', last_opened_at = 'now', updated_at = 'now',
         scheduled_start = '2026-10-17' WHERE id = 'p1'",
    )
    .await;

    let ops: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM replica_ops")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(ops, 0);
    assert_eq!(
        meta(&pool).await.unwrap().hlc,
        hlc,
        "the clock moves only on a capture"
    );
}

#[tokio::test]
async fn a_body_edit_is_its_own_record() {
    let pool = started_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Groceries"))
        .await
        .unwrap();
    clear_ops(&pool).await;

    crate::page_chunks::write_body(&pool, "p1", crate::page_chunks::EMPTY_BODY)
        .await
        .unwrap();

    assert_eq!(op(&pool, Entity::Page, "p1").await, None);
    assert_eq!(
        op(&pool, Entity::Body, "p1").await.unwrap().fields,
        all_fields(Entity::Body)
    );
}

async fn page_with_children(pool: &SqlitePool) {
    insert_test_folder(pool, "f1", "Home").await.unwrap();
    insert_test_page(
        pool,
        TestPage {
            folder_id: Some("f1"),
            ..TestPage::new("p1", "Groceries")
        },
    )
    .await
    .unwrap();
    insert_test_page(pool, TestPage::new("child", "Milk"))
        .await
        .unwrap();
    exec(pool, "UPDATE pages SET parent_id = 'p1' WHERE id = 'child'").await;
    exec(
        pool,
        "INSERT INTO page_reminders (id, page_id, minutes_before, created_at) VALUES ('r1', 'p1', 10, 'x');
         INSERT INTO tags (id, name, created_at) VALUES ('t1', 'errands', 'x');
         INSERT INTO page_tags (page_id, tag_id) VALUES ('p1', 't1');
         INSERT INTO page_schedules (id, page_id, scheduled_start, created_at) VALUES ('s1', 'p1', '2026-10-17', 'x');
         INSERT INTO focus_sessions (id, page_id, started_at) VALUES ('fs1', 'p1', 'x');",
    )
    .await;
}

#[tokio::test]
async fn domain_keyed_rows_are_named_by_their_values() {
    let pool = started_pool().await;

    page_with_children(&pool).await;

    assert!(op(&pool, Entity::Tag, "errands").await.is_some());
    assert!(op(&pool, Entity::PageTag, "p1/errands").await.is_some());
    assert!(op(&pool, Entity::Schedule, "s1").await.is_some());
    assert!(op(&pool, Entity::Reminder, "r1").await.is_some());
}

#[tokio::test]
async fn purging_a_page_sends_its_tombstone_and_none_for_what_cascades() {
    let pool = started_pool().await;
    page_with_children(&pool).await;
    clear_ops(&pool).await;

    exec(&pool, "DELETE FROM pages WHERE id = 'p1'").await;

    let page = op(&pool, Entity::Page, "p1").await.unwrap();
    assert!(page.deleted);
    assert_eq!(page.fields, 0);
    let (_, tomb) = clocks(&pool, Entity::Page, "p1").await;
    assert_eq!(tomb, Some(page.clock));

    let others: Vec<(String, String)> = sqlx::query_as(
        "SELECT entity, key FROM replica_ops WHERE NOT (entity = 'page' AND key = 'p1')",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        others,
        vec![],
        "children deleted by the cascade, the child page's parent and the focus session's page \
         set NULL by it, are every device's own to repeat"
    );
}

#[tokio::test]
async fn deleting_a_calendar_event_page_captures_nothing_and_a_detached_one_its_tombstone() {
    let pool = started_pool().await;
    for (id, link) in [("mirror", "active"), ("kept", "detached")] {
        insert_test_page(&pool, TestPage::new(id, "Standup"))
            .await
            .unwrap();
        insert_test_page_sync(&pool, id, link).await.unwrap();
    }
    clear_ops(&pool).await;

    exec(&pool, "DELETE FROM pages WHERE id IN ('mirror', 'kept')").await;

    assert_eq!(op(&pool, Entity::Page, "mirror").await, None);
    assert!(op(&pool, Entity::Page, "kept").await.unwrap().deleted);
}

#[tokio::test]
async fn purging_a_folder_leaves_its_pages_folder_change_uncaptured() {
    let pool = started_pool().await;
    page_with_children(&pool).await;
    clear_ops(&pool).await;

    exec(&pool, "DELETE FROM folders WHERE id = 'f1'").await;

    assert!(op(&pool, Entity::Folder, "f1").await.unwrap().deleted);
    assert_eq!(op(&pool, Entity::Page, "p1").await, None);
}

#[tokio::test]
async fn moving_a_page_out_of_a_folder_that_still_exists_is_captured() {
    let pool = started_pool().await;
    page_with_children(&pool).await;
    clear_ops(&pool).await;

    exec(&pool, "UPDATE pages SET folder_id = NULL WHERE id = 'p1'").await;

    assert_eq!(
        op(&pool, Entity::Page, "p1").await.unwrap().fields,
        bit(Entity::Page, "folder_id")
    );
}

#[tokio::test]
async fn removing_a_child_directly_sends_its_removal() {
    let pool = started_pool().await;
    page_with_children(&pool).await;
    clear_ops(&pool).await;

    exec(
        &pool,
        "DELETE FROM page_reminders WHERE id = 'r1'; DELETE FROM page_tags WHERE page_id = 'p1'",
    )
    .await;

    assert!(op(&pool, Entity::Reminder, "r1").await.unwrap().deleted);
    assert!(
        op(&pool, Entity::PageTag, "p1/errands")
            .await
            .unwrap()
            .deleted
    );
}

#[tokio::test]
async fn an_override_is_named_by_its_page_and_date_and_goes_with_its_rule() {
    let pool = started_pool().await;
    insert_test_page(&pool, TestPage::new("p1", "Standup"))
        .await
        .unwrap();
    exec(
        &pool,
        "INSERT INTO page_recurrence_rules (id, page_id, rrule, scheduled_start, timezone, created_at)
           VALUES ('rule-here', 'p1', 'FREQ=DAILY', '2026-10-16T09:00:00', 'UTC', 'x');
         INSERT INTO page_schedules (id, page_id, scheduled_start, rule_id, original_date, created_at)
           VALUES ('o1', 'p1', '2026-10-18T10:00:00', 'rule-here', '2026-10-18', 'x');",
    )
    .await;

    assert!(op(&pool, Entity::Rule, "p1").await.is_some());
    assert!(op(&pool, Entity::Override, "p1/2026-10-18").await.is_some());
    assert_eq!(op(&pool, Entity::Schedule, "o1").await, None);
    clear_ops(&pool).await;

    exec(
        &pool,
        "DELETE FROM page_recurrence_rules WHERE id = 'rule-here'",
    )
    .await;

    assert!(op(&pool, Entity::Rule, "p1").await.unwrap().deleted);
    assert_eq!(
        op(&pool, Entity::Override, "p1/2026-10-18").await,
        None,
        "the override went with its rule, as it will on every device"
    );
}

#[tokio::test]
async fn a_row_created_again_after_its_delete_is_live_with_a_fresh_clock_and_keeps_the_delete() {
    let pool = started_pool().await;
    page_with_children(&pool).await;
    exec(&pool, "DELETE FROM skip_set").await;
    exec(
        &pool,
        "INSERT INTO skip_set (page_id, occurrence_date) VALUES ('p1', '2026-10-18')",
    )
    .await;
    exec(&pool, "DELETE FROM skip_set WHERE page_id = 'p1'").await;
    let removed = op(&pool, Entity::Skipped, "p1/2026-10-18").await.unwrap();

    exec(
        &pool,
        "INSERT INTO skip_set (page_id, occurrence_date) VALUES ('p1', '2026-10-18')",
    )
    .await;

    let readded = op(&pool, Entity::Skipped, "p1/2026-10-18").await.unwrap();
    assert!(removed.deleted);
    assert!(!readded.deleted);
    assert!(readded.clock > removed.clock);
    let (slots, tomb) = clocks(&pool, Entity::Skipped, "p1/2026-10-18").await;
    assert_eq!(
        tomb,
        Some(removed.clock),
        "the delete is remembered, so hearing of it again isn't news"
    );
    assert_eq!(slots, vec![readded.clock]);
}

#[tokio::test]
async fn an_unreadable_clock_fails_the_write_instead_of_restarting_time() {
    let pool = started_pool().await;
    exec(&pool, "UPDATE replica_meta SET hlc = 'garbage'").await;

    let result = insert_test_page(&pool, TestPage::new("p1", "Groceries")).await;

    assert!(result.is_err());
}
