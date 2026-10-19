//! Replica sync's side of the workspace: identity, the clock, capture and the apply marker.
//!
//! Called "replica" here because "sync" in this crate is calendar sync. Merge, records and
//! transports are `pikos-replica`'s; this module owns the rows they read and write.

pub mod apply;
pub mod build;
pub mod capture;
pub mod compare;
pub mod images;
pub mod manifest;
mod oversize;
pub mod schema;
pub mod state;

use pikos_replica::Hlc;
use sqlx::{Sqlite, SqlitePool, Transaction};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplicaMeta {
    pub workspace_id: String,
    pub device_id: Option<String>,
    pub hlc: Hlc,
    pub base_clock: Option<Hlc>,
    pub started: bool,
    pub paused: bool,
}

type MetaRow = (String, Option<String>, String, Option<String>, bool, bool);

fn parse_clock(text: &str) -> AppResult<Hlc> {
    text.parse()
        .map_err(|e| AppError::Invalid(format!("replica clock: {e}")))
}

pub async fn meta(pool: &SqlitePool) -> AppResult<ReplicaMeta> {
    let (workspace_id, device_id, hlc, base_clock, started, paused): MetaRow = sqlx::query_as(
        "SELECT workspace_id, device_id, hlc, base_clock, started, paused
         FROM replica_meta WHERE id = 1",
    )
    .fetch_one(pool)
    .await?;

    Ok(ReplicaMeta {
        workspace_id,
        device_id,
        hlc: parse_clock(&hlc)?,
        base_clock: base_clock.as_deref().map(parse_clock).transpose()?,
        started,
        paused,
    })
}

