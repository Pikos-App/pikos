use std::collections::BTreeMap;

use pikos_replica::codec::FieldMap;
use pikos_replica::merge::Value;
use pikos_replica::{Entity, RecordName, FORMAT_VERSION};
use sqlx::SqlitePool;

use super::{apply, Applied};
use crate::replica::build::{build, pending, sent};
use crate::replica::{meta, start, state};
use crate::*;

async fn device() -> SqlitePool {
    let pool = test_pool().await;
    start(&pool).await.unwrap();
    pool
}

/// What a transport carries from `from` to `to` in one round: every pending record, applied in
/// one batch, then reported sent.
async fn send(from: &SqlitePool, to: &SqlitePool) -> Applied {
    let names = pending(from, 100_000).await.unwrap();
    let built = build(from, &names).await.unwrap();
    let records: Vec<(RecordName, FieldMap)> = built
        .iter()
        .map(|b| (b.name.clone(), b.fields.clone()))
        .collect();
    let applied = apply(to, &records).await.unwrap();
    let acked: Vec<_> = built.iter().map(|b| (b.name.clone(), b.clock)).collect();
    sent(from, &acked).await.unwrap();
    applied
}

async fn converge(a: &SqlitePool, b: &SqlitePool) {
    for _ in 0..3 {
        send(a, b).await;
        send(b, a).await;
    }
}

/// Every synced row's values, by record name.
async fn synced(pool: &SqlitePool) -> BTreeMap<String, Vec<Vec<String>>> {
    state::synced_rows(pool)
        .await
        .unwrap()
        .into_iter()
        .map(|row| (row.name.to_string(), row.fields))
        .collect()
}

async fn assert_converged(a: &SqlitePool, b: &SqlitePool) {
    assert_eq!(synced(a).await, synced(b).await);
}

async fn deleted_at(pool: &SqlitePool, id: &str) -> Option<String> {
    sqlx::query_scalar("SELECT deleted_at FROM pages WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn text(pool: &SqlitePool, sql: &str) -> Option<String> {
    sqlx::query_scalar(sql)
        .fetch_optional(pool)
        .await
        .unwrap()
        .flatten()
}

fn new_page(title: &str) -> NewPage {
    NewPage {
        folder_id: None,
        title: title.into(),
        subtitle: None,
        content: "{}".into(),
        content_text: None,
        status: "not_started".into(),
        priority: 0,
        tags: vec![],
        scheduled_start: None,
        scheduled_end: None,
        completed_at: None,
        links: vec![],
        parent_id: None,
        last_opened_at: None,
        created_at: None,
        updated_at: None,
    }
}

const BODY: &str = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"oat milk"}]}]}"#;

#[tokio::test]
async fn a_page_made_on_one_device_arrives_whole_on_the_other() {
    let (mac, phone) = (device().await, device().await);
    let folder = create_folder_impl(
        &mac,
        NewFolder {
            name: "Home".into(),
            parent_id: None,
            color: Some("red".into()),
            icon: None,
        },
    )
    .await
    .unwrap();
    let page = create_page_impl(
        &mac,
        NewPage {
            folder_id: Some(folder.id.clone()),
            content: BODY.into(),
            tags: vec!["errands".into(), "weekend".into()],
            ..new_page("Groceries")
        },
    )
    .await
    .unwrap();
    create_page_schedule_impl(
        &mac,
        NewPageSchedule {
            page_id: page.id.clone(),
            scheduled_start: "2030-01-05T09:00:00".into(),
            scheduled_end: Some("2030-01-05T10:00:00".into()),
            timezone: Some("UTC".into()),
            rule_id: None,
            original_date: None,
        },
    )
    .await
    .unwrap();
    create_page_reminder(&mac, &page.id, 15).await.unwrap();

    send(&mac, &phone).await;

    assert_converged(&mac, &phone).await;
    let on_phone = get_page(&phone, &page.id).await.unwrap().unwrap();
    assert_eq!(on_phone.title, "Groceries");
    assert_eq!(on_phone.folder_id.as_deref(), Some(folder.id.as_str()));
    assert_eq!(
        on_phone.tags,
        vec!["errands", "weekend"],
        "the tag cache is rebuilt"
    );
    assert_eq!(
        on_phone.content_text.as_deref(),
        Some("oat milk"),
        "the search text is rebuilt"
    );
    assert_eq!(
        on_phone.scheduled_start.as_deref(),
        Some("2030-01-05T09:00:00"),
        "the schedule cache is rebuilt"
    );
    let found = search_pages_impl(&phone, "oat".into(), None).await.unwrap();
    assert_eq!(
        found.results.len(),
        1,
        "and the page is in the search index"
    );
}

