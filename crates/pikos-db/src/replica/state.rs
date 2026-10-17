//! The synced state: every in-scope row of every entity, read through the manifest.

use pikos_replica::RecordName;
use sqlx::{Row as _, SqlitePool};

use super::manifest::{EntityMap, ENTITIES};
use crate::error::AppResult;

pub struct SyncedRow {
    pub name: RecordName,
    /// Each field's columns, quoted as SQLite's `quote()` writes them, so NULL, text and numbers
    /// stay distinct.
    pub fields: Vec<Vec<String>>,
}

impl SyncedRow {
    /// A stable hash of the row's synced values, for telling later whether any of them changed.
    pub fn fingerprint(&self) -> String {
        let joined = self
            .fields
            .iter()
            .map(|f| f.join("\u{1f}"))
            .collect::<Vec<_>>()
            .join("\u{1e}");
        crate::reconciler::fnv_hex(&joined)
    }
}

fn select_sql(entity: &EntityMap) -> String {
    let columns: String = entity
        .fields
        .iter()
        .flat_map(|f| f.columns.iter())
        .map(|c| format!(", quote(t.{c})"))
        .collect();
    let covers = entity.covers.unwrap_or("1");
    format!(
        "SELECT {} AS key{columns} FROM {} AS t WHERE ({covers}) AND {}",
        entity.key,
        entity.table,
        entity.scope.sql()
    )
    .replace("{row}", "t")
}

/// Every in-scope row, entity by entity in manifest order.
pub async fn synced_rows(pool: &SqlitePool) -> AppResult<Vec<SyncedRow>> {
    let mut conn = pool.acquire().await?;
    synced_rows_conn(&mut conn).await
}

pub(crate) async fn synced_rows_conn(
    conn: &mut sqlx::SqliteConnection,
) -> AppResult<Vec<SyncedRow>> {
    let mut rows = Vec::new();
    for entity in ENTITIES {
        for row in sqlx::query(&select_sql(entity))
            .fetch_all(&mut *conn)
            .await?
        {
            let mut values = (1..row.len()).map(|i| row.get::<String, _>(i));
            let fields = entity
                .fields
                .iter()
                .map(|f| values.by_ref().take(f.columns.len()).collect())
                .collect();
            rows.push(SyncedRow {
                name: RecordName::live(entity.entity, row.get::<String, _>("key")),
                fields,
            });
        }
    }
    Ok(rows)
}

#[cfg(test)]
#[path = "state_tests.rs"]
mod tests;
