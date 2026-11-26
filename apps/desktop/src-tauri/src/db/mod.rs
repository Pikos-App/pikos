use std::path::{Path, PathBuf};

use sqlx::SqlitePool;
use tokio::sync::Mutex;

use crate::error::{AppError, AppResult};

#[path = "assets/assets.rs"]
pub mod assets;
pub mod commands;
pub mod dev;
#[cfg(all(target_os = "macos", feature = "icloud-sync"))]
mod icloud;
pub mod icloud_settings;
#[path = "schedules/schedules.rs"]
pub mod schedules;
pub mod sync;
pub mod sync_loop;
#[path = "watch.rs"]
mod watch;

// The command modules `db_commands!` generates, surfaced here by name. `schedules` and
// `sync` also hold hand-written commands, so they pull their generated half in themselves.
pub use commands::{focus, folders, notifications, pages, replica, search, tags, windows};

/// None until connect_db is called. The canonical path makes a repeated connect_db with
/// the *same* path a no-op (the mount effect fires twice under StrictMode), while a
/// *different* path is a programming error: the app connects one workspace per launch.
pub struct DbState {
    inner: Mutex<DbStateInner>,
}

#[derive(Default)]
struct DbStateInner {
    pool: Option<SqlitePool>,
    /// Canonicalised, so two paths to one file (e.g. one with `..`) are one workspace and
    /// never open a second pool. `None` matches the empty `pool`.
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

    pub(crate) async fn current_path(&self) -> Option<PathBuf> {
        self.inner.lock().await.path.clone()
    }

    pub(crate) async fn take_pool(&self) -> Option<SqlitePool> {
        let mut guard = self.inner.lock().await;
        guard.path = None;
        guard.pool.take()
    }

    /// Close the pool and keep the path, so the backups beside the file can still be
    /// listed and put back. Closing reaches every clone of the pool, so whatever else
    /// holds one stops with it.
    pub(crate) async fn close_keeping_path(&self) {
        let pool = self.inner.lock().await.pool.take();
        if let Some(pool) = pool {
            pool.close().await;
        }
    }

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

/// Best-effort canonical path; a file that doesn't exist yet (first run) is canonicalised
/// via its parent directory.
fn canonicalize_path(path: &str) -> PathBuf {
    let raw = std::path::Path::new(path);
    if let Ok(c) = raw.canonicalize() {
        return c;
    }
    if let (Some(parent), Some(name)) = (raw.parent(), raw.file_name()) {
        if let Ok(parent_c) = parent.canonicalize() {
            return parent_c.join(name);
        }
    }
    PathBuf::from(path)
}

/// A build opens a workspace only inside its own data folder. `workspaces.json` stores an
/// absolute path, so a data folder copied from another build still names that build's file, and
/// opening it would migrate it out from under the build that owns it. Checked before the open,
/// so a refused file is never touched. The bench build is exempt: it opens a scratch file named
/// by its environment.
#[cfg_attr(feature = "bench", allow(dead_code))]
fn ensure_inside_data_dir(canonical: &Path, data_dir: &Path) -> AppResult<()> {
    let data_dir = data_dir
        .canonicalize()
        .unwrap_or_else(|_| data_dir.to_path_buf());
    let is_inside = canonical.starts_with(&data_dir);
    if is_inside {
        return Ok(());
    }

    Err(AppError::Invalid(format!(
        "{} is outside this app's data folder {}, so it was not opened",
        canonical.display(),
        data_dir.display()
    )))
}

/// Idempotent for the **same** canonical path (the StrictMode double-mount warns so
/// regressions stay visible). A **different** path is refused: the frontend assumes
/// connect_db is the one-time bootstrap, and a different workspace means relaunching.
///
/// The mutex is held across `open_pool` so a concurrent second call waits and hits the
/// idempotent branch; two `open_pool`s on one file can return SQLITE_BUSY while
/// migrations / WAL recovery contend.
#[tauri::command]
pub async fn connect_db(
    path: String,
    state: tauri::State<'_, DbState>,
    app: tauri::AppHandle,
) -> AppResult<()> {
    let canonical = canonicalize_path(&path);

    #[cfg(not(feature = "bench"))]
    {
        let data_dir = tauri::Manager::path(&app)
            .app_data_dir()
            .map_err(|e| AppError::Internal(format!("Failed to get app data dir: {e}")))?;
        ensure_inside_data_dir(&canonical, &data_dir)?;
    }

    let mut guard = state.inner.lock().await;
    if let Some(existing) = guard.path.as_ref() {
        if existing == &canonical {
            log::warn!("connect_db invoked twice — pool already initialised, skipping reconnect");
            return Ok(());
        }
        return Err(AppError::Conflict(
            "DB already connected to a different workspace; relaunch to open another one".into(),
        ));
    }

    let pool = open_pool(&path).await?;
    assets::collect_after_launch(&app, pool.clone(), path.clone());
    *guard = DbStateInner {
        pool: Some(pool),
        path: Some(canonical),
    };
    log::info!("DB connected, migrations applied");

    #[cfg(all(target_os = "macos", feature = "icloud-sync"))]
    if let Some(pool) = guard.pool.clone() {
        icloud::attach(app.clone(), pool);
    }

    // Watch the workspace file so external writes (e.g. the CLI) live-refresh
    // the open app. Self-caused writes are filtered out on the frontend.
    watch::start(app, path);
    Ok(())
}

pub(crate) use pikos_db::Checkpoints;

/// In the background, telling the outside-change watcher each one is the app's own.
pub(crate) const APP_CHECKPOINTS: Checkpoints = Checkpoints::Background(watch::OWN_CHECKPOINTS);

/// The one place a pool is opened; pikos-db does schema and migrations, this adds the
/// app-only housekeeping.
pub(crate) async fn open_pool(path: &str) -> AppResult<SqlitePool> {
    let pool = pikos_db::open_pool_checkpointing(path, APP_CHECKPOINTS).await?;
    crate::notifications::scheduler::prune_notification_log(&pool).await?;
    // Soft-delete keeps a page forever on its own, and the trash promises "kept for 30 days",
    // so retention is swept once per launch, when nothing else is writing.
    let purged =
        pikos_db::purge_trashed_pages_older_than(&pool, pikos_db::TRASH_RETENTION_DAYS).await?;
    if purged > 0 {
        log::info!(
            "trash swept: {purged} page(s) past {TRASH_RETENTION_DAYS}-day retention destroyed",
            TRASH_RETENTION_DAYS = pikos_db::TRASH_RETENTION_DAYS
        );
    }
    Ok(pool)
}

// Tests take their fixtures (`test_pool`, `insert_test_*`, `TestPage`) from `pikos_db`'s
// `test-support` feature, so they share production's migration tree.

// Cross-module workflow tests drive pikos-db's public API the way the app does. They live
// here, not in pikos-db, because they assert how the desktop app composes those modules.
#[cfg(test)]
#[path = "workflows_tests.rs"]
mod workflows_tests;

#[cfg(test)]
#[path = "ipc_tests.rs"]
mod ipc_tests;

#[cfg(test)]
#[path = "data_dir_tests.rs"]
mod data_dir_tests;
