//! Reading the backups directory, and putting one back.
//!
//! `open_pool` and an import snapshot before they run, so a good copy usually exists. Restoring
//! never writes over the live file in place: it snapshots what is there first, so a mistaken
//! restore is undoable, and the app relaunches rather than hot-swapping the file under an open
//! pool.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::pool::embedded_migration_max;

/// Why a snapshot exists, read back from the filename prefix rather than stored.
#[derive(Debug, Serialize, PartialEq, Eq, Clone, Copy, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum BackupKind {
    /// Written by `open_pool` before applying pending migrations.
    PreMigration,
    /// Written before a batch import.
    PreImport,
    /// Written by a restore, holding what the restore displaced.
    PreRestore,
}

#[derive(Debug, Serialize, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields = nullable)]
pub struct BackupEntry {
    /// Filename only. Restoring takes this, never a caller-supplied path.
    pub file_name: String,
    pub kind: BackupKind,
    #[ts(type = "number")]
    pub bytes: i64,
    /// Filesystem modification time, ISO-8601. Filenames carry a timestamp in two formats, so
    /// this is the one the OS agrees with.
    pub created_at: String,
}

pub fn backups_dir(workspace_path: &str) -> PathBuf {
    Path::new(workspace_path)
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("backups")
}

fn kind_of(file_name: &str) -> Option<BackupKind> {
    if file_name.starts_with("pre-migration-") {
        Some(BackupKind::PreMigration)
    } else if file_name.starts_with("pre-import-") {
        Some(BackupKind::PreImport)
    } else if file_name.starts_with("pre-restore-") {
        Some(BackupKind::PreRestore)
    } else {
        None
    }
}

/// Every snapshot beside the workspace, newest first. A missing directory is an empty list.
pub fn list_backups(workspace_path: &str) -> AppResult<Vec<BackupEntry>> {
    let dir = backups_dir(workspace_path);
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".sqlite") {
            continue;
        }
        let Some(kind) = kind_of(&name) else { continue };
        let meta = entry.metadata()?;
        let created_at = meta
            .modified()
            .ok()
            .map(chrono::DateTime::<chrono::Utc>::from)
            .map(|t| t.to_rfc3339())
            .unwrap_or_default();
        out.push(BackupEntry {
            bytes: meta.len() as i64,
            created_at,
            file_name: name,
            kind,
        });
    }

    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

/// Refuses anything that is not a plain filename in the backups directory. The value comes
/// from the frontend, and an escaping path would let a restore overwrite the workspace with
/// an arbitrary file.
fn resolve(workspace_path: &str, file_name: &str) -> AppResult<PathBuf> {
    if file_name.contains('/') || file_name.contains('\\') || file_name.contains("..") {
        return Err(AppError::Invalid(format!(
            "not a backup file name: {file_name}"
        )));
    }
    if kind_of(file_name).is_none() || !file_name.ends_with(".sqlite") {
        return Err(AppError::Invalid(format!(
            "not a Pikos backup: {file_name}"
        )));
    }
    let path = backups_dir(workspace_path).join(file_name);
    if !path.is_file() {
        return Err(AppError::NotFound(format!("no backup named {file_name}")));
    }
    Ok(path)
}

/// A candidate must open, pass `quick_check` and carry a schema this build knows. Migrations
/// only run forward, so a backup from a newer build would be migrated by nothing and the app
/// would open a workspace whose columns it cannot see.
async fn verify(path: &Path) -> AppResult<()> {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(false)
                .read_only(true),
        )
        .await
        .map_err(|e| AppError::Corrupt(format!("the backup could not be opened: {e}")))?;

    let check = sqlx::query_scalar::<_, String>("PRAGMA quick_check")
        .fetch_one(&pool)
        .await;
    let applied = sqlx::query_scalar::<_, Option<i64>>("SELECT MAX(version) FROM _sqlx_migrations")
        .fetch_one(&pool)
        .await;
    pool.close().await;

    match check {
        Ok(row) if row == "ok" => {}
        Ok(row) => return Err(AppError::Corrupt(format!("the backup is damaged: {row}"))),
        Err(e) => return Err(AppError::Corrupt(format!("the backup is damaged: {e}"))),
    }

    let applied = applied
        .map_err(|e| AppError::Corrupt(format!("the backup has no migration history: {e}")))?
        .unwrap_or(0);
    if applied > embedded_migration_max() {
        return Err(AppError::Invalid(
            "this backup was written by a newer version of Pikos. Update, then restore it."
                .to_string(),
        ));
    }
    Ok(())
}

