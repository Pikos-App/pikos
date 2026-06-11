//! Asset storage commands: save files to the workspace assets directory.
//! Assets live in {appDataDir}/assets/{uuid}.{ext} — never as BLOBs in SQLite.
//! The DB stores relative paths only (e.g. "assets/abc123.png") so workspaces stay portable.

use std::path::Path;
use tauri::Manager;

use crate::error::{AppError, AppResult};

const ALLOWED_IMAGE_EXTENSIONS: [&str; 9] = [
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
];

fn validate_image_ext(ext: &str) -> AppResult<String> {
    let ext = ext.to_lowercase();
    if !ALLOWED_IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(AppError::Invalid(format!(
            "Unsupported image format: .{ext}"
        )));
    }
    Ok(ext)
}

fn ext_from_path(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin")
        .to_lowercase()
}

async fn spawn_blocking_io<F, T>(f: F) -> AppResult<T>
where
    F: FnOnce() -> std::io::Result<T> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Internal(format!("blocking task panicked: {e}")))?
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn init_assets_dir(app: tauri::AppHandle) -> AppResult<String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(format!("Failed to get app data dir: {e}")))?;
    let assets_dir = app_data.join("assets");
    std::fs::create_dir_all(&assets_dir)?;
    Ok(assets_dir.to_string_lossy().to_string())
}

/// Copy a file into the workspace assets directory with a UUID-based filename.
/// Returns the absolute path to the saved asset (frontend converts to asset:// URL).
#[tauri::command]
pub async fn save_asset(app: tauri::AppHandle, source_path: String) -> AppResult<String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(format!("Failed to get app data dir: {e}")))?;
    save_asset_into_dir(&app_data.join("assets"), &source_path).await
}

/// The filesystem core of [`save_asset`], split out from the `AppHandle` /
/// `app_data_dir()` plumbing so the validate→copy→relative-name behaviour is
/// testable against a temp directory without a Tauri runtime. Validates the
/// source exists and is an allowed image type, then copies it to
/// `<assets_dir>/<uuid>.<ext>` and returns the absolute destination path.
async fn save_asset_into_dir(assets_dir: &Path, source_path: &str) -> AppResult<String> {
    let source = Path::new(source_path);

    if !source.exists() {
        return Err(AppError::NotFound(format!(
            "Source file does not exist: {source_path}"
        )));
    }

    let ext = validate_image_ext(&ext_from_path(source))?;

    std::fs::create_dir_all(assets_dir)?;

    let id = uuid::Uuid::new_v4().to_string();
    let filename = format!("{id}.{ext}");
    let dest = assets_dir.join(&filename);

    let source = source.to_path_buf();
    let dest_for_copy = dest.clone();
    spawn_blocking_io(move || std::fs::copy(&source, &dest_for_copy).map(|_| ())).await?;

    // Return absolute path — frontend uses convertFileSrc() to make it loadable
    Ok(dest.to_string_lossy().to_string())
}

/// Copy raw bytes into the workspace assets directory (for paste from clipboard).
/// Returns the absolute path to the saved asset.
#[tauri::command]
pub async fn save_asset_bytes(
    app: tauri::AppHandle,
    data: Vec<u8>,
    ext: String,
) -> AppResult<String> {
    let ext = validate_image_ext(&ext)?;

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(format!("Failed to get app data dir: {e}")))?;
    let assets_dir = app_data.join("assets");
    std::fs::create_dir_all(&assets_dir)?;

    let id = uuid::Uuid::new_v4().to_string();
    let filename = format!("{id}.{ext}");
    let dest = assets_dir.join(&filename);

    let dest_for_write = dest.clone();
    spawn_blocking_io(move || std::fs::write(&dest_for_write, &data)).await?;

    Ok(dest.to_string_lossy().to_string())
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
