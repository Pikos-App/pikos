//! Workspace maintenance: reset, wipe, backups, and dev-only timestamp backdating.

use tauri::Manager;

use crate::db::DbState;
use crate::error::{AppError, AppResult};

/// Keeps the DB file and schema. Sync accounts are disconnected first, before the rows
/// their keychain blobs are keyed to are gone (see `disconnect_all_accounts`).
#[cfg(debug_assertions)]
#[tauri::command]
pub async fn reset_db(state: tauri::State<'_, DbState>) -> AppResult<()> {
    let pool = state.get_pool().await?;
    // Best-effort: an unreachable provider must not block wiping local data.
    if let Err(e) =
        pikos_calendar_sync::disconnect_all_accounts(&pool, pikos_calendar_sync::Keychain::system())
            .await
    {
        log::warn!("reset_db: could not disconnect the sync accounts: {e}");
    }
    reset_db_impl(&pool).await
}

/// Empty every table the workspace owns.
///
/// The deletes are `pikos_db::export::reset_workspace`, shared with the phone; this
/// adds the logging, which counts what went so the log says how much was lost.
// The e2e bridge resets workspaces through this in any build it's part of.
#[cfg(any(debug_assertions, test, feature = "e2e-bridge"))]
pub(crate) async fn reset_db_impl(pool: &sqlx::SqlitePool) -> AppResult<()> {
    let before: Vec<(&str, i64)> = {
        let mut counts = Vec::new();
        for table in [
            "pages",
            "folders",
            "page_schedules",
            "page_recurrence_rules",
            "focus_sessions",
            "sync_account",
        ] {
            let n: i64 =
                sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}"))) // sql-ok: table is a literal from the list above
                    .fetch_one(pool)
                    .await?;
            counts.push((table, n));
        }
        counts
    };

    pikos_db::export::reset_workspace(pool).await?;

    log::info!(
        "reset_db pages={} folders={} schedules={} rules={} sessions={} sync_accounts={}",
        before[0].1,
        before[1].1,
        before[2].1,
        before[3].1,
        before[4].1,
        before[5].1
    );
    Ok(())
}

