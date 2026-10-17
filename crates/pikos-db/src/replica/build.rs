//! The sending half: which records are waiting, built from the live rows, and what happens when a
//! transport reports them sent.
//!
//! A record is built from the row as it is now, not from a stored copy of the change, because every
//! write to a synced column is captured; the op-log only says which records to build. A record
//! that's out of scope is dropped from the op-log when it's built rather than when it's captured,
//! since the reconciler inserts a page before the calendar link that puts it out of scope.

use pikos_replica::codec::{self, FieldMap, Record};
use pikos_replica::merge::{FieldState, RowState, Value};
use pikos_replica::{Hlc, RecordName};
use sqlx::{Row as _, SqlitePool};

use super::apply::shape;
use super::manifest::{entity as entity_map, EntityMap};
use crate::error::{AppError, AppResult};

/// Records waiting to send, oldest change first.
pub async fn pending(pool: &SqlitePool, limit: i64) -> AppResult<Vec<RecordName>> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT entity, key FROM replica_ops ORDER BY clock LIMIT ?")
            .bind(limit)
            .fetch_all(pool)
            .await?;
    rows.into_iter()
        .map(|(entity, key)| {
            format!("{entity}:{key}")
                .parse()
                .map_err(|e| AppError::Internal(format!("pending record: {e}")))
        })
        .collect()
}

/// A built record and the op clock it was built at, which [`sent`] compares against.
pub struct Built {
    pub name: RecordName,
    pub fields: FieldMap,
    pub clock: Hlc,
}

/// Builds each named record from the live row and its clocks. A row that's gone builds its
/// tombstone; one that's out of scope is dropped from the op-log and not built.
pub async fn build(pool: &SqlitePool, names: &[RecordName]) -> AppResult<Vec<Built>> {
    let mut built = Vec::new();
    for name in names {
        let Some(entity) = entity_map(name.entity) else {
            continue;
        };
        let op: Option<String> =
            sqlx::query_scalar("SELECT clock FROM replica_ops WHERE entity = ? AND key = ?")
                .bind(name.entity.prefix())
                .bind(&name.key)
                .fetch_optional(pool)
                .await?;
        let Some(op_clock) = op else {
            continue;
        };
        let op_clock: Hlc = op_clock
            .parse()
            .map_err(|e| AppError::Invalid(format!("op clock: {e}")))?;

        match read(pool, entity, &name.key).await? {
            Read::OutOfScope | Read::Missing => {
                drop_op(pool, name).await?;
            }
            Read::Row(row) => {
                let record = Record {
                    name: name.clone(),
                    row,
                };
                built.push(Built {
                    name: name.clone(),
                    fields: codec::encode(&record, &shape(entity)),
                    clock: op_clock,
                });
            }
        }
    }
    Ok(built)
}

enum Read {
    Row(RowState),
    OutOfScope,
    Missing,
}

async fn read(pool: &SqlitePool, entity: &EntityMap, key: &str) -> AppResult<Read> {
    let columns: String = entity
        .fields
        .iter()
        .flat_map(|f| f.columns.iter())
        .map(|c| format!(", quote(t.{c})"))
        .collect();
    let covers = entity.covers.unwrap_or("1");
    let sql = format!(
        "SELECT {} AS in_scope{columns} FROM {} AS t WHERE ({covers}) AND {} = ?",
        entity.scope.sql(),
        entity.table,
        entity.key
    )
    .replace("{row}", "t");
    let row = sqlx::query(&sql).bind(key).fetch_optional(pool).await?;
    let clocks: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT clocks, tomb FROM replica_clocks WHERE entity = ? AND key = ?")
            .bind(entity.entity.prefix())
            .bind(key)
            .fetch_optional(pool)
            .await?;
    let (packed, tomb) = match (clocks, &row) {
        (Some(clocks), _) => clocks,
        (None, None) => return Ok(Read::Missing),
        // Unchanged since sync started.
        (None, Some(_)) => {
            let base: Option<String> =
                sqlx::query_scalar("SELECT base_clock FROM replica_meta WHERE id = 1")
                    .fetch_one(pool)
                    .await?;
            (
                base.unwrap_or_default().repeat(entity.fields.len() + 1),
                None,
            )
        }
    };
    let slots: Vec<Hlc> = packed
        .as_bytes()
        .chunks(20)
        .filter_map(|c| std::str::from_utf8(c).ok()?.parse().ok())
        .collect();
    let Some((&born, field_clocks)) = slots.split_first() else {
        return Ok(Read::Missing);
    };
    let tomb: Option<Hlc> = tomb.and_then(|t| t.parse().ok());
    let clock_of = |i: usize| field_clocks.get(i).copied().unwrap_or(born);

    let fields: Vec<FieldState> = match &row {
        Some(row) => {
            let in_scope: bool = row.get(0);
            if !in_scope {
                return Ok(Read::OutOfScope);
            }
            let mut values =
                (1..row.len()).map(|i| super::apply::unquote(&row.get::<String, _>(i)));
            entity
                .fields
                .iter()
                .enumerate()
                .map(|(i, f)| FieldState {
                    values: values.by_ref().take(f.columns.len()).collect(),
                    clock: clock_of(i),
                })
                .collect()
        }
        // A tombstone carries no values: the receiver only compares when the row went.
        None => entity
            .fields
            .iter()
            .enumerate()
            .map(|(i, f)| FieldState {
                values: vec![Value::Null; f.columns.len()],
                clock: clock_of(i),
            })
            .collect(),
    };
    // Gone with no tombstone of its own: a cascade, which every device repeats from the parent's.
    if row.is_none() && tomb.is_none() {
        return Ok(Read::Missing);
    }
    Ok(Read::Row(RowState { born, fields, tomb }))
}

async fn drop_op(pool: &SqlitePool, name: &RecordName) -> AppResult<()> {
    sqlx::query("DELETE FROM replica_ops WHERE entity = ? AND key = ?")
        .bind(name.entity.prefix())
        .bind(&name.key)
        .execute(pool)
        .await?;
    Ok(())
}

/// The transport stored these records. Each leaves the op-log only if nothing was captured for it
/// since it was built; an edit made while a record was in flight stays pending, and its name is
/// returned so the transport queues it again.
pub async fn sent(pool: &SqlitePool, records: &[(RecordName, Hlc)]) -> AppResult<Vec<RecordName>> {
    let mut still_pending = Vec::new();
    for (name, built_at) in records {
        let removed =
            sqlx::query("DELETE FROM replica_ops WHERE entity = ? AND key = ? AND clock <= ?")
                .bind(name.entity.prefix())
                .bind(&name.key)
                .bind(built_at.to_string())
                .execute(pool)
                .await?
                .rows_affected();
        if removed == 0 {
            let waiting: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM replica_ops WHERE entity = ? AND key = ?)",
            )
            .bind(name.entity.prefix())
            .bind(&name.key)
            .fetch_one(pool)
            .await?;
            if waiting {
                still_pending.push(name.clone());
            }
        }
    }
    Ok(still_pending)
}

#[cfg(test)]
#[path = "build_tests.rs"]
mod tests;
