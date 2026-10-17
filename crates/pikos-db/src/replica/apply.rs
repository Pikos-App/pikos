//! Applying records from other devices: merge each with this device's row and write the result,
//! all in one uncaptured transaction.
//!
//! The ordinary writers can't do this: they stamp `updated_at` with now, refuse trashed pages and
//! open their own transactions. These write synced columns directly, then hand the page to the code
//! that owns each derived column: the body's search text, the tag cache, and the schedule caches.
//! The search index, title keys, counts and change counter follow by their own triggers.
//!
//! A record whose parent this device has never seen waits in `replica_pen` and is retried on every
//! apply, and so does one whose parent was purged here, since a later write elsewhere can bring the
//! parent back; dropping it would lose it for good on this device. A reference the foreign key
//! would have set NULL is applied NULL instead. A record from a newer Pikos waits too, until an
//! update can read it.

use std::collections::{BTreeMap, BTreeSet};

use pikos_replica::codec::{self, DecodeError, FieldMap, Record};
use pikos_replica::merge::{self, FieldState, RowState, Value};
use pikos_replica::{Entity, Hlc, RecordName};
use sqlx::{Row as _, SqliteConnection, SqlitePool};

use super::manifest::{entity as entity_map, EntityMap, Lifecycle, PURGE_NULLED};
use super::Uncaptured;
use crate::error::{AppError, AppResult};

/// Parents before children, so a batch holding both never pens the child.
const APPLY_ORDER: [Entity; 12] = [
    Entity::Folder,
    Entity::Page,
    Entity::Body,
    Entity::Tag,
    Entity::Rule,
    Entity::Schedule,
    Entity::Override,
    Entity::PageTag,
    Entity::Completed,
    Entity::Skipped,
    Entity::Reminder,
    Entity::FocusSession,
];

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Applied {
    /// Records that changed something here.
    pub changed: usize,
    /// Records waiting for a parent or a newer Pikos.
    pub held: usize,
    /// Records this device sends again whole, re-stamped, because a write here outlived another
    /// device's purge of them.
    pub resent: BTreeSet<String>,
}

pub fn shape(entity: &EntityMap) -> Vec<(&'static str, usize)> {
    entity
        .fields
        .iter()
        .map(|f| (f.name, f.columns.len()))
        .collect()
}

/// Why a record is held back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Hold {
    UnknownParent,
    /// A later write elsewhere can bring the parent back, and the record with it.
    DeletedParent,
    NewerFormat,
    Unreadable,
}

impl Hold {
    fn reason(self) -> &'static str {
        match self {
            Hold::UnknownParent => "unknown_parent",
            Hold::DeletedParent => "deleted_parent",
            Hold::NewerFormat => "newer_format",
            Hold::Unreadable => "unreadable",
        }
    }
}

enum Outcome {
    Unchanged,
    Changed,
    Held(Hold),
    Dropped,
}

/// Merges `records` into the workspace in one transaction, retrying held records alongside them.
pub async fn apply(pool: &SqlitePool, records: &[(RecordName, FieldMap)]) -> AppResult<Applied> {
    crate::tx::retry_on_busy(|| async {
        let mut tx = Uncaptured::begin(pool).await?;
        let applied = apply_in(&mut tx, records).await?;
        tx.commit().await?;
        Ok(applied)
    })
    .await
}

async fn apply_in(
    tx: &mut Uncaptured<'_>,
    incoming: &[(RecordName, FieldMap)],
) -> AppResult<Applied> {
    // Each record with when it was first held here, if it was, sorted parents first.
    let mut batch: Vec<(RecordName, FieldMap, Option<String>)> = held(tx.conn())
        .await?
        .into_iter()
        .map(|(name, map, since)| (name, map, Some(since)))
        .chain(
            incoming
                .iter()
                .cloned()
                .map(|(name, map)| (name, map, None)),
        )
        .collect();
    sqlx::query("DELETE FROM replica_pen")
        .execute(tx.conn())
        .await?;
    batch.sort_by_key(|(name, _, _)| APPLY_ORDER.iter().position(|e| *e == name.entity));

    let mut applied = Applied::default();
    let mut touched = Touched::default();
    let mut newest = Hlc::ZERO;

    for (name, map, held_since) in &batch {
        let was_held = held_since.is_some();
        let since = held_since.as_deref();
        let Some(entity) = entity_map(name.entity) else {
            continue;
        };
        let outcome = match codec::decode(name.clone(), map, &shape(entity)) {
            Err(DecodeError::NewerFormat(_)) => Outcome::Held(Hold::NewerFormat),
            Err(DecodeError::Malformed(why)) => {
                log::warn!("replica: holding {name}: {why}");
                Outcome::Held(Hold::Unreadable)
            }
            Ok(record) => {
                newest = newest
                    .max(record.row.newest())
                    .max(record.row.tomb.unwrap_or(Hlc::ZERO));
                apply_record(tx, entity, &record, &mut touched, &mut applied)
                    .await
                    .map_err(|e| naming(e, name))?
            }
        };
        match outcome {
            // A held record can be this device's own, never sent: a child written just before a
            // purge arrived from elsewhere. Applied once its parent is back, it's sent too.
            Outcome::Changed if was_held => {
                applied.changed += 1;
                queue_whole(tx.conn(), name).await?;
            }
            Outcome::Changed => applied.changed += 1,
            Outcome::Held(hold) => {
                hold_record(tx.conn(), name, map, hold, since).await?;
                applied.held += 1;
            }
            Outcome::Unchanged | Outcome::Dropped => {}
        }
    }

    touched.rederive(tx).await?;
    observe(tx.conn(), newest).await?;
    for name in &applied.resent {
        let name: RecordName = name
            .parse()
            .map_err(|e| AppError::Internal(format!("resent record: {e}")))?;
        revive(tx.conn(), &name).await?;
    }
    Ok(applied)
}

