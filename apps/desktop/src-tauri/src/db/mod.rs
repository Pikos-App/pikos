use sqlx::SqlitePool;
use tokio::sync::Mutex;

pub mod assets;
pub mod dev;
pub mod folders;
pub mod notifications;
pub mod pages;
pub mod schedules;
pub mod search;
pub mod tags;

/// Shared database state. None until connect_db is called.
pub struct DbState(pub Mutex<Option<SqlitePool>>);

impl DbState {
    pub fn new() -> Self {
        DbState(Mutex::new(None))
    }

    pub async fn get_pool(&self) -> Result<SqlitePool, String> {
        let guard = self.0.lock().await;
        guard
            .as_ref()
            .ok_or_else(|| "No database connected. Call connect_db first.".to_string()).cloned()
    }
}

pub(crate) fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// Recursively extract plain text from a Tiptap JSON document.
/// Mirrors the TypeScript `extractText()` in packages/core — keeps FTS
/// content_text in sync for pages created before the frontend sent it.
fn extract_text_from_tiptap(content: &str) -> String {
    if content.is_empty() || content == "{}" {
        return String::new();
    }
    let doc: serde_json::Value = match serde_json::from_str(content) {
        Ok(v) => v,
        Err(_) => return String::new(),
    };
    let mut parts: Vec<String> = Vec::new();
    walk_tiptap_node(&doc, &mut parts);
    parts.join("\n").trim().to_string()
}

fn walk_tiptap_node(node: &serde_json::Value, parts: &mut Vec<String>) {
    // Text leaf node
    if let Some(text) = node.get("text").and_then(|t| t.as_str()) {
        parts.push(text.to_string());
        return;
    }

    let children = match node.get("content").and_then(|c| c.as_array()) {
        Some(arr) => arr,
        None => return,
    };

    let node_type = node.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let is_block = matches!(
        node_type,
        "paragraph" | "heading" | "codeBlock" | "blockquote" | "listItem" | "taskItem"
    );

    let mut child_parts: Vec<String> = Vec::new();
    for child in children {
        walk_tiptap_node(child, &mut child_parts);
    }

    if is_block {
        // Block nodes: join inline children, push as single entry
        parts.push(child_parts.join(""));
    } else {
        // Container nodes (doc, bulletList, orderedList, taskList): pass through
        parts.extend(child_parts);
    }
}

/// Open (or create) a SQLite workspace at the given path and run migrations.
/// Called by WorkspaceContext when the user opens or creates a workspace.
///
/// Idempotent: if a pool is already initialised, returns Ok without
/// reconnecting, re-running migrations, or rebuilding the FTS index. The
/// frontend's mount effect fires twice in dev under React.StrictMode, which
/// otherwise triggered duplicate "DB connected" logging and double work.
/// The duplicate-call path emits a WARN so future regressions stay visible
/// without polluting the steady-state log.
#[tauri::command]
pub async fn connect_db(path: String, state: tauri::State<'_, DbState>) -> Result<(), String> {
    {
        let guard = state.0.lock().await;
        if guard.is_some() {
            log::warn!(
                "connect_db invoked twice — pool already initialised, skipping reconnect"
            );
            return Ok(());
        }
    }

    // Ensure the parent directory exists (e.g. ~/Library/Application Support/app.pikos.desktop/)
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true)
                // WAL mode: readers don't block writers, writers don't block readers
                .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
                // SQLite disables FK enforcement by default — enable it
                .foreign_keys(true),
        )
        .await
        .map_err(|e| e.to_string())?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .map_err(|e| e.to_string())?;

    // Backfill content_text for pages where it's empty but content exists.
    // This covers pages created before the frontend started sending content_text.
    backfill_content_text(&pool).await?;

    // Prune notification log entries older than 30 days to prevent unbounded growth.
    crate::notifications::scheduler::prune_notification_log(&pool)
        .await
        .map_err(|e| e.to_string())?;

    // Rebuild FTS5 index from the pages content table.
    // For external-content FTS5 tables (content='pages'), the index is not
    // automatically populated from existing rows — triggers only fire on
    // INSERT/UPDATE/DELETE after the migration. Rebuilding on connect ensures
    // any pre-existing pages are indexed and the index stays consistent.
    sqlx::query("INSERT INTO pages_fts(pages_fts) VALUES('rebuild')")
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

    *state.0.lock().await = Some(pool);
    log::info!("DB connected, migrations applied");
    Ok(())
}

/// Backfill content_text by re-extracting plain text from Tiptap JSON content
/// for any pages where content_text is empty but content is not.
async fn backfill_content_text(pool: &SqlitePool) -> Result<(), String> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, content FROM pages WHERE (content_text IS NULL OR content_text = '') AND content != '' AND content != '{}'",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let mut backfilled = 0usize;
    for (id, content) in &rows {
        let text = extract_text_from_tiptap(content);
        if !text.is_empty() {
            sqlx::query("UPDATE pages SET content_text = ? WHERE id = ?")
                .bind(&text)
                .bind(id)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
            backfilled += 1;
        }
    }

    if backfilled > 0 {
        // Operational detail; runs at most once per workspace lifetime.
        // Demoted from INFO so a healthy boot stays at the lifecycle anchor only.
        log::debug!("backfill_content_text count={backfilled}");
    }
    Ok(())
}
