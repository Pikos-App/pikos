//! The capture triggers, generated from the manifest.
//!
//! A trigger records, in the transaction of the write that fired it, which synced fields of which
//! row changed and at what clock. Writes reach the synced tables through some sixty functions and
//! the calendar reconciler's raw statements, and a trigger can't be skipped by any of them.
//!
//! Each trigger advances the clock, marks the record's dirty fields in `replica_ops` and stamps the
//! changed fields' slots in `replica_clocks`. None fires before sync has started or while
//! `replica_applying` holds its row. Two writes are deliberately not captured, because every device
//! makes them itself when the purge's tombstone arrives: a cascade delete, and a column set NULL by
//! a purged row's foreign key.
//!
//! The generated SQL is checked in as a migration. `UPDATE_GOLDEN=1 cargo test -p pikos-db
//! replica` rewrites it, and a test fails when the database's triggers differ from what the
//! manifest generates.

use super::manifest::{EntityMap, Lifecycle, ENTITIES, PURGE_NULLED};

/// Where the generated triggers are checked in, relative to the crate.
pub const MIGRATION: &str = "migrations/028_replica_capture.sql";

const HLC_WIDTH: usize = 20;

const GATE: &str = "(SELECT started FROM replica_meta WHERE id = 1) = 1\n  \
     AND NOT EXISTS (SELECT 1 FROM replica_applying)";

const ADVANCE_CLOCK: &str = "UPDATE replica_meta \
     SET hlc = pikos_hlc_next(hlc, CAST(unixepoch('subsec') * 1000 AS INTEGER)) WHERE id = 1;";

#[derive(Clone, Copy)]
enum Op {
    Insert,
    Update,
    Delete,
}

impl Op {
    fn name(self) -> &'static str {
        match self {
            Op::Insert => "insert",
            Op::Update => "update",
            Op::Delete => "delete",
        }
    }

    fn row(self) -> &'static str {
        match self {
            Op::Delete => "OLD",
            Op::Insert | Op::Update => "NEW",
        }
    }
}

/// Every capture trigger's name and `CREATE TRIGGER` statement, in manifest order and without the
/// closing semicolon, as `sqlite_master` stores it.
pub fn triggers() -> Vec<(String, String)> {
    ENTITIES
        .iter()
        .flat_map(|entity| {
            ops(entity)
                .into_iter()
                .map(move |op| (trigger_name(entity, op), create_trigger(entity, op)))
        })
        .collect()
}

/// The migration that installs [`triggers`].
pub fn migration_sql() -> String {
    let mut sql = String::from(
        "-- Generated from the replica manifest in pikos-db. Don't edit; regenerate with\n\
         -- UPDATE_GOLDEN=1 cargo test -p pikos-db replica\n",
    );
    for (_, create) in triggers() {
        sql.push('\n');
        sql.push_str(&create);
        sql.push_str(";\n");
    }
    sql
}

fn ops(entity: &EntityMap) -> Vec<Op> {
    let changes = !entity.fields.is_empty();
    match entity.lifecycle {
        Lifecycle::Row if changes => vec![Op::Insert, Op::Update, Op::Delete],
        Lifecycle::Row => vec![Op::Insert, Op::Delete],
        Lifecycle::CreateOnly => vec![Op::Insert],
        Lifecycle::Part => vec![Op::Insert, Op::Update],
    }
}

fn trigger_name(entity: &EntityMap, op: Op) -> String {
    format!("replica_{}_{}", entity.entity.prefix(), op.name())
}

fn on_row(sql: &str, row: &str) -> String {
    sql.replace("{row}", row)
}

/// SQL true when field `i` changed in an update. A column set NULL because the row it pointed at
/// was purged doesn't count.
fn field_changed(entity: &EntityMap, i: usize) -> String {
    let changes: Vec<String> = entity.fields[i]
        .columns
        .iter()
        .map(|column| {
            let changed = format!("OLD.{column} IS NOT NEW.{column}");
            let nulled_by = PURGE_NULLED
                .iter()
                .find(|(table, c, _)| *table == entity.table && c == column);
            match nulled_by {
                Some((_, _, parent)) => format!(
                    "({changed} AND NOT (NEW.{column} IS NULL \
                     AND NOT EXISTS (SELECT 1 FROM {parent} WHERE id = OLD.{column})))"
                ),
                None => changed,
            }
        })
        .collect();
    changes.join(" OR ")
}