/// Names the record an apply failed on. A busy database stays as it is, so the write is retried.
fn naming(error: AppError, name: &RecordName) -> AppError {
    if crate::tx::is_retryable_busy(&error) {
        error
    } else {
        AppError::Internal(format!("applying {name}: {error}"))
    }
}

/// Pages whose derived columns are stale after the batch.
#[derive(Default)]
struct Touched {
    bodies: BTreeSet<String>,
    tags: BTreeSet<String>,
    reminders: BTreeSet<String>,
    schedules: BTreeSet<String>,
    /// The newest clock that won on each page or folder row, for its `updated_at`.
    stamped: BTreeMap<(&'static str, String), Hlc>,
}

impl Touched {
    async fn rederive(&self, tx: &mut Uncaptured<'_>) -> AppResult<()> {
        for page in &self.bodies {
            let content: Option<String> =
                sqlx::query_scalar("SELECT content FROM pages WHERE id = ?")
                    .bind(page)
                    .fetch_optional(tx.conn())
                    .await?;
            if let Some(content) = content {
                sqlx::query("UPDATE pages SET content_text = ? WHERE id = ?")
                    .bind(crate::pool::extract_text_from_tiptap(&content))
                    .bind(page)
                    .execute(tx.conn())
                    .await?;
            }
        }
        for page in &self.tags {
            sqlx::query(
                "UPDATE pages SET tags = (
                   SELECT COALESCE(json_group_array(name), '[]') FROM (
                     SELECT tags.name FROM page_tags JOIN tags ON tags.id = page_tags.tag_id
                     WHERE page_tags.page_id = pages.id ORDER BY tags.name))
                 WHERE id = ?",
            )
            .bind(page)
            .execute(tx.conn())
            .await?;
        }
        if !self.reminders.is_empty() {
            tx.capture().await?;
            for page in &self.reminders {
                settle_reminders(tx.conn(), page).await?;
            }
            tx.uncapture().await?;
        }
        for page in &self.schedules {
            crate::schedules::refresh_schedule_denorm_conn(tx.conn(), page).await?;
            // A series that runs out marks its page done, a value every device works out for
            // itself at its own time. Captured, one device's copy wins everywhere.
            tx.capture().await?;
            crate::recurrence_derive::recompute_recurring_schedule(tx.tx(), page).await?;
            tx.uncapture().await?;
        }
        for ((table, id), clock) in &self.stamped {
            let sql = match *table {
                "pages" => "UPDATE pages SET updated_at = ? WHERE id = ?",
                _ => "UPDATE folders SET updated_at = ? WHERE id = ?",
            };
            sqlx::query(sql)
                .bind(wall_time(*clock))
                .bind(id)
                .execute(tx.conn())
                .await?;
        }
        Ok(())
    }
}

/// Reminders set on two devices at once can leave a page with both "no reminders" and a real one, or
/// the same lead twice. "No reminders" wins and a repeated lead counts once. The removal is captured
/// and sent like any edit: left for each device to repeat, a device that never saw the reason, a
/// "no reminders" removed again before it was sent, would keep the reminder the others dropped.
async fn settle_reminders(conn: &mut SqliteConnection, page: &str) -> AppResult<()> {
    sqlx::query(
        "DELETE FROM page_reminders WHERE page_id = ?1 AND minutes_before <> ?2
           AND EXISTS (SELECT 1 FROM page_reminders WHERE page_id = ?1 AND minutes_before = ?2)",
    )
    .bind(page)
    .bind(crate::reminders::NO_REMINDERS)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM page_reminders WHERE page_id = ?1 AND id NOT IN
           (SELECT MIN(id) FROM page_reminders WHERE page_id = ?1 GROUP BY minutes_before)",
    )
    .bind(page)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// A clock's wall time in the `updated_at` format.
