//! Tauri-free pool opener + workspace bootstrap. Lifted from the desktop app's
//! db/mod.rs, minus the app-only bits (notification-log prune, path
//! canonicalisation, DbState/Tauri). Opens with the same pragmas the app uses so
//! concurrent access is safe, runs the sqlx migrations, backfills content_text,
//! and rebuilds the FTS index once per schema bump.

use std::path::{Path, PathBuf};
use std::time::Duration;

use sqlx::migrate::Migrator;
use sqlx::SqlitePool;

use crate::error::{AppError, AppResult};

/// The embedded migration set, shared by `open_pool` (to run them) and the
/// pre-migration backup check (to read the highest known version).
static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

/// Bump when a migration changes an FTS-indexed column; see the desktop app's
/// note. Kept identical so the rebuild/skip decision matches the app.
const FTS_SCHEMA_VERSION: i64 = 1;

/// How many pre-migration snapshots to retain. Older ones are pruned so they
/// don't accumulate; recovery only ever needs the most recent few.
const MAX_MIGRATION_BACKUPS: usize = 3;

/// UTC, millisecond precision, trailing Z — the canonical timestamp format for
/// created_at / updated_at across the workspace.
pub fn now_iso() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// Local wall-clock, no timezone suffix — the storage format for user-facing
/// instants that are date-compared against the local day (`scheduled_start`,
/// `completed_at`). Mirrors the frontend's `nowLocalISO()`
/// (`yyyy-MM-dd'T'HH:mm:ss`). Using `now_iso()` (UTC) here instead would make a
/// `completed_at.slice(0,10) === localToday()` comparison fail whenever the UTC
/// date differs from the local date (i.e. for much of every day off-UTC).
pub fn now_local_iso() -> String {
    chrono::Local::now()
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string()
}

/// Open (or create) the SQLite workspace at `path`, apply migrations, and run
/// first-launch housekeeping. WAL + busy_timeout make concurrent access with
/// the desktop app safe.
pub async fn open_pool(path: &str) -> AppResult<SqlitePool> {
    if let Some(parent) = std::path::Path::new(path).parent() {
        std::fs::create_dir_all(parent)?;
    }

    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(true)
                .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
                .synchronous(sqlx::sqlite::SqliteSynchronous::Normal)
                .busy_timeout(Duration::from_secs(5))
                .pragma("temp_store", "MEMORY")
                .pragma("mmap_size", "268435456")
                .foreign_keys(true),
        )
        .await?;

    // Snapshot the workspace before applying any pending migrations.
    // Migrations are forward-only and some are lossy, so a bad release can only
    // be recovered by restoring the pre-migration file.
    maybe_backup_before_migrations(&pool, path).await?;

    MIGRATOR
        .run(&pool)
        .await
        .map_err(|e| AppError::Db(sqlx::Error::Migrate(Box::new(e))))?;

    backfill_content_text(&pool).await?;

    let stored: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&pool)
        .await?;
    if stored != FTS_SCHEMA_VERSION {
        sqlx::query("INSERT INTO pages_fts(pages_fts) VALUES('rebuild')")
            .execute(&pool)
            .await?;
        sqlx::query(&format!("PRAGMA user_version = {FTS_SCHEMA_VERSION}")) // sql-ok: compile-time constant
            .execute(&pool)
            .await?;
    }

    Ok(pool)
}

