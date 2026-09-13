//! Getting a workspace's contents out of Pikos.
//!
//! Moved here from the desktop crate. The exports are not a desktop feature —
//! they are the answer to "what happens to my writing if I stop using this",
//! and a phone that cannot produce them cannot answer it. What stayed behind is
//! the half that touches a filesystem: where a file goes, and what a platform
//! calls a downloads folder, are not shared questions.
//!
//! So each export here returns *content*. CSV and `.ics` are one string each.
//! Markdown is a tree, and is returned as a plan the caller writes — see
//! [`plan_markdown_export`], which is split in two so that copying an asset can
//! fail on one platform without the rewriting logic knowing what a file is.

use std::collections::HashMap;

use sqlx::Row;

use crate::error::AppResult;

/// The pages a user-facing export ships.
///
/// An un-actioned mirror is the calendar's copy of an event and none of the
/// user's work, so it stays out unless `include_synced` asks for it; everything
/// the user completed, edited or detached exports either way. Shared by every
/// export so they cannot drift on what counts as the user's own.
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

/// Every `data-asset-path` in a document, in document order.
pub fn collect_asset_paths(node: &serde_json::Value, paths: &mut Vec<String>) {
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

/// A nullable text column, read as the `None` it actually is.
///
/// `row.try_get::<String, _>(col).ok()` looks like it does this and does not:
/// SQLite is dynamically typed and sqlx decodes a NULL into `Ok("")`, so the
/// `.ok()` never fires and every absent value arrives as `Some("")`. That is how
/// the Markdown export came to write every unfiled page into an
/// `Uncategorized/` directory whose `None` arm was unreachable, and how an
/// unscheduled page got `scheduled_start: ""` in its frontmatter.
fn nullable(row: &sqlx::sqlite::SqliteRow, column: &str) -> Option<String> {
    row.try_get::<Option<String>, _>(column)
        .ok()
        .flatten()
        .filter(|value| !value.is_empty())
}

// ─── Markdown ────────────────────────────────────────────────────────────────

/// One page, ready to be written once its assets are resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkdownPage {
    /// Path relative to the export root, including the `.md` — `"Work/Notes.md"`
    /// for a filed page, `"Notes.md"` for one in the inbox.
    pub path: String,
    /// The page is inside a folder directory, which is what decides whether an
    /// asset reference needs a `../`.
    pub in_folder: bool,
    /// Frontmatter plus body, with asset references still absolute.
    pub contents: String,
    /// The absolute asset paths this page's body refers to, in document order.
    pub assets: Vec<String>,
}

/// Every page a Markdown export writes, in export order.
///
/// A plan rather than finished files because one step in the middle belongs to
/// the platform: an asset is copied out of the workspace, and that copy can fail
/// — the source has been deleted, the disk is full, a sandbox refuses it. A page
/// whose asset did not arrive must keep its original reference rather than point
/// at a file that is not there, and only the caller knows which happened.
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

    let rows = fetch_export_pages(
        pool,
        "id, folder_id, title, content, status, priority, tags, \
         scheduled_start, scheduled_end, created_at, updated_at",
        include_synced,
    )
    .await?;

    let mut plan = Vec::with_capacity(rows.len());
    for row in &rows {
        let title: String = row.try_get("title").unwrap_or_default();
        let content: String = row.try_get("content").unwrap_or_default();
        let status: String = row.try_get("status").unwrap_or_default();
        let priority: i64 = row.try_get("priority").unwrap_or(0);
        let tags: String = row.try_get("tags").unwrap_or_else(|_| "[]".to_string());
        let scheduled_start = nullable(row, "scheduled_start");
        let scheduled_end = nullable(row, "scheduled_end");
        let created_at: String = row.try_get("created_at").unwrap_or_default();
        let updated_at: String = row.try_get("updated_at").unwrap_or_default();
        let folder_id = nullable(row, "folder_id");

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
        // A folder id with no folder behind it is not an error worth failing an
        // export over; the page still has to land somewhere a person can find.
        let directory = folder_id.as_deref().map(|id| {
            folder_names
                .get(id)
                .map(|n| sanitize_filename(n))
                .unwrap_or_else(|| "Uncategorized".to_string())
        });

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

        plan.push(MarkdownPage {
            path: match &directory {
                Some(dir) => format!("{dir}/{filename}.md"),
                None => format!("{filename}.md"),
            },
            in_folder: directory.is_some(),
            contents: format!("{frontmatter}{}", markdown_body(&content)),
            assets,
        });
    }

    Ok(plan)
}

