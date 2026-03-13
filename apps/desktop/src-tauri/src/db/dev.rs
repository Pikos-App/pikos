// dev.rs — Developer/settings commands: stats, reset, seed.
// run_seed is intentionally dev-only: it shells out to `pnpm seed` in the repo root,
// which only exists in a development checkout.

use serde::Serialize;

use crate::db::DbState;

#[derive(Serialize)]
pub struct DbStats {
    pub pages: i64,
    pub folders: i64,
    pub schedules: i64,
    pub focus_sessions: i64,
}

/// Return row counts for the main tables. Used by the Settings > General page.
#[tauri::command]
pub async fn get_db_stats(state: tauri::State<'_, DbState>) -> Result<DbStats, String> {
    let pool = state.get_pool().await?;

    let pages: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pages")
        .fetch_one(&pool)
        .await
        .map_err(|e| e.to_string())?;

    let folders: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM folders")
        .fetch_one(&pool)
        .await
        .map_err(|e| e.to_string())?;

    let schedules: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM page_schedules")
        .fetch_one(&pool)
        .await
        .map_err(|e| e.to_string())?;

    let focus_sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM focus_sessions")
        .fetch_one(&pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(DbStats {
        pages,
        folders,
        schedules,
        focus_sessions,
    })
}

/// Delete all user data from the workspace (keeps the DB file and schema).
/// FK order: focus_sessions → page_schedules → page_recurrence_rules → pages → folders
#[tauri::command]
pub async fn reset_db(state: tauri::State<'_, DbState>) -> Result<(), String> {
    let pool = state.get_pool().await?;

    sqlx::query("DELETE FROM focus_sessions")
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("DELETE FROM page_schedules")
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("DELETE FROM page_recurrence_rules")
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("DELETE FROM pages")
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("DELETE FROM folders")
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Copy the live database to ~/Downloads/pikos-backup-<timestamp>.sqlite.
/// Uses SQLite's VACUUM INTO so the copy is clean (no separate WAL file needed).
#[tauri::command]
pub async fn backup_db(state: tauri::State<'_, DbState>) -> Result<String, String> {
    let pool = state.get_pool().await?;

    let home = std::env::var("HOME").map_err(|e| format!("$HOME not set: {e}"))?;
    let timestamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S");
    let dest = format!("{}/Downloads/pikos-backup-{}.sqlite", home, timestamp);

    // VACUUM INTO creates a defragmented single-file copy while the DB stays open.
    let sql = format!("VACUUM INTO '{}'", dest.replace('\'', "''"));
    sqlx::query(&sql)
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(dest)
}

/// Run a seed scenario against the given DB path.
/// Shells out to `pnpm seed <scenario> <db_path>` from the repo root.
/// Only works in a development checkout — prod builds won't have the scripts directory.
#[tauri::command]
pub async fn run_seed(scenario: String, db_path: String) -> Result<String, String> {
    // CARGO_MANIFEST_DIR = apps/desktop/src-tauri/ at compile time
    let repo_root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../");

    let output = std::process::Command::new("pnpm")
        .arg("seed")
        .arg(&scenario)
        .arg(&db_path)
        .arg("--force")
        .current_dir(repo_root)
        .output()
        .map_err(|e| format!("Failed to launch seed process: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(if stdout.is_empty() { "Done.".to_string() } else { stdout })
    } else {
        Err(if stderr.is_empty() { "Seed process failed with no output.".to_string() } else { stderr })
    }
}
