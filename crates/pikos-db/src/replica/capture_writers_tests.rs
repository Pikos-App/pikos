//! Every writer's captured changes equal the change it made to synced state.
//!
//! The oracle reads every synced column of every entity before and after a writer runs, and works
//! out which records the capture must have marked and which fields: a new row whole, a changed row
//! by the fields that differ, a removed row as removed. The two writes a purge makes on every
//! device by itself, a cascade delete and a foreign key set NULL, are expected uncaptured.

use std::collections::{BTreeMap, BTreeSet};

use pikos_replica::Entity;
use sqlx::{Row as _, SqlitePool};

use crate::moves::{move_pages, Placement};
use crate::replica::manifest::{EntityMap, Lifecycle, ENTITIES, PURGE_NULLED};
use crate::replica::start;
use crate::*;

#[derive(Debug, Clone, PartialEq)]
struct Row {
    /// Each field's columns, quoted so NULL, text and numbers stay distinct.
    fields: Vec<Vec<String>>,
    parent: Option<String>,
}

type State = BTreeMap<(Entity, String), Row>;

#[derive(Debug, PartialEq, Eq)]
enum Expected {
    Created,
    Changed(i64),
    Removed,
}

fn column_list(entity: &EntityMap) -> Vec<&'static str> {
    entity
        .fields
        .iter()
        .flat_map(|f| f.columns.iter().copied())
        .collect()
}

async fn synced_state(pool: &SqlitePool) -> State {
    let mut state = State::new();
    for entity in ENTITIES {
        let columns = column_list(entity);
        let selected: Vec<String> = columns.iter().map(|c| format!("quote(t.{c})")).collect();
        let parent = entity
            .parent
            .as_ref()
            .map_or("NULL".to_owned(), |p| format!("t.{}", p.column));
        let covers = entity.covers.map_or("1".to_owned(), |c| c.replace("{row}", "t"));
        let sql = format!(
            "SELECT {} AS key, {parent} AS parent{} FROM {} AS t WHERE {covers}",
            entity.key.replace("{row}", "t"),
            selected.iter().map(|s| format!(", {s}")).collect::<String>(),
            entity.table,
        );

        for row in sqlx::query(&sql).fetch_all(pool).await.unwrap() {
            let mut values = (2..2 + columns.len()).map(|i| row.get::<String, _>(i));
            let fields = entity
                .fields
                .iter()
                .map(|f| values.by_ref().take(f.columns.len()).collect())
                .collect();
            state.insert(
                (entity.entity, row.get("key")),
                Row {
                    fields,
                    parent: row.get("parent"),
                },
            );
        }
    }
    state
}