/// Snapshot the DB file before applying pending migrations, so a misbehaving
/// release can be recovered by restoring the file. No-ops on the cases where a
/// snapshot would be pointless: a brand-new workspace (no `_sqlx_migrations`
/// table yet), an already-up-to-date workspace (no pending migrations), or an
/// empty workspace (no pages or folders to lose).
///
/// Lives in the shared `open_pool` so the CLI gets the same protection — it
/// mutates the same file. Downgrade safety is handled separately: the sqlx
/// migrator fails closed if the workspace is newer than the binary.
async fn maybe_backup_before_migrations(pool: &SqlitePool, path: &str) -> AppResult<()> {
    // Highest migration version the binary knows about (down-migrations ignored;
    // there are none today, but filter defensively).
    let Some(known_max) = MIGRATOR
        .iter()
        .filter(|m| !m.migration_type.is_down_migration())
        .map(|m| m.version)
        .max()
    else {
        return Ok(());
    };

    // No `_sqlx_migrations` table => this file was just created. Nothing to back up.
    let migrations_table_exists: bool = sqlx::query_scalar::<_, i64>(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations')",
    )
    .fetch_one(pool)
    .await?
        != 0;
    if !migrations_table_exists {
        return Ok(());
    }

    // Up to date => no pending migrations => no risk worth snapshotting.
    let applied_max: i64 = sqlx::query_scalar::<_, Option<i64>>("SELECT MAX(version) FROM _sqlx_migrations")
        .fetch_one(pool)
        .await?
        .unwrap_or(0);
    if applied_max >= known_max {
        return Ok(());
    }

    // Empty workspace => nothing to lose.
    let has_data: bool =
        sqlx::query_scalar::<_, i64>("SELECT EXISTS(SELECT 1 FROM pages) OR EXISTS(SELECT 1 FROM folders)")
            .fetch_one(pool)
            .await?
            != 0;
    if !has_data {
        return Ok(());
    }

    backup_for_migration(pool, path, applied_max, known_max).await
}

/// VACUUM INTO a timestamped snapshot under `<db parent>/backups/`, then prune
/// to the newest [`MAX_MIGRATION_BACKUPS`]. VACUUM INTO yields a consistent
/// single-file copy even with the WAL open, avoiding the torn-copy risk of a raw
/// `fs::copy` on a live database.
async fn backup_for_migration(
    pool: &SqlitePool,
    path: &str,
    from: i64,
    to: i64,
) -> AppResult<()> {
    let backup_dir = Path::new(path)
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("backups");
    std::fs::create_dir_all(&backup_dir)?;

    // Timestamp first in the name (filesystem-safe, no colons) so a lexical sort
    // is chronological for pruning. Millisecond precision avoids collisions.
    let ts = chrono::Utc::now().format("%Y%m%dT%H%M%S%3fZ");
    let dest = backup_dir.join(format!("pre-migration-{ts}-v{from}-to-v{to}.sqlite"));

    // VACUUM INTO's target can't be a bound parameter; escape the literal.
    let dest_str = dest.to_string_lossy();
    let sql = format!("VACUUM INTO '{}'", dest_str.replace('\'', "''"));
    sqlx::query(&sql).execute(pool).await?;

    prune_migration_backups(&backup_dir, MAX_MIGRATION_BACKUPS);
    Ok(())
}

/// Delete all but the newest `keep` `pre-migration-*.sqlite` files in `dir`.
/// Best-effort: a failed read/remove is logged via the caller, never fatal — a
/// stale extra backup is harmless.
fn prune_migration_backups(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut snaps: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("pre-migration-") && n.ends_with(".sqlite"))
        })
        .collect();
    if snaps.len() <= keep {
        return;
    }
    snaps.sort(); // timestamp-first names => ascending == oldest-first
    for old in &snaps[..snaps.len() - keep] {
        let _ = std::fs::remove_file(old);
    }
}

/// Re-extract plain text from Tiptap JSON for any rows missing content_text.
async fn backfill_content_text(pool: &SqlitePool) -> AppResult<()> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, content FROM pages WHERE (content_text IS NULL OR content_text = '') AND content != '' AND content != '{}'",
    )
    .fetch_all(pool)
    .await?;

    for (id, content) in &rows {
        let text = extract_text_from_tiptap(content);
        if !text.is_empty() {
            sqlx::query("UPDATE pages SET content_text = ? WHERE id = ?")
                .bind(&text)
                .bind(id)
                .execute(pool)
                .await?;
        }
    }
    Ok(())
}

/// Recursively extract plain text from a Tiptap JSON document. Mirrors the
/// TypeScript `extractText()` so FTS content_text stays in sync.
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
        parts.push(child_parts.join(""));
    } else {
        parts.extend(child_parts);
    }
}

