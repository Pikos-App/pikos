//! Asset storage commands: save files to the workspace assets directory.
//! Assets live in {appDataDir}/assets/{uuid}.{ext} — never as BLOBs in SQLite.
//! Pages store the path relative to the app data dir (`assets/<uuid>.<ext>`), and
//! [`resolve_asset_path`] turns a stored path back into a file on this machine.

use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use sqlx::SqlitePool;
use tauri::Manager;

use crate::error::{AppError, AppResult};

const ALLOWED_IMAGE_EXTENSIONS: [&str; 9] = [
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
];

pub(crate) use pikos_db::assets::{is_pikos_asset_name, ASSET_DIR};

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

/// How recently written an image must be to survive a collection whatever refers to it. The file
/// is written before the page that refers to it is saved, so a quit or crash between the two
/// leaves an image no page names yet.
const UNREFERENCED_GRACE: Duration = Duration::from_secs(24 * 60 * 60);

/// Collects in the background for the workspace just opened, if it is the one beside the app's
/// assets folder. Any other file, such as a bench or e2e scratch workspace, shares the folder
/// without sharing its pages, so collecting from it would remove the real workspace's images.
pub(crate) fn collect_after_launch(
    app: &tauri::AppHandle,
    pool: SqlitePool,
    workspace_path: String,
) {
    let Ok(app_data) = app.path().app_data_dir() else {
        return;
    };
    let workspace_dir = Path::new(&workspace_path)
        .parent()
        .and_then(|dir| dir.canonicalize().ok());
    let owns_assets = workspace_dir.is_some() && workspace_dir == app_data.canonicalize().ok();
    if !owns_assets {
        return;
    }

    tauri::async_runtime::spawn(async move {
        let assets_dir = app_data.join(ASSET_DIR);
        match collect_unreferenced(&pool, &workspace_path, &assets_dir, SystemTime::now()).await {
            Ok(0) => {}
            Ok(removed) => log::info!("assets: removed {removed} image(s) no page refers to"),
            Err(e) => log::warn!("assets: collecting unreferenced images failed: {e}"),
        }
    });
}

/// Removes the images in `assets_dir` that no page, trashed page or backup of the workspace
/// refers to, and returns how many went. Only files named as [`save_asset`] names them are
/// touched, and none written within [`UNREFERENCED_GRACE`].
///
/// The one place an image is deleted. Once iCloud sync exists it may run only after synced
/// content has converged, since a page held on another device can still refer to an image no page
/// here does, and it never deletes the cloud copy.
pub(crate) async fn collect_unreferenced(
    pool: &SqlitePool,
    workspace_path: &str,
    assets_dir: &Path,
    now: SystemTime,
) -> AppResult<usize> {
    let referenced = pikos_db::assets::referenced_asset_paths(pool, workspace_path).await?;
    let keep: HashSet<OsString> = referenced
        .iter()
        .map(|stored| resolve_asset_path(assets_dir, stored))
        .filter(|path| path.parent() == Some(assets_dir))
        .filter_map(|path| path.file_name().map(ToOwned::to_owned))
        .collect();

    let assets_dir = assets_dir.to_path_buf();
    spawn_blocking_io(move || remove_unreferenced(&assets_dir, &keep, now)).await
}

fn remove_unreferenced(
    assets_dir: &Path,
    keep: &HashSet<OsString>,
    now: SystemTime,
) -> std::io::Result<usize> {
    let entries = match std::fs::read_dir(assets_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e),
    };

    let mut removed = 0;
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let is_ours = name.to_str().is_some_and(is_pikos_asset_name);
        if !is_ours || keep.contains(&name) {
            continue;
        }

        let modified = entry.metadata()?.modified()?;
        let is_recent = now
            .duration_since(modified)
            .map_or(true, |age| age < UNREFERENCED_GRACE);
        if is_recent {
            continue;
        }

        std::fs::remove_file(entry.path())?;
        removed += 1;
    }

    Ok(removed)
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
