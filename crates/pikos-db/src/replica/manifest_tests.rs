use std::collections::{BTreeSet, HashSet};

use pikos_replica::{Entity, ALL_ENTITIES};
use sqlx::SqlitePool;

use super::{Lifecycle, ENTITIES, PURGE_NULLED, TABLES};
use crate::test_pool;

async fn columns(pool: &SqlitePool, table: &str) -> BTreeSet<String> {
    sqlx::query_scalar("SELECT name FROM pragma_table_xinfo(?)")
        .bind(table)
        .fetch_all(pool)
        .await
        .unwrap()
        .into_iter()
        .collect()
}

/// `(table, column, parent table, on delete)` for every foreign key of the synced tables.
async fn foreign_keys(pool: &SqlitePool) -> Vec<(String, String, String, String)> {
    let mut keys = Vec::new();
    for table in TABLES {
        let rows: Vec<(String, String, String)> =
            sqlx::query_as(r#"SELECT "from", "table", on_delete FROM pragma_foreign_key_list(?)"#)
                .bind(table.table)
                .fetch_all(pool)
                .await
                .unwrap();
        keys.extend(rows.into_iter().map(|(column, parent, on_delete)| {
            (table.table.to_owned(), column, parent, on_delete)
        }));
    }
    keys
}

fn is_local(table: &str, column: &str) -> bool {
    TABLES
        .iter()
        .any(|t| t.table == table && t.local.contains(&column))
}

#[tokio::test]
async fn every_column_of_a_synced_table_is_classified_once() {
    let pool = test_pool().await;

    for table in TABLES {
        let synced: BTreeSet<&str> = ENTITIES
            .iter()
            .filter(|e| e.table == table.table)
            .flat_map(|e| e.fields.iter().flat_map(|f| f.columns.iter().copied()))
            .collect();
        let unsynced: Vec<&str> = [table.identity, table.derived, table.local].concat();
        let unsynced_set: BTreeSet<&str> = unsynced.iter().copied().collect();

        assert_eq!(
            unsynced.len(),
            unsynced_set.len(),
            "{}: a column is listed twice among identity, derived and local",
            table.table
        );
        let both: Vec<&&str> = synced.intersection(&unsynced_set).collect();
        assert!(
            both.is_empty(),
            "{}: {both:?} can't both sync and not sync",
            table.table
        );

        let classified: BTreeSet<String> =
            synced.union(&unsynced_set).map(|c| c.to_string()).collect();
        assert_eq!(
            columns(&pool, table.table).await,
            classified,
            "{}: every column is synced by an entity's field or listed as identity, derived or \
             local, and every name listed is a real column",
            table.table
        );
    }
}

#[test]
fn every_entity_table_is_classified_and_every_entity_but_assets_has_a_table() {
    let classified: HashSet<&str> = TABLES.iter().map(|t| t.table).collect();
    for entity in ENTITIES {
        assert!(classified.contains(entity.table), "{:?}", entity.entity);
    }

    let mapped: HashSet<Entity> = ENTITIES.iter().map(|e| e.entity).collect();
    assert_eq!(mapped.len(), ENTITIES.len(), "an entity is mapped twice");
    for entity in ALL_ENTITIES {
        assert_eq!(
            mapped.contains(&entity),
            entity != Entity::Asset,
            "{entity:?}: images are files, every other entity is rows"
        );
    }
}

#[test]
fn field_names_are_unique_and_fit_the_dirty_mask() {
    for entity in ENTITIES {
        let names: HashSet<&str> = entity.fields.iter().map(|f| f.name).collect();
        assert_eq!(names.len(), entity.fields.len(), "{:?}", entity.entity);
        assert!(entity.fields.len() < 63, "{:?}", entity.entity);
    }
}

#[test]
fn entities_sharing_a_table_split_its_rows_or_its_columns() {
    for (i, a) in ENTITIES.iter().enumerate() {
        for b in &ENTITIES[i + 1..] {
            if a.table != b.table {
                continue;
            }
            let split_rows = a.covers.is_some() && b.covers.is_some();
            let a_columns: HashSet<&str> = a
                .fields
                .iter()
                .flat_map(|f| f.columns.iter().copied())
                .collect();
            let split_columns = b
                .fields
                .iter()
                .flat_map(|f| f.columns.iter())
                .all(|c| !a_columns.contains(c));
            assert!(
                split_rows || split_columns,
                "{:?} and {:?} would capture the same change twice",
                a.entity,
                b.entity
            );
        }
    }
}

#[tokio::test]
async fn the_purge_nulled_columns_are_exactly_the_set_null_foreign_keys() {
    let pool = test_pool().await;

    let set_null: BTreeSet<(String, String, String)> = foreign_keys(&pool)
        .await
        .into_iter()
        .filter(|(_, _, _, on_delete)| on_delete == "SET NULL")
        .map(|(table, column, parent, _)| (table, column, parent))
        .filter(|(table, column, _)| !is_local(table, column))
        .collect();
    let listed: BTreeSet<(String, String, String)> = PURGE_NULLED
        .iter()
        .map(|(t, c, p)| (t.to_string(), c.to_string(), p.to_string()))
        .collect();

    assert_eq!(set_null, listed);
}

#[tokio::test]
async fn every_entity_on_a_cascading_table_names_a_real_parent() {
    let pool = test_pool().await;
    let cascades: Vec<(String, String, String)> = foreign_keys(&pool)
        .await
        .into_iter()
        .filter(|(_, _, _, on_delete)| on_delete == "CASCADE")
        .map(|(table, column, parent, _)| (table, column, parent))
        .collect();

    for entity in ENTITIES.iter().filter(|e| e.lifecycle == Lifecycle::Row) {
        let cascading = cascades.iter().any(|(table, _, _)| table == entity.table);
        let Some(parent) = &entity.parent else {
            assert!(
                !cascading,
                "{:?}: its table cascades, so a cascade delete would be sent as a removal",
                entity.entity
            );
            continue;
        };

        let real = cascades.iter().any(|(table, column, parent_table)| {
            table == entity.table && column == parent.column && parent_table == parent.table
        });
        assert!(real, "{:?}: no such cascading foreign key", entity.entity);
    }
}
