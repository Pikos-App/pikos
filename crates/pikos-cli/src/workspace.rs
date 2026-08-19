//! Finding the workspace file and deciding whether we may touch it.
//!
//! One workspace file is shared with the installed desktop app, so resolving the
//! path and gating the (one-way) schema upgrade are the two things every entry
//! point — subcommands and the MCP server alike — must do identically.

use std::path::{Path, PathBuf};

use pikos_db::{migration_versions, open_pool};
use sqlx::SqlitePool;

use crate::error::{classify, CliError};

/// Debug builds address the `.dev` workspace the dev desktop app writes, mirroring
/// `tauri.conf.dev.json`: branch work must not be able to migrate the real
/// workspace and lock the installed app out of it.
const BUNDLE_IDENTIFIER: &str = if cfg!(debug_assertions) {
    "app.pikos.desktop.dev"
} else {
    "app.pikos.desktop"
};
const DB_FILENAME: &str = "default.sqlite";

fn platform_data_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    if cfg!(target_os = "windows") {
        std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(&home).join("AppData").join("Roaming"))
    } else if cfg!(target_os = "macos") {
        PathBuf::from(&home)
            .join("Library")
            .join("Application Support")
    } else {
        std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(&home).join(".local").join("share"))
    }
}

pub fn resolve_db_path(override_opt: &Option<String>) -> String {
    if let Some(p) = override_opt {
        return p.clone();
    }
    platform_data_dir()
        .join(BUNDLE_IDENTIFIER)
        .join(DB_FILENAME)
        .to_string_lossy()
        .into_owned()
}

/// Refuse to migrate the workspace forward unless the user asked for it — see
/// `pikos_db::migration_versions` for why a caller that doesn't own the file must
/// not. The upgrade is one-way; recovering the locked-out desktop app means
/// hand-editing `_sqlx_migrations`.
pub async fn require_migration_consent(path: &str, consented: bool) -> Result<(), CliError> {
    if consented {
        return Ok(());
    }
    let (embedded, applied) = migration_versions(path).await.map_err(classify)?;
    let Some(applied) = applied.filter(|a| embedded > *a) else {
        return Ok(());
    };
    Err(CliError::migration_required(format!(
        "This workspace is at schema v{applied}; this Pikos CLI carries v{embedded}. \
         Upgrading is one-way — the installed Pikos app will refuse to open the workspace \
         until it is updated too. Update the app first, or re-run with --migrate."
    )))
}

/// Resolve, gate and open the workspace — the prologue every entry point runs.
///
/// `open_pool` runs the migrator, which fails closed (`VersionMissing` → mapped
/// to `SchemaTooNew` in [`classify`]) when the workspace schema is newer than
/// this build, so a stale CLI can never write against an unknown schema.
pub async fn open_workspace(
    db_override: &Option<String>,
    migrate: bool,
) -> Result<SqlitePool, CliError> {
    let path = resolve_db_path(db_override);
    if !Path::new(&path).exists() {
        return Err(CliError::workspace(format!(
            "No Pikos workspace found at \"{path}\". Open the desktop app once to create it, or pass --db."
        )));
    }
    require_migration_consent(&path, migrate).await?;
    open_pool(&path).await.map_err(classify)
}
