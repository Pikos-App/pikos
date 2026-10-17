//! Replica sync's side of the workspace: identity, the clock, capture and the apply marker.
//!
//! Called "replica" here because "sync" in this crate is calendar sync. Merge, records and
//! transports are `pikos-replica`'s; this module owns the rows they read and write.

pub mod apply;
pub mod build;
pub mod capture;
pub mod manifest;
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
        sqlx::query(
            "UPDATE replica_meta
             SET started = 1, paused = 0, device_id = ?,
                 hlc = pikos_hlc_next(hlc, pikos_now_ms()), base_clock = pikos_hlc_next(hlc, pikos_now_ms())
             WHERE id = 1 AND started = 0",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    })
    .await?;

    meta(pool).await
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
                 engine_state = NULL, last_fetch_at = NULL, epoch_seen = NULL
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
#[path = "capture_writers_tests.rs"]
mod capture_writers_tests;

#[cfg(test)]
#[path = "convergence_tests.rs"]
mod convergence_tests;
