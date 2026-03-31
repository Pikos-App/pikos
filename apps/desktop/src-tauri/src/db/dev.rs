// dev.rs — Developer/settings commands: stats, reset, seed, export.

use serde::Serialize;
use sqlx::{Column, Row};

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

/// Export all user data as a JSON file to ~/Downloads/.
/// Includes folders, pages (excluding soft-deleted), schedules, recurrence rules,
/// and focus sessions. Page content is included as both ProseMirror JSON and plain text.
#[tauri::command]
pub async fn export_json(state: tauri::State<'_, DbState>) -> Result<String, String> {
    let pool = state.get_pool().await?;

    let folders = sqlx::query("SELECT * FROM folders ORDER BY sort_order")
        .fetch_all(&pool)
        .await
        .map_err(|e| e.to_string())?;

    let pages = sqlx::query("SELECT * FROM pages WHERE deleted_at IS NULL ORDER BY sort_order")
        .fetch_all(&pool)
        .await
        .map_err(|e| e.to_string())?;

    let schedules = sqlx::query("SELECT * FROM page_schedules ORDER BY scheduled_start")
        .fetch_all(&pool)
        .await
        .map_err(|e| e.to_string())?;

    let rules = sqlx::query("SELECT * FROM page_recurrence_rules")
        .fetch_all(&pool)
        .await
        .map_err(|e| e.to_string())?;

    let sessions = sqlx::query("SELECT * FROM focus_sessions ORDER BY started_at")
        .fetch_all(&pool)
        .await
        .map_err(|e| e.to_string())?;

    // Build JSON using serde_json::Value to handle dynamic columns
    let to_json = |rows: Vec<sqlx::sqlite::SqliteRow>| -> Vec<serde_json::Value> {
        rows.into_iter()
            .map(|row| {
                let mut obj = serde_json::Map::new();
                for col in row.columns() {
                    let name = col.name();
                    // Try text first, then integer, then null
                    let val: serde_json::Value =
                        if let Ok(v) = row.try_get::<String, _>(name) {
                            // Parse JSON fields inline (content, tags, links, rrule_exdates)
                            if matches!(name, "content" | "tags" | "links" | "rrule_exdates") {
                                serde_json::from_str(&v).unwrap_or(serde_json::Value::String(v))
                            } else {
                                serde_json::Value::String(v)
                            }
                        } else if let Ok(v) = row.try_get::<i64, _>(name) {
                            serde_json::Value::Number(v.into())
                        } else {
                            serde_json::Value::Null
                        };
                    obj.insert(name.to_string(), val);
                }
                serde_json::Value::Object(obj)
            })
            .collect()
    };

    let export = serde_json::json!({
        "version": 1,
        "exported_at": chrono::Utc::now().to_rfc3339(),
        "folders": to_json(folders),
        "pages": to_json(pages),
        "schedules": to_json(schedules),
        "recurrence_rules": to_json(rules),
        "focus_sessions": to_json(sessions),
    });

    let home = std::env::var("HOME").map_err(|e| format!("$HOME not set: {e}"))?;
    let timestamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S");
    let dest = format!("{}/Downloads/pikos-export-{}.json", home, timestamp);

    let json_str = serde_json::to_string_pretty(&export).map_err(|e| e.to_string())?;
    std::fs::write(&dest, json_str).map_err(|e| e.to_string())?;

    Ok(dest)
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

