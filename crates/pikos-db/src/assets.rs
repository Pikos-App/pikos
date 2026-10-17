//! Which image files a workspace still needs.

use std::collections::HashSet;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

use crate::backups::{backups_dir, list_backups};
use crate::error::AppResult;
use crate::export::collect_asset_paths;

/// The stored path of every image a page refers to, trashed pages included, since restoring one
/// brings its images back.
pub async fn asset_paths_in(pool: &SqlitePool) -> AppResult<HashSet<String>> {
    let bodies: Vec<String> =
        sqlx::query_scalar("SELECT content FROM pages WHERE instr(content, '\"image\"') > 0")
            .fetch_all(pool)
            .await?;

    let mut paths = Vec::new();
    for body in &bodies {
        if let Ok(doc) = serde_json::from_str::<serde_json::Value>(body) {
            collect_asset_paths(&doc, &mut paths);
        }
    }

    Ok(paths.into_iter().collect())
}

/// [`asset_paths_in`] for the open workspace and every backup beside it. A backup can be restored
/// from Settings, and a restore that brought back pages whose images were removed meanwhile would
/// show them broken. A backup that won't open is skipped rather than failing the whole read.
pub async fn referenced_asset_paths(
    pool: &SqlitePool,
    workspace_path: &str,
) -> AppResult<HashSet<String>> {
    let mut paths = asset_paths_in(pool).await?;

    let dir = backups_dir(workspace_path);
    for backup in list_backups(workspace_path)? {
        let options = SqliteConnectOptions::new()
            .filename(dir.join(&backup.file_name))
            .read_only(true);
        let Ok(backup_pool) = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
        else {
            log::warn!("assets: backup {} would not open", backup.file_name);
            continue;
        };
        match asset_paths_in(&backup_pool).await {
            Ok(found) => paths.extend(found),
            Err(e) => log::warn!("assets: reading backup {} failed: {e}", backup.file_name),
        }
        backup_pool.close().await;
    }

    Ok(paths)
}

#[cfg(test)]
#[path = "assets_tests.rs"]
mod tests;