#[tokio::test]
async fn a_note_written_before_the_other_device_turned_sync_on_keeps_its_body() {
    let mac = device().await;
    let page = create_page_impl(
        &mac,
        NewPage {
            content: BODY.into(),
            ..new_page("Groceries")
        },
    )
    .await
    .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let phone = device().await;

    send(&mac, &phone).await;

    let on_phone = get_page(&phone, &page.id).await.unwrap().unwrap();
    assert_eq!(on_phone.content, BODY);
    assert_converged(&mac, &phone).await;
}

#[tokio::test]
async fn edits_to_different_fields_on_two_devices_both_survive() {
    let (mac, phone) = (device().await, device().await);
    let page = create_page_impl(&mac, new_page("Groceries")).await.unwrap();
    converge(&mac, &phone).await;

    update_page_impl(
        &mac,
        page.id.clone(),
        PageUpdate {
            title: Some("Groceries, Saturday".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    set_pages_status_impl(
        &phone,
        std::slice::from_ref(&page.id),
        "done",
        Some("2026-10-16T21:00:00"),
    )
    .await
    .unwrap();
    converge(&mac, &phone).await;

    assert_converged(&mac, &phone).await;
    let merged = get_page(&mac, &page.id).await.unwrap().unwrap();
    assert_eq!(merged.title, "Groceries, Saturday");
    assert_eq!(merged.status, "done");
}

#[tokio::test]
async fn the_later_edit_to_one_field_wins_on_both() {
    let (mac, phone) = (device().await, device().await);
    let page = create_page_impl(&mac, new_page("Groceries")).await.unwrap();
    converge(&mac, &phone).await;

    let retitle = |pool: &SqlitePool, title: &str| {
        let (pool, id, title) = (pool.clone(), page.id.clone(), title.to_owned());
        async move {
            update_page_impl(
                &pool,
                id,
                PageUpdate {
                    title: Some(title),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
    };
    retitle(&mac, "Earlier").await;
    tokio::time::sleep(std::time::Duration::from_millis(3)).await;
    retitle(&phone, "Later").await;
    converge(&mac, &phone).await;

    assert_converged(&mac, &phone).await;
    assert_eq!(
        get_page(&mac, &page.id).await.unwrap().unwrap().title,
        "Later"
    );
}

#[tokio::test]
async fn a_purge_reaches_the_other_device_with_everything_under_the_page() {
    let (mac, phone) = (device().await, device().await);
    let page = create_page_impl(
        &mac,
        NewPage {
            tags: vec!["errands".into()],
            ..new_page("Groceries")
        },
    )
    .await
    .unwrap();
    create_page_reminder(&mac, &page.id, 15).await.unwrap();
    converge(&mac, &phone).await;

    hard_delete_page_impl(&mac, &page.id).await.unwrap();
    converge(&mac, &phone).await;

    assert_converged(&mac, &phone).await;
    assert!(get_page(&phone, &page.id).await.unwrap().is_none());
    let reminders: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM page_reminders")
        .fetch_one(&phone)
        .await
        .unwrap();
    assert_eq!(reminders, 0);
}

#[tokio::test]
async fn an_edit_made_after_a_purge_brings_the_page_back_everywhere() {
    let (mac, phone) = (device().await, device().await);
    let page = create_page_impl(&mac, new_page("Groceries")).await.unwrap();
    create_page_reminder(&mac, &page.id, 15).await.unwrap();
    converge(&mac, &phone).await;

    hard_delete_page_impl(&mac, &page.id).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(3)).await;
    update_page_impl(
        &phone,
        page.id.clone(),
        PageUpdate {
            title: Some("Still need these".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    converge(&mac, &phone).await;

    assert_converged(&mac, &phone).await;
    let back = get_page(&mac, &page.id).await.unwrap().unwrap();
    assert_eq!(back.title, "Still need these");
    let reminders: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM page_reminders")
        .fetch_one(&mac)
        .await
        .unwrap();
    assert_eq!(reminders, 1, "its children came back with it");
}

#[tokio::test]
async fn an_edit_made_before_a_purge_loses_to_it() {
    let (mac, phone) = (device().await, device().await);
    let page = create_page_impl(&mac, new_page("Groceries")).await.unwrap();
    converge(&mac, &phone).await;

    update_page_impl(
        &phone,
        page.id.clone(),
        PageUpdate {
            title: Some("Edited offline".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(3)).await;
    hard_delete_page_impl(&mac, &page.id).await.unwrap();
    converge(&mac, &phone).await;

    assert_converged(&mac, &phone).await;
    assert!(get_page(&phone, &page.id).await.unwrap().is_none());
}

#[tokio::test]
async fn a_child_that_arrives_before_its_page_waits_for_it() {
    let (mac, phone) = (device().await, device().await);
    let page = create_page_impl(&mac, new_page("Groceries")).await.unwrap();
    create_page_reminder(&mac, &page.id, 15).await.unwrap();

    let names = pending(&mac, 100).await.unwrap();
    let built = build(&mac, &names).await.unwrap();
    let (children, parents): (Vec<_>, Vec<_>) = built
        .into_iter()
        .map(|b| (b.name, b.fields))
        .partition(|(name, _)| name.entity == Entity::Reminder);

    let first = apply(&phone, &children).await.unwrap();
    assert_eq!(first.held, 1);
    let second = apply(&phone, &parents).await.unwrap();

    assert_eq!(
        second.held, 0,
        "the held reminder applied once its page arrived"
    );
    let reminders: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM page_reminders")
        .fetch_one(&phone)
        .await
        .unwrap();
    assert_eq!(reminders, 1);
}

#[tokio::test]
async fn a_page_in_a_purged_folder_lands_in_the_inbox() {
    let (mac, phone) = (device().await, device().await);
    let folder = create_folder_impl(
        &mac,
        NewFolder {
            name: "Old".into(),
            parent_id: None,
            color: None,
            icon: None,
        },
    )
    .await
    .unwrap();
    converge(&mac, &phone).await;
    delete_folder_impl(&mac, folder.id.clone()).await.unwrap();
    converge(&mac, &phone).await;

    let page = create_page_impl(&phone, new_page("Made before the purge arrived"))
        .await
        .unwrap();
    let names = vec![RecordName::live(Entity::Page, page.id.clone())];
    let mut built = build(&phone, &names).await.unwrap();
    built[0]
        .fields
        .insert("folder_id.0".into(), Value::Text(folder.id.clone()));

    apply(&mac, &[(built[0].name.clone(), built[0].fields.clone())])
        .await
        .unwrap();

    let landed = get_page(&mac, &page.id).await.unwrap().unwrap();
    assert_eq!(landed.folder_id, None);
}

#[tokio::test]
async fn a_record_from_a_newer_pikos_waits_rather_than_being_dropped() {
    let (mac, phone) = (device().await, device().await);
    let page = create_page_impl(&mac, new_page("From the future"))
        .await
        .unwrap();
    let names = pending(&mac, 100).await.unwrap();
    let mut built = build(&mac, &names).await.unwrap();
    for record in &mut built {
        record
            .fields
            .insert("fmt".into(), Value::Integer(i64::from(FORMAT_VERSION) + 1));
    }
    let records: Vec<_> = built
        .iter()
        .map(|b| (b.name.clone(), b.fields.clone()))
        .collect();

    let applied = apply(&phone, &records).await.unwrap();

    assert_eq!(applied.held, records.len());
    assert!(get_page(&phone, &page.id).await.unwrap().is_none());
    let reason = text(&phone, "SELECT reason FROM replica_pen LIMIT 1").await;
    assert_eq!(reason.as_deref(), Some("newer_format"));
}

#[tokio::test]
async fn applying_a_batch_twice_changes_nothing_the_second_time() {
    let (mac, phone) = (device().await, device().await);
    create_page_impl(
        &mac,
        NewPage {
            tags: vec!["errands".into()],
            ..new_page("Groceries")
        },
    )
    .await
    .unwrap();
    let names = pending(&mac, 100).await.unwrap();
    let built = build(&mac, &names).await.unwrap();
    let records: Vec<_> = built
        .iter()
        .map(|b| (b.name.clone(), b.fields.clone()))
        .collect();

    let first = apply(&phone, &records).await.unwrap();
    let before = synced(&phone).await;
    let second = apply(&phone, &records).await.unwrap();

    assert!(first.changed > 0);
    assert_eq!(second.changed, 0);
    assert_eq!(synced(&phone).await, before);
}

#[tokio::test]
async fn applying_is_not_sent_back_and_moves_the_clock_past_what_arrived() {
    let (mac, phone) = (device().await, device().await);
    create_page_impl(&mac, new_page("Groceries")).await.unwrap();
    let mac_clock = meta(&mac).await.unwrap().hlc;

    send(&mac, &phone).await;

    assert!(pending(&phone, 100).await.unwrap().is_empty());
    assert!(meta(&phone).await.unwrap().hlc >= mac_clock);
}

#[tokio::test]
async fn trashing_and_restoring_travel() {
    let (mac, phone) = (device().await, device().await);
    let page = create_page_impl(&mac, new_page("Groceries")).await.unwrap();
    converge(&mac, &phone).await;

    soft_delete_page_impl(&mac, &page.id).await.unwrap();
    converge(&mac, &phone).await;
    let trashed = deleted_at(&phone, &page.id).await;
    restore_page_impl(&phone, &page.id).await.unwrap();
    converge(&mac, &phone).await;

    assert!(trashed.is_some());
    assert_converged(&mac, &phone).await;
    assert_eq!(deleted_at(&mac, &page.id).await, None);
}

#[tokio::test]
async fn a_completed_occurrence_travels_with_its_done_copy() {
    let (mac, phone) = (device().await, device().await);
    let standup = create_page_impl(&mac, new_page("Standup")).await.unwrap();
    create_recurrence_rule_impl(
        &mac,
        NewRecurrenceRule {
            page_id: standup.id.clone(),
            rrule: "FREQ=DAILY".into(),
            rrule_exdates: vec![],
            scheduled_start: "2026-10-16T09:00:00".into(),
            scheduled_end: Some("2026-10-16T09:15:00".into()),
            timezone: "UTC".into(),
        },
    )
    .await
    .unwrap();
    converge(&mac, &phone).await;

    complete_recurring_page_impl(
        &mac,
        CompleteRecurringInput {
            page_id: standup.id.clone(),
            occurrence_date: None,
            scheduled_start: None,
            scheduled_end: None,
            expected_occurrence_date: None,
        },
    )
    .await
    .unwrap();
    converge(&mac, &phone).await;

    assert_converged(&mac, &phone).await;
    let head = |pool: &SqlitePool| {
        let (pool, id) = (pool.clone(), standup.id.clone());
        async move { get_page(&pool, &id).await.unwrap().unwrap().scheduled_start }
    };
    assert_eq!(
        head(&mac).await,
        head(&phone).await,
        "the head moved on both"
    );
}

async fn link_state(pool: &SqlitePool, page: &str, state: &str) {
    sqlx::query("UPDATE page_sync SET sync_state = ? WHERE page_id = ?")
        .bind(state)
        .bind(page)
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn a_calendar_page_stays_local_until_it_detaches_then_leaves_again_when_it_relinks() {
    let (mac, phone) = (device().await, device().await);
    insert_test_page(&mac, TestPage::new("event", "Dentist"))
        .await
        .unwrap();
    insert_test_page_sync(&mac, "event", "active")
        .await
        .unwrap();
    create_page_reminder(&mac, "event", 15).await.unwrap();

    send(&mac, &phone).await;
    assert!(get_page(&phone, "event").await.unwrap().is_none());

    link_state(&mac, "event", "detached").await;
    send(&mac, &phone).await;
    let arrived = get_page(&phone, "event").await.unwrap();
    let reminders: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM page_reminders")
        .fetch_one(&phone)
        .await
        .unwrap();
    assert_eq!(arrived.map(|p| p.title).as_deref(), Some("Dentist"));
    assert_eq!(reminders, 1, "it arrives with what hangs off it");

    link_state(&mac, "event", "active").await;
    send(&mac, &phone).await;
    assert!(
        get_page(&phone, "event").await.unwrap().is_none(),
        "every device mirrors the event itself again"
    );
    assert!(get_page(&mac, "event").await.unwrap().is_some());
}

#[tokio::test]
async fn a_page_that_left_scope_and_came_back_arrives_again() {
    let (mac, phone) = (device().await, device().await);
    insert_test_page(&mac, TestPage::new("event", "Dentist"))
        .await
        .unwrap();
    insert_test_page_sync(&mac, "event", "detached")
        .await
        .unwrap();
    send(&mac, &phone).await;
    link_state(&mac, "event", "active").await;
    send(&mac, &phone).await;

    link_state(&mac, "event", "detached").await;
    send(&mac, &phone).await;

    assert!(get_page(&phone, "event").await.unwrap().is_some());
}
