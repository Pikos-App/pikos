//! Reading the backups directory, and putting one back.
//!
//! The write side already existed and was only ever half a feature: `open_pool`
//! snapshots before a pending migration and an import snapshots before it runs,
//! so by the time anything goes wrong there is usually a good copy sitting on
//! disk — with no way to reach it except quitting the app, finding the
//! application-support directory and renaming a file by hand. Pikos is built for
//! people who would not do that.
//!
//! Restoring never writes over the live file in place. It snapshots what is
//! there first, so a restore chosen by mistake is itself undoable, and the app
//! relaunches rather than hot-swapping the file under an open pool.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::pool::embedded_migration_max;

/// Why a snapshot exists. The prefix is part of the filename the writers already
/// use, so this is read back out rather than stored.
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
    /// Filesystem modification time, ISO-8601. The filenames carry a timestamp
    /// too, in two different formats, so this reads the one the OS agrees with.
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

/// Every snapshot beside the workspace, newest first. A missing directory is an
/// empty list, not an error: it simply means nothing has needed one yet.
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

/// Refuse anything that is not a plain filename in the backups directory. The
/// value reaches here from the frontend, and a path that escapes the directory
/// would let a restore read an arbitrary file and then overwrite the workspace
/// with it.
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

/// Read a candidate before trusting it: it has to open, pass `quick_check`, and
/// carry a schema this build knows.
///
/// The schema test is the same refusal the CLI makes when a workspace is newer
/// than the binary, and it matters more here: migrations only run forward, so a
/// backup written by a newer build would be migrated by nothing, and the app
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

/// Answer "would restoring this work?" without touching anything.
///
/// Exists so a caller that has to close its pool before restoring can find out
/// first. Once the pool is gone every other command fails, so a restore that
/// discovers a damaged backup at that point has already broken the running app
/// to deliver the bad news.
pub async fn verify_restorable(workspace_path: &str, file_name: &str) -> AppResult<()> {
    let source = resolve(workspace_path, file_name)?;
    verify(&source).await
}

/// Copy the workspace to `dest` through SQLite rather than the filesystem.
///
/// A plain `fs::copy` of the main file is not a copy of the database: recent
/// writes may still live in the write-ahead log beside it, and closing the pool
/// only checkpoints when SQLite gets around to it. Copying the file alone loses
/// exactly the most recent edits, which on this path are the ones the user is
/// about to want back. `VACUUM INTO` reads through the WAL and emits one
/// consistent file, which is why every other snapshot in the codebase uses it.
async fn snapshot_workspace(workspace_path: &str, dest: &Path) -> AppResult<()> {
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
    let result = sqlx::query(&sql).execute(&pool).await; // sql-ok: VACUUM INTO takes no bind parameter
    pool.close().await;
    result?;
    Ok(())
}

/// Put `file_name` back as the workspace, after snapshotting what is there now.
///
/// The caller must have closed its pool: SQLite's WAL and shared-memory files
/// belong to the old database, and leaving either beside the new one is how a
/// restore produces a workspace that is neither file. They are removed here for
/// the same reason.
///
/// Returns the snapshot of the displaced workspace, so the UI can name it.
pub async fn restore_backup(workspace_path: &str, file_name: &str) -> AppResult<String> {
    let source = resolve(workspace_path, file_name)?;
    verify(&source).await?;

    let dir = backups_dir(workspace_path);
    std::fs::create_dir_all(&dir)?;
    let ts = chrono::Utc::now().format("%Y%m%dT%H%M%S%3fZ");
    let displaced = dir.join(format!("pre-restore-{ts}.sqlite"));

    if Path::new(workspace_path).exists() {
        snapshot_workspace(workspace_path, &displaced).await?;
    }

    std::fs::copy(&source, workspace_path)?;
    for suffix in ["-wal", "-shm"] {
        let stale = PathBuf::from(format!("{workspace_path}{suffix}"));
        if stale.exists() {
            std::fs::remove_file(&stale)?;
        }
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
        pool.close().await;
        (dir, path_str)
    }

    /// Write a snapshot the way the app does. A plain `fs::copy` here produced a
    /// backup that was sometimes missing the most recent insert, because closing
    /// a pool does not synchronously fold the write-ahead log back into the file.
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
        pool.close().await;
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
        // Neither of these is ours, and a restore must never offer them.
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

    /// The file name crosses the IPC boundary, so it is the one input here an
    /// attacker-shaped value could arrive in. Each of these would otherwise read
    /// a file outside the backups directory and then overwrite the workspace.
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

    #[tokio::test]
    async fn restoring_puts_the_backup_back_and_keeps_what_it_displaced() {
        let (dir, path) = workspace().await;

        // Snapshot the one-folder state, then add a second folder so the live
        // file and the backup differ in a way the assertions can see.
        let backup_name = "pre-migration-20260101T000000000Z-v8-to-v9.sqlite";
        snapshot(&path, backup_name).await;
        let pool = crate::pool::open_pool(&path).await.unwrap();
        crate::insert_test_folder(&pool, "f2", "Later")
            .await
            .unwrap();
        pool.close().await;

        let displaced = restore_backup(&path, backup_name).await.unwrap();

        let pool = crate::pool::open_pool(&path).await.unwrap();
        let folders: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM folders")
            .fetch_one(&pool)
            .await
            .unwrap();
        pool.close().await;
        assert_eq!(folders, 1, "the restored workspace is not the backup");

        // The displaced state is itself recoverable — a restore chosen by mistake
        // is not the end of the story.
        let pool = crate::pool::open_pool(&displaced).await.unwrap();
        let folders: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM folders")
            .fetch_one(&pool)
            .await
            .unwrap();
        pool.close().await;
        assert_eq!(folders, 2, "the displaced workspace was not kept");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_restore_leaves_no_wal_from_the_old_database() {
        let (dir, path) = workspace().await;
        let backup_name = "pre-import-2026-01-02T00-00-00.sqlite";
        snapshot(&path, backup_name).await;

        // Reopen so WAL and shm exist beside the live file, as they do in the app.
        let pool = crate::pool::open_pool(&path).await.unwrap();
        crate::insert_test_folder(&pool, "f2", "Later")
            .await
            .unwrap();
        std::fs::write(format!("{path}-wal"), b"stale").unwrap();

        pool.close().await;
        restore_backup(&path, backup_name).await.unwrap();

        assert!(
            !std::path::Path::new(&format!("{path}-wal")).exists(),
            "a WAL belonging to the replaced database survived the restore"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