/// "Delete All Data": the whole on-disk footprint (SQLite files, assets, backups, the store
/// registry, logs). The frontend must `relaunch()` immediately after this resolves.
#[tauri::command]
pub async fn wipe_app_data(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
) -> AppResult<()> {
    log::info!("wipe_app_data action=drop_pool_remove_disk");

    // close_pool, not just drop: SqlitePool's Drop hands cleanup to a background task, so
    // connections can outlive the wipe and leave the WAL uncheckpointed, and the next launch
    // would race WAL recovery and hit SQLITE_BUSY.
    if let Some(pool) = state.take_pool().await {
        pikos_db::close_pool(&pool).await;
    }

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(format!("app_data_dir: {e}")))?;
    if app_data.exists() {
        std::fs::remove_dir_all(&app_data)?;
    }

    // Best-effort: tauri-plugin-log may still hold the log file open, which fails the
    // removal on Windows; on Unix the handle keeps writing to the unlinked inode until relaunch.
    if let Ok(app_log) = app.path().app_log_dir() {
        if app_log.exists() {
            let _ = std::fs::remove_dir_all(&app_log);
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn backup_db(state: tauri::State<'_, DbState>) -> AppResult<String> {
    let pool = state.get_pool().await?;

    let home =
        std::env::var("HOME").map_err(|e| AppError::Internal(format!("$HOME not set: {e}")))?;
    let dest = write_sqlite_export(&pool, &std::path::Path::new(&home).join("Downloads")).await?;

    let dest = dest.to_string_lossy().to_string();
    log::info!("backup_db dest={}", dest.replacen(&home, "~", 1));
    Ok(dest)
}

pub(crate) async fn write_sqlite_export(
    pool: &sqlx::SqlitePool,
    dir: &std::path::Path,
) -> AppResult<std::path::PathBuf> {
    let dest = dir.join(super::export::stamped_file_name("pikos-backup", "sqlite"));
    vacuum_into(pool, &dest.to_string_lossy()).await?;
    Ok(dest)
}

/// Delegates to `pikos_db::export::backup_to`, which the phone shares, so the path
/// escaping lives in one copy.
pub(crate) async fn vacuum_into(pool: &sqlx::SqlitePool, dest: &str) -> AppResult<()> {
    pikos_db::export::backup_to(pool, dest).await
}

#[tauri::command]
pub async fn backup_db_before_import(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
) -> AppResult<String> {
    let pool = state.get_pool().await?;

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(format!("Failed to get app data dir: {e}")))?;
    let backup_dir = app_data.join("backups");
    std::fs::create_dir_all(&backup_dir)?;

    let timestamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S");
    let dest = backup_dir
        .join(format!("pre-import-{timestamp}.sqlite"))
        .to_string_lossy()
        .to_string();

    vacuum_into(&pool, &dest).await?;

    Ok(dest)
}

#[cfg(any(debug_assertions, test))]
#[derive(serde::Deserialize)]
pub struct BackdateParams {
    pub id: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub completed_at: Option<String>,
}

#[cfg(debug_assertions)]
#[tauri::command]
pub async fn backdate_page(
    state: tauri::State<'_, DbState>,
    params: BackdateParams,
) -> AppResult<()> {
    let pool = state.get_pool().await?;
    backdate_page_impl(&pool, params).await
}

#[cfg(any(debug_assertions, test))]
pub async fn backdate_page_impl(pool: &sqlx::SqlitePool, params: BackdateParams) -> AppResult<()> {
    let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new("UPDATE pages SET ");
    let mut sep = builder.separated(", ");
    let mut has_updates = false;

    if let Some(ref v) = params.created_at {
        sep.push("created_at = ");
        sep.push_bind_unseparated(v.clone());
        has_updates = true;
    }
    if let Some(ref v) = params.updated_at {
        sep.push("updated_at = ");
        sep.push_bind_unseparated(v.clone());
        has_updates = true;
    }
    if let Some(ref v) = params.completed_at {
        sep.push("completed_at = ");
        sep.push_bind_unseparated(v.clone());
        has_updates = true;
    }

    if !has_updates {
        return Ok(());
    }

    builder.push(" WHERE id = ");
    builder.push_bind(&params.id);

    builder.build().execute(pool).await?;
    Ok(())
}

#[tauri::command]
pub async fn list_backups(
    state: tauri::State<'_, DbState>,
) -> AppResult<Vec<pikos_db::BackupEntry>> {
    let path = state
        .current_path()
        .await
        .ok_or_else(|| AppError::Internal("No database connected.".into()))?;
    pikos_db::list_backups(&path.to_string_lossy())
}

/// Stop reading and writing a workspace the app has found damaged, since every
/// further write to it can lose more. The sync loops, the checkpoint timer and the
/// asset sweep all hold the same pool, so they stop too.
#[tauri::command]
pub async fn close_damaged_workspace(state: tauri::State<'_, DbState>) -> AppResult<()> {
    state.close_keeping_path().await;
    log::warn!("workspace closed: the file is damaged");
    Ok(())
}

/// Restarts into the snapshot rather than swapping the file under a live pool, which would
/// mean reasoning about every open connection, the WAL, and a React tree holding vanished
/// rows. The pool is dropped, the file replaced, and the process re-execs.
///
/// A refused or damaged backup returns its error with the pool open and nothing on disk touched.
#[tauri::command]
pub async fn restore_backup(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
    file_name: String,
) -> AppResult<()> {
    restore_backup_impl(&state, &file_name).await?;
    app.restart();
}

/// [`restore_backup`] up to the restart.
pub(crate) async fn restore_backup_impl(state: &DbState, file_name: &str) -> AppResult<()> {
    let path = state
        .current_path()
        .await
        .ok_or_else(|| AppError::Internal("No database connected.".into()))?;
    let path = path.to_string_lossy().to_string();

    // Validate before taking the pool: a rejected restore has to leave a working
    // app behind, and every command fails once the pool is gone.
    pikos_db::backups::verify_restorable(&path, file_name).await?;

    if let Some(pool) = state.take_pool().await {
        pikos_db::close_pool(&pool).await;
    }

    let displaced = pikos_db::restore_backup(&path, file_name).await?;
    log::info!("restored {file_name}; previous workspace kept at {displaced}");
    Ok(())
}