/// Starts capturing changes, once per device: mints the device id and stamps the base clock that
/// every existing row holds until it changes, so starting writes nothing per row. Starting again
/// changes nothing.
pub async fn start(pool: &SqlitePool) -> AppResult<ReplicaMeta> {
    crate::tx::retry_on_busy(|| async {
        let mut tx = pool.begin().await?;
        let starting = sqlx::query(
            "UPDATE replica_meta
             SET started = 1, paused = 0, device_id = ?, hlc = pikos_hlc_next(hlc, pikos_now_ms())
             WHERE id = 1 AND started = 0",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .execute(&mut *tx)
        .await?
        .rows_affected()
            == 1;
        if starting {
            sqlx::query("UPDATE replica_meta SET base_clock = hlc WHERE id = 1")
                .execute(&mut *tx)
                .await?;
            schedule_rows_for_cached_times(&mut tx).await?;
            queue_everything(&mut tx).await?;
        }
        tx.commit().await?;
        Ok(())
    })
    .await?;

    meta(pool).await
}

/// Gives a schedule row to every page whose time lives only in its cached schedule, as done copies
/// of ticked occurrences did before they got rows. Sync carries rows, not the cache, so without
/// one the page arrives unscheduled everywhere else. Repeating and calendar pages are left alone:
/// their cache is derived from the rule or the calendar.
async fn schedule_rows_for_cached_times(tx: &mut Transaction<'_, Sqlite>) -> AppResult<()> {
    let cached: Vec<(String, String, Option<String>, String)> = sqlx::query_as(
        "SELECT id, scheduled_start, scheduled_end, status FROM pages AS p
         WHERE scheduled_start IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM page_schedules WHERE page_id = p.id)
           AND NOT EXISTS (SELECT 1 FROM page_recurrence_rules WHERE page_id = p.id)
           AND NOT EXISTS (SELECT 1 FROM page_sync WHERE page_id = p.id)",
    )
    .fetch_all(&mut **tx)
    .await?;
    let now = crate::now_iso();
    for (page, start, end, status) in cached {
        let status = if status == "done" {
            "done"
        } else {
            "not_started"
        };
        sqlx::query(
            "INSERT INTO page_schedules
             (id, page_id, scheduled_start, scheduled_end, timezone, rule_id, original_date, status, created_at)
             VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&page)
        .bind(&start)
        .bind(&end)
        .bind(status)
        .bind(&now)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

/// Queues every synced row to send, once, when sync starts: the first upload, or this device's
/// half of a merge with an account that already syncs. Each row is sent at the base clock, so a row
/// changed on another device since loses to that change.
async fn queue_everything(tx: &mut Transaction<'_, Sqlite>) -> AppResult<()> {
    images::forget_sent(tx).await?;
    for entity in manifest::ENTITIES {
        let covers = entity.covers.unwrap_or("1");
        let sql = format!(
            "INSERT INTO replica_ops (entity, key, fields, deleted, clock)
             SELECT '{}', {}, {}, 0, (SELECT base_clock FROM replica_meta WHERE id = 1)
             FROM {} AS t WHERE ({covers}) AND {}
             ON CONFLICT (entity, key) DO NOTHING",
            entity.entity.prefix(),
            entity.key,
            (1i64 << entity.fields.len()) - 1,
            entity.table,
            entity.scope.sql(),
        )
        .replace("{row}", "t");
        sqlx::query(&sql).execute(&mut **tx).await?;
    }
    Ok(())
}

/// Pausing stops the transport and nothing else: capture keeps running, so resuming is an ordinary
/// catch-up rather than a merge of rows that have no clocks against rows that do.
pub async fn set_paused(pool: &SqlitePool, paused: bool) -> AppResult<()> {
    sqlx::query("UPDATE replica_meta SET paused = ? WHERE id = 1")
        .bind(paused)
        .execute(pool)
        .await?;
    Ok(())
}

/// Forget sync on this device: stop capturing and drop every clock, pending change and transport
/// state. The device then joins again as a new one. The clock itself is kept, since it only ever
/// moves forward.
pub async fn forget(pool: &SqlitePool) -> AppResult<()> {
    crate::tx::retry_on_busy(|| async {
        let mut tx = pool.begin().await?;
        sqlx::query(
            "UPDATE replica_meta
             SET started = 0, paused = 0, device_id = NULL, base_clock = NULL,
                 engine_state = NULL, last_fetch_at = NULL, epoch_seen = NULL, held_for = NULL
             WHERE id = 1",
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM replica_ops")
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM replica_clocks")
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    })
    .await
}

/// What the sync status line reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncSummary {
    pub started: bool,
    pub paused: bool,
    /// Records waiting to send.
    pub pending: i64,
    /// Records that arrived and are waiting for a parent or a newer Pikos.
    pub held: i64,
    /// Held because a newer Pikos wrote them: the status line says to update.
    pub needs_update: bool,
    /// When the transport last finished fetching, in `now_iso` form.
    pub last_fetch_at: Option<String>,
}

pub async fn summary(pool: &SqlitePool) -> AppResult<SyncSummary> {
    let (started, paused, last_fetch_at): (bool, bool, Option<String>) =
        sqlx::query_as("SELECT started, paused, last_fetch_at FROM replica_meta WHERE id = 1")
            .fetch_one(pool)
            .await?;
    let (pending, held, newer): (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM replica_ops),
                (SELECT COUNT(*) FROM replica_pen),
                (SELECT COUNT(*) FROM replica_pen WHERE reason = 'newer_format')",
    )
    .fetch_one(pool)
    .await?;
    Ok(SyncSummary {
        started,
        paused,
        pending,
        held,
        needs_update: newer > 0,
        last_fetch_at,
    })
}

/// The transport's own state, saved with the workspace: CloudKit's sync engine state, or a folder
/// transport's read positions. Opaque here.
pub async fn engine_state(pool: &SqlitePool) -> AppResult<Option<Vec<u8>>> {
    Ok(
        sqlx::query_scalar("SELECT engine_state FROM replica_meta WHERE id = 1")
            .fetch_one(pool)
            .await?,
    )
}

/// Saves the transport's state. Called only after the apply that consumed the changes it records
/// has committed: CloudKit never hands changes back once its state moves past them.
pub async fn set_engine_state(pool: &SqlitePool, state: &[u8]) -> AppResult<()> {
    sqlx::query("UPDATE replica_meta SET engine_state = ?, last_fetch_at = ? WHERE id = 1")
        .bind(state)
        .bind(crate::pool::now_iso())
        .execute(pool)
        .await?;
    Ok(())
}

/// Why the transport waits on the person, in its own words, or None while it runs.
pub async fn held_for(pool: &SqlitePool) -> AppResult<Option<String>> {
    Ok(
        sqlx::query_scalar("SELECT held_for FROM replica_meta WHERE id = 1")
            .fetch_one(pool)
            .await?,
    )
}

/// Stops the transport until the person chooses, across relaunches. Only [`forget`] clears it,
/// since every choice the person can make starts this device over.
pub async fn hold(pool: &SqlitePool, reason: &str) -> AppResult<()> {
    sqlx::query("UPDATE replica_meta SET held_for = ? WHERE id = 1")
        .bind(reason)
        .execute(pool)
        .await?;
    Ok(())
}

/// Marks a fetch that finished and applied everything it brought. The transport saves its state
/// only when that state changes, and a fetch that found nothing may not change it, so a device
/// online every day in a zone quiet for the retention window would otherwise read as away.
pub async fn fetch_finished(pool: &SqlitePool) -> AppResult<()> {
    sqlx::query("UPDATE replica_meta SET last_fetch_at = ? WHERE id = 1")
        .bind(crate::pool::now_iso())
        .execute(pool)
        .await?;
    Ok(())
}

/// Checks the device id kept outside the file, in the keychain with a this-device-only flag, against
/// the one in it, and returns the id to keep there.
///
/// A restore, an iPhone transfer or Migration Assistant copies the file but not that keychain item,
/// so a copy arrives with another device's id and runs as a second device under it. On a mismatch,
/// or with nothing outside, this device takes a new id and drops the transport's state, keeping
/// every clock; it then fetches again from the start as a new device. The caller stores the id
/// `start` returns straight away, so nothing outside means a copy, not a first run.
pub async fn claim_device(pool: &SqlitePool, outside: Option<&str>) -> AppResult<Option<String>> {
    let current = meta(pool).await?;
    let Some(inside) = current.device_id else {
        return Ok(None);
    };
    if outside == Some(inside.as_str()) {
        return Ok(Some(inside));
    }

    let fresh = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "UPDATE replica_meta SET device_id = ?, engine_state = NULL, last_fetch_at = NULL
         WHERE id = 1",
    )
    .bind(&fresh)
    .execute(pool)
    .await?;
    Ok(Some(fresh))
}

