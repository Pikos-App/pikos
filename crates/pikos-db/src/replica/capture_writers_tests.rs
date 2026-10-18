//! Every writer's captured changes equal the change it made to synced state.

use crate::moves::{move_pages, Placement};
use crate::replica::oracle::check;
use crate::replica::start;
use crate::*;

fn page(title: &str) -> NewPage {
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
        parent_id: None,
        last_opened_at: None,
        created_at: None,
        updated_at: None,
    }
}

#[tokio::test]
async fn every_page_and_folder_writer_captures_exactly_what_it_changed() {
    let pool = test_pool().await;
    start(&pool).await.unwrap();
    let p = &pool;

    let folder = check(p, "create folder", || {
        create_folder_impl(
            p,
            NewFolder {
                name: "Home".into(),
                parent_id: None,
                color: Some("red".into()),
                icon: None,
            },
        )
    })
    .await;
    let other = check(p, "create second folder", || {
        create_folder_impl(
            p,
            NewFolder {
                name: "Work".into(),
                parent_id: None,
                color: None,
                icon: None,
            },
        )
    })
    .await;
    check(p, "rename folder", || {
        update_folder_impl(
            p,
            folder.id.clone(),
            FolderUpdate {
                name: Some("House".into()),
                ..Default::default()
            },
        )
    })
    .await;
    let folder_order = [other.id.clone(), folder.id.clone()];
    check(p, "reorder folders", || {
        reorder_folders_impl(p, &folder_order)
    })
    .await;

    let groceries = check(p, "create page with tags in a folder", || {
        create_page_impl(
            p,
            NewPage {
                folder_id: Some(folder.id.clone()),
                tags: vec!["errands".into(), "home".into()],
                ..page("Groceries")
            },
        )
    })
    .await;
    let laundry = check(p, "create second page", || {
        create_page_impl(p, page("Laundry"))
    })
    .await;
    let child = check(p, "create child page", || {
        create_page_impl(
            p,
            NewPage {
                parent_id: Some(groceries.id.clone()),
                ..page("Milk")
            },
        )
    })
    .await;

    check(p, "retitle", || {
        update_page_impl(
            p,
            groceries.id.clone(),
            PageUpdate {
                title: Some("Groceries, Saturday".into()),
                ..Default::default()
            },
        )
    })
    .await;
    check(p, "edit body", || {
        update_page_impl(
            p,
            groceries.id.clone(),
            PageUpdate {
                content: Some(
                    r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"oat milk"}]}]}"#
                        .into(),
                ),
                content_text: Some("oat milk".into()),
                ..Default::default()
            },
        )
    })
    .await;
    check(p, "retag", || {
        update_page_impl(
            p,
            groceries.id.clone(),
            PageUpdate {
                tags: Some(vec!["errands".into(), "weekend".into()]),
                ..Default::default()
            },
        )
    })
    .await;
    check(p, "open a page", || {
        update_page_impl(
            p,
            groceries.id.clone(),
            PageUpdate {
                last_opened_at: Some(serde_json::json!("2026-10-16T22:00:00")),
                ..Default::default()
            },
        )
    })
    .await;
    check(p, "complete", || {
        update_page_impl(
            p,
            laundry.id.clone(),
            PageUpdate {
                status: Some("done".into()),
                completed_at: Some(serde_json::json!("2026-10-16T21:00:00")),
                ..Default::default()
            },
        )
    })
    .await;
    let both = [laundry.id.clone(), groceries.id.clone()];
    check(p, "reopen several", || {
        set_pages_status_impl(p, &both, "not_started", None)
    })
    .await;
    check(p, "move to the inbox", || {
        update_page_impl(
            p,
            laundry.id.clone(),
            PageUpdate {
                folder_id: Some(serde_json::json!(other.id)),
                ..Default::default()
            },
        )
    })
    .await;
    let just_child = [child.id.clone()];
    check(p, "reorder pages", || {
        reorder_pages_impl(p, None, &just_child)
    })
    .await;
    let just_laundry = [laundry.id.clone()];
    let top = Placement::default();
    check(p, "move pages", || move_pages(p, &just_laundry, &top)).await;

    check(p, "trash page", || soft_delete_page_impl(p, &laundry.id)).await;
    check(p, "restore page", || restore_page_impl(p, &laundry.id)).await;
    check(p, "trash folder", || {
        soft_delete_folder_impl(p, folder.id.clone())
    })
    .await;
    check(p, "restore folder", || {
        restore_folder_impl(p, folder.id.clone())
    })
    .await;

    check(p, "purge page with a child page", || {
        hard_delete_page_impl(p, &groceries.id)
    })
    .await;
    check(p, "purge folder", || {
        delete_folder_impl(p, other.id.clone())
    })
    .await;
}

