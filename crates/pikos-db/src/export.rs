//! Getting a workspace's contents out of Pikos.
//!
//! Shared by desktop, CLI and phone, because the exports answer "what happens to my writing if
//! I stop using this". Where a file goes is the caller's question, so each export returns
//! content: CSV and `.ics` are one string each, and Markdown is a plan the caller writes (see
//! [`plan_markdown_export`]). [`write_markdown_export`] is that writing for a caller with the
//! workspace's images on disk beside it, the desktop and the CLI.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use sqlx::Row;

use crate::error::AppResult;

/// The pages a user-facing export ships.
///
/// An un-actioned mirror is the calendar's copy of an event and none of the user's work, so
/// it stays out unless `include_synced` asks for it. Shared by every export so they agree on
/// what counts as the user's own.
pub async fn fetch_export_pages(
    pool: &sqlx::SqlitePool,
    columns: &str,
    include_synced: bool,
) -> AppResult<Vec<sqlx::sqlite::SqliteRow>> {
    let exclude_mirrors = if include_synced {
        String::new()
    } else {
        format!(" AND NOT {}", crate::unactioned_mirror_sql())
    };
    let sql = format!(
        "SELECT {columns} FROM pages p \
         WHERE p.deleted_at IS NULL{exclude_mirrors} ORDER BY p.sort_order"
    );
    Ok(sqlx::query(sqlx::AssertSqlSafe(sql.as_str()))
        .fetch_all(pool)
        .await?)
}

/// The stored path of an image node's file: `data-asset-path` where the editor set it, else a
/// `src` that is a path rather than a URL, which is all Markdown import writes.
fn stored_image_path(node: &serde_json::Value) -> Option<&str> {
    let attrs = node.get("attrs")?;
    let path = attrs
        .get("data-asset-path")
        .and_then(|p| p.as_str())
        .filter(|p| !p.is_empty())
        .or_else(|| attrs.get("src").and_then(|s| s.as_str()))?;
    let is_url = path.contains("://") || path.starts_with("data:") || path.starts_with("blob:");
    (!path.is_empty() && !is_url).then_some(path)
}

/// The stored asset path of every image in a document, in document order.
pub fn collect_asset_paths(node: &serde_json::Value, paths: &mut Vec<String>) {
    let node_type = node.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if node_type == "image" {
        if let Some(path) = stored_image_path(node) {
            paths.push(path.to_string());
        }
    }
    if let Some(content) = node.get("content").and_then(|c| c.as_array()) {
        for child in content {
            collect_asset_paths(child, paths);
        }
    }
}

/// A nullable text column, read as the `None` it actually is.
///
/// `row.try_get::<String, _>(col).ok()` looks like it does this and does not: sqlx decodes a
/// NULL into `Ok("")`, so every absent value arrives as `Some("")`, and an unfiled page lands
/// in `Uncategorized/` or an unscheduled one gets `scheduled_start: ""`.
fn nullable(row: &sqlx::sqlite::SqliteRow, column: &str) -> Option<String> {
    row.try_get::<Option<String>, _>(column)
        .ok()
        .flatten()
        .filter(|value| !value.is_empty())
}

/// One page, ready to be written once its assets are resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkdownPage {
    /// Path relative to the export root, including the `.md` — `"Work/Notes.md"`
    /// for a filed page, `"Notes.md"` for one in the inbox.
    pub path: String,
    /// The page is inside a folder directory, which is what decides whether an
    /// asset reference needs a `../`.
    pub in_folder: bool,
    /// Frontmatter plus body, with asset references still as stored.
    pub contents: String,
    /// The stored asset paths this page's body refers to, in document order.
    pub assets: Vec<String>,
}

/// Every page a Markdown export writes, in export order.
///
/// A plan rather than finished files because copying an asset out of the workspace belongs to
/// the platform and can fail (source deleted, disk full, sandbox). A page whose asset didn't
/// arrive must keep its original reference, and only the caller knows which happened.
///
/// Call [`render_markdown_page`] with whatever was actually copied.
pub type MarkdownPlan = Vec<MarkdownPage>;