/// How long a tombstone, and a record held for a parent that was purged, are kept. A device offline
/// longer re-fetches everything, which can bring back what it never saw purged.
pub const RETENTION_DAYS: i64 = 90;

/// Forgets tombstones this device wrote long ago and records long held for a purged parent, by wall
/// time so a clock running far ahead can't keep them. Returns the records whose tombstones went,
/// for the transport to delete from its store too; a link still pointing at one of them now points
/// at nothing, as it will on every device.
pub async fn expire(pool: &SqlitePool) -> AppResult<Vec<pikos_replica::RecordName>> {
    let cutoff_ms = chrono::Utc::now().timestamp_millis() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let cutoff = Hlc::new(cutoff_ms.max(0) as u64, 0).to_string();
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM replica_pen WHERE reason = 'deleted_parent' AND since < ?")
        .bind(&cutoff)
        .execute(&mut *tx)
        .await?;
    let mut forgotten = Vec::new();
    for entity in manifest::ENTITIES {
        let covers = entity.covers.unwrap_or("1");
        let sql = format!(
            "DELETE FROM replica_clocks WHERE entity = ? AND tomb IS NOT NULL AND tomb_at < ?
               AND NOT EXISTS (SELECT 1 FROM {} AS t WHERE ({covers}) AND {} = replica_clocks.key)
             RETURNING key",
            entity.table, entity.key
        )
        .replace("{row}", "t");
        let keys: Vec<String> = sqlx::query_scalar(&sql)
            .bind(entity.entity.prefix())
            .bind(cutoff_ms)
            .fetch_all(&mut *tx)
            .await?;
        if capture::is_purge_target(entity) {
            for key in &keys {
                sqlx::query("DELETE FROM replica_detached WHERE target = ?")
                    .bind(key)
                    .execute(&mut *tx)
                    .await?;
            }
        }
        forgotten.extend(
            keys.into_iter()
                .map(|key| pikos_replica::RecordName::live(entity.entity, key)),
        );
    }
    tx.commit().await?;
    Ok(forgotten)
}

/// What turning sync on does when the account already holds a workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Join {
    /// Nothing here was made by the person: take the account's rows instead. Merging would put a
    /// second set of first-run pages on every device.
    Replace,
    /// Union by id. Two devices used apart show both copies of anything made on both, which the
    /// person can tidy; nothing is lost.
    Merge,
}

pub async fn plan_join(pool: &SqlitePool) -> AppResult<Join> {
    Ok(if holds_only_seed(pool).await? {
        Join::Replace
    } else {
        Join::Merge
    })
}

