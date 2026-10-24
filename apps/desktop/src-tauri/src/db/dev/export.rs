//! The desktop half of the exports: where a file goes.
//!
//! Everything about *what* is exported — the ownership predicate, the CSV
//! columns, the Markdown frontmatter, the whole `.ics` — moved to
//! `pikos_db::export` when the phone needed it too. What stayed is the part
//! that is genuinely a desktop question: a path under `~/Downloads`, a
//! timestamped name, and copying a page's images out of the workspace.
//!
//! The JSON snapshot below has no command and no caller. It stays because it is
//! the shape the export → re-import round-trip tests assert against, and the
//! place to start from if a JSON export is ever offered again.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use sqlx::{Column, Row};
use tauri::Manager;

use crate::db::DbState;
use crate::error::{AppError, AppResult};
use pikos_db::export::collect_asset_paths;

/// Build the full export object: every table as an array of dynamic-column
/// objects, plus the asset paths its pages reference. Includes folders, pages
/// (excluding soft-deleted), schedules, recurrence rules and focus sessions;
/// page content is carried as both ProseMirror JSON and plain text.
///
/// No command wraps this — the JSON snapshot is not offered in the UI. It is
/// the shape the export → re-import round-trip tests assert against, and the
/// one place to start from if a JSON export is ever exposed again, which is
/// why it survives the removal of its command rather than being deleted with it.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) async fn build_export_json_impl(
    pool: &sqlx::SqlitePool,
) -> AppResult<serde_json::Value> {
    let folders = sqlx::query("SELECT * FROM folders ORDER BY sort_order")
        .fetch_all(pool)
        .await?;

    let body = pikos_db::page_chunks::body_sql("pages.id");
    // sql-ok: body_sql is built from a compile-time constant
    let pages = sqlx::query(&format!(
        "SELECT *, {body} AS body FROM pages WHERE deleted_at IS NULL ORDER BY sort_order"
    ))
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
                    // A page's stored body column gives way to the body every reader gets.
                    let key = match name {
                        "content" => continue,
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
/// Each page becomes a .md file with YAML frontmatter (title, status, priority,
/// tags, scheduled dates). Folder structure is preserved as subdirectories.
/// Images are copied into an assets/ subdirectory with references rewritten.
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

/// The Markdown export into `base_dir`, reading images from `assets_dir`, split from
/// [`export_markdown`] so it runs against a temp directory. Returns how many pages
/// and image files it wrote.
pub(crate) async fn write_markdown_export(
    pool: &sqlx::SqlitePool,
    base_dir: &Path,
    assets_dir: &Path,
    include_synced: bool,
) -> AppResult<(usize, usize)> {
    let plan = pikos_db::export::plan_markdown_export(pool, include_synced).await?;
    std::fs::create_dir_all(base_dir)?;

    let mut copied = HashMap::new();
    for page in &plan {
        copy_page_assets(page, assets_dir, base_dir, &mut copied)?;

        let destination = base_dir.join(&page.path);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(
            &destination,
            pikos_db::export::render_markdown_page(page, &copied),
        )?;
    }

    Ok((plan.len(), copied.len()))
}

/// Copy a page's images into `base_dir/assets/`, recording each that arrived in
/// `copied` as stored path → path relative to `base_dir`. A page whose asset did
/// not copy keeps its stored reference rather than pointing at a file that is
/// not there.
fn copy_page_assets(
    page: &pikos_db::export::MarkdownPage,
    assets_dir: &Path,
    base_dir: &Path,
    copied: &mut HashMap<String, String>,
) -> AppResult<()> {
    for stored in &page.assets {
        if copied.contains_key(stored) {
            continue;
        }

        let source = crate::db::assets::resolve_asset_path(assets_dir, stored);
        if !source.exists() {
            continue;
        }

        std::fs::create_dir_all(base_dir.join("assets"))?;
        let filename = source
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("asset.bin")
            .to_string();
        if let Err(e) = std::fs::copy(&source, base_dir.join("assets").join(&filename)) {
            // The source is a user asset path — log only the io::ErrorKind, not the path.
            log::warn!("export_markdown_copy_asset_failed kind={:?}", e.kind());
            continue;
        }
        copied.insert(stored.clone(), format!("assets/{filename}"));
    }

    Ok(())
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

/// One page written into `dir`, split from [`export_page_markdown`] so it runs
/// against a temp directory.
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
        .any(|stored| crate::db::assets::resolve_asset_path(assets_dir, stored).exists());
    let (base_dir, file) = if has_images {
        let base_dir = unused_path(dir, stem, "");
        (base_dir.clone(), base_dir.join(&page.path))
    } else {
        (dir.to_path_buf(), unused_path(dir, stem, ".md"))
    };

    std::fs::create_dir_all(&base_dir)?;
    let mut copied = HashMap::new();
    copy_page_assets(&page, assets_dir, &base_dir, &mut copied)?;
    std::fs::write(
        &file,
        pikos_db::export::render_markdown_page(&page, &copied),
    )?;

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
/// Columns match what the CSV importer expects so the output can be re-imported.
/// Rich text content is exported as plain text (content_text).
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

/// The CSV export written into `dir`, split from [`export_csv`] so it runs against a
/// temp directory. Returns the file and how many pages it holds.
pub(crate) async fn write_csv_export(
    pool: &sqlx::SqlitePool,
    dir: &Path,
    include_synced: bool,
) -> AppResult<(std::path::PathBuf, usize)> {
    let out = pikos_db::export::build_export_csv(pool, include_synced).await?;
    let dest = dir.join(stamped_file_name("pikos-export", "csv"));
    let row_count = out.lines().count().saturating_sub(1);
    std::fs::write(&dest, out)?;
    Ok((dest, row_count))
}

/// Export every scheduled page as one `.ics` file in ~/Downloads. Same
/// destination shape and same return value as the CSV export, so the settings
/// panel treats all three exports identically.
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
    std::fs::write(&dest, out)?;

    let dest = dest.to_string_lossy().to_string();
    log::info!(
        "export_ics events={} dest={}",
        event_count,
        dest.replacen(&home, "~", 1)
    );
    Ok(dest)
}
