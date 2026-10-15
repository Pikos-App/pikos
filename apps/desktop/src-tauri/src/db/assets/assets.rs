//! Asset storage commands: save files to the workspace assets directory.
//! Assets live in {appDataDir}/assets/{uuid}.{ext} — never as BLOBs in SQLite.
//! Pages store the path relative to the app data dir (`assets/<uuid>.<ext>`), and
//! [`resolve_asset_path`] turns a stored path back into a file on this machine.

use std::path::{Path, PathBuf};
use tauri::Manager;

use crate::error::{AppError, AppResult};

const ALLOWED_IMAGE_EXTENSIONS: [&str; 9] = [
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
];

/// The folder under the app data dir that holds every image a page embeds.
pub(crate) const ASSET_DIR: &str = "assets";

/// True for the `<uuid>.<ext>` names [`save_asset`] gives the files it writes.
fn is_pikos_asset_name(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    stem.len() == 36
        && uuid::Uuid::parse_str(stem).is_ok()
        && !ext.is_empty()
        && ext.chars().all(|c| c.is_ascii_alphanumeric())
}

/// The file a page's stored image path names, inside this machine's `assets_dir`.
///
/// Pages store `assets/<file>`, so a workspace copied to another Mac, another user or
/// another build still finds its images. Images saved by earlier versions stored the
/// full path on the machine that saved them; one that ends in an assets folder and a
/// name Pikos generated is read as that file here, which heals those pages without
/// rewriting them. Any other path is not one Pikos saved and comes back unchanged.
///
/// `resolveAssetPath` in `@pikos/core` runs the same rule against the same table,
/// `asset-paths.json`.
pub(crate) fn resolve_asset_path(assets_dir: &Path, stored: &str) -> PathBuf {
    let parts: Vec<&str> = stored.split(['/', '\\']).collect();
    let name = parts.last().copied().unwrap_or("");
    if parts.len() == 2 && parts[0] == ASSET_DIR {
        return assets_dir.join(name);
    }
    let bytes = stored.as_bytes();
    let absolute = stored.starts_with('/')
        || (bytes.len() > 2
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'/' || bytes[2] == b'\\'));
    let in_asset_dir = parts.len() >= 2 && parts[parts.len() - 2] == ASSET_DIR;
    if absolute && in_asset_dir && is_pikos_asset_name(name) {
        return assets_dir.join(name);
    }
    PathBuf::from(stored)
}

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
    let assets_dir = app_data.join(ASSET_DIR);
    std::fs::create_dir_all(&assets_dir)?;
    Ok(assets_dir.to_string_lossy().to_string())
}

/// Copy a file into the workspace assets directory with a UUID-based filename.
/// Returns the stored path, `assets/<uuid>.<ext>`.
#[tauri::command]
pub async fn save_asset(app: tauri::AppHandle, source_path: String) -> AppResult<String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(format!("Failed to get app data dir: {e}")))?;
    save_asset_into_dir(&app_data.join(ASSET_DIR), &source_path).await
}

/// The filesystem core of [`save_asset`], split out from the `AppHandle` /
/// `app_data_dir()` plumbing so the validate→copy→relative-name behaviour is
/// testable against a temp directory without a Tauri runtime. Validates the
/// source exists and is an allowed image type, then copies it to
/// `<assets_dir>/<uuid>.<ext>` and returns its stored path.
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
    spawn_blocking_io(move || std::fs::copy(&source, &dest).map(|_| ())).await?;

    Ok(format!("{ASSET_DIR}/{filename}"))
}

/// Copy raw bytes into the workspace assets directory (for paste from clipboard).
/// Returns the stored path, `assets/<uuid>.<ext>`.
#[tauri::command]
pub async fn save_asset_bytes(
    app: tauri::AppHandle,
    data: Vec<u8>,
    ext: String,
) -> AppResult<String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(format!("Failed to get app data dir: {e}")))?;
    save_bytes_into_dir(&app_data.join(ASSET_DIR), data, &ext).await
}

/// The filesystem core of [`save_asset_bytes`], split out for the same reason as
/// [`save_asset_into_dir`].
async fn save_bytes_into_dir(assets_dir: &Path, data: Vec<u8>, ext: &str) -> AppResult<String> {
    let ext = validate_image_ext(ext)?;
    std::fs::create_dir_all(assets_dir)?;

    let filename = format!("{}.{ext}", uuid::Uuid::new_v4());
    let dest = assets_dir.join(&filename);
    spawn_blocking_io(move || std::fs::write(&dest, &data)).await?;

    Ok(format!("{ASSET_DIR}/{filename}"))
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