/// Clears a workspace nobody has used before it takes an account's rows, and adopts that
/// workspace's id. The calendar layer stays: it's this device's own. Nothing here is sent.
pub async fn clear_for_join(pool: &SqlitePool, workspace_id: &str) -> AppResult<()> {
    let mut tx = Uncaptured::begin(pool).await?;
    for entity in [
        manifest::entity(pikos_replica::Entity::Page),
        manifest::entity(pikos_replica::Entity::Folder),
    ]
    .into_iter()
    .flatten()
    {
        let sql = format!(
            "DELETE FROM {} WHERE rowid IN (SELECT t.rowid FROM {} AS t WHERE {})",
            entity.table,
            entity.table,
            entity.scope.sql()
        )
        .replace("{row}", "t");
        sqlx::query(&sql).execute(tx.conn()).await?;
    }
    sqlx::query("DELETE FROM replica_ops")
        .execute(tx.conn())
        .await?;
    sqlx::query("DELETE FROM replica_clocks")
        .execute(tx.conn())
        .await?;
    sqlx::query(
        "UPDATE replica_meta SET workspace_id = ?, seeded = '{}', engine_state = NULL WHERE id = 1",
    )
    .bind(workspace_id)
    .execute(tx.conn())
    .await?;
    tx.commit().await
}

/// Adopts the workspace id of the zone this one merged into, and queues every row to send there,
/// and every delete this device remembers, at the delete's own clock: one sent only to the old zone
/// went with it. What CloudKit knew of the old zone's records and changes is dropped, since none
/// of it applies.
pub async fn adopt_workspace_id(pool: &SqlitePool, workspace_id: &str) -> AppResult<()> {
    crate::tx::retry_on_busy(|| async {
        let mut tx = pool.begin().await?;
        sqlx::query("UPDATE replica_meta SET workspace_id = ?, engine_state = NULL WHERE id = 1")
            .bind(workspace_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE replica_clocks SET system_fields = NULL")
            .execute(&mut *tx)
            .await?;
        queue_everything(&mut tx).await?;
        sqlx::query(
            "INSERT INTO replica_ops (entity, key, fields, deleted, clock)
             SELECT entity, key, 0, 1, tomb FROM replica_clocks WHERE tomb IS NOT NULL
             ON CONFLICT (entity, key) DO NOTHING",
        )
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    })
    .await
}

/// A device whose last fetch is older than [`RETENTION_DAYS`] can hold rows another device purged
/// and has since forgotten the tombstones of, so nothing it fetches would tell it. It sends
/// everything it holds again and fetches from the start: what it kept comes back everywhere,
/// rather than living on one device alone. The transport's saved copies go too: the records they
/// name may be long gone from its store, and saving over a gone copy is refused every time.
async fn catch_up_after_absence(pool: &SqlitePool) -> AppResult<()> {
    let last_fetch: Option<String> =
        sqlx::query_scalar("SELECT last_fetch_at FROM replica_meta WHERE id = 1")
            .fetch_one(pool)
            .await?;
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(RETENTION_DAYS))
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    let was_away = last_fetch.is_some_and(|at| at < cutoff);
    if !was_away {
        return Ok(());
    }

    crate::tx::retry_on_busy(|| async {
        let mut tx = pool.begin().await?;
        sqlx::query(
            "UPDATE replica_meta SET engine_state = NULL, last_fetch_at = NULL WHERE id = 1",
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE replica_clocks SET system_fields = NULL")
            .execute(&mut *tx)
            .await?;
        queue_everything(&mut tx).await?;
        tx.commit().await?;
        Ok(())
    })
    .await
}

/// Settles which of the account's zones this workspace syncs in, given every zone the account
/// holds, and returns it. When another device's zone wins, this workspace moves into it as
/// [`plan_join`] says; the transport then deletes the zone this one made, if it made one.
pub async fn join(pool: &SqlitePool, zones: &[String]) -> AppResult<String> {
    catch_up_after_absence(pool).await?;
    let own = pikos_replica::zone::zone_name(&meta(pool).await?.workspace_id);
    let listed = zones.iter().map(String::as_str).chain([own.as_str()]);
    let winner = pikos_replica::zone::winner(listed)
        .unwrap_or(&own)
        .to_owned();

    if winner == own {
        return Ok(own);
    }

    let workspace_id = pikos_replica::zone::workspace_of(&winner)
        .ok_or_else(|| AppError::Invalid(format!("zone {winner} names no workspace")))?;
    match plan_join(pool).await? {
        Join::Replace => clear_for_join(pool, workspace_id).await?,
        Join::Merge => adopt_workspace_id(pool, workspace_id).await?,
    }

    Ok(winner)
}

/// Sync's state on a workspace about to be replaced by a backup, carried over to the file put back.
pub struct Displaced {
    device_id: Option<String>,
    hlc: Hlc,
    base_clock: Option<Hlc>,
    paused: bool,
    held_for: Option<String>,
    engine_state: Option<Vec<u8>>,
    workspace_id: String,
    names: Vec<pikos_replica::RecordName>,
}

/// Notes what a restore must carry over, or None when sync never started on this workspace (or it
/// predates sync), and the restore is just a file copy.
pub async fn before_restore(pool: &SqlitePool) -> AppResult<Option<Displaced>> {
    let has_sync: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'replica_meta')",
    )
    .fetch_one(pool)
    .await?;
    if !has_sync {
        return Ok(None);
    }
    let current = meta(pool).await?;
    if !current.started {
        return Ok(None);
    }
    Ok(Some(Displaced {
        device_id: current.device_id,
        hlc: current.hlc,
        base_clock: current.base_clock,
        paused: current.paused,
        held_for: held_for(pool).await?,
        engine_state: engine_state(pool).await?,
        workspace_id: current.workspace_id,
        names: state::synced_rows(pool)
            .await?
            .into_iter()
            .map(|row| row.name)
            .collect(),
    }))
}

