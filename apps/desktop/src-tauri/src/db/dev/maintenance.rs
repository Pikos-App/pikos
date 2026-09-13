//! Workspace maintenance: resetting the data, wiping the app's on-disk
//! footprint, taking backups, and the dev-only timestamp backdating the seed
//! scripts drive.

use pikos_calendar_sync::Keychain;
use serde::Deserialize;
use tauri::Manager;

use crate::db::DbState;
use crate::error::{AppError, AppResult};

/// Delete all user data from the workspace (keeps the DB file and schema).
/// FK order: focus_sessions → page_schedules → page_recurrence_rules → pages → folders
///
/// Sync accounts are disconnected first, through the same path the settings panel
/// uses — see `disconnect_all_accounts` for what that has to reach before the rows
/// their keychain blobs are keyed to are gone.
#[tauri::command]
pub async fn reset_db(state: tauri::State<'_, DbState>) -> AppResult<()> {
    let pool = state.get_pool().await?;
    // Best-effort: an unreachable provider must not block wiping local data.
    if let Err(e) = pikos_calendar_sync::disconnect_all_accounts(&pool, Keychain::system()).await {
        log::warn!("reset_db: could not disconnect the sync accounts: {e}");
    }
    reset_db_impl(&pool).await
}

/// Empty every table the workspace owns.
///
/// The deletes themselves moved to `pikos_db::export::reset_workspace` when the
/// phone needed the same button; what stays here is the logging, which counts
/// what went so the line in the log says how much was lost.
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
            let n: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}")) // sql-ok: table is a literal from the list above
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

/// User-facing "Delete All Data": wipes the entire on-disk footprint of the
/// app — SQLite files (DB, WAL, SHM), workspace assets, backups, the
/// tauri-plugin-store registry, and the rotating log directory. The frontend
/// is expected to call `relaunch()` immediately after this resolves so the
/// app starts fresh as if newly installed.
#[tauri::command]
pub async fn wipe_app_data(
    app: tauri::AppHandle,
    state: tauri::State<'_, DbState>,
) -> AppResult<()> {
    log::info!("wipe_app_data action=drop_pool_remove_disk");

    // close().await, not just drop: SqlitePool's Drop hands cleanup to a
    // background task, so connections can outlive the wipe and the WAL can
    // stay uncheckpointed — the next launch would then race WAL recovery
    // across StrictMode's double-mount and hit SQLITE_BUSY. The test
    // `wipe_drops_pool_so_handles_release_before_file_removal` asserts this
    // close-before-unlink ordering.
    if let Some(pool) = state.take_pool().await {
        pool.close().await;
    }

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(format!("app_data_dir: {e}")))?;
    if app_data.exists() {
        std::fs::remove_dir_all(&app_data)?;
    }

    // Best-effort: tauri-plugin-log may still hold the current log file open.
    // The directory removal can fail on Windows; on Unix it succeeds and the
    // open handle continues writing to the now-unlinked inode until relaunch.
    if let Ok(app_log) = app.path().app_log_dir() {
        if app_log.exists() {
            let _ = std::fs::remove_dir_all(&app_log);
        }
    }

    Ok(())
}

/// Copy the live database to ~/Downloads/pikos-backup-<timestamp>.sqlite.
/// Uses SQLite's VACUUM INTO so the copy is clean (no separate WAL file needed).
#[tauri::command]
pub async fn backup_db(state: tauri::State<'_, DbState>) -> AppResult<String> {
    let pool = state.get_pool().await?;

    let home =
        std::env::var("HOME").map_err(|e| AppError::Internal(format!("$HOME not set: {e}")))?;
    let timestamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S");
    let dest = format!("{home}/Downloads/pikos-backup-{timestamp}.sqlite");

    vacuum_into(&pool, &dest).await?;

    log::info!("backup_db dest={}", dest.replacen(&home, "~", 1));
    Ok(dest)
}

/// VACUUM INTO a destination path — a defragmented single-file copy made while
/// the DB stays open.
///
/// Delegates to `pikos_db::export::backup_to`: the phone takes the same backup,
/// and the escaping this used to do inline is the kind of detail that is wrong
/// in exactly one of two copies.
pub(crate) async fn vacuum_into(pool: &sqlx::SqlitePool, dest: &str) -> AppResult<()> {
    pikos_db::export::backup_to(pool, dest).await
}

/// Pre-import safety backup — copies the DB to {appDataDir}/backups/ before a batch import.
/// Uses VACUUM INTO for a clean, single-file copy.
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

// ── Seed helpers ─────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct BackdateParams {
    pub id: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub completed_at: Option<String>,
}

/// Dev-only: overwrite timestamps on a page for realistic seed data.
/// Not exposed in production — only called by seed scripts.
#[tauri::command]
pub async fn backdate_page(
    state: tauri::State<'_, DbState>,
    params: BackdateParams,
) -> AppResult<()> {
    let pool = state.get_pool().await?;
    backdate_page_impl(&pool, params).await
}

pub(crate) async fn backdate_page_impl(
    pool: &sqlx::SqlitePool,
    params: BackdateParams,
) -> AppResult<()> {
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
