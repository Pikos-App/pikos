//! Developer/settings commands: stats, reset, export, seed helpers.

use serde::{Deserialize, Serialize};
use sqlx::{Column, Row};
use tauri::Manager;

use crate::db::DbState;
use crate::error::{AppError, AppResult};
use crate::markdown::prosemirror_to_markdown;

// ── Rich usage stats ─────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct StatusCount {
    pub status: String,
    pub count: i64,
}

#[derive(Serialize)]
pub struct WeekActivity {
    /// ISO week label, e.g. "Mar 24"
    pub week: String,
    pub created: i64,
    pub edited: i64,
    pub completed: i64,
}

#[derive(Serialize)]
pub struct UsageStats {
    // Totals
    pub total_pages: i64,
    pub total_folders: i64,
    pub total_schedules: i64,
    pub total_focus_sessions: i64,
    pub total_focus_minutes: i64,
    pub total_completed: i64,
    pub total_words: i64,

    // Pages by status
    pub pages_by_status: Vec<StatusCount>,

    // Weekly activity (last 12 weeks)
    pub weekly_activity: Vec<WeekActivity>,

    // Feature adoption
    pub has_folders: bool,
    pub has_schedules: bool,
    pub has_recurring: bool,
    pub has_focus_sessions: bool,
    pub has_subtasks: bool,
    pub has_tags: bool,
    pub has_priorities: bool,

    // Milestones
    pub first_page_date: Option<String>,
}

/// Rich usage stats for the Settings > Data panel. All queries are local — no telemetry.
///
/// Perf note: this fans out into ~14 sequential queries on every Settings open.
/// Acceptable for now (Settings is rarely open and the DB is local), but a
/// single CTE-based query would be the obvious next step if this ever shows
/// up in a profile.
#[tauri::command]
pub async fn get_usage_stats(state: tauri::State<'_, DbState>) -> AppResult<UsageStats> {
    let pool = state.get_pool().await?;
    get_usage_stats_impl(&pool).await
}

