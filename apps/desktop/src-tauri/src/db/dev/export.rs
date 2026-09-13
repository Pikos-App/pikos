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

use sqlx::{Column, Row};

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

/// Collect absolute asset paths from image nodes in ProseMirror JSON.
/// `~/Downloads/pikos-<suffix>`, with the timestamp every export shares.
fn download_path(suffix: &str) -> AppResult<(String, String)> {
    let home =
        std::env::var("HOME").map_err(|e| AppError::Internal(format!("$HOME not set: {e}")))?;
    let timestamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S");
    Ok((format!("{home}/Downloads/pikos-{suffix}-{timestamp}"), home))
}

/// Export all pages as Markdown files to ~/Downloads/pikos-markdown-<timestamp>/.
/// Each page becomes a .md file with YAML frontmatter (title, status, priority,
/// tags, scheduled dates). Folder structure is preserved as subdirectories.
/// Images are copied into an assets/ subdirectory with references rewritten.
#[tauri::command]
pub async fn export_markdown(
    state: tauri::State<'_, DbState>,
    include_synced: bool,
) -> AppResult<String> {
    let pool = state.get_pool().await?;
    let plan = pikos_db::export::plan_markdown_export(&pool, include_synced).await?;

    let (base_dir, home) = download_path("markdown")?;
    std::fs::create_dir_all(&base_dir)?;

    // Absolute source → path relative to the export root, for assets that
    // actually arrived. A page whose asset did not copy keeps its original
    // reference rather than pointing at a file that is not there.
    let mut copied: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut assets_dir_created = false;

    for page in &plan {
        for source_path in &page.assets {
            if copied.contains_key(source_path) {
                continue;
            }
            let source = std::path::Path::new(source_path);
            if !source.exists() {
                continue;
            }
            if !assets_dir_created {
                std::fs::create_dir_all(format!("{base_dir}/assets"))?;
                assets_dir_created = true;
            }
            let filename = source
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("asset.bin");
            if let Err(e) = std::fs::copy(source, format!("{base_dir}/assets/{filename}")) {
                // source_path is a user asset path — log only the io::ErrorKind, not the path.
                log::warn!("export_markdown_copy_asset_failed kind={:?}", e.kind());
                continue;
            }
            copied.insert(source_path.clone(), format!("assets/{filename}"));
        }

        let destination = format!("{base_dir}/{}", page.path);
        if let Some(parent) = std::path::Path::new(&destination).parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(
            &destination,
            pikos_db::export::render_markdown_page(page, &copied),
        )?;
    }

    log::info!(
        "export_markdown pages={} assets={} dest={}",
        plan.len(),
        copied.len(),
        base_dir.replacen(&home, "~", 1)
    );
    Ok(base_dir)
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
    let out = pikos_db::export::build_export_csv(&pool, include_synced).await?;

    let (base, home) = download_path("export")?;
    let dest = format!("{base}.csv");
    let row_count = out.lines().count().saturating_sub(1);
    std::fs::write(&dest, out)?;

    log::info!(
        "export_csv pages={} dest={}",
        row_count,
        dest.replacen(&home, "~", 1)
    );
    Ok(dest)
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

    let (base, home) = download_path("export")?;
    let dest = format!("{base}.ics");
    let event_count = out.matches("BEGIN:VEVENT").count();
    std::fs::write(&dest, out)?;

    log::info!(
        "export_ics events={} dest={}",
        event_count,
        dest.replacen(&home, "~", 1)
    );
    Ok(dest)
}