#[tokio::test]
async fn every_schedule_recurrence_reminder_and_focus_writer_captures_exactly_what_it_changed() {
    let pool = test_pool().await;
    start(&pool).await.unwrap();
    let p = &pool;

    let task = check(p, "create page", || create_page_impl(p, page("Dentist"))).await;
    let block = check(p, "schedule", || {
        create_page_schedule_impl(
            p,
            NewPageSchedule {
                page_id: task.id.clone(),
                scheduled_start: "2026-10-20T09:00:00".into(),
                scheduled_end: Some("2026-10-20T10:00:00".into()),
                timezone: Some("UTC".into()),
                rule_id: None,
                original_date: None,
            },
        )
    })
    .await;
    check(p, "move a block", || {
        update_page_schedule_impl(
            p,
            block.id.clone(),
            PageScheduleUpdate {
                scheduled_start: Some("2026-10-21T09:00:00".into()),
                ..Default::default()
            },
        )
    })
    .await;
    let reminder = check(p, "add reminder", || create_page_reminder(p, &task.id, 15)).await;
    check(p, "remove reminder", || {
        delete_page_reminder(p, &reminder.id)
    })
    .await;
    check(p, "add focus session", || {
        create_focus_session(
            p,
            &task.id,
            "2026-10-16T09:00:00",
            "2026-10-16T09:25:00",
            1500,
        )
    })
    .await;
    check(p, "unschedule", || {
        delete_page_schedule_impl(p, block.id.clone())
    })
    .await;

    let standup = check(p, "create recurring page", || {
        create_page_impl(p, page("Standup"))
    })
    .await;
    let rule = check(p, "make it repeat", || {
        create_recurrence_rule_impl(
            p,
            NewRecurrenceRule {
                page_id: standup.id.clone(),
                rrule: "FREQ=DAILY".into(),
                rrule_exdates: vec![],
                scheduled_start: "2026-10-16T09:00:00".into(),
                scheduled_end: Some("2026-10-16T09:15:00".into()),
                timezone: "UTC".into(),
            },
        )
    })
    .await;
    check(p, "complete an occurrence", || {
        complete_recurring_page_impl(
            p,
            CompleteRecurringInput {
                page_id: standup.id.clone(),
                occurrence_date: None,
                scheduled_start: None,
                scheduled_end: None,
                expected_occurrence_date: None,
            },
        )
    })
    .await;
    let ticked: String =
        sqlx::query_scalar("SELECT occurrence_date FROM completed_set WHERE page_id = ?")
            .bind(&standup.id)
            .fetch_one(p)
            .await
            .unwrap();
    check(p, "uncomplete it", || {
        uncomplete_recurring_occurrence_impl(
            p,
            UncompleteRecurringInput {
                page_id: standup.id.clone(),
                occurrence_date: ticked.clone(),
            },
        )
    })
    .await;
    check(p, "skip an occurrence", || {
        skip_occurrence_impl(
            p,
            SkipOccurrenceInput {
                page_id: standup.id.clone(),
                occurrence_date: "2026-10-17".into(),
            },
        )
    })
    .await;
    check(p, "unskip it", || {
        undo_skip_occurrence_impl(
            p,
            SkipOccurrenceInput {
                page_id: standup.id.clone(),
                occurrence_date: "2026-10-17".into(),
            },
        )
    })
    .await;
    check(p, "move one occurrence", || {
        reschedule_virtual_occurrence_impl(
            p,
            RescheduleVirtualInput {
                rule_id: rule.id.clone(),
                original_date: "2026-10-19".into(),
                scheduled_start: "2026-10-19T11:00:00".into(),
                scheduled_end: None,
                timezone: "UTC".into(),
            },
        )
    })
    .await;
    check(p, "exclude dates", || {
        add_rule_exdates_impl(p, rule.id.clone(), vec!["2026-10-22".into()])
    })
    .await;
    check(p, "change the rule", || {
        update_recurrence_rule_impl(
            p,
            rule.id.clone(),
            RecurrenceRuleUpdate {
                rrule: Some("FREQ=WEEKLY".into()),
                ..Default::default()
            },
        )
    })
    .await;
    check(p, "stop repeating", || {
        delete_recurrence_rule_impl(p, &rule.id)
    })
    .await;
    check(p, "purge the page and everything under it", || {
        hard_delete_page_impl(p, &task.id)
    })
    .await;
}
