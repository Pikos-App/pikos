//! Images: the files page bodies show, synced as records that carry the file beside their fields.
//!
//! An image is written once under a name Pikos made and never changed, so its record is create-only
//! and has no field clocks. It's queued the first time a body that shows it is built, and a row in
//! `replica_clocks` marks it as queued or already in the zone, so no device sends it twice. A
//! device that receives an image has it in the zone by definition and never sends it back.

use std::path::{Path, PathBuf};

use pikos_replica::codec::{self, FieldMap, Record};
use pikos_replica::merge::{RowState, Value};
use pikos_replica::{Entity, Hlc, RecordName};
use sqlx::SqliteConnection;

use crate::assets::{is_pikos_asset_name, pikos_file_name};
use crate::error::AppResult;
use crate::export::collect_asset_paths;

/// Where this device keeps the workspace's images. Set at every launch, before sync runs; until it
/// is, images are neither sent nor received.
pub async fn set_assets_dir(pool: &sqlx::SqlitePool, dir: &Path) -> AppResult<()> {
    sqlx::query("UPDATE replica_meta SET assets_dir = ? WHERE id = 1")
        .bind(dir.to_string_lossy())
        .execute(pool)
        .await?;
    Ok(())
}

async fn assets_dir(conn: &mut SqliteConnection) -> AppResult<Option<PathBuf>> {
    let dir: Option<String> =
        sqlx::query_scalar("SELECT assets_dir FROM replica_meta WHERE id = 1")
            .fetch_one(&mut *conn)
            .await?;
    Ok(dir.map(PathBuf::from))
}

/// Queues each image `content` shows that this device has and hasn't queued before.
pub(crate) async fn queue_shown(
    conn: &mut SqliteConnection,
    content: &str,
    clock: Hlc,
) -> AppResult<()> {
    let Some(dir) = assets_dir(conn).await? else {
        return Ok(());
    };
    let Ok(doc) = serde_json::from_str::<serde_json::Value>(content) else {
        return Ok(());
    };
    let mut paths = Vec::new();
    collect_asset_paths(&doc, &mut paths);

    for name in paths.iter().filter_map(|path| pikos_file_name(path)) {
        let have_it = dir.join(name).is_file();
        if !have_it {
            continue;
        }

        let first_time = mark_in_zone(conn, name, clock).await?;
        if first_time {
            sqlx::query(
                "INSERT INTO replica_ops (entity, key, fields, deleted, clock) VALUES (?, ?, 0, 0, ?)
                 ON CONFLICT (entity, key) DO NOTHING",
            )
            .bind(Entity::Asset.prefix())
            .bind(name)
            .bind(clock.to_string())
            .execute(&mut *conn)
            .await?;
        }
    }
    Ok(())
}

/// Returns whether the image wasn't marked before.
async fn mark_in_zone(conn: &mut SqliteConnection, name: &str, born: Hlc) -> AppResult<bool> {
    let inserted = sqlx::query(
        "INSERT INTO replica_clocks (entity, key, clocks) VALUES (?, ?, ?)
         ON CONFLICT (entity, key) DO NOTHING",
    )
    .bind(Entity::Asset.prefix())
    .bind(name)
    .bind(born.to_string())
    .execute(&mut *conn)
    .await?
    .rows_affected();
    Ok(inserted == 1)
}

/// The image's record with its file, or None when the file is no longer here to send.
pub(crate) async fn build(
    conn: &mut SqliteConnection,
    name: &RecordName,
) -> AppResult<Option<FieldMap>> {
    let Some(dir) = assets_dir(conn).await? else {
        return Ok(None);
    };
    let file = dir.join(&name.key);
    let sendable = is_pikos_asset_name(&name.key) && file.is_file();
    if !sendable {
        return Ok(None);
    }

    let born: Option<String> = sqlx::query_scalar(
        "SELECT substr(clocks, 1, 20) FROM replica_clocks WHERE entity = ? AND key = ?",
    )
    .bind(Entity::Asset.prefix())
    .bind(&name.key)
    .fetch_optional(&mut *conn)
    .await?;
    let born = born.and_then(|b| b.parse().ok()).unwrap_or(Hlc::ZERO);
    let record = Record {
        name: name.clone(),
        row: RowState {
            born,
            fields: Vec::new(),
            tomb: None,
        },
    };
    let mut fields = codec::encode(&record, &[]);
    fields.insert(
        codec::FILE.to_owned(),
        Value::Text(file.to_string_lossy().into_owned()),
    );
    Ok(Some(fields))
}

/// Puts an arrived image in the assets folder unless it's already there. Returns whether it
/// arrived. The record's file is the transport's download, which may be gone once the apply
/// returns, so it's copied rather than kept as a path.
pub(crate) async fn apply(
    conn: &mut SqliteConnection,
    record: &Record,
    map: &FieldMap,
) -> AppResult<bool> {
    // The name becomes a path here, so anything but a name Pikos makes is refused outright.
    let refused = record.name.tombstone || !is_pikos_asset_name(&record.name.key);
    if refused {
        return Ok(false);
    }
    let Some(dir) = assets_dir(conn).await? else {
        log::warn!(
            "replica: no images folder set, so {} wasn't kept",
            record.name
        );
        return Ok(false);
    };

    let target = dir.join(&record.name.key);
    let arrived = if target.is_file() {
        false
    } else {
        let Some(Value::Text(download)) = map.get(codec::FILE) else {
            return Ok(false);
        };
        copy_in(Path::new(download), &target)?;
        true
    };
    mark_in_zone(conn, &record.name.key, record.row.born).await?;
    Ok(arrived)
}

/// Copies through a temporary name, so a half-written image never shows under the real one.
fn copy_in(source: &Path, target: &Path) -> std::io::Result<()> {
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let partial = target.with_extension("part");
    std::fs::copy(source, &partial)?;
    std::fs::rename(&partial, target)
}

/// A workspace moving into another zone, or starting over in one, has sent no images there.
pub(crate) async fn forget_sent(conn: &mut SqliteConnection) -> AppResult<()> {
    sqlx::query("DELETE FROM replica_clocks WHERE entity = ?")
        .bind(Entity::Asset.prefix())
        .execute(&mut *conn)
        .await?;
    Ok(())
}

#[cfg(test)]
#[path = "images_tests.rs"]
mod tests;
