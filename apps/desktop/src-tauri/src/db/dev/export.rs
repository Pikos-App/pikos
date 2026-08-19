//! Workspace exports: the full JSON snapshot, the Markdown tree, and the CSV
//! the importer can read back.

use sqlx::{Column, Row};

use crate::db::DbState;
use crate::error::{AppError, AppResult};
use crate::markdown::prosemirror_to_markdown;

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

/// Collect absolute asset paths from image nodes in ProseMirror JSON.
pub(super) fn collect_asset_paths(node: &serde_json::Value, paths: &mut Vec<String>) {
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

/// The pages a user-facing export ships. An un-actioned mirror is the calendar's
/// copy of an event and none of the user's work, so it stays out unless
/// `include_synced` asks for it; everything the user completed, edited or detached
/// exports either way. Shared by the Markdown and CSV exports so the two can't
/// drift on what counts as the user's own.
pub(super) async fn fetch_export_pages(
    pool: &sqlx::SqlitePool,
    columns: &str,
    include_synced: bool,
) -> AppResult<Vec<sqlx::sqlite::SqliteRow>> {
    let exclude_mirrors = if include_synced {
        String::new()
    } else {
        format!(" AND NOT {}", pikos_db::unactioned_mirror_sql())
    };
    let sql = format!(
        "SELECT {columns} FROM pages p \
         WHERE p.deleted_at IS NULL{exclude_mirrors} ORDER BY p.sort_order"
    );
    Ok(sqlx::query(&sql).fetch_all(pool).await?)
}

/// Export all pages as Markdown files to ~/Downloads/pikos-markdown-<timestamp>/.
/// Each page becomes a .md file with YAML frontmatter (title, status, priority, tags,
/// scheduled dates). Folder structure is preserved as subdirectories.
/// Images are copied into an assets/ subdirectory with references rewritten.
#[tauri::command]
pub async fn export_markdown(
    state: tauri::State<'_, DbState>,
    include_synced: bool,
) -> AppResult<String> {
    let pool = state.get_pool().await?;

    let folders =
        sqlx::query_as::<_, (String, String)>("SELECT id, name FROM folders ORDER BY sort_order")
            .fetch_all(&pool)
            .await?;

    let folder_names: std::collections::HashMap<String, String> = folders.into_iter().collect();

    let pages = fetch_export_pages(
        &pool,
        "id, folder_id, title, content, status, priority, tags, \
         scheduled_start, scheduled_end, created_at, updated_at",
        include_synced,
    )
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
pub async fn export_csv(
    state: tauri::State<'_, DbState>,
    include_synced: bool,
) -> AppResult<String> {
    let pool = state.get_pool().await?;
    let out = build_export_csv_impl(&pool, include_synced).await?;

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
pub(crate) async fn build_export_csv_impl(
    pool: &sqlx::SqlitePool,
    include_synced: bool,
) -> AppResult<String> {
    let folders =
        sqlx::query_as::<_, (String, String)>("SELECT id, name FROM folders ORDER BY sort_order")
            .fetch_all(pool)
            .await?;

    let folder_names: std::collections::HashMap<String, String> = folders.into_iter().collect();

    let pages = fetch_export_pages(
        pool,
        "id, folder_id, title, content_text, status, priority, tags, \
         scheduled_start, scheduled_end, created_at, updated_at, completed_at",
        include_synced,
    )
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

pub(super) fn sanitize_filename(name: &str) -> String {
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
pub(super) fn build_frontmatter(
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
pub(super) fn markdown_body(content: &str) -> String {
    if content.is_empty() || content == "{}" {
        return String::new();
    }
    match serde_json::from_str::<serde_json::Value>(content) {
        Ok(doc) => prosemirror_to_markdown(&doc),
        Err(_) => String::new(),
    }
}