pub(crate) async fn get_usage_stats_impl(pool: &sqlx::SqlitePool) -> AppResult<UsageStats> {
    // ── Totals ────────────────────────────────────────────────────────────────
    let total_pages: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL")
            .fetch_one(pool)
            .await?;

    let total_folders: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM folders WHERE deleted_at IS NULL")
            .fetch_one(pool)
            .await?;

    let total_schedules: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM page_schedules")
        .fetch_one(pool)
        .await?;

    let total_focus_sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM focus_sessions")
        .fetch_one(pool)
        .await?;

    let total_focus_minutes: i64 =
        sqlx::query_scalar("SELECT COALESCE(SUM(duration_s), 0) / 60 FROM focus_sessions")
            .fetch_one(pool)
            .await?;

    let total_completed: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL AND status = 'done'",
    )
    .fetch_one(pool)
    .await?;

    // Word count: sum of words in content_text across all pages
    let total_words: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(LENGTH(content_text) - LENGTH(REPLACE(content_text, ' ', '')) + 1), 0) \
         FROM pages WHERE deleted_at IS NULL AND content_text != ''"
    ).fetch_one(pool).await?;

    // ── Pages by status ───────────────────────────────────────────────────────
    let status_rows = sqlx::query(
        "SELECT status, COUNT(*) as count FROM pages WHERE deleted_at IS NULL GROUP BY status ORDER BY count DESC"
    ).fetch_all(pool).await?;

    let pages_by_status: Vec<StatusCount> = status_rows
        .iter()
        .map(|row| StatusCount {
            status: row.try_get::<String, _>("status").unwrap_or_default(),
            count: row.try_get::<i64, _>("count").unwrap_or(0),
        })
        .collect();

    // ── Weekly activity (last 12 weeks) ───────────────────────────────────────
    // Tracks pages created, pages edited (updated_at != created_at), and pages completed per week.
    let week_rows = sqlx::query(
        "WITH RECURSIVE weeks(n) AS ( \
           SELECT 0 UNION ALL SELECT n+1 FROM weeks WHERE n < 11 \
         ), \
         week_starts AS ( \
           SELECT date('now', '-' || (n * 7) || ' days', 'weekday 1', '-7 days') AS week_start \
           FROM weeks \
         ) \
         SELECT \
           ws.week_start, \
           COALESCE(cr.created, 0) AS created, \
           COALESCE(ed.edited, 0) AS edited, \
           COALESCE(co.completed, 0) AS completed \
         FROM week_starts ws \
         LEFT JOIN ( \
           SELECT date(created_at, 'weekday 1', '-7 days') AS w, COUNT(*) AS created \
           FROM pages WHERE deleted_at IS NULL \
           GROUP BY w \
         ) cr ON cr.w = ws.week_start \
         LEFT JOIN ( \
           SELECT date(updated_at, 'weekday 1', '-7 days') AS w, COUNT(*) AS edited \
           FROM pages WHERE deleted_at IS NULL AND updated_at != created_at \
           GROUP BY w \
         ) ed ON ed.w = ws.week_start \
         LEFT JOIN ( \
           SELECT date(completed_at, 'weekday 1', '-7 days') AS w, COUNT(*) AS completed \
           FROM pages WHERE deleted_at IS NULL AND completed_at IS NOT NULL \
           GROUP BY w \
         ) co ON co.w = ws.week_start \
         ORDER BY ws.week_start ASC",
    )
    .fetch_all(pool)
    .await?;

    let weekly_activity: Vec<WeekActivity> = week_rows
        .iter()
        .map(|row| {
            let week_start: String = row.try_get("week_start").unwrap_or_default();
            // Format "2026-03-23" → "Mar 23"
            let label = if week_start.len() >= 10 {
                let month = match &week_start[5..7] {
                    "01" => "Jan",
                    "02" => "Feb",
                    "03" => "Mar",
                    "04" => "Apr",
                    "05" => "May",
                    "06" => "Jun",
                    "07" => "Jul",
                    "08" => "Aug",
                    "09" => "Sep",
                    "10" => "Oct",
                    "11" => "Nov",
                    "12" => "Dec",
                    _ => "???",
                };
                let day = &week_start[8..10];
                format!("{} {}", month, day)
            } else {
                week_start
            };
            WeekActivity {
                week: label,
                created: row.try_get("created").unwrap_or(0),
                edited: row.try_get("edited").unwrap_or(0),
                completed: row.try_get("completed").unwrap_or(0),
            }
        })
        .collect();

    // ── Feature adoption ──────────────────────────────────────────────────────
    let has_folders = total_folders > 0;
    let has_schedules = total_schedules > 0;

    let has_recurring: bool =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM page_recurrence_rules")
            .fetch_one(pool)
            .await?
            > 0;

    let has_focus_sessions = total_focus_sessions > 0;

    let has_subtasks: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pages WHERE parent_id IS NOT NULL AND deleted_at IS NULL",
    )
    .fetch_one(pool)
    .await?
        > 0;

    let has_tags: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL AND tags != '[]' AND tags != ''",
    )
    .fetch_one(pool)
    .await?
        > 0;

    let has_priorities: bool = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL AND priority != 0",
    )
    .fetch_one(pool)
    .await?
        > 0;

    // ── Milestones ────────────────────────────────────────────────────────────
    let first_page_date: Option<String> =
        sqlx::query_scalar("SELECT MIN(created_at) FROM pages WHERE deleted_at IS NULL")
            .fetch_one(pool)
            .await?;

    Ok(UsageStats {
        total_pages,
        total_folders,
        total_schedules,
        total_focus_sessions,
        total_focus_minutes,
        total_completed,
        total_words,
        pages_by_status,
        weekly_activity,
        has_folders,
        has_schedules,
        has_recurring,
        has_focus_sessions,
        has_subtasks,
        has_tags,
        has_priorities,
        first_page_date,
    })
}

/// Delete all user data from the workspace (keeps the DB file and schema).
/// FK order: focus_sessions → page_schedules → page_recurrence_rules → pages → folders
#[tauri::command]
pub async fn reset_db(state: tauri::State<'_, DbState>) -> AppResult<()> {
    let pool = state.get_pool().await?;
    reset_db_impl(&pool).await
}

