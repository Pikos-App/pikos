use pikos_replica::codec::FieldMap;
use pikos_replica::merge::Value;
use pikos_replica::{Entity, RecordName, FORMAT_VERSION};
use sqlx::SqlitePool;

use super::apply;
use crate::replica::build::{build, pending, sent};
use crate::replica::two_devices::*;
use crate::replica::{meta, start};
use crate::*;

async fn deleted_at(pool: &SqlitePool, id: &str) -> Option<String> {
    sqlx::query_scalar("SELECT deleted_at FROM pages WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

const BODY: &str = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"oat milk"}]}]}"#;

// qa: CLOUD-01, CLOUD-73
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

// qa: CLOUD-07
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

// qa: CLOUD-02
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

// qa: CLOUD-69:2
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
        .insert("folder_id_0".into(), Value::Text(folder.id.clone()));

    apply(&mac, &[(built[0].name.clone(), built[0].fields.clone())])
        .await
        .unwrap();

    let landed = get_page(&mac, &page.id).await.unwrap().unwrap();
    assert_eq!(landed.folder_id, None);
}

// qa: CLOUD-115
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
async fn a_record_whose_write_fails_waits_and_the_rest_of_its_batch_still_applies() {
    let (mac, phone) = (device().await, device().await);
    let kept = create_page_impl(&mac, new_page("Kept")).await.unwrap();
    let refused = create_page_impl(&mac, new_page("Refused")).await.unwrap();
    let refused_name = RecordName::live(Entity::Page, refused.id.clone());
    let names = pending(&mac, 100).await.unwrap();
    let records: Vec<_> = build(&mac, &names)
        .await
        .unwrap()
        .into_iter()
        .map(|b| {
            let mut fields = b.fields;
            if b.name == refused_name {
                fields.insert(
                    pikos_replica::codec::column_key("status", 0),
                    Value::Text("someday".into()),
                );
            }
            (b.name, fields)
        })
        .collect();

    apply(&phone, &records).await.unwrap();

    assert!(get_page(&phone, &kept.id).await.unwrap().is_some());
    assert!(get_page(&phone, &refused.id).await.unwrap().is_none());
    let (reason, error): (String, Option<String>) =
        sqlx::query_as("SELECT reason, error FROM replica_pen WHERE name = ?")
            .bind(refused_name.to_string())
            .fetch_one(&phone)
            .await
            .unwrap();
    assert_eq!(reason, "failed");
    assert!(error.unwrap().contains("pages.status"));
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

// qa: CLOUD-11, CLOUD-12
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

// qa: CLOUD-43
#[tokio::test]
async fn a_completed_occurrence_travels_with_its_done_copy_at_its_time() {
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

    let done = complete_recurring_page_impl(
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
    .unwrap()
    .clone;
    converge(&mac, &phone).await;

    assert_converged(&mac, &phone).await;
    let on_phone = get_page(&phone, &done.id).await.unwrap().unwrap();
    assert_eq!(
        on_phone.scheduled_start.as_deref(),
        Some("2026-10-16T09:00:00"),
        "the done copy keeps the ticked occurrence's time"
    );
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

// qa: CLOUD-70:2, CLOUD-98
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

// qa: CLOUD-111
#[tokio::test]
async fn a_new_phone_joining_takes_the_macs_workspace_instead_of_adding_its_first_run_pages() {
    let mac = device().await;
    create_page_impl(&mac, new_page("Groceries")).await.unwrap();
    let phone = test_pool().await;
    insert_test_folder(&phone, "start", "Start here")
        .await
        .unwrap();
    insert_test_page(
        &phone,
        TestPage {
            folder_id: Some("start"),
            ..TestPage::new("welcome", "Welcome to Pikos")
        },
    )
    .await
    .unwrap();
    crate::replica::record_seed(&phone).await.unwrap();
    insert_test_page(&phone, TestPage::new("event", "Dentist"))
        .await
        .unwrap();
    insert_test_page_sync(&phone, "event", "active")
        .await
        .unwrap();
    start(&phone).await.unwrap();

    assert_eq!(
        crate::replica::plan_join(&phone).await.unwrap(),
        crate::replica::Join::Replace
    );
    let mac_workspace = meta(&mac).await.unwrap().workspace_id;
    crate::replica::clear_for_join(&phone, &mac_workspace)
        .await
        .unwrap();
    send(&mac, &phone).await;

    assert_converged(&mac, &phone).await;
    assert_eq!(meta(&phone).await.unwrap().workspace_id, mac_workspace);
    assert!(get_page(&phone, "welcome").await.unwrap().is_none());
    assert!(
        get_page(&phone, "event").await.unwrap().is_some(),
        "the phone's own calendar stays"
    );
    assert!(
        pending(&phone, 10).await.unwrap().is_empty(),
        "clearing sends nothing"
    );
}

#[tokio::test]
async fn a_used_workspace_joining_merges() {
    let phone = device().await;
    create_page_impl(&phone, new_page("Made on the phone"))
        .await
        .unwrap();

    assert_eq!(
        crate::replica::plan_join(&phone).await.unwrap(),
        crate::replica::Join::Merge
    );
}

/// Sends everything pending to a zone of its own, as a device does before it has seen another, and
/// returns what that zone then holds.
async fn send_to_own_zone(pool: &SqlitePool) -> Vec<(RecordName, FieldMap)> {
    let names = pending(pool, 100_000).await.unwrap();
    let built = build(pool, &names).await.unwrap();
    let acked: Vec<_> = built.iter().map(|b| (b.name.clone(), b.clock)).collect();
    sent(pool, &acked).await.unwrap();
    built.into_iter().map(|b| (b.name, b.fields)).collect()
}

// qa: CLOUD-112
#[tokio::test]
async fn a_delete_sent_to_a_zone_that_lost_reaches_the_zone_moved_into() {
    let (mac, phone) = (device().await, device().await);
    let page = create_page_impl(&mac, new_page("Groceries")).await.unwrap();
    send(&mac, &phone).await;
    delete_page_impl(&phone, &page.id).await.unwrap();
    send_to_own_zone(&phone).await;

    let mac_workspace = meta(&mac).await.unwrap().workspace_id;
    crate::replica::adopt_workspace_id(&phone, &mac_workspace)
        .await
        .unwrap();
    send(&phone, &mac).await;

    assert!(get_page(&mac, &page.id).await.unwrap().is_none());
    assert_converged(&mac, &phone).await;
}

// qa: CLOUD-110:2
#[tokio::test]
async fn two_devices_that_each_synced_alone_settle_in_one_zone_with_both_pages() {
    let mac = device().await;
    let phone = device().await;
    create_page_impl(&mac, new_page("Made on the Mac"))
        .await
        .unwrap();
    create_page_impl(&phone, new_page("Made on the phone"))
        .await
        .unwrap();
    let mac_zone = send_to_own_zone(&mac).await;
    let phone_zone = send_to_own_zone(&phone).await;
    let zone = |pool: &SqlitePool| {
        let pool = pool.clone();
        async move { pikos_replica::zone::zone_name(&meta(&pool).await.unwrap().workspace_id) }
    };
    let zones = vec![zone(&mac).await, zone(&phone).await];
    let winner = zones.iter().min().unwrap().clone();
    let (mover, held) = if winner == zones[0] {
        (&phone, mac_zone)
    } else {
        (&mac, phone_zone)
    };

    let mac_joined = crate::replica::join(&mac, &zones).await.unwrap();
    let phone_joined = crate::replica::join(&phone, &zones).await.unwrap();
    apply(mover, &held).await.unwrap();
    converge(&mac, &phone).await;

    assert_eq!(mac_joined, winner);
    assert_eq!(phone_joined, winner);
    assert_eq!(zone(&mac).await, zone(&phone).await);
    assert_converged(&mac, &phone).await;
    assert_eq!(
        synced(&mac)
            .await
            .keys()
            .filter(|k| k.starts_with("page:"))
            .count(),
        2
    );
}

// qa: CLOUD-81:2, CLOUD-82:2
#[tokio::test]
async fn a_restore_made_offline_before_another_device_empties_the_trash_wins() {
    let (mac, phone) = (device().await, device().await);
    let page = create_page_impl(&mac, new_page("Groceries")).await.unwrap();
    converge(&mac, &phone).await;
    soft_delete_page_impl(&mac, &page.id).await.unwrap();
    converge(&mac, &phone).await;

    tokio::time::sleep(std::time::Duration::from_millis(3)).await;
    restore_page_impl(&phone, &page.id).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(3)).await;
    let swept = purge_trashed_pages_older_than(&mac, 0).await.unwrap();
    converge(&mac, &phone).await;

    assert_eq!(
        swept, 1,
        "the sweep ran after the restore, on a device that hadn't seen it"
    );
    assert_converged(&mac, &phone).await;
    assert!(get_page(&mac, &page.id).await.unwrap().is_some());
    assert_eq!(deleted_at(&mac, &page.id).await, None);
}

// qa: CLOUD-81:2
#[tokio::test]
async fn emptying_the_trash_with_no_restore_anywhere_removes_the_page_everywhere() {
    let (mac, phone) = (device().await, device().await);
    let page = create_page_impl(&mac, new_page("Groceries")).await.unwrap();
    converge(&mac, &phone).await;
    soft_delete_page_impl(&mac, &page.id).await.unwrap();
    converge(&mac, &phone).await;

    purge_trashed_pages_older_than(&mac, 0).await.unwrap();
    converge(&mac, &phone).await;

    assert!(get_page(&phone, &page.id).await.unwrap().is_none());
}

#[tokio::test]
async fn no_reminders_set_on_one_device_beats_a_reminder_added_on_the_other() {
    let (mac, phone) = (device().await, device().await);
    let page = create_page_impl(&mac, new_page("Dentist")).await.unwrap();
    converge(&mac, &phone).await;

    create_page_reminder(&mac, &page.id, -1).await.unwrap();
    create_page_reminder(&phone, &page.id, 15).await.unwrap();
    converge(&mac, &phone).await;

    assert_eq!(leads(&mac, &page.id).await, vec![-1]);
    assert_eq!(leads(&phone, &page.id).await, vec![-1]);
}

// qa: CLOUD-22
#[tokio::test]
async fn the_same_reminder_added_on_both_devices_counts_once() {
    let (mac, phone) = (device().await, device().await);
    let page = create_page_impl(&mac, new_page("Dentist")).await.unwrap();
    converge(&mac, &phone).await;

    create_page_reminder(&mac, &page.id, 15).await.unwrap();
    create_page_reminder(&phone, &page.id, 15).await.unwrap();
    converge(&mac, &phone).await;

    assert_eq!(leads(&mac, &page.id).await, vec![15]);
    assert_converged(&mac, &phone).await;
}

// qa: CLOUD-70:2, CLOUD-104
#[tokio::test]
async fn a_calendar_folder_left_with_pages_when_its_calendar_is_turned_off_arrives_with_them() {
    let (mac, phone) = (device().await, device().await);
    insert_test_folder(&mac, "cal-folder", "Work calendar")
        .await
        .unwrap();
    sqlx::query("UPDATE folders SET is_external_calendar = 1 WHERE id = 'cal-folder'")
        .execute(&mac)
        .await
        .unwrap();
    insert_test_page(
        &mac,
        TestPage {
            folder_id: Some("cal-folder"),
            ..TestPage::new("event", "Planning")
        },
    )
    .await
    .unwrap();
    insert_test_page_sync(&mac, "event", "active")
        .await
        .unwrap();
    send(&mac, &phone).await;

    link_state(&mac, "event", "detached").await;
    sqlx::query("UPDATE folders SET is_external_calendar = 0 WHERE id = 'cal-folder'")
        .execute(&mac)
        .await
        .unwrap();
    send(&mac, &phone).await;

    let landed = get_page(&phone, "event").await.unwrap().unwrap();
    assert_eq!(landed.folder_id.as_deref(), Some("cal-folder"));
    assert_converged(&mac, &phone).await;

    sqlx::query("UPDATE folders SET is_external_calendar = 1 WHERE id = 'cal-folder'")
        .execute(&mac)
        .await
        .unwrap();
    link_state(&mac, "event", "active").await;
    send(&mac, &phone).await;
    let folders: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM folders WHERE id = 'cal-folder'")
        .fetch_one(&phone)
        .await
        .unwrap();
    assert_eq!(
        folders, 0,
        "turned back on, the folder is the calendar's again"
    );
}

// qa: CLOUD-23
#[tokio::test]
async fn a_reminder_fired_here_fires_again_when_another_device_moves_its_time() {
    let (mac, phone) = (device().await, device().await);
    let page = create_page_impl(&mac, new_page("Dentist")).await.unwrap();
    let block = create_page_schedule_impl(
        &mac,
        NewPageSchedule {
            page_id: page.id.clone(),
            scheduled_start: "2030-01-05T09:00:00".into(),
            scheduled_end: None,
            timezone: Some("UTC".into()),
            rule_id: None,
            original_date: None,
        },
    )
    .await
    .unwrap();
    create_page_reminder(&mac, &page.id, 15).await.unwrap();
    converge(&mac, &phone).await;
    crate::notification_log::log_reminder_fired(
        &phone,
        &page.id,
        &format!("{}#15", block.id),
        "2030-01-05T08:45:00",
    )
    .await
    .unwrap();

    update_page_schedule_impl(
        &mac,
        block.id.clone(),
        PageScheduleUpdate {
            scheduled_start: Some("2030-01-06T09:00:00".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    converge(&mac, &phone).await;

    let fired = text(
        &phone,
        "SELECT group_concat(schedule_id) FROM notification_log WHERE type = 'reminder'",
    )
    .await;
    assert_eq!(fired, None, "the move cleared the old firing");
}

#[tokio::test]
async fn two_versions_held_for_a_missing_page_merge_rather_than_the_later_arrival_winning() {
    let (mac, phone) = (device().await, device().await);
    let page = create_page_impl(&mac, new_page("Dentist")).await.unwrap();
    let block = create_page_schedule_impl(
        &mac,
        NewPageSchedule {
            page_id: page.id.clone(),
            scheduled_start: "2030-01-05T09:00:00".into(),
            scheduled_end: None,
            timezone: Some("UTC".into()),
            rule_id: None,
            original_date: None,
        },
    )
    .await
    .unwrap();
    let first = build(&mac, &pending(&mac, 100).await.unwrap())
        .await
        .unwrap();
    let (older, page_records): (Vec<_>, Vec<_>) = first
        .into_iter()
        .map(|b| (b.name, b.fields))
        .filter(|(name, _)| matches!(name.entity, Entity::Schedule | Entity::Page))
        .partition(|(name, _)| name.entity == Entity::Schedule);
    update_page_schedule_impl(
        &mac,
        block.id.clone(),
        PageScheduleUpdate {
            scheduled_start: Some("2030-01-05T10:00:00".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let newer: Vec<_> = build(&mac, &pending(&mac, 100).await.unwrap())
        .await
        .unwrap()
        .into_iter()
        .filter(|b| b.name.entity == Entity::Schedule)
        .map(|b| (b.name, b.fields))
        .collect();

    apply(&phone, &newer).await.unwrap();
    apply(&phone, &older).await.unwrap();
    apply(&phone, &page_records).await.unwrap();

    let start = text(
        &phone,
        &format!(
            "SELECT scheduled_start FROM page_schedules WHERE id = '{}'",
            block.id
        ),
    )
    .await;
    assert_eq!(start.as_deref(), Some("2030-01-05T10:00:00"));
}
