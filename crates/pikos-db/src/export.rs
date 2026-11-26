//! Getting a workspace's contents out of Pikos.
//!
//! The exports are not a desktop feature: they answer "what happens to my writing if I
//! stop using this", so a phone must be able to produce them. Anything that touches a
//! filesystem stays with the caller, so each export returns content. CSV and `.ics` are one
//! string each; Markdown is a plan the caller writes (see [`plan_markdown_export`]).

use std::collections::HashMap;

use sqlx::Row;

use crate::error::AppResult;

/// The pages a user-facing export ships.
///
/// An un-actioned mirror is the calendar's copy of an event, not the user's work, so it
/// stays out unless `include_synced` asks; anything the user completed, edited or detached
/// exports either way. Shared so the exports can't drift on what counts as the user's own.
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
    Ok(sqlx::query(&sql).fetch_all(pool).await?)
}

/// The stored path of an image node's file: `data-asset-path` where the editor set it, else
/// a `src` that is a path rather than a URL, which is all Markdown import writes.
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
/// `row.try_get::<String, _>(col).ok()` doesn't do this: sqlx decodes a SQLite NULL into
/// `Ok("")`, so every absent value arrives as `Some("")`.
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
/// A plan, not finished files, because copying an asset out of the workspace belongs to the
/// platform and can fail (source deleted, disk full, sandbox). A page whose asset didn't
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

    let rows = fetch_export_pages(pool, MARKDOWN_COLUMNS, include_synced).await?;

    let titles: HashMap<String, String> = rows
        .iter()
        .map(|row| {
            let id: String = row.try_get("id").unwrap_or_default();
            let title: String = row.try_get("title").unwrap_or_default();
            (id, title)
        })
        .collect();

    Ok(rows
        .iter()
        .map(|row| {
            // A dangling folder id mustn't fail the export; the page still has to land somewhere findable.
            let directory = nullable(row, "folder_id").map(|id| {
                folder_names
                    .get(&id)
                    .map(|n| sanitize_filename(n))
                    .unwrap_or_else(|| "Uncategorized".to_string())
            });
            markdown_page(row, directory, &titles)
        })
        .collect())
}

/// One page as a Markdown file of its own, at the root of wherever it is written.
///
/// A page shared alone carries no folder directory. Any page not in the trash exports,
/// mirrors included: asking for one by name is the explicit action the workspace filter
/// stands in for.
pub async fn plan_markdown_page(
    pool: &sqlx::SqlitePool,
    page_id: &str,
) -> AppResult<Option<MarkdownPage>> {
    let sql =
        format!("SELECT {MARKDOWN_COLUMNS} FROM pages p WHERE p.id = ? AND p.deleted_at IS NULL");
    let Some(row) = sqlx::query(&sql).bind(page_id).fetch_optional(pool).await? else {
        return Ok(None);
    };

    let content: String = row.try_get("content").unwrap_or_default();
    let titles = match serde_json::from_str::<serde_json::Value>(&content) {
        Ok(doc) => crate::page_links::target_titles(pool, &doc).await?,
        Err(_) => HashMap::new(),
    };

    Ok(Some(markdown_page(&row, None, &titles)))
}

const MARKDOWN_COLUMNS: &str = "id, folder_id, title, content, status, priority, tags, \
     scheduled_start, scheduled_end, created_at, updated_at";

fn markdown_page(
    row: &sqlx::sqlite::SqliteRow,
    directory: Option<String>,
    titles: &HashMap<String, String>,
) -> MarkdownPage {
    let title: String = row.try_get("title").unwrap_or_default();
    let content: String = row.try_get("content").unwrap_or_default();
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
/// `copied` maps a stored asset path to its path relative to the export root. An asset
/// missing from it keeps its stored reference, better than a link that goes nowhere. Only a
/// link target is rewritten, so a path also appearing in a page's text is left as written.
pub fn render_markdown_page(page: &MarkdownPage, copied: &HashMap<String, String>) -> String {
    let mut body = page.contents.clone();
    for (source, relative) in copied {
        let reference = if page.in_folder {
            format!("../{relative}")
        } else {
            relative.clone()
        };
        body = body.replace(&format!("]({source})"), &format!("]({reference})"));
    }
    body
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

/// A Markdown page's YAML frontmatter. Default status and zero priority are omitted. Always
/// ends with the `---\n\n` separator so the caller can concatenate the body.
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

/// A page's stored ProseMirror JSON as a Markdown body, naming each linked page by its title
/// in `titles` where it has one. Empty, `"{}"` and unparseable content yield an empty string,
/// so a page always produces a valid file.
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
/// reads: a leading `-` means "before the start" (the importer strips the sign), and `PT0S`
/// is at-start. Only minutes are emitted, the unit `page_reminders` stores, so nothing rounds.
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
/// Column names match the importer's header heuristics so the output round-trips through
/// import, including `Repeat` and `Reminder`.
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

    // The `-1` sentinel ("no reminders") has no ISO-8601 spelling, so it is left out; the empty
    // cell reads on import as the global default, the nearest honest match.
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

        // Stored as the importer wants it, bare, so it goes out verbatim.
        let repeat = rrules.get(&id).cloned().unwrap_or_default();
        // `;`, not `,`, keeps a multi-reminder cell out of the quoting path.
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
/// `VACUUM INTO`, not a file copy: in WAL mode a byte copy of the main file can miss recent
/// commits or fail to open. The copy carries everything, trash and sync bookkeeping
/// included; credentials live in the OS keychain and are not in it.
pub async fn backup_to(pool: &sqlx::SqlitePool, destination: &str) -> AppResult<()> {
    // `VACUUM INTO` takes no bound parameter, so the path goes in as a literal with the quote
    // doubled; refusing a quote would fail a name legal on every platform.
    let sql = format!("VACUUM INTO '{}'", destination.replace('\'', "''")); // sql-ok: quote-escaped literal; VACUUM INTO takes no bound parameter
    sqlx::query(&sql).execute(pool).await?;
    Ok(())
}

/// Empty the workspace: every page, folder, schedule, rule, focus session and
/// calendar link.
///
/// Ordered rather than relying on cascades, so a caller's logged counts are each table's own
/// and a later foreign key can't change what a reset means.
///
/// `sync_account` goes last, taking `sync_calendar` and `page_sync` with it: a disconnect
/// keeps those dormant to re-link pages, but a reset has deleted the pages.
///
/// The keychain is untouched. A caller wanting credentials gone disconnects the accounts
/// first, kept separate so one that can't reach the server can still wipe local data.
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
        sqlx::query(&format!("DELETE FROM {table}")) // sql-ok: table is a literal from the list above
            .execute(pool)
            .await?;
    }
    crate::changes::new_epoch(pool).await
}

#[cfg(test)]
#[path = "export_tests.rs"]
mod tests;