async fn exists(pool: &SqlitePool, table: &str, id: &str) -> bool {
    sqlx::query_scalar(&format!("SELECT EXISTS (SELECT 1 FROM {table} WHERE id = ?)")) // sql-ok: table names from the manifest
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

fn unquote(quoted: &str) -> Option<&str> {
    quoted.strip_prefix('\'')?.strip_suffix('\'')
}

/// Whether a column's change is a purge's foreign key setting it NULL.
async fn nulled_by_purge(
    pool: &SqlitePool,
    entity: &EntityMap,
    column: &str,
    before: &str,
    after: &str,
) -> bool {
    let Some((_, _, parent)) = PURGE_NULLED
        .iter()
        .find(|(table, c, _)| *table == entity.table && *c == column)
    else {
        return false;
    };
    let Some(old_id) = unquote(before) else {
        return false;
    };
    after == "NULL" && !exists(pool, parent, old_id).await
}

async fn expected(pool: &SqlitePool, before: &State, after: &State) -> BTreeMap<(Entity, String), Expected> {
    let mut expect = BTreeMap::new();
    let keys: BTreeSet<&(Entity, String)> = before.keys().chain(after.keys()).collect();

    for key in keys {
        let entity = ENTITIES.iter().find(|e| e.entity == key.0).unwrap();
        match (before.get(key), after.get(key)) {
            (None, Some(_)) => {
                expect.insert(key.clone(), Expected::Created);
            }
            (Some(old), None) => {
                let parent_gone = match (&entity.parent, &old.parent) {
                    (Some(parent), Some(id)) => !exists(pool, parent.table, id).await,
                    _ => false,
                };
                let removal_is_sent = entity.lifecycle == Lifecycle::Row && !parent_gone;
                if removal_is_sent {
                    expect.insert(key.clone(), Expected::Removed);
                }
            }
            (Some(old), Some(new)) => {
                let mut mask = 0;
                for (i, field) in entity.fields.iter().enumerate() {
                    for (c, column) in field.columns.iter().enumerate() {
                        let (was, now) = (&old.fields[i][c], &new.fields[i][c]);
                        if was != now && !nulled_by_purge(pool, entity, column, was, now).await {
                            mask |= 1 << i;
                        }
                    }
                }
                if mask != 0 {
                    expect.insert(key.clone(), Expected::Changed(mask));
                }
            }
            (None, None) => unreachable!(),
        }
    }
    expect
}

async fn captured(pool: &SqlitePool) -> BTreeMap<(Entity, String), Expected> {
    let rows: Vec<(String, String, i64, bool)> =
        sqlx::query_as("SELECT entity, key, fields, deleted FROM replica_ops")
            .fetch_all(pool)
            .await
            .unwrap();
    rows.into_iter()
        .map(|(entity, key, fields, deleted)| {
            let entity = ENTITIES
                .iter()
                .map(|e| e.entity)
                .find(|e| e.prefix() == entity)
                .unwrap();
            let all = (1i64 << crate::replica::manifest::entity(entity).unwrap().fields.len()) - 1;
            let op = match (deleted, fields) {
                (true, _) => Expected::Removed,
                (false, f) if f == all && f != 0 => Expected::Created,
                (false, 0) => Expected::Created,
                (false, f) => Expected::Changed(f),
            };
            ((entity, key), op)
        })
        .collect()
}

/// Runs `write` and checks what it captured against what it changed.
async fn check<F, Fut, T>(pool: &SqlitePool, label: &str, write: F) -> T
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = AppResult<T>>,
{
    sqlx::query("DELETE FROM replica_ops")
        .execute(pool)
        .await
        .unwrap();
    let before = synced_state(pool).await;

    let result = write().await.unwrap_or_else(|e| panic!("{label}: {e}"));

    let after = synced_state(pool).await;
    let mut want = expected(pool, &before, &after).await;
    let got = captured(pool).await;
    // A change that rewrites every field can't be told from a creation by the mask alone.
    for (key, op) in want.iter_mut() {
        let all = (1i64 << crate::replica::manifest::entity(key.0).unwrap().fields.len()) - 1;
        if *op == Expected::Changed(all) && got.get(key) == Some(&Expected::Created) {
            *op = Expected::Created;
        }
    }
    assert_eq!(got, want, "{label}: captured changes differ from what changed");
    result
}

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
        links: vec![],
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
    check(p, "reorder folders", || reorder_folders_impl(p, &folder_order)).await;

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
    let laundry = check(p, "create second page", || create_page_impl(p, page("Laundry"))).await;
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
    check(p, "reorder pages", || reorder_pages_impl(p, None, &just_child)).await;
    let just_laundry = [laundry.id.clone()];
    let top = Placement::default();
    check(p, "move pages", || move_pages(p, &just_laundry, &top)).await;

    check(p, "trash page", || soft_delete_page_impl(p, &laundry.id)).await;
    check(p, "restore page", || restore_page_impl(p, &laundry.id)).await;
    check(p, "trash folder", || soft_delete_folder_impl(p, folder.id.clone())).await;
    check(p, "restore folder", || restore_folder_impl(p, folder.id.clone())).await;

    check(p, "purge page with a child page", || {
        hard_delete_page_impl(p, &groceries.id)
    })
    .await;
    check(p, "purge folder", || delete_folder_impl(p, other.id.clone())).await;
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
    check(p, "remove reminder", || delete_page_reminder(p, &reminder.id)).await;
    check(p, "add focus session", || {
        create_focus_session(p, &task.id, "2026-10-16T09:00:00", "2026-10-16T09:25:00", 1500)
    })
    .await;
    check(p, "unschedule", || delete_page_schedule_impl(p, block.id.clone())).await;

    let standup = check(p, "create recurring page", || create_page_impl(p, page("Standup"))).await;
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
    check(p, "stop repeating", || delete_recurrence_rule_impl(p, &rule.id)).await;
    check(p, "purge the page and everything under it", || {
        hard_delete_page_impl(p, &task.id)
    })
    .await;
}