pub async fn plan_markdown_export(
    pool: &sqlx::SqlitePool,
    include_synced: bool,
) -> AppResult<MarkdownPlan> {
    let folder_names: HashMap<String, String> =
        sqlx::query_as::<_, (String, String)>("SELECT id, name FROM folders ORDER BY sort_order")
            .fetch_all(pool)
            .await?
            .into_iter()
            .collect();

    let rows = fetch_export_pages(pool, &markdown_columns(), include_synced).await?;

    let titles: HashMap<String, String> = rows
        .iter()
        .map(|row| {
            let id: String = row.try_get("id").unwrap_or_default();
            let title: String = row.try_get("title").unwrap_or_default();
            (id, title)
        })
        .collect();

    let mut claimed = HashSet::new();
    Ok(rows
        .iter()
        .map(|row| {
            // A folder id with no folder behind it is not an error worth failing an
            // export over; the page still has to land somewhere a person can find.
            let directory = nullable(row, "folder_id").map(|id| {
                folder_names
                    .get(&id)
                    .map(|n| sanitize_filename(n))
                    .unwrap_or_else(|| "Uncategorized".to_string())
            });
            let mut page = markdown_page(row, directory, &titles);
            page.path = unclaimed_path(&page.path, &mut claimed);
            page
        })
        .collect())
}

/// `path`, or `<stem> 2.md` and up when an earlier page took it, as the one-page export names a
/// file that is already there.
///
/// A repeating page's done copies, untitled pages and imported duplicates share a title, and
/// without this each was written over the last. `claimed` holds lowercased paths because the
/// macOS and iOS file systems ignore case, so `Notes.md` and `notes.md` are one file there.
fn unclaimed_path(path: &str, claimed: &mut HashSet<String>) -> String {
    let stem = path.strip_suffix(".md").unwrap_or(path);
    let free = std::iter::once(path.to_string())
        .chain((2..).map(|n| format!("{stem} {n}.md")))
        .find(|candidate| !claimed.contains(&candidate.to_lowercase()))
        .expect("an unbounded range always finds a free name");

    claimed.insert(free.to_lowercase());
    free
}

/// One page as a Markdown file of its own, at the root of wherever it is written.
///
/// A folder is the workspace export's directory, so a page shared alone carries none. Any page
/// not in the trash exports, mirrors included, since asking for one page by name is explicit.
pub async fn plan_markdown_page(
    pool: &sqlx::SqlitePool,
    page_id: &str,
) -> AppResult<Option<MarkdownPage>> {
    let columns = markdown_columns();
    let sql = format!("SELECT {columns} FROM pages p WHERE p.id = ? AND p.deleted_at IS NULL");
    let Some(row) = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()))
        .bind(page_id)
        .fetch_optional(pool)
        .await?
    else {
        return Ok(None);
    };

    let content: String = row.try_get("body").unwrap_or_default();
    let titles = match serde_json::from_str::<serde_json::Value>(&content) {
        Ok(doc) => crate::page_links::target_titles(pool, &doc).await?,
        Err(_) => HashMap::new(),
    };

    Ok(Some(markdown_page(&row, None, &titles)))
}

fn markdown_columns() -> String {
    let body = crate::page_chunks::body_sql("p.id");
    format!(
        "id, folder_id, title, {body} AS body, status, priority, tags, \
         scheduled_start, scheduled_end, created_at, updated_at"
    )
}

fn markdown_page(
    row: &sqlx::sqlite::SqliteRow,
    directory: Option<String>,
    titles: &HashMap<String, String>,
) -> MarkdownPage {
    let title: String = row.try_get("title").unwrap_or_default();
    let content: String = row.try_get("body").unwrap_or_default();
    let status: String = row.try_get("status").unwrap_or_default();
    let priority: i64 = row.try_get("priority").unwrap_or(0);
    let tags: String = row.try_get("tags").unwrap_or_else(|_| "[]".to_string());
    let scheduled_start = nullable(row, "scheduled_start");
    let scheduled_end = nullable(row, "scheduled_end");
    let created_at: String = row.try_get("created_at").unwrap_or_default();
    let updated_at: String = row.try_get("updated_at").unwrap_or_default();

    let mut assets = Vec::new();
    if !content.is_empty() && content != "{}" {
        if let Ok(doc) = serde_json::from_str::<serde_json::Value>(&content) {
            collect_asset_paths(&doc, &mut assets);
        }
    }

    let filename = if title.is_empty() {
        "Untitled".to_string()
    } else {
        sanitize_filename(&title)
    };

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

    MarkdownPage {
        path: match &directory {
            Some(dir) => format!("{dir}/{filename}.md"),
            None => format!("{filename}.md"),
        },
        in_folder: directory.is_some(),
        contents: format!("{frontmatter}{}", markdown_body(&content, titles)),
        assets,
    }
}