/// A page's final text, with every asset that was actually copied pointed at its
/// place in the export.
///
/// `copied` maps an absolute source path to its path relative to the export
/// root (`"assets/1234.png"`). An asset missing from the map keeps its original
/// absolute reference — which resolves to nothing outside this machine, and is
/// still better than a link into the export that goes nowhere inside it.
pub fn render_markdown_page(page: &MarkdownPage, copied: &HashMap<String, String>) -> String {
    let mut body = page.contents.clone();
    for (source, relative) in copied {
        // A page inside a folder directory is one level down from `assets/`.
        let reference = if page.in_folder {
            format!("../{relative}")
        } else {
            relative.clone()
        };
        body = body.replace(source, &reference);
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

/// Convert a page's stored ProseMirror JSON `content` to a Markdown body.
/// Empty (`""`), empty-doc (`"{}"`), and unparseable content all yield an
/// empty string so a page always produces a valid (frontmatter-only) file.
pub fn markdown_body(content: &str) -> String {
    if content.is_empty() || content == "{}" {
        return String::new();
    }
    match serde_json::from_str::<serde_json::Value>(content) {
        Ok(doc) => pikos_core::prosemirror_to_markdown(&doc),
        Err(_) => String::new(),
    }
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

/// One reminder offset in the ISO-8601 duration form the importer's
/// `parseDurationToMinutes` reads: a leading `-` means "before the start" (the
/// sign is what the importer strips, so it is decoration either way), and `PT0S`
/// is the at-start case its own doc comment names. Minutes are the only unit
/// emitted — that is the unit `page_reminders` stores, and the importer's
/// grammar takes any minute count, so no lossy hour/day rounding is needed.
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
/// Column names match the importer's header heuristics so the output round-trips
/// back through import — including `Repeat` and `Reminder`, which the importer
/// has always understood but the export used to drop.
pub async fn build_export_csv(pool: &sqlx::SqlitePool, include_synced: bool) -> AppResult<String> {
    let folder_names: HashMap<String, String> =
        sqlx::query_as::<_, (String, String)>("SELECT id, name FROM folders ORDER BY sort_order")
            .fetch_all(pool)
            .await?
            .into_iter()
            .collect();

    // Recurrence and reminders hang off their own tables, so they are read once
    // and keyed by page rather than joined onto the page query — one rule per
    // page (the table is UNIQUE on page_id), any number of reminders.
    let rrules: HashMap<String, String> =
        sqlx::query_as::<_, (String, String)>("SELECT page_id, rrule FROM page_recurrence_rules")
            .fetch_all(pool)
            .await?
            .into_iter()
            .collect();

    // The `-1` sentinel means "no reminders on this page", which no ISO-8601
    // duration can say — it is left out, and the empty cell it produces reads on
    // import as "fall back to the global default", the nearest honest match.
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

        // The rule is stored the way the importer wants it — bare, no `RRULE:`
        // prefix and no DTSTART — so it goes out verbatim.
        let repeat = rrules.get(&id).cloned().unwrap_or_default();
        // `;` rather than `,`: the importer splits on either, and a semicolon
        // keeps a multi-reminder cell out of the quoting path.
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

// ─── SQLite ──────────────────────────────────────────────────────────────────

/// Copy the whole database to `destination`, consistently.
///
/// `VACUUM INTO` rather than copying the file: SQLite in WAL mode is three files
/// and a reader mid-write, so a byte copy of the main file can land a database
/// that is missing its most recent commits or refuses to open at all. This takes
/// a read lock and writes one defragmented file.
///
/// The copy carries everything, trash and sync bookkeeping included. Credentials
/// are not in it — those live in the OS keychain and never reach the database.
pub async fn backup_to(pool: &sqlx::SqlitePool, destination: &str) -> AppResult<()> {
    // SQLite rejects a bound parameter for `VACUUM INTO`'s target, so the path
    // goes into the statement as a literal and the quote is doubled — the same
    // escaping the desktop's `vacuum_into` has always used. Refusing such a path
    // instead would be a new failure on a name that is legal on every platform
    // this runs on.
    let sql = format!("VACUUM INTO '{}'", destination.replace('\'', "''")); // sql-ok: quote-escaped literal; VACUUM INTO takes no bound parameter
    sqlx::query(&sql).execute(pool).await?;
    Ok(())
}

// ─── Starting over ───────────────────────────────────────────────────────────

/// Empty the workspace: every page, folder, schedule, rule, focus session and
/// calendar link.
///
/// Ordered rather than relying on cascades, so the counts logged by a caller are
/// each table's own and a foreign key added later cannot silently change what a
/// reset means.
///
/// `sync_account` goes last and takes `sync_calendar` and `page_sync` with it.
/// An ordinary disconnect keeps those dormant so a reconnect can re-link the
/// pages it left behind; a reset has deleted the pages, so there is nothing left
/// to re-link and keeping the rows would strand them.
///
/// What this does *not* touch is the keychain. Credentials live there, not in
/// the database, so a caller that wants them gone has to disconnect the accounts
/// first — and one that cannot reach the server should still be able to wipe its
/// local data, which is why the two are separate calls rather than one.
pub async fn reset_workspace(pool: &sqlx::SqlitePool) -> AppResult<()> {
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
    Ok(())
}

#[cfg(test)]
#[path = "export_tests.rs"]
mod tests;