/// Makes a restored file the truth on every device that syncs it. Merged as it is, the backup's
/// older rows would lose to every device's newer copy and the restore would quietly undo itself. So
/// every restored row is re-stamped as a fresh write, every row the workspace had that the backup
/// doesn't gets a tombstone, and this device carries on as itself, with its id, clock and transport
/// state.
pub async fn after_restore(pool: &SqlitePool, displaced: Displaced) -> AppResult<()> {
    let mut tx = Uncaptured::begin(pool).await?;
    sqlx::query(
        "UPDATE replica_meta
         SET started = 1, paused = ?, held_for = ?, device_id = ?, base_clock = ?,
             engine_state = ?, workspace_id = ?, hlc = max(hlc, ?)
         WHERE id = 1",
    )
    .bind(displaced.paused)
    .bind(&displaced.held_for)
    .bind(&displaced.device_id)
    .bind(displaced.base_clock.map(|c| c.to_string()))
    .bind(&displaced.engine_state)
    .bind(&displaced.workspace_id)
    .bind(displaced.hlc.to_string())
    .execute(tx.conn())
    .await?;
    sqlx::query("UPDATE replica_meta SET hlc = pikos_hlc_next(hlc, pikos_now_ms()) WHERE id = 1")
        .execute(tx.conn())
        .await?;
    let clock: String = sqlx::query_scalar("SELECT hlc FROM replica_meta WHERE id = 1")
        .fetch_one(tx.conn())
        .await?;
    sqlx::query("DELETE FROM replica_ops")
        .execute(tx.conn())
        .await?;
    sqlx::query("DELETE FROM replica_pen")
        .execute(tx.conn())
        .await?;
    sqlx::query("DELETE FROM replica_detached")
        .execute(tx.conn())
        .await?;
    // The backup's marks of images already sent are as old as the backup.
    images::forget_sent(tx.conn()).await?;

    let restored: std::collections::HashSet<String> = {
        let rows = state::synced_rows_conn(tx.conn()).await?;
        for row in &rows {
            let entity = manifest::entity(row.name.entity).expect("synced rows have an entity");
            restamp(tx.conn(), entity, &row.name.key, &clock, None).await?;
        }
        rows.into_iter().map(|row| row.name.to_string()).collect()
    };
    for name in displaced.names {
        let Some(entity) = manifest::entity(name.entity) else {
            continue;
        };
        if !restored.contains(&name.to_string()) {
            restamp(tx.conn(), entity, &name.key, &clock, Some(&clock)).await?;
        }
    }
    tx.commit().await
}

