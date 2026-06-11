use std::path::PathBuf;

use sqlx::SqlitePool;
use tokio::sync::Mutex;

use crate::error::{AppError, AppResult};

#[path = "assets/assets.rs"]
pub mod assets;
#[path = "dev/dev.rs"]
pub mod dev;
#[path = "folders/folders.rs"]
pub mod folders;
pub mod notifications;
#[path = "pages/pages.rs"]
pub mod pages;
#[path = "schedules/schedules.rs"]
pub mod schedules;
#[path = "search/search.rs"]
pub mod search;
pub mod tags;
#[path = "watch.rs"]
mod watch;

/// Shared database state. None until connect_db is called.
///
/// Tracks the canonical path of the currently-connected file so a repeated
/// connect_db with the *same* path is a cheap no-op (frontend mount effect
/// fires twice under React.StrictMode) while a *different* path is treated
/// as a programming error — the caller should use `switch_workspace`.
pub struct DbState {
    inner: Mutex<DbStateInner>,
}

#[derive(Default)]
struct DbStateInner {
    pool: Option<SqlitePool>,
    /// Canonicalised absolute path of the currently-connected DB file.
    /// `None` matches the empty `pool`. Two paths that canonicalise to the
    /// same on-disk file (e.g. one with `..`) are treated as the same
    /// workspace — avoids opening a second pool to the same SQLite file.
    path: Option<PathBuf>,
}

impl DbState {
    pub fn new() -> Self {
        DbState {
            inner: Mutex::new(DbStateInner::default()),
        }
    }

    pub async fn get_pool(&self) -> AppResult<SqlitePool> {
        let guard = self.inner.lock().await;
        guard
            .pool
            .as_ref()
            .ok_or_else(|| {
                AppError::Internal("No database connected. Call connect_db first.".into())
            })
            .cloned()
    }

    /// Take ownership of the current pool, clearing state. Used by
    /// `wipe_app_data` so SQLite file handles release before the on-disk
    /// file is removed.
    pub(crate) async fn take_pool(&self) -> Option<SqlitePool> {
        let mut guard = self.inner.lock().await;
        guard.path = None;
        guard.pool.take()
    }

    /// Test-only: build a state already holding `pool`, bypassing `connect_db`
    /// (which needs a `tauri::State`). Lets unit tests exercise the
    /// take_pool/get_pool lifecycle that `wipe_app_data` depends on.
    #[cfg(test)]
    pub(crate) fn with_pool(pool: SqlitePool) -> Self {
        DbState {
            inner: Mutex::new(DbStateInner {
                pool: Some(pool),
                path: None,
            }),
        }
    }
}

/// Best-effort canonical path. Falls back to the raw path if the file
/// doesn't exist yet (first-run create_if_missing) — in that case we
/// canonicalise the parent dir and append the filename.
fn canonicalize_path(path: &str) -> PathBuf {
    let raw = std::path::Path::new(path);
    if let Ok(c) = raw.canonicalize() {
        return c;
    }
    // File doesn't exist yet — canonicalise parent and re-attach name.
    if let (Some(parent), Some(name)) = (raw.parent(), raw.file_name()) {
        if let Ok(parent_c) = parent.canonicalize() {
            return parent_c.join(name);
        }
    }
    PathBuf::from(path)
}

/// Open (or create) the SQLite workspace at `path`, run migrations, and
/// store the pool in shared state.
///
/// Idempotent: a second call with the **same** canonical path is a fast
/// no-op (the React.StrictMode double-mount path emits a WARN so future
/// regressions stay visible). A call with a **different** path returns an
/// error pointing the caller at `switch_workspace` — silently re-mapping
/// the connection would surprise the frontend, which assumes connect_db
/// is the one-time bootstrap.
///
/// The mutex is held across `open_pool` so a concurrent second call (the
/// dev StrictMode double-mount) waits and then hits the idempotency
/// branch — racing into a second `open_pool` against the same file can
/// return SQLITE_BUSY when migrations / WAL recovery contend.
#[tauri::command]
pub async fn connect_db(
    path: String,
    state: tauri::State<'_, DbState>,
    app: tauri::AppHandle,
) -> AppResult<()> {
    let canonical = canonicalize_path(&path);

    let mut guard = state.inner.lock().await;
    if let Some(existing) = guard.path.as_ref() {
        if existing == &canonical {
            log::warn!("connect_db invoked twice — pool already initialised, skipping reconnect");
            return Ok(());
        }
        return Err(AppError::Conflict(
            "DB already connected to a different workspace; call switch_workspace".into(),
        ));
    }

    let pool = open_pool(&path).await?;
    *guard = DbStateInner {
        pool: Some(pool),
        path: Some(canonical),
    };
    log::info!("DB connected, migrations applied");

    // Watch the workspace file so external writes (e.g. the CLI) live-refresh
    // the open app. Self-caused writes are filtered out on the frontend.
    watch::start(app, path);
    Ok(())
}

/// Switch the workspace at runtime — close the current pool (flushes WAL),
/// open the new file, run migrations.
///
/// Without this command, workspace switching requires an app restart since
/// `connect_db` is intentionally idempotent. The mutex is held for the full
/// close+open cycle so a stray query during the swap fails fast rather than
/// hitting a half-closed pool.
#[tauri::command]
pub async fn switch_workspace(path: String, state: tauri::State<'_, DbState>) -> AppResult<()> {
    let canonical = canonicalize_path(&path);

    let mut guard = state.inner.lock().await;
    // Fast-path: same workspace — nothing to do.
    if guard.path.as_ref() == Some(&canonical) {
        return Ok(());
    }

    // Close the existing pool first so the WAL is flushed and SQLite file
    // handles release before we open the new file. On Windows this is
    // mandatory; on Unix it's good hygiene.
    if let Some(old) = guard.pool.take() {
        old.close().await;
        log::info!("DB pool closed for workspace switch");
    }
    guard.path = None;

    let pool = open_pool(&path).await?;
    *guard = DbStateInner {
        pool: Some(pool),
        path: Some(canonical),
    };
    log::info!("DB switched to new workspace, migrations applied");
    Ok(())
}

/// Shared by `connect_db` and `switch_workspace`: open via pikos-db (schema,
/// migrations, pragmas, content_text backfill, FTS rebuild all live there) then
/// run app-only housekeeping.
async fn open_pool(path: &str) -> AppResult<SqlitePool> {
    let pool = pikos_db::open_pool(path).await?;
    crate::notifications::scheduler::prune_notification_log(&pool).await?;
    Ok(pool)
}

// Tests import test_pool / insert_test_* / TestPage directly from `pikos_db`
// (its `test-support` feature is enabled in this crate's dev-dependencies).
// Sharing the upstream fixtures keeps tests on the same migration tree as
// production — no separate apps/desktop/src-tauri/migrations/ to drift against.

// Cross-module workflow + real-pool integration tests. They drive pikos-db's
// public API the way the app does (pages + folders + schedules + search through
// one pool). They live in this crate, not pikos-db, because CI runs the Rust
// suite from here — pikos-db's own #[cfg(test)] modules never execute in CI
// (the root workspace excludes this package). See the file header for detail.
#[cfg(test)]
#[path = "workflows_tests.rs"]
mod workflows_tests;
