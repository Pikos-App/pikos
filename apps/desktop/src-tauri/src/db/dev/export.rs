//! The desktop half of the exports: where a file goes.
//!
//! What is exported (the ownership predicate, CSV columns, Markdown frontmatter, the `.ics`)
//! lives in `pikos_db::export`, shared with the phone. This file holds only a path under
//! `~/Downloads` and a timestamped name.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use sqlx::{Column, Row};
use tauri::Manager;

use crate::db::DbState;
use crate::error::{AppError, AppResult};
use pikos_db::export::collect_asset_paths;
pub(crate) use pikos_db::export::write_markdown_export;

/// Build the full export object: every table as an array of dynamic-column
/// objects, plus the asset paths its pages reference. Includes folders, pages
/// (excluding soft-deleted), schedules, recurrence rules and focus sessions;
/// page content is carried as both ProseMirror JSON and plain text.
///
/// No command wraps this: the JSON snapshot isn't offered in the UI. It stays as the shape the
/// export and re-import round-trip tests assert against.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) async fn build_export_json_impl(
    pool: &sqlx::SqlitePool,
) -> AppResult<serde_json::Value> {
    let folders = sqlx::query("SELECT * FROM folders ORDER BY sort_order")
        .fetch_all(pool)
        .await?;

    let body = pikos_db::page_chunks::body_sql("pages.id");
    // sql-ok: body_sql is built from a compile-time constant
    let pages = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT *, {body} AS body FROM pages WHERE deleted_at IS NULL ORDER BY sort_order"
    )))
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
                    let key = match name {
                        "body" => "content",
                        _ => name,
                    };
                    let val: serde_json::Value = if let Ok(v) = row.try_get::<String, _>(name) {
                        if matches!(key, "content" | "tags" | "links" | "rrule_exdates") {
                            serde_json::from_str(&v).unwrap_or(serde_json::Value::String(v))
                        } else {
                            serde_json::Value::String(v)
                        }
                    } else if let Ok(v) = row.try_get::<i64, _>(name) {
                        serde_json::Value::Number(v.into())
                    } else {
                        serde_json::Value::Null
                    };
                    obj.insert(key.to_string(), val);
                }
                serde_json::Value::Object(obj)
            })
            .collect()
    };

    let mut asset_paths: Vec<String> = Vec::new();
    for row in &pages {
        if let Ok(content) = row.try_get::<String, _>("body") {
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

/// `<stem>-<UTC timestamp>.<ext>`, the name a one-file export is saved under.
pub(crate) fn stamped_file_name(stem: &str, ext: &str) -> String {
    format!(
        "{stem}-{}.{ext}",
        chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S")
    )
}

fn home_dir() -> AppResult<String> {
    std::env::var("HOME").map_err(|e| AppError::Internal(format!("$HOME not set: {e}")))
}

/// Export all pages as Markdown files to ~/Downloads/pikos-markdown-<timestamp>/.
/// Folders become subdirectories and images are copied into `assets/`. Returns the directory.
#[tauri::command]
pub async fn export_markdown<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, DbState>,
    include_synced: bool,
) -> AppResult<String> {
    let pool = state.get_pool().await?;
    let assets_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(format!("Failed to get app data dir: {e}")))?
        .join(crate::db::assets::ASSET_DIR);

    let home = home_dir()?;
    let timestamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S");
    let base_dir = format!("{home}/Downloads/pikos-markdown-{timestamp}");

    let (pages, assets) =
        write_markdown_export(&pool, Path::new(&base_dir), &assets_dir, include_synced).await?;

    log::info!(
        "export_markdown pages={pages} assets={assets} dest={}",
        base_dir.replacen(&home, "~", 1)
    );
    Ok(base_dir)
}

/// Export one page as Markdown to ~/Downloads, for sharing it on its own.
/// Returns the `.md` file's path.
#[tauri::command]
pub async fn export_page_markdown<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, DbState>,
    page_id: String,
) -> AppResult<String> {
    let pool = state.get_pool().await?;
    let assets_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(format!("Failed to get app data dir: {e}")))?
        .join(crate::db::assets::ASSET_DIR);
    let home = home_dir()?;

    let dest = write_page_markdown(
        &pool,
        &page_id,
        &Path::new(&home).join("Downloads"),
        &assets_dir,
    )
    .await?;

    let dest = dest.to_string_lossy().to_string();
    log::info!("export_page_markdown dest={}", dest.replacen(&home, "~", 1));
    Ok(dest)
}

