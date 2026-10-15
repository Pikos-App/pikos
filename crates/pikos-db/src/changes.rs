//! The change counter migration 015 keeps: what the app reads to learn whether the workspace
//! changed since it last looked, and whether it was the one that changed it.

use serde::Serialize;
use sqlx::SqlitePool;

use crate::error::AppResult;
use crate::sql_functions::writer_id;

/// How long a process's count is kept after its last change. One idle longer than this sees one
/// spurious outside change on its next write, when its count starts again from zero.
const WRITER_KEPT_SECS: i64 = 24 * 60 * 60;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ChangeState {
    /// Changes counted in this epoch, by every process.
    #[ts(type = "number")]
    pub seq: i64,
    /// A new value means the counter may have moved backwards, and everything read before is void.
    pub epoch: String,
    /// The changes in `seq` this process made.
    #[ts(type = "number")]
    pub own_changes: i64,
}

pub async fn change_state(pool: &SqlitePool) -> AppResult<ChangeState> {
    let (seq, epoch, own_changes) = sqlx::query_as(
        "SELECT seq, epoch,
                COALESCE((SELECT changes FROM change_writers WHERE writer = ?), 0)
         FROM change_counter",
    )
    .bind(writer_id())
    .fetch_one(pool)
    .await?;
    Ok(ChangeState {
        seq,
        epoch,
        own_changes,
    })
}

pub async fn new_epoch<'e>(executor: impl sqlx::SqliteExecutor<'e>) -> AppResult<()> {
    sqlx::query("UPDATE change_counter SET epoch = lower(hex(randomblob(16)))")
        .execute(executor)
        .await?;
    Ok(())
}

pub(crate) async fn prune_writers(pool: &SqlitePool) -> AppResult<()> {
    sqlx::query(
        "DELETE FROM change_writers WHERE last_change_at < unixepoch() - ? AND writer <> ?",
    )
    .bind(WRITER_KEPT_SECS)
    .bind(writer_id())
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
#[path = "changes_tests.rs"]
mod changes_tests;
