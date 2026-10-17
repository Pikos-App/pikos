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
//! The NULL keeps the reference's own clock, so a move made elsewhere before the purge still wins
//! over it, and each reference set NULL is noted with what it pointed at. If a later write elsewhere
//! brings the purged row back, every device that set a reference NULL points it there again, so a
//! folder that comes back has its pages back on every device.
//!
//! The generated SQL is checked in as a migration. `UPDATE_GOLDEN=1 cargo test -p pikos-db
//! replica` rewrites it, and a test fails when the database's triggers differ from what the
//! manifest generates.

use super::manifest::{EntityMap, Lifecycle, Scope, ENTITIES, PURGE_NULLED};

/// Where the generated triggers are checked in, relative to the crate.
pub const MIGRATION: &str = "migrations/028_replica_capture.sql";

const HLC_WIDTH: usize = 20;

const GATE: &str = "(SELECT started FROM replica_meta WHERE id = 1) = 1\n  \
     AND NOT EXISTS (SELECT 1 FROM replica_applying)";

const ADVANCE_CLOCK: &str = "UPDATE replica_meta \
     SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1;";

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
    let captures = ENTITIES.iter().flat_map(|entity| {
        ops(entity)
            .into_iter()
            .map(move |op| (trigger_name(entity, op), create_trigger(entity, op)))
    });
    let purges = ENTITIES
        .iter()
        .filter(|e| is_purge_target(e))
        .map(|e| (purge_trigger_name(e), create_purge_trigger(e)));
    let scope = [
        ("replica_scope_enter".to_owned(), scope_enter_trigger()),
        ("replica_scope_leave".to_owned(), scope_leave_trigger()),
    ];
    captures.chain(purges).chain(scope).collect()
}

/// A calendar page detaching from its calendar enters scope: it, everything hanging off it and the
/// done copies made by ticking its occurrences are sent whole as a fresh write, re-stamped at now.
/// Re-stamped because a page that left scope before carries the tombstone that removed its copy
/// elsewhere, and its older clocks would read as gone.
fn scope_enter_trigger() -> String {
    let mut statements = vec![ADVANCE_CLOCK.to_owned()];
    for entity in ENTITIES {
        let Scope::Page(column) = entity.scope else {
            continue;
        };
        let mut rows = format!("t.{column} = NEW.page_id");
        if column == "id" {
            rows.push_str(
                " OR t.id IN (SELECT clone_id FROM completed_set WHERE page_id = NEW.page_id)",
            );
        }
        let covers = entity.covers.map_or("1".to_owned(), |c| on_row(c, "t"));
        statements.push(format!(
            "INSERT INTO replica_ops (entity, key, fields, deleted, clock)\n  \
             SELECT '{}', {}, {}, 0, (SELECT hlc FROM replica_meta WHERE id = 1)\n  \
             FROM {} AS t WHERE ({covers}) AND ({rows})\n  \
             ON CONFLICT (entity, key) DO UPDATE SET fields = excluded.fields, deleted = 0, \
             clock = excluded.clock;",
            entity.entity.prefix(),
            on_row(entity.key, "t"),
            (1u64 << entity.fields.len()) - 1,
            entity.table
        ));
        statements.push(format!(
            "INSERT INTO replica_clocks (entity, key, clocks)\n  \
             SELECT '{}', {}, {} FROM {} AS t, replica_meta\n  \
             WHERE replica_meta.id = 1 AND ({covers}) AND ({rows})\n  \
             ON CONFLICT (entity, key) DO UPDATE SET clocks = excluded.clocks;",
            entity.entity.prefix(),
            on_row(entity.key, "t"),
            every_slot(entity, "replica_meta.hlc"),
            entity.table
        ));
    }
    format!(
        "CREATE TRIGGER replica_scope_enter AFTER UPDATE OF sync_state ON page_sync\n\
         WHEN {GATE}\n  AND OLD.sync_state <> 'detached' AND NEW.sync_state = 'detached'\n\
         BEGIN\n  {}\nEND",
        statements.join("\n  ")
    )
}

/// A detached page re-linking to its calendar leaves scope: every other device mirrors that event
/// itself, so the synced copy is removed there with a tombstone.
fn scope_leave_trigger() -> String {
    let page = ENTITIES
        .iter()
        .find(|e| e.entity == pikos_replica::Entity::Page)
        .expect("pages are synced");
    format!(
        "CREATE TRIGGER replica_scope_leave AFTER UPDATE OF sync_state ON page_sync\n\
         WHEN {GATE}\n  AND OLD.sync_state = 'detached' AND NEW.sync_state <> 'detached'\n\
         BEGIN\n  {ADVANCE_CLOCK}\n  \
         INSERT INTO replica_ops (entity, key, fields, deleted, clock)\n  \
         SELECT 'page', NEW.page_id, 0, 1, hlc FROM replica_meta WHERE id = 1\n  \
         ON CONFLICT (entity, key) DO UPDATE SET fields = 0, deleted = 1, clock = excluded.clock;\n  \
         INSERT INTO replica_clocks (entity, key, clocks, tomb)\n  \
         SELECT 'page', NEW.page_id, {}, hlc FROM replica_meta WHERE id = 1\n  \
         ON CONFLICT (entity, key) DO UPDATE SET tomb = excluded.tomb;\nEND",
        every_slot(page, "base_clock")
    )
}

/// The field whose clock a purge of a trashed row takes.
const TRASH_FIELD: &str = "deleted_at";

/// A row other rows' foreign keys set NULL when it's purged.
pub(crate) fn is_purge_target(entity: &EntityMap) -> bool {
    entity.lifecycle == Lifecycle::Row
        && entity.covers.is_none()
        && PURGE_NULLED
            .iter()
            .any(|(_, _, target)| *target == entity.table)
}