fn wall_time(clock: Hlc) -> String {
    chrono::DateTime::from_timestamp_millis(clock.wall_ms() as i64)
        .unwrap_or_default()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

async fn observe(conn: &mut SqliteConnection, newest: Hlc) -> AppResult<()> {
    let current: String = sqlx::query_scalar("SELECT hlc FROM replica_meta WHERE id = 1")
        .fetch_one(&mut *conn)
        .await?;
    let current: Hlc = current
        .parse()
        .map_err(|e| AppError::Invalid(format!("replica clock: {e}")))?;
    if newest > current {
        sqlx::query("UPDATE replica_meta SET hlc = ? WHERE id = 1")
            .bind(current.observe(newest).to_string())
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

/// Held records, each with when it was first held.
async fn held(conn: &mut SqliteConnection) -> AppResult<Vec<(RecordName, FieldMap, String)>> {
    let rows: Vec<(String, String, String)> =
        sqlx::query_as("SELECT name, record, since FROM replica_pen")
            .fetch_all(&mut *conn)
            .await?;
    rows.into_iter()
        .map(|(name, record, since)| {
            let name = name
                .parse()
                .map_err(|e| AppError::Internal(format!("held record name: {e}")))?;
            Ok((name, map_from_json(&record)?, since))
        })
        .collect()
}

/// Holds a record, keeping `since` when it was already held so its retention runs from the first
/// time. A new hold is dated by wall time, never the clock, which a device far ahead could inflate.
async fn hold_record(
    conn: &mut SqliteConnection,
    name: &RecordName,
    map: &FieldMap,
    hold: Hold,
    since: Option<&str>,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO replica_pen (name, record, reason, since)
         VALUES (?, ?, ?, COALESCE(?, pikos_hlc_next('00000000000000000000', pikos_now_ms())))
         ON CONFLICT (name) DO UPDATE SET record = excluded.record, reason = excluded.reason",
    )
    .bind(name.to_string())
    .bind(map_to_json(map))
    .bind(hold.reason())
    .bind(since)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Values tagged with their type, since JSON alone can't tell an integer from a real.
fn map_to_json(map: &FieldMap) -> String {
    let object: serde_json::Map<String, serde_json::Value> = map
        .iter()
        .map(|(k, v)| {
            let tagged = match v {
                Value::Null => serde_json::Value::Null,
                Value::Integer(i) => serde_json::json!({ "i": i }),
                Value::Real(r) => serde_json::json!({ "r": r }),
                Value::Text(t) => serde_json::json!({ "t": t }),
            };
            (k.clone(), tagged)
        })
        .collect();
    serde_json::Value::Object(object).to_string()
}

fn map_from_json(text: &str) -> AppResult<FieldMap> {
    let bad = || AppError::Internal("held record is unreadable".into());
    let object: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(text).map_err(|_| bad())?;
    object
        .into_iter()
        .map(|(k, v)| {
            let value = match &v {
                serde_json::Value::Null => Value::Null,
                serde_json::Value::Object(o) => match o.iter().next() {
                    Some((tag, inner)) if tag == "i" => {
                        Value::Integer(inner.as_i64().ok_or_else(bad)?)
                    }
                    Some((tag, inner)) if tag == "r" => {
                        Value::Real(inner.as_f64().ok_or_else(bad)?)
                    }
                    Some((tag, inner)) if tag == "t" => {
                        Value::Text(inner.as_str().ok_or_else(bad)?.to_owned())
                    }
                    _ => return Err(bad()),
                },
                _ => return Err(bad()),
            };
            Ok((k, value))
        })
        .collect()
}

/// SQLite's `quote()` text back to a value. Synced columns hold text, integers, reals or NULL.
pub(crate) fn unquote(quoted: &str) -> Value {
    if quoted == "NULL" {
        return Value::Null;
    }
    if let Some(inner) = quoted.strip_prefix('\'').and_then(|q| q.strip_suffix('\'')) {
        return Value::Text(inner.replace("''", "'"));
    }
    if let Ok(i) = quoted.parse::<i64>() {
        return Value::Integer(i);
    }
    quoted
        .parse::<f64>()
        .map(Value::Real)
        .unwrap_or_else(|_| Value::Text(quoted.to_owned()))
}

/// The page id a child record hangs off, from its key or its fields.
fn page_of(record: &Record) -> Option<String> {
    let entity = entity_map(record.name.entity)?;
    match record.name.entity {
        Entity::Page | Entity::Body => Some(record.name.key.clone()),
        Entity::Rule => Some(record.name.key.clone()),
        Entity::PageTag | Entity::Override | Entity::Completed | Entity::Skipped => record
            .name
            .key
            .split_once('/')
            .map(|(page, _)| page.to_owned()),
        _ => {
            let (field, column) = locate(entity, "page_id")?;
            match &record.row.fields[field].values[column] {
                Value::Text(page) => Some(page.clone()),
                _ => None,
            }
        }
    }
}

/// The field and column index of a column in an entity's fields.
fn locate(entity: &EntityMap, column: &str) -> Option<(usize, usize)> {
    entity
        .fields
        .iter()
        .enumerate()
        .find_map(|(i, f)| f.columns.iter().position(|c| *c == column).map(|c| (i, c)))
}

/// What this device knows of a row a record refers to. A present row can still carry the tombstone
/// of a purge that a later write outlived.
#[derive(Debug, PartialEq, Eq)]
enum Known {
    Present(Option<Hlc>),
    Tombstoned(Hlc),
    Unknown,
}

async fn known(
    conn: &mut SqliteConnection,
    table: &str,
    entity: Entity,
    id: &str,
) -> AppResult<Known> {
    let present: bool = sqlx::query_scalar(&format!(
        "SELECT EXISTS (SELECT 1 FROM {table} WHERE id = ?)"
    )) // sql-ok: table names are literals from this module
    .bind(id)
    .fetch_one(&mut *conn)
    .await?;
    let tomb: Option<String> = sqlx::query_scalar(
        "SELECT tomb FROM replica_clocks WHERE entity = ? AND key = ? AND tomb IS NOT NULL",
    )
    .bind(entity.prefix())
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    let tomb: Option<Hlc> = tomb.and_then(|t| t.parse().ok());
    Ok(match (present, tomb) {
        (true, tomb) => Known::Present(tomb),
        (false, Some(tomb)) => Known::Tombstoned(tomb),
        (false, None) => Known::Unknown,
    })
}

/// What a purge of `target`'s row `id`, heard of from a tombstone, does to the rows pointing at it
/// here: each is noted with what it pointed at before the foreign key sets the column NULL, as the
/// purge trigger does where the purge happens. The link's synced value is unchanged.
async fn detach_references(
    conn: &mut SqliteConnection,
    target: &EntityMap,
    id: &str,
) -> AppResult<()> {
    for (table, column, _) in PURGE_NULLED.iter().filter(|(_, _, t)| *t == target.table) {
        for entity in super::manifest::ENTITIES
            .iter()
            .filter(|e| e.table == *table)
        {
            let Some((field, _)) = locate(entity, column) else {
                continue;
            };
            let covers = entity.covers.unwrap_or("1");
            let sql = format!(
                "SELECT {} FROM {table} AS t WHERE t.{column} = ? AND ({covers})",
                entity.key
            )
            .replace("{row}", "t");
            let keys: Vec<String> = sqlx::query_scalar(&sql)
                .bind(id)
                .fetch_all(&mut *conn)
                .await?;
            for key in keys {
                note_detached(conn, entity, &key, field, column, id).await?;
            }
        }
    }
    Ok(())
}

async fn note_detached(
    conn: &mut SqliteConnection,
    entity: &EntityMap,
    key: &str,
    field: usize,
    column: &str,
    target: &str,
) -> AppResult<()> {
    sqlx::query(
        "INSERT OR REPLACE INTO replica_detached (entity, key, field, col, target)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(entity.entity.prefix())
    .bind(key)
    .bind(field as i64)
    .bind(column)
    .bind(target)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// A row links point at has arrived, or come back after a purge: every link here noted as pointing
/// at it shows it again.
async fn reattach_references(
    conn: &mut SqliteConnection,
    target: &EntityMap,
    id: &str,
) -> AppResult<()> {
    let detached: Vec<(String, String, i64, String)> =
        sqlx::query_as("SELECT entity, key, field, col FROM replica_detached WHERE target = ?")
            .bind(id)
            .fetch_all(&mut *conn)
            .await?;
    for (prefix, key, field, column) in detached {
        let Some(entity) = super::manifest::ENTITIES
            .iter()
            .find(|e| e.entity.prefix() == prefix)
        else {
            continue;
        };
        let points_here = PURGE_NULLED
            .iter()
            .any(|(t, c, tt)| *t == entity.table && *c == column && *tt == target.table);
        if !points_here {
            continue;
        }
        let covers = entity.covers.unwrap_or("1");
        let sql = format!(
            "UPDATE {} SET {column} = ? WHERE {column} IS NULL AND rowid IN
               (SELECT t.rowid FROM {} AS t WHERE ({covers}) AND {} = ?)",
            entity.table, entity.table, entity.key
        )
        .replace("{row}", "t");
        sqlx::query(&sql)
            .bind(id)
            .bind(&key)
            .execute(&mut *conn)
            .await?;
        sqlx::query("DELETE FROM replica_detached WHERE entity = ? AND key = ? AND field = ?")
            .bind(&prefix)
            .bind(&key)
            .bind(field)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

/// The row as it can be written here: a link to a row this device doesn't have is written NULL, as
/// its foreign key requires, and noted with what it points at; a link that can be shown clears any
/// note. The synced values, which merge and are sent, keep every link.
async fn project_links(
    conn: &mut SqliteConnection,
    entity: &EntityMap,
    key: &str,
    row: &RowState,
) -> AppResult<RowState> {
    let mut projected = row.clone();
    for (_, column, target_table) in PURGE_NULLED.iter().filter(|(t, _, _)| *t == entity.table) {
        let Some((f, c)) = locate(entity, column) else {
            continue;
        };
        let missing = match &row.fields[f].values[c] {
            Value::Text(id) => {
                let here: bool = sqlx::query_scalar(&format!(
                    "SELECT EXISTS (SELECT 1 FROM {target_table} WHERE id = ?)"
                )) // sql-ok: table names are literals from the manifest
                .bind(id)
                .fetch_one(&mut *conn)
                .await?;
                (!here).then(|| id.clone())
            }
            _ => None,
        };
        match missing {
            Some(id) => {
                projected.fields[f].values[c] = Value::Null;
                note_detached(conn, entity, key, f, column, &id).await?;
            }
            None => {
                sqlx::query(
                    "DELETE FROM replica_detached WHERE entity = ? AND key = ? AND field = ?",
                )
                .bind(entity.entity.prefix())
                .bind(key)
                .bind(f as i64)
                .execute(&mut *conn)
                .await?;
            }
        }
    }
    Ok(projected)
}

async fn apply_record(
    tx: &mut Uncaptured<'_>,
    entity: &EntityMap,
    record: &Record,
    touched: &mut Touched,
    applied: &mut Applied,
) -> AppResult<Outcome> {
    let remote = record.row.clone();

    // A calendar page here, and what hangs off it, is this device's own; its synced copy elsewhere
    // is a different row that left scope.
    if out_of_scope_here(tx.conn(), entity, &record.name.key).await? {
        return Ok(Outcome::Dropped);
    }

    if remote.is_live() {
        let needs_page = !matches!(
            record.name.entity,
            Entity::Page | Entity::Folder | Entity::Tag | Entity::FocusSession
        );
        if needs_page {
            let Some(page) = page_of(record) else {
                return Ok(Outcome::Dropped);
            };
            match known(tx.conn(), "pages", Entity::Page, &page).await? {
                // Written before the page's purge, which removed it everywhere; a page brought back
                // since re-sent what it still had, at new clocks.
                Known::Present(Some(tomb)) if remote.newest() <= tomb => {
                    return Ok(Outcome::Dropped)
                }
                Known::Present(_) => {}
                Known::Tombstoned(_) => return Ok(Outcome::Held(Hold::DeletedParent)),
                Known::Unknown => return Ok(Outcome::Held(Hold::UnknownParent)),
            }
        }
        if record.name.entity == Entity::Override
            && local_rule(tx.conn(), &page_of(record).unwrap_or_default())
                .await?
                .is_none()
        {
            return Ok(Outcome::Held(Hold::UnknownParent));
        }
    }

    let local_row = read_row(tx.conn(), entity, &record.name.key).await?;
    let clocks = read_clocks(tx.conn(), entity, &record.name.key).await?;
    let local = match (&local_row, clocks) {
        (Some(values), clocks) => {
            let (born, slots, tomb) = match clocks {
                Some(c) => c,
                None => {
                    let base = base_clock(tx.conn()).await?;
                    (base, vec![base; entity.fields.len()], None)
                }
            };
            Some(RowState {
                born,
                fields: values
                    .iter()
                    .zip(slots)
                    .map(|(values, clock)| FieldState {
                        values: values.clone(),
                        clock,
                    })
                    .collect(),
                tomb,
            })
        }
        // Removed by its own delete, so only when it went counts.
        (None, Some((born, slots, Some(tomb))))
            if slots.iter().copied().fold(born, Hlc::max) <= tomb =>
        {
            Some(RowState {
                born,
                fields: entity
                    .fields
                    .iter()
                    .zip(slots)
                    .map(|(f, clock)| FieldState {
                        values: vec![Value::Null; f.columns.len()],
                        clock,
                    })
                    .collect(),
                tomb: Some(tomb),
            })
        }
        // Removed by its parent's purge, its clocks newer than any delete of its own. While the
        // parent is gone its records are held above, so one that gets here came with the parent
        // brought back, and is taken as new.
        (None, _) => None,
    };

    let merged = merge::merge(local.as_ref(), &remote);
    let was_live = local_row.is_some();
    let now_live = merged.row.is_live();
    let writes_row = now_live && (merged.taken != 0 || !was_live);

    if entity.lifecycle == Lifecycle::Part && writes_row && !was_live {
        return Ok(Outcome::Held(Hold::UnknownParent));
    }

    if writes_row {
        let writable = project_links(tx.conn(), entity, &record.name.key, &merged.row).await?;
        write_row(tx.conn(), entity, &record.name.key, &writable).await?;
        if !was_live {
            unstamp_parts(tx.conn(), entity, &record.name.key).await?;
            if super::capture::is_purge_target(entity) {
                reattach_references(tx.conn(), entity, &record.name.key).await?;
            }
        }
    } else if was_live && !now_live {
        if let (true, Some(tomb)) = (super::capture::is_purge_target(entity), merged.row.tomb) {
            detach_references(tx.conn(), entity, &record.name.key).await?;
            if entity.entity == Entity::Page {
                hold_newer_children(tx.conn(), &record.name.key, tomb).await?;
            }
        }
        delete_row(tx.conn(), entity, &record.name.key).await?;
    }
    let local_tomb = local.as_ref().and_then(|l| l.tomb);
    let purge_news = remote.tomb.filter(|t| Some(*t) > local_tomb);
    if let (true, true, Some(tomb)) = (
        now_live,
        super::capture::is_purge_target(entity),
        purge_news,
    ) {
        // Unless the write that outlived the purge was this device's own: then its children are
        // what it sends again, re-stamped.
        let died_here = local.as_ref().is_some_and(|l| l.newest() <= tomb);
        if entity.entity == Entity::Page && died_here {
            prune_purged_children(tx.conn(), &record.name.key, tomb).await?;
            touched.tags.insert(record.name.key.clone());
            touched.schedules.insert(record.name.key.clone());
        }
    }
    write_clocks(tx.conn(), entity, &record.name.key, &merged.row).await?;

    if merged.outlived_tombstone {
        applied.resent.insert(record.name.to_string());
    }

    let changed = writes_row || (was_live && !now_live);
    if changed {
        note_touched(entity, record, &merged, touched);
    }
    Ok(if changed {
        Outcome::Changed
    } else {
        Outcome::Unchanged
    })
}

fn note_touched(
    entity: &EntityMap,
    record: &Record,
    merged: &merge::Merged,
    touched: &mut Touched,
) {
    let page = page_of(record);
    match record.name.entity {
        Entity::Body => {
            touched.bodies.extend(page.clone());
        }
        Entity::PageTag => {
            touched.tags.extend(page.clone());
        }
        Entity::Reminder => {
            touched.reminders.extend(page.clone());
        }
        Entity::Rule
        | Entity::Schedule
        | Entity::Override
        | Entity::Completed
        | Entity::Skipped => {
            touched.schedules.extend(page.clone());
        }
        _ => {}
    }
    let stamped_table = match record.name.entity {
        Entity::Page | Entity::Body => Some("pages"),
        Entity::Folder => Some("folders"),
        _ => None,
    };
    if let (Some(table), true) = (stamped_table, merged.row.is_live()) {
        let won = merged
            .row
            .fields
            .iter()
            .enumerate()
            .filter(|(i, _)| merged.taken & (1 << i) != 0)
            .map(|(_, f)| f.clock)
            .max()
            .unwrap_or(merged.row.born);
        let slot = touched
            .stamped
            .entry((table, record.name.key.clone()))
            .or_insert(won);
        *slot = (*slot).max(won);
    }
    let _ = entity;
}

/// A row created by an apply holds column defaults for the entities that share its table, like a
/// page's body before the body record arrives. Clocked at zero, so any record for them wins. Left
/// unclocked, they'd read as this device's base clock; left with the clocks of a row that was purged
/// and has come back, they'd claim a body the row no longer holds. Either can beat the real one.
async fn unstamp_parts(
    conn: &mut SqliteConnection,
    created: &EntityMap,
    key: &str,
) -> AppResult<()> {
    let sharing = super::manifest::ENTITIES
        .iter()
        .filter(|e| e.table == created.table && e.entity != created.entity && e.key == created.key);
    for entity in sharing {
        let zero = Hlc::ZERO.to_string().repeat(entity.fields.len() + 1);
        sqlx::query(
            "INSERT INTO replica_clocks (entity, key, clocks) VALUES (?, ?, ?)
             ON CONFLICT (entity, key) DO UPDATE SET clocks = excluded.clocks, tomb = NULL",
        )
        .bind(entity.entity.prefix())
        .bind(key)
        .bind(zero)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// A purge this device hears of only once a later write elsewhere has brought the page back still
/// removed what hung off the page then, everywhere: the rows here written no later than the purge
/// go, as the cascade took them on the devices that purged it.
async fn prune_purged_children(
    conn: &mut SqliteConnection,
    page: &str,
    tomb: Hlc,
) -> AppResult<()> {
    for entity in super::manifest::ENTITIES {
        let (super::manifest::Scope::Page(column), Some(_)) = (entity.scope, &entity.parent) else {
            continue;
        };
        let covers = entity.covers.unwrap_or("1");
        let sql = format!(
            "SELECT {} FROM {} AS t WHERE ({covers}) AND t.{column} = ?",
            entity.key, entity.table
        )
        .replace("{row}", "t");
        let keys: Vec<String> = sqlx::query_scalar(&sql)
            .bind(page)
            .fetch_all(&mut *conn)
            .await?;
        for key in keys {
            let super::build::Read::Row(row) =
                super::build::read(conn, entity, &key, false).await?
            else {
                continue;
            };
            if row.newest() <= tomb {
                delete_row(conn, entity, &key).await?;
            }
        }
    }
    Ok(())
}

/// Queues a record to send whole with the clocks it has.
async fn queue_whole(conn: &mut SqliteConnection, name: &RecordName) -> AppResult<()> {
    let Some(entity) = entity_map(name.entity) else {
        return Ok(());
    };
    sqlx::query(
        "INSERT INTO replica_ops (entity, key, fields, deleted, clock)
         SELECT ?, ?, ?, 0, hlc FROM replica_meta WHERE id = 1
         ON CONFLICT (entity, key) DO UPDATE SET fields = excluded.fields, deleted = 0",
    )
    .bind(name.entity.prefix())
    .bind(&name.key)
    .bind((1i64 << entity.fields.len()) - 1)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Moves this device's clock on for a write the apply makes as its own, and returns it.
async fn advance_clock(conn: &mut SqliteConnection) -> AppResult<Hlc> {
    sqlx::query("UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1")
        .execute(&mut *conn)
        .await?;
    let clock: String = sqlx::query_scalar("SELECT hlc FROM replica_meta WHERE id = 1")
        .fetch_one(&mut *conn)
        .await?;
    clock
        .parse()
        .map_err(|e| AppError::Invalid(format!("replica clock: {e}")))
}

/// Before a page goes in a purge another device made, keeps what hung off it that was written after
/// the purge. The purge didn't remove those, and if a later write elsewhere brings the page back,
/// they come back with it; the cascade would otherwise lose them for good here.
async fn hold_newer_children(conn: &mut SqliteConnection, page: &str, tomb: Hlc) -> AppResult<()> {
    for entity in super::manifest::ENTITIES {
        let super::manifest::Scope::Page(column) = entity.scope else {
            continue;
        };
        // Only what the cascade deletes: a row whose reference is set NULL stays, and its NULL is
        // handled with the other purge NULLs.
        let deleted_with_page = entity.parent.is_some() || entity.lifecycle == Lifecycle::Part;
        if entity.entity == Entity::Page || !deleted_with_page {
            continue;
        }
        let covers = entity.covers.unwrap_or("1");
        let sql = format!(
            "SELECT {} FROM {} AS t WHERE ({covers}) AND t.{column} = ?",
            entity.key, entity.table
        )
        .replace("{row}", "t");
        let keys: Vec<String> = sqlx::query_scalar(&sql)
            .bind(page)
            .fetch_all(&mut *conn)
            .await?;
        for key in keys {
            let super::build::Read::Row(row) =
                super::build::read(conn, entity, &key, false).await?
            else {
                continue;
            };
            if row.newest() <= tomb {
                continue;
            }
            let name = RecordName::live(entity.entity, key);
            let record = Record {
                name: name.clone(),
                row,
            };
            let map = codec::encode(&record, &shape(entity));
            hold_record(conn, &name, &map, Hold::DeletedParent, None).await?;
        }
    }
    Ok(())
}

async fn out_of_scope_here(
    conn: &mut SqliteConnection,
    entity: &EntityMap,
    key: &str,
) -> AppResult<bool> {
    let covers = entity.covers.unwrap_or("1");
    let sql = format!(
        "SELECT NOT ({}) FROM {} AS t WHERE ({covers}) AND {} = ?",
        entity.scope.sql(),
        entity.table,
        entity.key
    )
    .replace("{row}", "t");
    let out: Option<bool> = sqlx::query_scalar(&sql)
        .bind(key)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(out.unwrap_or(false))
}

/// The local row's synced values by field, or None when this device doesn't have it.
async fn read_row(
    conn: &mut SqliteConnection,
    entity: &EntityMap,
    key: &str,
) -> AppResult<Option<Vec<Vec<Value>>>> {
    let columns: String = entity
        .fields
        .iter()
        .flat_map(|f| f.columns.iter())
        .map(|c| format!(", quote(t.{c})"))
        .collect();
    let covers = entity.covers.unwrap_or("1");
    let sql = format!(
        "SELECT 1{columns} FROM {} AS t WHERE ({covers}) AND {} = ?",
        entity.table, entity.key
    )
    .replace("{row}", "t");
    let Some(row) = sqlx::query(&sql)
        .bind(key)
        .fetch_optional(&mut *conn)
        .await?
    else {
        return Ok(None);
    };
    let mut values = (1..row.len()).map(|i| unquote(&row.get::<String, _>(i)));
    let mut fields: Vec<Vec<Value>> = entity
        .fields
        .iter()
        .map(|f| values.by_ref().take(f.columns.len()).collect())
        .collect();

    // A link shown NULL because its row isn't here still points at that row.
    let detached: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT field, col, target FROM replica_detached WHERE entity = ? AND key = ?",
    )
    .bind(entity.entity.prefix())
    .bind(key)
    .fetch_all(&mut *conn)
    .await?;
    for (field, column, target) in detached {
        let position = entity
            .fields
            .get(field as usize)
            .and_then(|f| f.columns.iter().position(|c| *c == column));
        let value = position.and_then(|c| fields.get_mut(field as usize)?.get_mut(c));
        if let Some(value @ Value::Null) = value {
            *value = Value::Text(target);
        }
    }
    Ok(Some(fields))
}

type Clocks = (Hlc, Vec<Hlc>, Option<Hlc>);

async fn read_clocks(
    conn: &mut SqliteConnection,
    entity: &EntityMap,
    key: &str,
) -> AppResult<Option<Clocks>> {
    let row: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT clocks, tomb FROM replica_clocks WHERE entity = ? AND key = ?")
            .bind(entity.entity.prefix())
            .bind(key)
            .fetch_optional(&mut *conn)
            .await?;
    let Some((packed, tomb)) = row else {
        return Ok(None);
    };
    let parse = |s: &str| -> AppResult<Hlc> {
        s.parse()
            .map_err(|e| AppError::Invalid(format!("replica clocks for {key}: {e}")))
    };
    let slots = packed
        .as_bytes()
        .chunks(20)
        .map(|c| parse(std::str::from_utf8(c).unwrap_or("")))
        .collect::<AppResult<Vec<Hlc>>>()?;
    let (born, fields) = slots
        .split_first()
        .ok_or_else(|| AppError::Invalid(format!("replica clocks for {key} are empty")))?;
    let mut fields = fields.to_vec();
    fields.resize(entity.fields.len(), *born);
    Ok(Some((
        *born,
        fields,
        tomb.as_deref().map(parse).transpose()?,
    )))
}

async fn base_clock(conn: &mut SqliteConnection) -> AppResult<Hlc> {
    let base: Option<String> =
        sqlx::query_scalar("SELECT base_clock FROM replica_meta WHERE id = 1")
            .fetch_one(&mut *conn)
            .await?;
    Ok(base.and_then(|b| b.parse().ok()).unwrap_or(Hlc::ZERO))
}

async fn write_clocks(
    conn: &mut SqliteConnection,
    entity: &EntityMap,
    key: &str,
    row: &RowState,
) -> AppResult<()> {
    let slots: Vec<Hlc> = row.fields.iter().map(|f| f.clock).collect();
    write_packed(conn, entity, key, row.born, &slots, row.tomb).await
}

async fn write_packed(
    conn: &mut SqliteConnection,
    entity: &EntityMap,
    key: &str,
    born: Hlc,
    slots: &[Hlc],
    tomb: Option<Hlc>,
) -> AppResult<()> {
    let packed: String = std::iter::once(&born)
        .chain(slots)
        .map(|c| c.to_string())
        .collect();
    sqlx::query(
        "INSERT INTO replica_clocks (entity, key, clocks, tomb) VALUES (?, ?, ?, ?)
         ON CONFLICT (entity, key) DO UPDATE SET clocks = excluded.clocks, tomb = excluded.tomb",
    )
    .bind(entity.entity.prefix())
    .bind(key)
    .bind(packed)
    .bind(tomb.map(|t| t.to_string()))
    .execute(&mut *conn)
    .await?;
    Ok(())
}

fn bind_value<'q>(
    query: sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    value: &Value,
) -> sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    match value {
        Value::Null => query.bind(None::<String>),
        Value::Integer(i) => query.bind(*i),
        Value::Real(r) => query.bind(*r),
        Value::Text(t) => query.bind(t.clone()),
    }
}

async fn local_rule(conn: &mut SqliteConnection, page: &str) -> AppResult<Option<String>> {
    Ok(
        sqlx::query_scalar("SELECT id FROM page_recurrence_rules WHERE page_id = ?")
            .bind(page)
            .fetch_optional(&mut *conn)
            .await?,
    )
}

fn split_key(key: &str) -> (&str, &str) {
    key.split_once('/').unwrap_or((key, ""))
}

/// Writes every synced column of a live row, creating it if this device doesn't have it.
async fn write_row(
    conn: &mut SqliteConnection,
    entity: &EntityMap,
    key: &str,
    row: &RowState,
) -> AppResult<()> {
    let columns: Vec<&str> = entity
        .fields
        .iter()
        .flat_map(|f| f.columns.iter().copied())
        .collect();
    let values: Vec<&Value> = row.fields.iter().flat_map(|f| f.values.iter()).collect();
    let stamp = wall_time(row.newest());

    // Identity columns, by entity: a row id, or the parts of a domain key mapped to this device's rows.
    let (identity_columns, identity_values): (Vec<&str>, Vec<String>) = match entity.entity {
        Entity::Page | Entity::Folder => (vec!["id", "updated_at"], vec![key.to_owned(), stamp]),
        Entity::Schedule | Entity::Reminder | Entity::FocusSession => {
            (vec!["id"], vec![key.to_owned()])
        }
        Entity::Tag => (
            vec!["id", "name"],
            vec![uuid::Uuid::new_v4().to_string(), key.to_owned()],
        ),
        Entity::Rule => {
            let id = local_rule(conn, key)
                .await?
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            (vec!["id", "page_id"], vec![id, key.to_owned()])
        }
        Entity::Override => {
            let (page, date) = split_key(key);
            let rule = local_rule(conn, page)
                .await?
                .ok_or_else(|| AppError::Internal(format!("override {key} has no rule here")))?;
            let id: Option<String> = sqlx::query_scalar(
                "SELECT id FROM page_schedules WHERE rule_id = ? AND original_date = ?",
            )
            .bind(&rule)
            .bind(date)
            .fetch_optional(&mut *conn)
            .await?;
            (
                vec!["id", "page_id", "rule_id", "original_date"],
                vec![
                    id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                    page.to_owned(),
                    rule,
                    date.to_owned(),
                ],
            )
        }
        Entity::Completed | Entity::Skipped => {
            let (page, date) = split_key(key);
            (
                vec!["page_id", "occurrence_date"],
                vec![page.to_owned(), date.to_owned()],
            )
        }
        Entity::PageTag => {
            let (page, tag) = split_key(key);
            sqlx::query("INSERT OR IGNORE INTO tags (id, name) VALUES (?, ?)")
                .bind(uuid::Uuid::new_v4().to_string())
                .bind(tag)
                .execute(&mut *conn)
                .await?;
            sqlx::query("INSERT OR IGNORE INTO page_tags (page_id, tag_id) SELECT ?, id FROM tags WHERE name = ?")
                .bind(page)
                .bind(tag)
                .execute(&mut *conn)
                .await?;
            return Ok(());
        }
        Entity::Body => {
            let sql = "UPDATE pages SET content = ?, content_schema_version = ? WHERE id = ?";
            let mut query = sqlx::query(sql);
            for value in &values {
                query = bind_value(query, value);
            }
            query.bind(key).execute(&mut *conn).await?;
            return Ok(());
        }
        Entity::Asset => return Ok(()),
    };

    let conflict_target = match entity.entity {
        Entity::Tag => "name",
        Entity::Rule => "page_id",
        Entity::Completed | Entity::Skipped => "page_id, occurrence_date",
        _ => "id",
    };
    let all_columns: Vec<&str> = identity_columns
        .iter()
        .copied()
        .chain(columns.iter().copied())
        .collect();
    let updates: Vec<String> = columns
        .iter()
        .chain(identity_columns.iter().filter(|c| **c == "updated_at"))
        .map(|c| format!("{c} = excluded.{c}"))
        .collect();
    let on_conflict = if updates.is_empty() || entity.lifecycle == Lifecycle::CreateOnly {
        "DO NOTHING".to_owned()
    } else {
        format!("DO UPDATE SET {}", updates.join(", "))
    };
    let sql = format!(
        "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT ({conflict_target}) {on_conflict}",
        entity.table,
        all_columns.join(", "),
        vec!["?"; all_columns.len()].join(", "),
    );
    let mut query = sqlx::query(&sql);
    for value in &identity_values {
        query = query.bind(value.clone());
    }
    for value in &values {
        query = bind_value(query, value);
    }
    query.execute(&mut *conn).await?;
    Ok(())
}

async fn delete_row(conn: &mut SqliteConnection, entity: &EntityMap, key: &str) -> AppResult<()> {
    let covers = entity.covers.unwrap_or("1");
    let sql = format!(
        "DELETE FROM {} WHERE rowid IN (SELECT t.rowid FROM {} AS t WHERE ({covers}) AND {} = ?)",
        entity.table, entity.table, entity.key
    )
    .replace("{row}", "t");
    sqlx::query(&sql).bind(key).execute(&mut *conn).await?;
    Ok(())
}

/// A write here outlived another device's purge of `name`. Every other device removed the row, and
/// for a page everything that hung off it, so this device sends them again as a fresh write at a new
/// clock. Sent with their old clocks, the outcome would depend on the order the devices heard of the
/// purge, the revival and each other's older edits; re-stamped, every device takes this copy whole.
async fn revive(conn: &mut SqliteConnection, name: &RecordName) -> AppResult<()> {
    let clock = advance_clock(conn).await?.to_string();

    let reviving_page = name.entity == Entity::Page;
    for entity in super::manifest::ENTITIES {
        let rows_sql = match (entity.entity == name.entity, entity.scope) {
            (true, _) => format!("{} = ?", entity.key),
            (false, super::manifest::Scope::Page(column)) if reviving_page => {
                format!("t.{column} = ?")
            }
            _ => continue,
        };
        let covers = entity.covers.unwrap_or("1");
        let sql = format!(
            "SELECT {} FROM {} AS t WHERE ({covers}) AND {rows_sql}",
            entity.key, entity.table
        )
        .replace("{row}", "t");
        let keys: Vec<String> = sqlx::query_scalar(&sql)
            .bind(&name.key)
            .fetch_all(&mut *conn)
            .await?;
        let all: i64 = (1i64 << entity.fields.len()) - 1;
        let stamped = clock.repeat(entity.fields.len() + 1);
        for key in keys {
            sqlx::query(
                "INSERT INTO replica_clocks (entity, key, clocks) VALUES (?, ?, ?)
                 ON CONFLICT (entity, key) DO UPDATE SET clocks = excluded.clocks",
            )
            .bind(entity.entity.prefix())
            .bind(&key)
            .bind(&stamped)
            .execute(&mut *conn)
            .await?;
            sqlx::query(
                "INSERT INTO replica_ops (entity, key, fields, deleted, clock) VALUES (?, ?, ?, 0, ?)
                 ON CONFLICT (entity, key) DO UPDATE SET fields = excluded.fields, deleted = 0,
                   clock = excluded.clock",
            )
            .bind(entity.entity.prefix())
            .bind(&key)
            .bind(all)
            .bind(&clock)
            .execute(&mut *conn)
            .await?;
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "apply_tests.rs"]
mod tests;
