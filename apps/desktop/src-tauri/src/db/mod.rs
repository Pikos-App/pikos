use sqlx::SqlitePool;
use tokio::sync::Mutex;

pub mod folders;
pub mod pages;
pub mod schedules;
pub mod search;

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
            .ok_or_else(|| "No database connected. Call connect_db first.".to_string())
            .map(SqlitePool::clone)
    }
}

pub(crate) fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// Open (or create) a SQLite workspace at the given path and run migrations.
/// Called by WorkspaceContext when the user opens or creates a workspace.
#[tauri::command]
pub async fn connect_db(path: String, state: tauri::State<'_, DbState>) -> Result<(), String> {
    // Ensure the parent directory exists (e.g. ~/Library/Application Support/com.pikos.app/)
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

    *state.0.lock().await = Some(pool);
    Ok(())
}