pub(crate) async fn reset_db_impl(pool: &sqlx::SqlitePool) -> AppResult<()> {
    let sessions = sqlx::query("DELETE FROM focus_sessions")
        .execute(pool)
        .await?
        .rows_affected();

    let schedules = sqlx::query("DELETE FROM page_schedules")
        .execute(pool)
        .await?
        .rows_affected();

    let rules = sqlx::query("DELETE FROM page_recurrence_rules")
        .execute(pool)
        .await?
        .rows_affected();

    let pages = sqlx::query("DELETE FROM pages")
        .execute(pool)
        .await?
        .rows_affected();

    let folders = sqlx::query("DELETE FROM folders")
        .execute(pool)
        .await?
        .rows_affected();

    log::info!(
        "reset_db pages={pages} folders={folders} schedules={schedules} \
         rules={rules} sessions={sessions}"
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

/// Export all user data as a JSON file to ~/Downloads/.
/// Includes folders, pages (excluding soft-deleted), schedules, recurrence rules,
/// and focus sessions. Page content is included as both ProseMirror JSON and plain text.
#[tauri::command]
pub async fn export_json(state: tauri::State<'_, DbState>) -> AppResult<String> {
    let pool = state.get_pool().await?;

    let export = build_export_json_impl(&pool).await?;
    let pages_len = export["pages"].as_array().map_or(0, |a| a.len());
    let folders_len = export["folders"].as_array().map_or(0, |a| a.len());

    let home =
        std::env::var("HOME").map_err(|e| AppError::Internal(format!("$HOME not set: {e}")))?;
    let timestamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S");
    let dest = format!("{home}/Downloads/pikos-export-{timestamp}.json");

    let json_str = serde_json::to_string_pretty(&export)?;
    std::fs::write(&dest, json_str)?;

    log::info!(
        "export_json pages={pages_len} folders={folders_len} dest={}",
        dest.replacen(&home, "~", 1)
    );
    Ok(dest)
}

/// Build the full export object (every table as an array of dynamic-column
/// objects, plus referenced asset paths). Split from `export_json` so the
/// data shape is testable without touching the filesystem.
pub(crate) async fn build_export_json_impl(
    pool: &sqlx::SqlitePool,
) -> AppResult<serde_json::Value> {
    let folders = sqlx::query("SELECT * FROM folders ORDER BY sort_order")
        .fetch_all(pool)
        .await?;

    let pages = sqlx::query("SELECT * FROM pages WHERE deleted_at IS NULL ORDER BY sort_order")
        .fetch_all(pool)
        .await?;

    let schedules = sqlx::query("SELECT * FROM page_schedules ORDER BY scheduled_start")
        .fetch_all(pool)
        .await?;

    let rules = sqlx::query("SELECT * FROM page_recurrence_rules")
        .fetch_all(pool)
        .await?;

    let sessions = sqlx::query("SELECT * FROM focus_sessions ORDER BY started_at")
        .fetch_all(pool)
        .await?;

    let to_json = |rows: Vec<sqlx::sqlite::SqliteRow>| -> Vec<serde_json::Value> {
        rows.into_iter()
            .map(|row| {
                let mut obj = serde_json::Map::new();
                for col in row.columns() {
                    let name = col.name();
                    let val: serde_json::Value = if let Ok(v) = row.try_get::<String, _>(name) {
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

    let mut asset_paths: Vec<String> = Vec::new();
    for row in &pages {
        if let Ok(content) = row.try_get::<String, _>("content") {
            if let Ok(doc) = serde_json::from_str::<serde_json::Value>(&content) {
                collect_asset_paths(&doc, &mut asset_paths);
            }
        }
    }
    asset_paths.sort();
    asset_paths.dedup();

    Ok(serde_json::json!({
        "version": 1,
        "exported_at": chrono::Utc::now().to_rfc3339(),
        "folders": to_json(folders),
        "pages": to_json(pages),
        "schedules": to_json(schedules),
        "recurrence_rules": to_json(rules),
        "focus_sessions": to_json(sessions),
        "assets": asset_paths,
    }))
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
/// the DB stays open. The single-quote escaping guards the literal SQL (SQLite
/// rejects a bound parameter for VACUUM INTO's target).
pub(crate) async fn vacuum_into(pool: &sqlx::SqlitePool, dest: &str) -> AppResult<()> {
    let sql = format!("VACUUM INTO '{}'", dest.replace('\'', "''"));
    sqlx::query(&sql).execute(pool).await?;
    Ok(())
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

/// Collect absolute asset paths from image nodes in ProseMirror JSON.
fn collect_asset_paths(node: &serde_json::Value, paths: &mut Vec<String>) {
    let node_type = node.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if node_type == "image" {
        if let Some(path) = node
            .get("attrs")
            .and_then(|a| a.get("data-asset-path"))
            .and_then(|p| p.as_str())
        {
            if !path.is_empty() {
                paths.push(path.to_string());
            }
        }
    }
    if let Some(content) = node.get("content").and_then(|c| c.as_array()) {
        for child in content {
            collect_asset_paths(child, paths);
        }
    }
}

/// Export all pages as Markdown files to ~/Downloads/pikos-markdown-<timestamp>/.
/// Each page becomes a .md file with YAML frontmatter (title, status, priority, tags,
/// scheduled dates). Folder structure is preserved as subdirectories.
/// Images are copied into an assets/ subdirectory with references rewritten.
#[tauri::command]
pub async fn export_markdown(state: tauri::State<'_, DbState>) -> AppResult<String> {
    let pool = state.get_pool().await?;

    let folders =
        sqlx::query_as::<_, (String, String)>("SELECT id, name FROM folders ORDER BY sort_order")
            .fetch_all(&pool)
            .await?;

    let folder_names: std::collections::HashMap<String, String> = folders.into_iter().collect();

    let pages = sqlx::query(
        "SELECT id, folder_id, title, content, status, priority, tags, \
         scheduled_start, scheduled_end, created_at, updated_at \
         FROM pages WHERE deleted_at IS NULL ORDER BY sort_order",
    )
    .fetch_all(&pool)
    .await?;

    let home =
        std::env::var("HOME").map_err(|e| AppError::Internal(format!("$HOME not set: {e}")))?;
    let timestamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S");
    let base_dir = format!("{home}/Downloads/pikos-markdown-{timestamp}");

    std::fs::create_dir_all(&base_dir)?;

    // Track copied assets to avoid duplicates (absolute source → relative export path)
    let mut copied_assets: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let mut assets_dir_created = false;

    for row in &pages {
        let title: String = row.try_get("title").unwrap_or_default();
        let content: String = row.try_get("content").unwrap_or_default();
        let status: String = row.try_get("status").unwrap_or_default();
        let priority: i64 = row.try_get("priority").unwrap_or(0);
        let tags: String = row.try_get("tags").unwrap_or_else(|_| "[]".to_string());
        let scheduled_start: Option<String> = row.try_get("scheduled_start").ok();
        let scheduled_end: Option<String> = row.try_get("scheduled_end").ok();
        let created_at: String = row.try_get("created_at").unwrap_or_default();
        let updated_at: String = row.try_get("updated_at").unwrap_or_default();
        let folder_id: Option<String> = row.try_get("folder_id").ok();

        // Collect and copy image assets from the page content
        if !content.is_empty() && content != "{}" {
            if let Ok(doc) = serde_json::from_str::<serde_json::Value>(&content) {
                let mut asset_paths = Vec::new();
                collect_asset_paths(&doc, &mut asset_paths);

                for abs_path in &asset_paths {
                    if copied_assets.contains_key(abs_path) {
                        continue;
                    }
                    let source = std::path::Path::new(abs_path);
                    if !source.exists() {
                        continue;
                    }

                    if !assets_dir_created {
                        let dir = format!("{base_dir}/assets");
                        std::fs::create_dir_all(&dir)?;
                        assets_dir_created = true;
                    }

                    let filename = source
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("asset.bin");
                    let dest = format!("{}/assets/{}", base_dir, filename);
                    let relative = format!("assets/{}", filename);

                    if let Err(e) = std::fs::copy(source, &dest) {
                        // abs_path is a user asset path — log only the io::ErrorKind, not the path.
                        log::warn!("export_markdown_copy_asset_failed kind={:?}", e.kind());
                        continue;
                    }
                    copied_assets.insert(abs_path.to_string(), relative);
                }
            }
        }

        let out_dir = match folder_id.as_deref() {
            Some(folder_id) => {
                let folder_name = folder_names
                    .get(folder_id)
                    .map(|n| sanitize_filename(n))
                    .unwrap_or_else(|| "Uncategorized".to_string());
                let dir = format!("{base_dir}/{folder_name}");
                std::fs::create_dir_all(&dir)?;
                dir
            }
            None => base_dir.clone(),
        };

        let filename = if title.is_empty() {
            "Untitled".to_string()
        } else {
            sanitize_filename(&title)
        };
        let filepath = format!("{}/{}.md", out_dir, filename);

        let frontmatter = build_frontmatter(
            &title,
            &status,
            priority,
            &tags,
            scheduled_start.as_deref(),
            scheduled_end.as_deref(),
            &created_at,
            &updated_at,
        );

        let mut body = markdown_body(&content);

        // Rewrite absolute asset paths to relative export paths in the markdown body.
        // The relative path depends on whether the page is in a subfolder:
        // - Root pages: assets/uuid.png
        // - Subfolder pages: ../assets/uuid.png
        let in_subfolder = folder_id.is_some();
        for (abs_path, rel_path) in &copied_assets {
            let export_ref = if in_subfolder {
                format!("../{}", rel_path)
            } else {
                rel_path.clone()
            };
            body = body.replace(abs_path, &export_ref);
        }

        let full = format!("{frontmatter}{body}");
        std::fs::write(&filepath, full)?;
    }

    log::info!(
        "export_markdown pages={} assets={} dest={}",
        pages.len(),
        copied_assets.len(),
        base_dir.replacen(&home, "~", 1)
    );
    Ok(base_dir)
}

/// Export all pages as a CSV file to ~/Downloads/.
/// Columns match what the CSV importer expects so the output can be re-imported.
/// Rich text content is exported as plain text (content_text).
#[tauri::command]
pub async fn export_csv(state: tauri::State<'_, DbState>) -> AppResult<String> {
    let pool = state.get_pool().await?;
    let out = build_export_csv_impl(&pool).await?;

    let home =
        std::env::var("HOME").map_err(|e| AppError::Internal(format!("$HOME not set: {e}")))?;
    let timestamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S");
    let dest = format!("{home}/Downloads/pikos-export-{timestamp}.csv");

    let row_count = out.lines().count().saturating_sub(1);
    std::fs::write(&dest, out)?;

    log::info!(
        "export_csv pages={} dest={}",
        row_count,
        dest.replacen(&home, "~", 1)
    );
    Ok(dest)
}

/// Build the CSV body (header + one row per non-deleted page). Split from
/// `export_csv` so the escaping and column order are testable without writing
/// to disk. Column names match the CSV importer's header heuristics so the
/// output round-trips back through import.
pub(crate) async fn build_export_csv_impl(pool: &sqlx::SqlitePool) -> AppResult<String> {
    let folders =
        sqlx::query_as::<_, (String, String)>("SELECT id, name FROM folders ORDER BY sort_order")
            .fetch_all(pool)
            .await?;

    let folder_names: std::collections::HashMap<String, String> = folders.into_iter().collect();

    let pages = sqlx::query(
        "SELECT id, folder_id, title, content_text, status, priority, tags, \
         scheduled_start, scheduled_end, created_at, updated_at, completed_at \
         FROM pages WHERE deleted_at IS NULL ORDER BY sort_order",
    )
    .fetch_all(pool)
    .await?;

    let mut out = String::new();

    out.push_str("Title,Content,Folder,Status,Priority,Tags,Start Date,End Date,Created At,Updated At,Completed At\n");

    for row in &pages {
        let title: String = row.try_get("title").unwrap_or_default();
        let content_text: String = row.try_get("content_text").unwrap_or_default();
        let status: String = row.try_get("status").unwrap_or_default();
        let priority: i64 = row.try_get("priority").unwrap_or(0);
        let tags: String = row.try_get("tags").unwrap_or_else(|_| "[]".to_string());
        let scheduled_start: Option<String> = row.try_get("scheduled_start").ok();
        let scheduled_end: Option<String> = row.try_get("scheduled_end").ok();
        let created_at: String = row.try_get("created_at").unwrap_or_default();
        let updated_at: String = row.try_get("updated_at").unwrap_or_default();
        let completed_at: Option<String> = row.try_get("completed_at").ok();
        let folder_id: Option<String> = row.try_get("folder_id").ok();

        let folder_name = folder_id
            .as_deref()
            .and_then(|fid| folder_names.get(fid))
            .cloned()
            .unwrap_or_default();

        let tag_str = if let Ok(tag_list) = serde_json::from_str::<Vec<String>>(&tags) {
            tag_list.join(", ")
        } else {
            String::new()
        };

        fn csv_field(s: &str) -> String {
            if s.contains(',') || s.contains('\n') || s.contains('"') {
                format!("\"{}\"", s.replace('"', "\"\""))
            } else {
                s.to_string()
            }
        }

        out.push_str(&csv_field(&title));
        out.push(',');
        out.push_str(&csv_field(&content_text));
        out.push(',');
        out.push_str(&csv_field(&folder_name));
        out.push(',');
        out.push_str(&csv_field(&status));
        out.push(',');
        out.push_str(&priority.to_string());
        out.push(',');
        out.push_str(&csv_field(&tag_str));
        out.push(',');
        out.push_str(&csv_field(scheduled_start.as_deref().unwrap_or("")));
        out.push(',');
        out.push_str(&csv_field(scheduled_end.as_deref().unwrap_or("")));
        out.push(',');
        out.push_str(&csv_field(&created_at));
        out.push(',');
        out.push_str(&csv_field(&updated_at));
        out.push(',');
        out.push_str(&csv_field(completed_at.as_deref().unwrap_or("")));
        out.push('\n');
    }

    Ok(out)
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

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect::<String>()
        .trim()
        .to_string()
}

/// Build a Markdown page's YAML frontmatter block. Default status
/// (`not_started`) and zero priority are omitted; tags come from a JSON array
/// string; `"` is escaped in quoted values. Always ends with the `---\n\n`
/// separator so the caller can concatenate the body directly.
#[allow(clippy::too_many_arguments)]
fn build_frontmatter(
    title: &str,
    status: &str,
    priority: i64,
    tags: &str,
    scheduled_start: Option<&str>,
    scheduled_end: Option<&str>,
    created_at: &str,
    updated_at: &str,
) -> String {
    let mut frontmatter = String::from("---\n");
    frontmatter.push_str(&format!("title: \"{}\"\n", title.replace('"', "\\\"")));
    if status != "not_started" {
        frontmatter.push_str(&format!("status: {}\n", status));
    }
    if priority != 0 {
        frontmatter.push_str(&format!("priority: {}\n", priority));
    }
    if let Ok(tag_list) = serde_json::from_str::<Vec<String>>(tags) {
        if !tag_list.is_empty() {
            frontmatter.push_str("tags:\n");
            for tag in &tag_list {
                frontmatter.push_str(&format!("  - \"{}\"\n", tag.replace('"', "\\\"")));
            }
        }
    }
    if let Some(start) = scheduled_start {
        frontmatter.push_str(&format!("scheduled_start: \"{}\"\n", start));
    }
    if let Some(end) = scheduled_end {
        frontmatter.push_str(&format!("scheduled_end: \"{}\"\n", end));
    }
    frontmatter.push_str(&format!("created: \"{}\"\n", created_at));
    frontmatter.push_str(&format!("updated: \"{}\"\n", updated_at));
    frontmatter.push_str("---\n\n");
    frontmatter
}

/// Convert a page's stored ProseMirror JSON `content` to a Markdown body.
/// Empty (`""`), empty-doc (`"{}"`), and unparseable content all yield an
/// empty string so a page always produces a valid (frontmatter-only) file.
fn markdown_body(content: &str) -> String {
    if content.is_empty() || content == "{}" {
        return String::new();
    }
    match serde_json::from_str::<serde_json::Value>(content) {
        Ok(doc) => prosemirror_to_markdown(&doc),
        Err(_) => String::new(),
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
