//! The sending half: which records are waiting, built from the live rows, and what happens when a
//! transport reports them sent.
//!
//! A record is built from the row as it is now, not from a stored copy of the change, because every
//! write to a synced column is captured; the op-log only says which records to build. A record
//! that's out of scope is dropped from the op-log when it's built rather than when it's captured,
//! since the reconciler inserts a page before the calendar link that puts it out of scope.

use pikos_replica::codec::{self, FieldMap, Record};
use pikos_replica::merge::{FieldState, RowState, Value};
use pikos_replica::{Entity, Hlc, RecordName};
use sqlx::{Row as _, SqlitePool};

use super::apply::shape;
use super::manifest::{entity as entity_map, EntityMap};
use crate::error::{AppError, AppResult};

/// Records waiting to send, oldest change first.
pub async fn pending(pool: &SqlitePool, limit: i64) -> AppResult<Vec<RecordName>> {
    let rows: Vec<(String, String)> =
        // sql-ok: apply_rank is built from entity prefixes, which are constants
        sqlx::query_as(&format!(
            "SELECT entity, key FROM replica_ops ORDER BY clock, {}, key LIMIT ?",
            apply_rank()
        ))
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

/// SQL ranking `entity` in apply order. Within one clock, as everything has at a first upload,
/// parents go first, so a receiver rarely has to hold a child for its parent.
fn apply_rank() -> String {
    let arms: String = super::apply::APPLY_ORDER
        .iter()
        .enumerate()
        .map(|(rank, entity)| format!(" WHEN '{}' THEN {rank}", entity.prefix()))
        .collect();
    format!("CASE entity{arms} ELSE 99 END")
}

/// A built record and the op clock it was built at, which [`sent`] compares against.
pub struct Built {
    pub name: RecordName,
    pub fields: FieldMap,
    pub clock: Hlc,
    /// The transport's metadata for the record as it last saw it, if it kept any.
    pub system_fields: Option<Vec<u8>>,
}

/// Builds each named record from the live row and its clocks. A row that's gone builds its
/// tombstone; one that's out of scope is dropped from the op-log and not built.
pub async fn build(pool: &SqlitePool, names: &[RecordName]) -> AppResult<Vec<Built>> {
    let mut built = Vec::new();
    for name in names {
        let op: Option<(String, bool)> =
            sqlx::query_as("SELECT clock, deleted FROM replica_ops WHERE entity = ? AND key = ?")
                .bind(name.entity.prefix())
                .bind(&name.key)
                .fetch_optional(pool)
                .await?;
        let Some((op_clock, deleted)) = op else {
            continue;
        };
        let op_clock: Hlc = op_clock
            .parse()
            .map_err(|e| AppError::Invalid(format!("op clock: {e}")))?;

        if name.entity == Entity::Asset {
            let fields = {
                let mut conn = pool.acquire().await?;
                super::images::build(&mut conn, name).await?
            };
            match fields {
                Some(fields) => built.push(Built {
                    name: name.clone(),
                    fields,
                    clock: op_clock,
                    system_fields: system_fields(pool, name).await?,
                }),
                None => drop_op(pool, name).await?,
            }
            continue;
        }
        let Some(entity) = entity_map(name.entity) else {
            continue;
        };

        let read = {
            let mut conn = pool.acquire().await?;
            read(&mut conn, entity, &name.key, deleted).await?
        };
        match read {
            Read::OutOfScope | Read::Missing => {
                drop_op(pool, name).await?;
            }
            Read::Row(row) => {
                let content = match row.fields.first().and_then(|f| f.values.first()) {
                    Some(Value::Text(content)) if name.entity == Entity::Body => Some(content),
                    _ => None,
                };
                if let Some(content) = content {
                    let mut conn = pool.acquire().await?;
                    super::images::queue_shown(&mut conn, content, op_clock).await?;
                }

                let record = Record {
                    name: name.clone(),
                    row,
                };
                built.push(Built {
                    name: name.clone(),
                    fields: codec::encode(&record, &shape(entity)),
                    clock: op_clock,
                    system_fields: system_fields(pool, name).await?,
                });
            }
        }
    }
    Ok(built)
}

async fn system_fields(pool: &SqlitePool, name: &RecordName) -> AppResult<Option<Vec<u8>>> {
    Ok(
        sqlx::query_scalar("SELECT system_fields FROM replica_clocks WHERE entity = ? AND key = ?")
            .bind(name.entity.prefix())
            .bind(&name.key)
            .fetch_optional(pool)
            .await?
            .flatten(),
    )
}

pub(crate) enum Read {
    Row(RowState),
    OutOfScope,
    Missing,
}

/// `deleted` says the op-log recorded a removal. A row still here but out of scope with a removal
/// recorded has left scope, and builds its tombstone.
pub(crate) async fn read(
    conn: &mut sqlx::SqliteConnection,
    entity: &EntityMap,
    key: &str,
    deleted: bool,
) -> AppResult<Read> {
    let columns = super::manifest::quoted_values(entity);
    let covers = entity.covers.unwrap_or("1");
    let sql = format!(
        "SELECT {} AS in_scope{columns} FROM {} AS t WHERE ({covers}) AND {} = ?",
        entity.scope.sql(),
        entity.table,
        entity.key
    )
    .replace("{row}", "t");
    let row = sqlx::query(&sql)
        .bind(key)
        .fetch_optional(&mut *conn)
        .await?;
    let left_scope = row.as_ref().is_some_and(|r| !r.get::<bool, _>(0)) && deleted;
    let row = if left_scope { None } else { row };
    let clocks: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT clocks, tomb FROM replica_clocks WHERE entity = ? AND key = ?")
            .bind(entity.entity.prefix())
            .bind(key)
            .fetch_optional(&mut *conn)
            .await?;
    let (packed, tomb) = match (clocks, &row) {
        (Some(clocks), _) => clocks,
        (None, None) => return Ok(Read::Missing),
        // Unchanged since sync started.
        (None, Some(_)) => {
            let base: Option<String> =
                sqlx::query_scalar("SELECT base_clock FROM replica_meta WHERE id = 1")
                    .fetch_one(&mut *conn)
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
        // A tombstone carries no values: the receiver only compares when the row went. No clock
        // passes the tombstone's, or the record would read as a live row of NULLs.
        None => entity
            .fields
            .iter()
            .enumerate()
            .map(|(i, f)| FieldState {
                values: vec![Value::Null; f.columns.len()],
                clock: tomb.map_or(clock_of(i), |t| clock_of(i).min(t)),
            })
            .collect(),
    };
    let mut fields = fields;
    if row.is_some() {
        restore_detached(conn, entity, key, &mut fields).await?;
    }
    let born = match (&row, tomb) {
        (None, Some(t)) => born.min(t),
        _ => born,
    };
    // Gone with no tombstone of its own: a cascade, which every device repeats from the parent's.
    if row.is_none() && tomb.is_none() {
        return Ok(Read::Missing);
    }
    Ok(Read::Row(RowState { born, fields, tomb }))
}

/// A reference a purge set NULL here is sent as what it pointed at: the NULL is this device's
/// leftover of the purge, which each device makes for itself, and the record has to read the same
/// wherever the purged row turns out to come back.
async fn restore_detached(
    conn: &mut sqlx::SqliteConnection,
    entity: &EntityMap,
    key: &str,
    fields: &mut [FieldState],
) -> AppResult<()> {
    let detached: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT field, col, target FROM replica_detached WHERE entity = ? AND key = ?",
    )
    .bind(entity.entity.prefix())
    .bind(key)
    .fetch_all(&mut *conn)
    .await?;
    for (field, column, target) in detached {
        let Some(state) = fields.get_mut(field as usize) else {
            continue;
        };
        let position = entity.fields[field as usize]
            .columns
            .iter()
            .position(|c| *c == column);
        if let Some(value) = position.and_then(|c| state.values.get_mut(c)) {
            if *value == Value::Null {
                *value = Value::Text(target);
            }
        }
    }
    Ok(())
}

async fn drop_op(pool: &SqlitePool, name: &RecordName) -> AppResult<()> {
    sqlx::query("DELETE FROM replica_ops WHERE entity = ? AND key = ?")
        .bind(name.entity.prefix())
        .bind(&name.key)
        .execute(pool)
        .await?;
    Ok(())
}

/// Keeps the transport's metadata for records it saved or fetched, such as CloudKit's change tag,
/// so the next save builds on the server's copy instead of being refused as stale after a relaunch.
pub async fn save_system_fields(
    pool: &SqlitePool,
    records: &[(RecordName, Vec<u8>)],
) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    for (name, data) in records {
        sqlx::query("UPDATE replica_clocks SET system_fields = ? WHERE entity = ? AND key = ?")
            .bind(data)
            .bind(name.entity.prefix())
            .bind(&name.key)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
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