/// Whether restoring would work, touching nothing, so a caller can check before closing its
/// pool: once it is gone every other command fails.
pub async fn verify_restorable(workspace_path: &str, file_name: &str) -> AppResult<()> {
    let source = resolve(workspace_path, file_name)?;
    verify(&source).await
}

/// Copies the workspace to `dest` through SQLite. A plain `fs::copy` loses the most recent
/// writes, which may still be in the write-ahead log, as closing the pool checkpoints only
/// when SQLite gets to it. `VACUUM INTO` reads through the WAL into one consistent file.
pub(crate) async fn snapshot_workspace(workspace_path: &str, dest: &Path) -> AppResult<()> {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(workspace_path)
                .create_if_missing(false),
        )
        .await?;

    let sql = format!(
        "VACUUM INTO '{}'",
        dest.to_string_lossy().replace('\'', "''")
    );
    let result = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()))
        .execute(&pool)
        .await; // sql-ok: VACUUM INTO takes no bind parameter
    pool.close().await;
    result?;
    Ok(())
}

/// The restored file's counter is the backup's, behind the one anything watching has seen, so it
/// gets a new epoch. A backup from before the counter existed gets one when it migrates.
async fn renew_epoch(workspace_path: &str) -> AppResult<()> {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(workspace_path)
                .create_if_missing(false),
        )
        .await?;
    let counted: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'change_counter')",
    )
    .fetch_one(&pool)
    .await?;
    if counted {
        crate::changes::new_epoch(&pool).await?;
    }
    pool.close().await;
    Ok(())
}

/// Device sync's state on the workspace a restore is about to replace, read before the file goes.
async fn sync_before_restore(workspace_path: &str) -> AppResult<Option<crate::replica::Displaced>> {
    let pool = crate::pool::with_functions(sqlx::sqlite::SqlitePoolOptions::new())
        .max_connections(1)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(workspace_path)
                .create_if_missing(false),
        )
        .await?;
    let carried = crate::replica::before_restore(&pool).await;
    pool.close().await;
    carried
}