/// A page's final text, with every asset that was actually copied pointed at its
/// place in the export.
///
/// `copied` maps a stored asset path to its path relative to the export root
/// (`"assets/1234.png"`). An asset missing from the map keeps its stored reference. Only a
/// link target is rewritten, so a path that also appears in a page's text is left as written.
pub fn render_markdown_page(page: &MarkdownPage, copied: &HashMap<String, String>) -> String {
    let mut body = page.contents.clone();
    for (source, relative) in copied {
        // A page inside a folder directory is one level down from `assets/`.
        let reference = if page.in_folder {
            format!("../{relative}")
        } else {
            relative.clone()
        };
        body = body.replace(&format!("]({source})"), &format!("]({reference})"));
    }
    body
}

/// The Markdown export written into `base_dir`, with images copied from `assets_dir`.
/// Returns how many pages and image files it wrote.
pub async fn write_markdown_export(
    pool: &sqlx::SqlitePool,
    base_dir: &Path,
    assets_dir: &Path,
    include_synced: bool,
) -> AppResult<(usize, usize)> {
    let plan = plan_markdown_export(pool, include_synced).await?;
    std::fs::create_dir_all(base_dir)?;

    let mut copied = HashMap::new();
    for page in &plan {
        copy_page_assets(page, assets_dir, base_dir, &mut copied)?;

        let destination = base_dir.join(&page.path);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&destination, render_markdown_page(page, &copied))?;
    }

    Ok((plan.len(), copied.len()))
}

