//! The capture oracle: whether a write captured exactly the change it made to synced state.
//!
//! It reads every synced column of every entity before and after a write runs, and works out which
//! records the capture must have marked and which fields: a new row whole, a changed row by the
//! fields that differ, a removed row as removed. The two writes a purge makes on every device by
//! itself, a cascade delete and a foreign key set NULL, are expected uncaptured.

use std::collections::{BTreeMap, BTreeSet};

use pikos_replica::Entity;
use sqlx::{Row as _, SqlitePool};

use crate::error::AppResult;
use crate::replica::manifest::{EntityMap, Lifecycle, ENTITIES, PURGE_NULLED};

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
        let covers = entity
            .covers
            .map_or("1".to_owned(), |c| c.replace("{row}", "t"));
        let sql = format!(
            "SELECT {} AS key, {parent} AS parent{} FROM {} AS t WHERE {covers}",
            entity.key.replace("{row}", "t"),
            selected
                .iter()
                .map(|s| format!(", {s}"))
                .collect::<String>(),
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
    sqlx::query_scalar(&format!(
        "SELECT EXISTS (SELECT 1 FROM {table} WHERE id = ?)"
    )) // sql-ok: table names from the manifest
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

async fn expected(
    pool: &SqlitePool,
    before: &State,
    after: &State,
) -> BTreeMap<(Entity, String), Expected> {
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
            let all = (1i64
                << crate::replica::manifest::entity(entity)
                    .unwrap()
                    .fields
                    .len())
                - 1;
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
pub(crate) async fn check<F, Fut, T>(pool: &SqlitePool, label: &str, write: F) -> T
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
        let all = (1i64
            << crate::replica::manifest::entity(key.0)
                .unwrap()
                .fields
                .len())
            - 1;
        if *op == Expected::Changed(all) && got.get(key) == Some(&Expected::Created) {
            *op = Expected::Created;
        }
    }
    assert_eq!(
        got, want,
        "{label}: captured changes differ from what changed"
    );
    result
}