/// Puts `file_name` back as the workspace, after snapshotting what is there. Returns that
/// snapshot so the UI can name it.
///
/// The caller must have closed its pool: the WAL and shared-memory files belong to the old
/// database, and left beside the new one they produce a workspace that is neither file, so
/// they are removed here.
pub async fn restore_backup(workspace_path: &str, file_name: &str) -> AppResult<String> {
    let source = resolve(workspace_path, file_name)?;
    verify(&source).await?;

    let dir = backups_dir(workspace_path);
    std::fs::create_dir_all(&dir)?;
    let ts = chrono::Utc::now().format("%Y%m%dT%H%M%S%3fZ");
    let displaced = dir.join(format!("pre-restore-{ts}.sqlite"));

    let mut carried = None;
    if Path::new(workspace_path).exists() {
        snapshot_workspace(workspace_path, &displaced).await?;
        carried = sync_before_restore(workspace_path).await?;
    }

    std::fs::copy(&source, workspace_path)?;
    for suffix in ["-wal", "-shm"] {
        let stale = PathBuf::from(format!("{workspace_path}{suffix}"));
        if stale.exists() {
            std::fs::remove_file(&stale)?;
        }
    }
    renew_epoch(workspace_path).await?;
    if let Some(carried) = carried {
        let pool = crate::pool::open_pool_for_maintenance(workspace_path).await?;
        let result = crate::replica::after_restore(&pool, carried).await;
        pool.close().await;
        result?;
    }

    Ok(displaced.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A workspace directory with a real migrated database in it.
    async fn workspace() -> (PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("pkos_bk_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("workspace.sqlite");
        let path_str = path.to_string_lossy().to_string();
        let pool = crate::pool::open_pool(&path_str).await.unwrap();
        crate::insert_test_folder(&pool, "f1", "Work")
            .await
            .unwrap();
        crate::pool::close_pool(&pool).await;
        (dir, path_str)
    }

    /// Writes a snapshot as the app does: a plain `fs::copy` can miss the latest insert, as
    /// closing a pool doesn't synchronously fold the write-ahead log back.
    async fn snapshot(workspace_path: &str, name: &str) -> PathBuf {
        let dir = backups_dir(workspace_path);
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join(name);
        snapshot_workspace(workspace_path, &dest).await.unwrap();
        dest
    }

    async fn folder_count(path: &str) -> i64 {
        let pool = crate::pool::open_pool(path).await.unwrap();
        let n = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM folders")
            .fetch_one(&pool)
            .await
            .unwrap();
        crate::pool::close_pool(&pool).await;
        n
    }

    #[tokio::test]
    async fn an_absent_backups_directory_is_an_empty_list() {
        let (dir, path) = workspace().await;
        assert!(list_backups(&path).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn listing_reads_the_kind_out_of_the_name_and_ignores_strangers() {
        let (dir, path) = workspace().await;
        snapshot(&path, "pre-migration-20260101T000000000Z-v8-to-v9.sqlite").await;
        snapshot(&path, "pre-import-2026-01-02T00-00-00.sqlite").await;
        snapshot(&path, "pre-restore-20260103T000000000Z.sqlite").await;
        // Not ours, so a restore must never offer them.
        snapshot(&path, "holiday-photos.sqlite").await;
        std::fs::write(backups_dir(&path).join("notes.txt"), "hi").unwrap();

        let found = list_backups(&path).unwrap();
        assert_eq!(found.len(), 3, "{found:?}");
        let kinds: Vec<BackupKind> = found.iter().map(|b| b.kind).collect();
        assert!(kinds.contains(&BackupKind::PreMigration));
        assert!(kinds.contains(&BackupKind::PreImport));
        assert!(kinds.contains(&BackupKind::PreRestore));
        assert!(found.iter().all(|b| b.bytes > 0));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The file name crosses the IPC boundary; each of these would otherwise read a file outside
    /// the backups directory and overwrite the workspace.
    #[tokio::test]
    async fn a_name_that_is_a_path_is_refused() {
        let (dir, path) = workspace().await;
        for name in [
            "../../../etc/passwd",
            "pre-migration-../escape.sqlite",
            "/etc/hosts",
            "subdir/pre-migration-x.sqlite",
        ] {
            let err = restore_backup(&path, name).await.unwrap_err();
            assert_eq!(err.kind(), "Invalid", "{name} was not refused: {err}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_file_that_is_not_a_pikos_backup_is_refused() {
        let (dir, path) = workspace().await;
        snapshot(&path, "holiday-photos.sqlite").await;
        let err = restore_backup(&path, "holiday-photos.sqlite")
            .await
            .unwrap_err();
        assert_eq!(err.kind(), "Invalid");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_damaged_backup_is_refused_before_it_displaces_anything() {
        let (dir, path) = workspace().await;
        let bad = backups_dir(&path).join("pre-migration-20260101T000000000Z-v8-to-v9.sqlite");
        std::fs::create_dir_all(backups_dir(&path)).unwrap();
        std::fs::write(&bad, b"this is not a database").unwrap();

        let before = folder_count(&path).await;
        let err = restore_backup(&path, bad.file_name().unwrap().to_str().unwrap())
            .await
            .unwrap_err();

        assert_eq!(err.kind(), "Corrupt", "{err}");
        assert_eq!(
            folder_count(&path).await,
            before,
            "the workspace was changed by a restore that should have refused"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // qa: EXP-09:3
    #[tokio::test]
    async fn restoring_puts_the_backup_back_and_keeps_what_it_displaced() {
        let (dir, path) = workspace().await;

        let backup_name = "pre-migration-20260101T000000000Z-v8-to-v9.sqlite";
        snapshot(&path, backup_name).await;
        let pool = crate::pool::open_pool(&path).await.unwrap();
        crate::insert_test_folder(&pool, "f2", "Later")
            .await
            .unwrap();
        crate::pool::close_pool(&pool).await;

        let displaced = restore_backup(&path, backup_name).await.unwrap();

        let pool = crate::pool::open_pool(&path).await.unwrap();
        let folders: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM folders")
            .fetch_one(&pool)
            .await
            .unwrap();
        crate::pool::close_pool(&pool).await;
        assert_eq!(folders, 1, "the restored workspace is not the backup");

        let pool = crate::pool::open_pool(&displaced).await.unwrap();
        let folders: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM folders")
            .fetch_one(&pool)
            .await
            .unwrap();
        crate::pool::close_pool(&pool).await;
        assert_eq!(folders, 2, "the displaced workspace was not kept");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_restore_leaves_no_wal_from_the_old_database() {
        let (dir, path) = workspace().await;
        let backup_name = "pre-import-2026-01-02T00-00-00.sqlite";
        snapshot(&path, backup_name).await;

        let pool = crate::pool::open_pool(&path).await.unwrap();
        crate::insert_test_folder(&pool, "f2", "Later")
            .await
            .unwrap();
        crate::pool::close_pool(&pool).await;
        // Written after the close: under an open pool, whether a checkpoint gets to it first is a race.
        std::fs::write(format!("{path}-wal"), b"stale").unwrap();

        restore_backup(&path, backup_name).await.unwrap();

        assert!(
            !std::path::Path::new(&format!("{path}-wal")).exists(),
            "a WAL belonging to the replaced database survived the restore"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    async fn pending(path: &str) -> Vec<(String, String, bool)> {
        let pool = crate::pool::open_pool(path).await.unwrap();
        let ops = sqlx::query_as(
            "SELECT entity, key, deleted FROM replica_ops WHERE entity = 'page' ORDER BY key",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        crate::pool::close_pool(&pool).await;
        ops
    }

    #[tokio::test]
    async fn a_restore_with_sync_on_replaces_the_workspace_on_every_device() {
        let (dir, path) = workspace().await;
        let pool = crate::pool::open_pool(&path).await.unwrap();
        let device = crate::replica::start(&pool).await.unwrap().device_id;
        crate::insert_test_page(&pool, crate::TestPage::new("kept", "Groceries"))
            .await
            .unwrap();
        crate::pool::close_pool(&pool).await;
        snapshot(&path, "pre-import-2026-10-17T00-00-00.sqlite").await;

        let pool = crate::pool::open_pool(&path).await.unwrap();
        crate::insert_test_page(
            &pool,
            crate::TestPage::new("after", "Made after the backup"),
        )
        .await
        .unwrap();
        sqlx::query("UPDATE pages SET title = 'Edited after the backup' WHERE id = 'kept'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM replica_ops")
            .execute(&pool)
            .await
            .unwrap();
        crate::replica::hold(&pool, "accountChanged").await.unwrap();
        let before = crate::replica::meta(&pool).await.unwrap();
        crate::pool::close_pool(&pool).await;

        restore_backup(&path, "pre-import-2026-10-17T00-00-00.sqlite")
            .await
            .unwrap();

        let pool = crate::pool::open_pool(&path).await.unwrap();
        let after = crate::replica::meta(&pool).await.unwrap();
        let held_for = crate::replica::held_for(&pool).await.unwrap();
        let title: String = sqlx::query_scalar("SELECT title FROM pages WHERE id = 'kept'")
            .fetch_one(&pool)
            .await
            .unwrap();
        let built = crate::replica::build::build(
            &pool,
            &[pikos_replica::RecordName::live(
                pikos_replica::Entity::Page,
                "kept",
            )],
        )
        .await
        .unwrap();
        crate::pool::close_pool(&pool).await;
        assert_eq!(title, "Groceries");
        assert!(after.started);
        assert_eq!(after.device_id, device, "this device carries on as itself");
        assert_eq!(
            held_for.as_deref(),
            Some("accountChanged"),
            "a restore doesn't settle what iCloud waits on the person for"
        );
        assert!(after.hlc > before.hlc);
        assert_eq!(
            pending(&path).await,
            vec![
                ("page".to_owned(), "after".to_owned(), true),
                ("page".to_owned(), "kept".to_owned(), false),
            ],
            "the restored page goes out as a fresh write, and the page the backup lacks as removed"
        );
        let title_clock: pikos_replica::Hlc = match built[0].fields.get("title_at") {
            Some(pikos_replica::merge::Value::Text(c)) => c.parse().unwrap(),
            other => panic!("no title clock: {other:?}"),
        };
        assert!(
            title_clock > before.hlc,
            "it beats the edit made after the backup"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_restore_with_sync_never_started_sends_nothing() {
        let (dir, path) = workspace().await;
        snapshot(&path, "pre-import-2026-10-17T00-00-00.sqlite").await;

        restore_backup(&path, "pre-import-2026-10-17T00-00-00.sqlite")
            .await
            .unwrap();

        assert!(pending(&path).await.is_empty());
        let pool = crate::pool::open_pool(&path).await.unwrap();
        assert!(!crate::replica::meta(&pool).await.unwrap().started);
        crate::pool::close_pool(&pool).await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