/// Copies a page's images into `base_dir/assets/`, recording each that arrived in `copied` as
/// stored path to path relative to `base_dir`.
pub fn copy_page_assets(
    page: &MarkdownPage,
    assets_dir: &Path,
    base_dir: &Path,
    copied: &mut HashMap<String, String>,
) -> AppResult<()> {
    for stored in &page.assets {
        if copied.contains_key(stored) {
            continue;
        }

        let source = crate::assets::resolve_asset_path(assets_dir, stored);
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

pub fn sanitize_filename(name: &str) -> String {
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
pub fn build_frontmatter(
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

/// Convert a page's stored ProseMirror JSON `content` to a Markdown body, naming each linked
/// page by its title in `titles` where it has one.
/// Empty (`""`), empty-doc (`"{}"`), and unparseable content all yield an
/// empty string so a page always produces a valid (frontmatter-only) file.
pub fn markdown_body(content: &str, titles: &HashMap<String, String>) -> String {
    if content.is_empty() || content == "{}" {
        return String::new();
    }
    match serde_json::from_str::<serde_json::Value>(content) {
        Ok(mut doc) => {
            pikos_core::page_links::refresh_link_titles(&mut doc, &|id| titles.get(id).cloned());
            pikos_core::prosemirror_to_markdown(&doc)
        }
        Err(_) => String::new(),
    }
}

/// One reminder offset in the ISO-8601 duration form the importer's `parseDurationToMinutes`
/// reads: a leading `-` means "before the start", and `PT0S` is at-start. Minutes are the only
/// unit emitted, matching `page_reminders`, so no hour or day rounding loses anything.
fn reminder_duration(minutes_before: i64) -> String {
    if minutes_before == 0 {
        "PT0S".to_string()
    } else {
        format!("-PT{minutes_before}M")
    }
}

fn csv_field(s: &str) -> String {
    if s.contains(',') || s.contains('\n') || s.contains('"') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// The CSV body: header plus one row per non-deleted page.
///
/// Column names match the importer's header heuristics so the output round-trips, `Repeat` and
/// `Reminder` included.
pub async fn build_export_csv(pool: &sqlx::SqlitePool, include_synced: bool) -> AppResult<String> {
    let folder_names: HashMap<String, String> =
        sqlx::query_as::<_, (String, String)>("SELECT id, name FROM folders ORDER BY sort_order")
            .fetch_all(pool)
            .await?
            .into_iter()
            .collect();

    // Read once and keyed by page rather than joined: one rule per page, any number of reminders.
    let rrules: HashMap<String, String> =
        sqlx::query_as::<_, (String, String)>("SELECT page_id, rrule FROM page_recurrence_rules")
            .fetch_all(pool)
            .await?
            .into_iter()
            .collect();

    // The `-1` sentinel means "no reminders", which no ISO-8601 duration can say. The empty
    // cell reads on import as the global default, the nearest match.
    let mut reminders: HashMap<String, Vec<i64>> = HashMap::new();
    for (page_id, minutes_before) in sqlx::query_as::<_, (String, i64)>(
        "SELECT page_id, minutes_before FROM page_reminders \
         WHERE minutes_before >= 0 ORDER BY minutes_before ASC",
    )
    .fetch_all(pool)
    .await?
    {
        reminders.entry(page_id).or_default().push(minutes_before);
    }

    let pages = fetch_export_pages(
        pool,
        "id, folder_id, title, content_text, status, priority, tags, \
         scheduled_start, scheduled_end, created_at, updated_at, completed_at",
        include_synced,
    )
    .await?;

    let mut out = String::new();
    out.push_str("Title,Content,Folder,Status,Priority,Tags,Start Date,End Date,Repeat,Reminder,Created At,Updated At,Completed At\n");

    for row in &pages {
        let id: String = row.try_get("id").unwrap_or_default();
        let title: String = row.try_get("title").unwrap_or_default();
        let content_text: String = row.try_get("content_text").unwrap_or_default();
        let status: String = row.try_get("status").unwrap_or_default();
        let priority: i64 = row.try_get("priority").unwrap_or(0);
        let tags: String = row.try_get("tags").unwrap_or_else(|_| "[]".to_string());
        let scheduled_start = nullable(row, "scheduled_start");
        let scheduled_end = nullable(row, "scheduled_end");
        let created_at: String = row.try_get("created_at").unwrap_or_default();
        let updated_at: String = row.try_get("updated_at").unwrap_or_default();
        let completed_at = nullable(row, "completed_at");
        let folder_id = nullable(row, "folder_id");

        let folder_name = folder_id
            .as_deref()
            .and_then(|fid| folder_names.get(fid))
            .cloned()
            .unwrap_or_default();

        let tag_str = serde_json::from_str::<Vec<String>>(&tags)
            .map(|list| list.join(", "))
            .unwrap_or_default();

        // Stored bare, as the importer wants it, so it goes out verbatim.
        let repeat = rrules.get(&id).cloned().unwrap_or_default();
        // `;` not `,`: the importer splits on either, and it keeps the cell out of the quoting path.
        let reminder = reminders
            .get(&id)
            .map(|mins| {
                mins.iter()
                    .map(|m| reminder_duration(*m))
                    .collect::<Vec<_>>()
                    .join(";")
            })
            .unwrap_or_default();

        let fields = [
            csv_field(&title),
            csv_field(&content_text),
            csv_field(&folder_name),
            csv_field(&status),
            priority.to_string(),
            csv_field(&tag_str),
            csv_field(scheduled_start.as_deref().unwrap_or("")),
            csv_field(scheduled_end.as_deref().unwrap_or("")),
            csv_field(&repeat),
            csv_field(&reminder),
            csv_field(&created_at),
            csv_field(&updated_at),
            csv_field(completed_at.as_deref().unwrap_or("")),
        ];
        out.push_str(&fields.join(","));
        out.push('\n');
    }

    Ok(out)
}

/// Copy the whole database to `destination`, consistently.
///
/// `VACUUM INTO` rather than a file copy: in WAL mode a byte copy of the main file can miss
/// recent commits or refuse to open. This takes a read lock and writes one file.
///
/// The copy carries everything, trash and sync bookkeeping included. Credentials live in the
/// OS keychain and are not in it.
pub async fn backup_to(pool: &sqlx::SqlitePool, destination: &str) -> AppResult<()> {
    // SQLite rejects a bound parameter for the target, so the path goes in as a literal with
    // the quote doubled; refusing such a path would fail on a name every platform allows.
    let sql = format!("VACUUM INTO '{}'", destination.replace('\'', "''")); // sql-ok: quote-escaped literal; VACUUM INTO takes no bound parameter
    sqlx::query(sqlx::AssertSqlSafe(sql.as_str()))
        .execute(pool)
        .await?;
    Ok(())
}

/// Empty the workspace: every page, folder, schedule, rule, focus session and
/// calendar link.
///
/// Ordered rather than relying on cascades, so a caller's logged counts are each table's own
/// and a later foreign key can't change what a reset means.
///
/// `sync_account` goes last and takes `sync_calendar` and `page_sync` with it: a disconnect
/// keeps those dormant to re-link pages, but a reset has deleted the pages.
///
/// The keychain is untouched. A caller that wants credentials gone disconnects the accounts
/// first; the two stay separate so one that can't reach the server can still wipe local data.
pub async fn reset_workspace(pool: &sqlx::SqlitePool) -> AppResult<()> {
    // Captured, these deletes would wipe every device the workspace syncs to.
    crate::replica::forget(pool).await?;
    for table in [
        "focus_sessions",
        "page_schedules",
        "page_recurrence_rules",
        "pages",
        "folders",
        "sync_account",
    ] {
        sqlx::query(sqlx::AssertSqlSafe(format!("DELETE FROM {table}"))) // sql-ok: table is a literal from the list above
            .execute(pool)
            .await?;
    }
    crate::changes::new_epoch(pool).await
}

#[cfg(test)]
#[path = "export_tests.rs"]
mod tests;