/// Every slot of a record at `clock`, queued to send whole, or as removed with `tomb`.
async fn restamp(
    conn: &mut sqlx::SqliteConnection,
    entity: &manifest::EntityMap,
    key: &str,
    clock: &str,
    tomb: Option<&str>,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO replica_clocks (entity, key, clocks, tomb) VALUES (?, ?, ?, ?)
         ON CONFLICT (entity, key) DO UPDATE SET clocks = excluded.clocks, tomb = excluded.tomb",
    )
    .bind(entity.entity.prefix())
    .bind(key)
    .bind(clock.repeat(entity.fields.len() + 1))
    .bind(tomb)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "INSERT INTO replica_ops (entity, key, fields, deleted, clock) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(entity.entity.prefix())
    .bind(key)
    .bind(if tomb.is_some() {
        0
    } else {
        (1i64 << entity.fields.len()) - 1
    })
    .bind(tomb.is_some())
    .bind(clock)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

type Fingerprints = std::collections::BTreeMap<String, String>;

async fn fingerprints(pool: &SqlitePool) -> AppResult<Fingerprints> {
    Ok(state::synced_rows(pool)
        .await?
        .into_iter()
        .map(|row| (row.name.to_string(), row.fingerprint()))
        .collect())
}

/// Records the synced rows a new workspace's first-run pages created, called by whatever seeded
/// them, so turning sync on can tell a workspace nobody has used yet from one with work in it.
pub async fn record_seed(pool: &SqlitePool) -> AppResult<()> {
    let seeded = serde_json::to_string(&fingerprints(pool).await?)
        .map_err(|e| AppError::Internal(format!("seed fingerprints: {e}")))?;
    sqlx::query("UPDATE replica_meta SET seeded = ? WHERE id = 1")
        .bind(seeded)
        .execute(pool)
        .await?;
    Ok(())
}

/// Whether every synced row is a first-run row, unchanged since it was seeded. Such a workspace
/// joining an account that already syncs takes the account's rows instead of merging, which would
/// put a second set of first-run pages on every device.
pub async fn holds_only_seed(pool: &SqlitePool) -> AppResult<bool> {
    let stored: String = sqlx::query_scalar("SELECT seeded FROM replica_meta WHERE id = 1")
        .fetch_one(pool)
        .await?;
    let seeded: Fingerprints = serde_json::from_str(&stored).unwrap_or_default();

    Ok(fingerprints(pool).await? == seeded)
}

/// A transaction whose writes aren't captured: remote records being applied, or maintenance every
/// device runs for itself. It holds the apply marker from its first statement and clears it in
/// [`Uncaptured::commit`], so the marker never commits and no other connection sees it; dropping
/// it rolls back, marker and all. SQLite has one writer at a time, so a trigger that sees the
/// marker is inside this transaction.
pub struct Uncaptured<'a> {
    tx: Transaction<'a, Sqlite>,
}

impl<'a> Uncaptured<'a> {
    /// Takes the write lock up front: an apply reads clocks and then writes, and a transaction
    /// that read first can't be granted the lock while another connection writes.
    pub async fn begin(pool: &'a SqlitePool) -> AppResult<Uncaptured<'a>> {
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
        sqlx::query("INSERT INTO replica_applying (id) VALUES (1)")
            .execute(&mut *tx)
            .await?;
        Ok(Uncaptured { tx })
    }

    pub async fn commit(mut self) -> AppResult<()> {
        sqlx::query("DELETE FROM replica_applying")
            .execute(&mut *self.tx)
            .await?;
        self.tx.commit().await?;
        Ok(())
    }

    pub fn conn(&mut self) -> &mut sqlx::SqliteConnection {
        &mut self.tx
    }

    pub fn tx(&mut self) -> &mut Transaction<'a, Sqlite> {
        &mut self.tx
    }

    /// Lets the next writes be captured, until [`Uncaptured::uncapture`]: for a value this device
    /// derives at its own moment, where one device's copy has to win everywhere.
    pub async fn capture(&mut self) -> AppResult<()> {
        sqlx::query("DELETE FROM replica_applying")
            .execute(&mut *self.tx)
            .await?;
        Ok(())
    }

    pub async fn uncapture(&mut self) -> AppResult<()> {
        sqlx::query("INSERT INTO replica_applying (id) VALUES (1)")
            .execute(&mut *self.tx)
            .await?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "replica_tests.rs"]
mod tests;

#[cfg(test)]
pub(crate) mod oracle;

#[cfg(test)]
#[path = "capture_writers_tests.rs"]
mod capture_writers_tests;

#[cfg(test)]
#[path = "convergence_tests.rs"]
mod convergence_tests;

#[cfg(test)]
pub(crate) mod two_devices;

#[cfg(test)]
#[path = "matrix_tests.rs"]
mod matrix_tests;