fn when(entity: &EntityMap, op: Op) -> String {
    let row = op.row();
    let mut terms = vec![GATE.to_owned()];
    if let Some(covers) = entity.covers {
        terms.push(on_row(covers, row));
    }
    if let (Op::Delete, Some(parent)) = (op, &entity.parent) {
        terms.push(format!(
            "EXISTS (SELECT 1 FROM {} WHERE id = OLD.{})",
            parent.table, parent.column
        ));
    }
    if let Op::Update = op {
        let any: Vec<String> = (0..entity.fields.len())
            .map(|i| format!("({})", field_changed(entity, i)))
            .collect();
        terms.push(format!("({})", any.join("\n    OR ")));
    }
    terms.join("\n  AND ")
}

/// `source` repeated once per clock slot: the row's creation, then each field.
fn every_slot(entity: &EntityMap, source: &str) -> String {
    vec![source; entity.fields.len() + 1].join(" || ")
}

fn body(entity: &EntityMap, op: Op) -> String {
    let name = entity.entity.prefix();
    let key = on_row(entity.key, op.row());
    let all_fields: u64 = (1u64 << entity.fields.len()) - 1;

    let (fields, deleted, on_conflict) = match op {
        Op::Insert => (
            all_fields.to_string(),
            0,
            "fields = excluded.fields, deleted = 0, clock = excluded.clock",
        ),
        Op::Update => (
            (0..entity.fields.len())
                .map(|i| {
                    format!(
                        "(CASE WHEN {} THEN {} ELSE 0 END)",
                        field_changed(entity, i),
                        1u64 << i
                    )
                })
                .collect::<Vec<_>>()
                .join("\n      | "),
            0,
            "fields = fields | excluded.fields, clock = excluded.clock",
        ),
        Op::Delete => (
            "0".to_owned(),
            1,
            "fields = 0, deleted = 1, clock = excluded.clock",
        ),
    };
    let op_row = format!(
        "INSERT INTO replica_ops (entity, key, fields, deleted, clock)\n  \
         SELECT '{name}', {key},\n      {fields},\n      {deleted}, hlc \
         FROM replica_meta WHERE id = 1\n  \
         ON CONFLICT (entity, key) DO UPDATE SET {on_conflict};"
    );

    let clocks = match op {
        Op::Insert => format!(
            "INSERT INTO replica_clocks (entity, key, clocks, tomb)\n  \
             SELECT '{name}', {key}, {}, NULL FROM replica_meta WHERE id = 1\n  \
             ON CONFLICT (entity, key) DO UPDATE SET clocks = excluded.clocks, tomb = NULL;",
            every_slot(entity, "hlc")
        ),
        Op::Update => {
            let slots: Vec<String> = std::iter::once(format!("substr(clocks, 1, {HLC_WIDTH})"))
                .chain((0..entity.fields.len()).map(|i| {
                    format!(
                        "CASE WHEN {} THEN (SELECT hlc FROM replica_meta WHERE id = 1) \
                         ELSE substr(clocks, {}, {HLC_WIDTH}) END",
                        field_changed(entity, i),
                        (i + 1) * HLC_WIDTH + 1
                    )
                }))
                .collect();
            format!(
                "{}\n  UPDATE replica_clocks SET clocks =\n      {}\n  \
                 WHERE entity = '{name}' AND key = {key};",
                ensure_clocks(entity, &key),
                slots.join("\n      || ")
            )
        }
        Op::Delete => format!(
            "INSERT INTO replica_clocks (entity, key, clocks, tomb)\n  \
             SELECT '{name}', {key}, {}, hlc FROM replica_meta WHERE id = 1\n  \
             ON CONFLICT (entity, key) DO UPDATE SET tomb = excluded.tomb;",
            every_slot(entity, "base_clock")
        ),
    };

    format!("  {ADVANCE_CLOCK}\n  {op_row}\n  {clocks}")
}

/// A row with no clocks yet holds the base clock in every slot.
fn ensure_clocks(entity: &EntityMap, key: &str) -> String {
    format!(
        "INSERT INTO replica_clocks (entity, key, clocks)\n  \
         SELECT '{}', {key}, {} FROM replica_meta WHERE id = 1\n  \
         ON CONFLICT (entity, key) DO NOTHING;",
        entity.entity.prefix(),
        every_slot(entity, "base_clock")
    )
}

fn create_trigger(entity: &EntityMap, op: Op) -> String {
    format!(
        "CREATE TRIGGER {} AFTER {} ON {}\nWHEN {}\nBEGIN\n{}\nEND",
        trigger_name(entity, op),
        op.name().to_uppercase(),
        entity.table,
        when(entity, op),
        body(entity, op)
    )
}

#[cfg(test)]
#[path = "capture_tests.rs"]
mod tests;