/// In-memory pool with migrations applied, for tests. Single connection so every
/// query hits the same `:memory:` DB; foreign keys on to match production.
#[cfg(any(test, feature = "test-support"))]
pub async fn test_pool() -> SqlitePool {
    use std::str::FromStr;
    let opts = sqlx::sqlite::SqliteConnectOptions::from_str(":memory:")
        .expect("parse :memory: opts")
        .foreign_keys(true);
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .expect("connect in-memory sqlite");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("apply migrations");
    pool
}

/// A real on-disk WAL pool (max 5 connections, production pragmas) for
/// concurrency tests. The `:memory:`, single-connection [`test_pool`] cannot
/// exhibit multi-writer contention — there is no second connection and no WAL —
/// so it can never reproduce the `SQLITE_BUSY_SNAPSHOT` (517) that a real pool
/// hits when two writers race. The temp DB file (+ `-wal`/`-shm` sidecars) is
/// deleted when the returned guard drops. Test-only (not exported via the
/// `test-support` feature) — only pikos-db's own concurrency tests need a real
/// multi-connection pool.
#[cfg(test)]
pub struct TempWalDb {
    pub pool: SqlitePool,
    path: PathBuf,
}

#[cfg(test)]
impl Drop for TempWalDb {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_file(self.path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(self.path.with_extension("sqlite-shm"));
    }
}

#[cfg(test)]
pub async fn wal_test_pool() -> TempWalDb {
    use std::sync::atomic::{AtomicU64, Ordering};
    // Unique per test within a process; no rand/clock needed.
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let path =
        std::env::temp_dir().join(format!("pikos-waltest-{}-{n}.sqlite", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let pool = open_pool(path.to_str().expect("temp path is utf-8"))
        .await
        .expect("open wal test pool");
    TempWalDb { pool, path }
}

/// Test fixture for inserting a minimal `pages` row. `content` is empty JSON;
/// `content_text` drives FTS body matches.
#[cfg(any(test, feature = "test-support"))]
#[derive(Clone)]
pub struct TestPage<'a> {
    pub id: &'a str,
    pub title: &'a str,
    pub subtitle: Option<&'a str>,
    pub content_text: &'a str,
    pub folder_id: Option<&'a str>,
    pub status: &'a str,
    pub tags_json: &'a str,
    pub scheduled_start: Option<&'a str>,
    pub scheduled_end: Option<&'a str>,
}

#[cfg(any(test, feature = "test-support"))]
impl<'a> TestPage<'a> {
    pub fn new(id: &'a str, title: &'a str) -> Self {
        TestPage {
            id,
            title,
            subtitle: None,
            content_text: "",
            folder_id: None,
            status: "not_started",
            tags_json: "[]",
            scheduled_start: None,
            scheduled_end: None,
        }
    }
}

#[cfg(any(test, feature = "test-support"))]
pub async fn insert_test_page(pool: &SqlitePool, p: TestPage<'_>) -> AppResult<()> {
    let now = now_iso();
    sqlx::query(
        "INSERT INTO pages
         (id, folder_id, title, subtitle, content, content_text, status, priority, tags,
          sort_order, scheduled_start, scheduled_end, created_at, updated_at)
         VALUES (?, ?, ?, ?, '{}', ?, ?, 0, ?, 0, ?, ?, ?, ?)",
    )
    .bind(p.id)
    .bind(p.folder_id)
    .bind(p.title)
    .bind(p.subtitle)
    .bind(p.content_text)
    .bind(p.status)
    .bind(p.tags_json)
    .bind(p.scheduled_start)
    .bind(p.scheduled_end)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(any(test, feature = "test-support"))]
pub async fn insert_test_folder(pool: &SqlitePool, id: &str, name: &str) -> AppResult<()> {
    let now = now_iso();
    sqlx::query(
        "INSERT INTO folders (id, name, sort_order, created_at, updated_at) VALUES (?, ?, 0, ?, ?)",
    )
    .bind(id)
    .bind(name)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
#[path = "pool_tests.rs"]
mod pool_tests;
