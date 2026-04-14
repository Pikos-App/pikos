// assets.rs — Asset storage commands: save files to the workspace assets directory.
// Assets live in {appDataDir}/assets/{uuid}.{ext} — never as BLOBs in SQLite.
// The DB stores relative paths only (e.g. "assets/abc123.png") so workspaces stay portable.

use std::path::Path;
use tauri::Manager;

/// Ensure the workspace assets directory exists. Called during workspace init.
#[tauri::command]
pub async fn init_assets_dir(app: tauri::AppHandle) -> Result<String, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;
    let assets_dir = app_data.join("assets");
    std::fs::create_dir_all(&assets_dir)
        .map_err(|e| format!("Failed to create assets dir: {e}"))?;
    Ok(assets_dir.to_string_lossy().to_string())
}

/// Copy a file into the workspace assets directory with a UUID-based filename.
/// Returns the absolute path to the saved asset (frontend converts to asset:// URL).
#[tauri::command]
pub async fn save_asset(
    app: tauri::AppHandle,
    source_path: String,
) -> Result<String, String> {
    let source = Path::new(&source_path);

    if !source.exists() {
        return Err(format!("Source file does not exist: {}", source_path));
    }

    // Extract extension from source filename
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin")
        .to_lowercase();

    // Validate it's a known image type
    let allowed = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"];
    if !allowed.contains(&ext.as_str()) {
        return Err(format!("Unsupported image format: .{ext}"));
    }

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;
    let assets_dir = app_data.join("assets");
    std::fs::create_dir_all(&assets_dir)
        .map_err(|e| format!("Failed to create assets dir: {e}"))?;

    let id = uuid::Uuid::new_v4().to_string();
    let filename = format!("{}.{}", id, ext);
    let dest = assets_dir.join(&filename);

    std::fs::copy(source, &dest)
        .map_err(|e| format!("Failed to copy asset: {e}"))?;

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
) -> Result<String, String> {
    let ext = ext.to_lowercase();
    let allowed = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"];
    if !allowed.contains(&ext.as_str()) {
        return Err(format!("Unsupported image format: .{ext}"));
    }

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;
    let assets_dir = app_data.join("assets");
    std::fs::create_dir_all(&assets_dir)
        .map_err(|e| format!("Failed to create assets dir: {e}"))?;

    let id = uuid::Uuid::new_v4().to_string();
    let filename = format!("{}.{}", id, ext);
    let dest = assets_dir.join(&filename);

    std::fs::write(&dest, &data)
        .map_err(|e| format!("Failed to write asset: {e}"))?;

    Ok(dest.to_string_lossy().to_string())
}