/// One page written into `dir`.
///
/// A page with no images is a lone `<title>.md`, the file a chat app takes. One
/// with images needs them beside it, so it becomes a `<title>/` directory holding
/// the `.md` and an `assets/` folder, the workspace export's layout. Neither
/// replaces an earlier export of the same page: the name takes the first free
/// numeral, as Finder does.
pub(crate) async fn write_page_markdown(
    pool: &sqlx::SqlitePool,
    page_id: &str,
    dir: &Path,
    assets_dir: &Path,
) -> AppResult<PathBuf> {
    let page = pikos_db::export::plan_markdown_page(pool, page_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("page {page_id}")))?;
    let stem = page.path.trim_end_matches(".md");

    let has_images = page
        .assets
        .iter()
        .any(|stored| pikos_db::assets::resolve_asset_path(assets_dir, stored).exists());
    let (base_dir, file) = if has_images {
        let base_dir = unused_path(dir, stem, "");
        (base_dir.clone(), base_dir.join(&page.path))
    } else {
        (dir.to_path_buf(), unused_path(dir, stem, ".md"))
    };

    // Both paths carry the page's title, so the errors name the folder they sit in and the id.
    std::fs::create_dir_all(&base_dir).map_err(|e| {
        AppError::io_at(
            &format!("creating the folder for page {page_id} in"),
            dir,
            e,
        )
    })?;
    let mut copied = HashMap::new();
    pikos_db::export::copy_page_assets(&page, assets_dir, &base_dir, &mut copied)?;
    std::fs::write(
        &file,
        pikos_db::export::render_markdown_page(&page, &copied),
    )
    .map_err(|e| AppError::io_at(&format!("writing page {page_id} into"), dir, e))?;

    Ok(file)
}

/// `dir/<stem><ext>`, or `dir/<stem> 2<ext>` and up when that is taken.
fn unused_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{stem}{ext}"));
    if !first.exists() {
        return first;
    }

    (2..)
        .map(|n| dir.join(format!("{stem} {n}{ext}")))
        .find(|candidate| !candidate.exists())
        .expect("an unbounded range always finds a free name")
}

/// Export all pages as a CSV file to ~/Downloads/.
/// The columns are the ones the CSV importer reads, and rich text goes out as plain text.
#[tauri::command]
pub async fn export_csv(
    state: tauri::State<'_, DbState>,
    include_synced: bool,
) -> AppResult<String> {
    let pool = state.get_pool().await?;
    let home = home_dir()?;

    let (dest, row_count) =
        write_csv_export(&pool, &Path::new(&home).join("Downloads"), include_synced).await?;

    let dest = dest.to_string_lossy().to_string();
    log::info!(
        "export_csv pages={} dest={}",
        row_count,
        dest.replacen(&home, "~", 1)
    );
    Ok(dest)
}

/// The CSV export written into `dir`. Returns the file and how many pages it holds.
pub(crate) async fn write_csv_export(
    pool: &sqlx::SqlitePool,
    dir: &Path,
    include_synced: bool,
) -> AppResult<(std::path::PathBuf, usize)> {
    let out = pikos_db::export::build_export_csv(pool, include_synced).await?;
    let dest = dir.join(stamped_file_name("pikos-export", "csv"));
    let row_count = out.lines().count().saturating_sub(1);
    std::fs::write(&dest, out).map_err(|e| AppError::io_at("writing the CSV export", &dest, e))?;
    Ok((dest, row_count))
}

/// Export every scheduled page as one `.ics` file in ~/Downloads. Returns the file's path.
#[tauri::command]
pub async fn export_ics(
    state: tauri::State<'_, DbState>,
    include_synced: bool,
) -> AppResult<String> {
    let pool = state.get_pool().await?;
    let out = pikos_db::export_ics::build_export_ics(&pool, include_synced).await?;

    let home = home_dir()?;
    let dest = Path::new(&home)
        .join("Downloads")
        .join(stamped_file_name("pikos-export", "ics"));
    let event_count = out.matches("BEGIN:VEVENT").count();
    std::fs::write(&dest, out)
        .map_err(|e| AppError::io_at("writing the calendar export", &dest, e))?;

    let dest = dest.to_string_lossy().to_string();
    log::info!(
        "export_ics events={} dest={}",
        event_count,
        dest.replacen(&home, "~", 1)
    );
    Ok(dest)
}