/// The clock a purge of the row in `OLD` is stamped with: now, except that purging a trashed row
/// takes the clock of its trashing, so a restore made on any device after the trashing beats an
/// empty-trash that runs later, even days later.
fn purge_clock(entity: &EntityMap) -> String {
    let now = "(SELECT hlc FROM replica_meta WHERE id = 1)";
    match entity.fields.iter().position(|f| f.name == TRASH_FIELD) {
        Some(i) => format!(
            "CASE WHEN OLD.{TRASH_FIELD} IS NOT NULL THEN COALESCE(\
             (SELECT substr(clocks, {}, {HLC_WIDTH}) FROM replica_clocks \
             WHERE entity = '{}' AND key = {}), \
             (SELECT base_clock FROM replica_meta WHERE id = 1)) ELSE {now} END",
            (i + 1) * HLC_WIDTH + 1,
            entity.entity.prefix(),
            on_row(entity.key, "OLD"),
        ),
        None => now.to_owned(),
    }
}

fn purge_trigger_name(target: &EntityMap) -> String {
    format!("replica_{}_purge", target.entity.prefix())
}

/// Before a purge target goes, notes every reference its foreign keys are about to set NULL, with
/// what it pointed at and its clock, so it points there again if a later write elsewhere brings the
/// row back. The NULL keeps the reference's own clock: a move made elsewhere before the purge still
/// beats it. The delete trigger then takes the same clock for the tombstone without moving it.
///
/// Purging a trashed row is clocked at the trashing, so a reference made after it, a focus session
/// started on the trashed page, is newer than the purge. Its NULL is sent as an ordinary edit, at
/// now, rather than left for every device to repeat from a tombstone that's older than it.
fn create_purge_trigger(target: &EntityMap) -> String {
    let clock = purge_clock(target);
    let mut statements = vec![ADVANCE_CLOCK.to_owned()];
    for (table, column, _) in PURGE_NULLED.iter().filter(|(_, _, t)| *t == target.table) {
        for entity in ENTITIES.iter().filter(|e| e.table == *table) {
            let Some(field) = entity
                .fields
                .iter()
                .position(|f| f.columns.contains(column))
            else {
                continue;
            };
            let name = entity.entity.prefix();
            let covers = entity
                .covers
                .map_or(String::new(), |c| format!(" AND {}", on_row(c, "c")));
            let key = on_row(entity.key, "c");
            let slot_start = (field + 1) * HLC_WIDTH + 1;
            let slot = format!("substr(replica_clocks.clocks, {slot_start}, {HLC_WIDTH})");
            let referencing = format!(
                "FROM {table} AS c JOIN replica_clocks ON replica_clocks.entity = '{name}' \
                 AND replica_clocks.key = {key}\n  WHERE c.{column} = OLD.id{covers}"
            );
            statements.push(format!(
                "INSERT INTO replica_clocks (entity, key, clocks)\n  \
                 SELECT '{name}', {key}, {} FROM {table} AS c, replica_meta\n  \
                 WHERE replica_meta.id = 1 AND c.{column} = OLD.id{covers}\n  \
                 ON CONFLICT (entity, key) DO NOTHING;",
                every_slot(entity, "replica_meta.base_clock")
            ));
            statements.push(format!(
                "INSERT OR REPLACE INTO replica_detached (entity, key, field, col, target, clock)\n  \
                 SELECT '{name}', {key}, {field}, '{column}', OLD.id, {slot}\n  \
                 {referencing} AND {slot} <= {clock};"
            ));
            statements.push(format!(
                "INSERT INTO replica_ops (entity, key, fields, deleted, clock)\n  \
                 SELECT '{name}', {key}, {}, 0, (SELECT hlc FROM replica_meta WHERE id = 1)\n  \
                 {referencing} AND {slot} > {clock}\n  \
                 ON CONFLICT (entity, key) DO UPDATE SET fields = fields | excluded.fields, \
                 clock = excluded.clock;",
                1u64 << field
            ));
            let slots: Vec<String> = (0..=entity.fields.len())
                .map(|i| {
                    let current = format!("substr(clocks, {}, {HLC_WIDTH})", i * HLC_WIDTH + 1);
                    if i == field + 1 {
                        format!(
                            "CASE WHEN {current} > {clock} \
                             THEN (SELECT hlc FROM replica_meta WHERE id = 1) ELSE {current} END"
                        )
                    } else {
                        current
                    }
                })
                .collect();
            statements.push(format!(
                "UPDATE replica_clocks SET clocks =\n      {}\n  \
                 WHERE entity = '{name}' AND key IN \
                 (SELECT {key} FROM {table} AS c WHERE c.{column} = OLD.id{covers});",
                slots.join("\n      || ")
            ));
        }
    }
    format!(
        "CREATE TRIGGER {} BEFORE DELETE ON {}\nWHEN {GATE}\nBEGIN\n  {}\nEND",
        purge_trigger_name(target),
        target.table,
        statements.join("\n  ")
    )
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
             SELECT '{name}', {key}, {}, {} FROM replica_meta WHERE id = 1\n  \
             ON CONFLICT (entity, key) DO UPDATE SET tomb = excluded.tomb;",
            every_slot(entity, "base_clock"),
            purge_clock(entity)
        ),
    };

    // A purge target's clock already moved in its purge trigger, and the tombstone has to match the
    // clock that trigger stamped.
    let purged_already = matches!(op, Op::Delete) && is_purge_target(entity);
    if purged_already {
        format!("  {op_row}\n  {clocks}")
    } else {
        format!("  {ADVANCE_CLOCK}\n  {op_row}\n  {clocks}")
    }
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
