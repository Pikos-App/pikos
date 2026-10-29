//! Which image files a workspace still needs.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

use crate::backups::{backups_dir, list_backups};
use crate::error::AppResult;
use crate::export::collect_asset_paths;

/// The folder, beside a workspace's own data, that holds every image its pages embed.
pub const ASSET_DIR: &str = "assets";

/// True for the `<uuid>.<ext>` names Pikos gives the image files it writes.
pub fn is_pikos_asset_name(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    stem.len() == 36
        && uuid::Uuid::parse_str(stem).is_ok()
        && !ext.is_empty()
        && ext.chars().all(|c| c.is_ascii_alphanumeric())
}

/// The file name of an image Pikos saved, from the path a page stores for it: `assets/<file>`, or
/// the full path an earlier version stored, ending in an assets folder. None for any other path,
/// which is not a file Pikos wrote and so is never synced or removed.
pub fn pikos_file_name(stored: &str) -> Option<&str> {
    let mut parts = stored.rsplit(['/', '\\']);
    let name = parts.next()?;
    let in_asset_dir = parts.next() == Some(ASSET_DIR);
    (in_asset_dir && is_pikos_asset_name(name)).then_some(name)
}

/// The file a page's stored image path names, inside this machine's `assets_dir`.
///
/// Pages store `assets/<file>`, so a workspace copied to another Mac, another user or
/// another build still finds its images. Images saved by earlier versions stored the
/// full path on the machine that saved them; one that ends in an assets folder and a
/// name Pikos generated is read as that file here, which heals those pages without
/// rewriting them. Any other path is not one Pikos saved and comes back unchanged.
///
/// `resolveAssetPath` in `@pikos/core` runs the same rule against the same table,
/// `asset-paths.json`.
pub fn resolve_asset_path(assets_dir: &Path, stored: &str) -> PathBuf {
    let parts: Vec<&str> = stored.split(['/', '\\']).collect();
    let name = parts.last().copied().unwrap_or("");
    if parts.len() == 2 && parts[0] == ASSET_DIR {
        return assets_dir.join(name);
    }
    let bytes = stored.as_bytes();
    let absolute = stored.starts_with('/')
        || (bytes.len() > 2
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'/' || bytes[2] == b'\\'));
    let in_asset_dir = parts.len() >= 2 && parts[parts.len() - 2] == ASSET_DIR;
    if absolute && in_asset_dir && is_pikos_asset_name(name) {
        return assets_dir.join(name);
    }
    PathBuf::from(stored)
}

/// The stored path of every image a page refers to, trashed pages included, since restoring one
/// brings its images back.
///
/// Reads the chunks' bodies one by one rather than whole pages: it also scans backups, opened
/// read-only and unmigrated on a connection without Pikos's SQL functions. A backup from before
/// bodies were stored only as chunks still has its `content` column, and one older than chunks has
/// nothing else, so that column is read wherever it is there. An image missed is deleted, and the
/// restore shows it broken.
pub async fn asset_paths_in(pool: &SqlitePool) -> AppResult<HashSet<String>> {
    // body-read-ok: a backup's own schema, see the doc above
    let has_body_column: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM pragma_table_info('pages') WHERE name = 'content')",
    )
    .fetch_one(pool)
    .await?;
    let sql = if has_body_column {
        // body-read-ok: a backup from before bodies were stored only as chunks
        "SELECT content FROM pages WHERE instr(content, '\"image\"') > 0"
    } else {
        "SELECT body FROM page_chunks WHERE instr(body, '\"image\"') > 0"
    };
    let bodies: Vec<String> = sqlx::query_scalar(sql).fetch_all(pool).await?;

    let mut paths = Vec::new();
    for body in &bodies {
        match serde_json::from_str::<serde_json::Value>(body) {
            Ok(serde_json::Value::Array(blocks)) => {
                for block in &blocks {
                    collect_asset_paths(block, &mut paths);
                }
            }
            Ok(doc) => collect_asset_paths(&doc, &mut paths),
            Err(_) => {}
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
