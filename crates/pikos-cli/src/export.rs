//! `pikos export`: the workspace written out by the same builders the apps use.

use std::path::Path;

use pikos_db::error::AppResult;
use serde_json::json;
use sqlx::SqlitePool;

use crate::error::{classify, CliError};
use crate::render::print_json;

#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum Format {
    Markdown,
    Csv,
    Ics,
    Sqlite,
}

/// Write the export to `out`, refusing a path that already exists, since an unattended
/// export that replaced the previous night's copy would leave nothing to fall back on.
pub async fn export(
    pool: &SqlitePool,
    db_path: &str,
    format: Format,
    out: &Path,
    include_synced: bool,
    json: bool,
) -> Result<(), CliError> {
    if out.exists() {
        return Err(CliError::conflict(format!(
            "\"{}\" already exists; export never overwrites. Choose a new --out.",
            out.display()
        )));
    }

    write(pool, db_path, format, out, include_synced)
        .await
        .map_err(classify)?;

    if json {
        print_json(&json!({ "path": out }));
    } else {
        println!("{}", out.display());
    }

    Ok(())
}

async fn write(
    pool: &SqlitePool,
    db_path: &str,
    format: Format,
    out: &Path,
    include_synced: bool,
) -> AppResult<()> {
    match format {
        Format::Markdown => {
            let workspace_dir = Path::new(db_path).parent().unwrap_or(Path::new("."));
            let assets_dir = workspace_dir.join(pikos_db::assets::ASSET_DIR);
            pikos_db::export::write_markdown_export(pool, out, &assets_dir, include_synced)
                .await?;
        }
        Format::Csv => {
            let csv = pikos_db::export::build_export_csv(pool, include_synced).await?;
            std::fs::write(out, csv)?;
        }
        Format::Ics => {
            let ics = pikos_db::export_ics::build_export_ics(pool, include_synced).await?;
            std::fs::write(out, ics)?;
        }
        Format::Sqlite => {
            pikos_db::export::backup_to(pool, &out.to_string_lossy()).await?;
        }
    }

    Ok(())
}
