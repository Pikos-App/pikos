// Minimal window state save/restore. Replaces tauri-plugin-window-state
// because that plugin had a save/restore asymmetry causing the window to
// drift smaller on every launch cycle (exact cause unclear — likely an
// inner/outer size mismatch or a scale-factor round-trip bug).
//
// This module saves the inner size + outer position in physical pixels and
// restores them symmetrically via set_size / set_position. Same metric on
// both ends → no drift.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime};

const FILE_NAME: &str = "window-state.json";

#[derive(Debug, Serialize, Deserialize)]
struct SavedState {
    /// Inner (content area) width in physical pixels.
    width: u32,
    /// Inner (content area) height in physical pixels.
    height: u32,
    /// Outer window x position in physical pixels.
    x: i32,
    /// Outer window y position in physical pixels.
    y: i32,
}

fn state_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|p| p.join(FILE_NAME))
}

/// Called in setup after the main window exists. No-op if the state file
/// is missing or corrupted — the window keeps the config default.
pub fn restore<R: Runtime>(app: &AppHandle<R>) {
    let Some(path) = state_path(app) else { return };
    let Ok(data) = fs::read_to_string(&path) else { return };
    let Ok(state) = serde_json::from_str::<SavedState>(&data) else { return };
    let Some(window) = app.get_webview_window("main") else { return };

    // Sanity: reject obviously-bogus sizes so a corrupted file can't produce
    // an unusable window. Tauri's minWidth/minHeight also guard this.
    if state.width < 200 || state.height < 200 {
        return;
    }

    let _ = window.set_size(PhysicalSize::new(state.width, state.height));
    let _ = window.set_position(PhysicalPosition::new(state.x, state.y));
}

/// Called on WindowEvent::CloseRequested. Silently no-ops on any error.
pub fn save<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else { return };
    let Ok(size) = window.inner_size() else { return };
    let Ok(pos) = window.outer_position() else { return };

    let state = SavedState {
        width: size.width,
        height: size.height,
        x: pos.x,
        y: pos.y,
    };

    let Some(path) = state_path(app) else { return };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(&state) {
        let _ = fs::write(&path, json);
    }
}
