//! Minimal window state save/restore. Replaces tauri-plugin-window-state
//! because that plugin had a save/restore asymmetry causing the window to
//! drift smaller on every launch cycle (exact cause unclear — likely an
//! inner/outer size mismatch or a scale-factor round-trip bug).
//!
//! Geometry is persisted in **logical** pixels (size + position), not physical.
//! Storing physical pixels meant a window saved on a 2x display restored at the
//! same physical size on a 1x display — i.e. twice as large in logical terms —
//! so after moving between monitors of different scale the window came back
//! oversized, macOS treated it as zoomed, and the native title-bar drag was
//! disabled. Logical pixels round-trip across scale factors. On restore we also
//! clamp size + position to the target monitor's visible work area so a stale or
//! corrupted file (or a now-disconnected monitor) can never leave the window
//! off-screen or larger than the screen.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Runtime};

const FILE_NAME: &str = "window-state.json";

#[derive(Debug, Serialize, Deserialize)]
struct SavedState {
    /// Inner (content area) width in logical pixels.
    width: f64,
    /// Inner (content area) height in logical pixels.
    height: f64,
    /// Outer window x position in logical pixels.
    x: f64,
    /// Outer window y position in logical pixels.
    y: f64,
}

/// A logical-pixel rectangle (top-left origin), used for the work-area clamp.
#[derive(Debug, Clone, Copy, PartialEq)]
struct LogicalRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn state_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|p| p.join(FILE_NAME))
}

/// Clamp the saved geometry to fit within `area`: shrink the size to the
/// work area, then pull the position back so the whole window stays visible.
/// Pure math, unit-tested below — the Tauri-facing code just feeds it monitor
/// data.
fn clamp_to_work_area(saved: &SavedState, area: LogicalRect) -> SavedState {
    let width = saved.width.min(area.width);
    let height = saved.height.min(area.height);
    // After shrinking, max_* >= area origin, so the clamp range is always valid.
    let max_x = area.x + area.width - width;
    let max_y = area.y + area.height - height;
    SavedState {
        width,
        height,
        x: saved.x.clamp(area.x, max_x),
        y: saved.y.clamp(area.y, max_y),
    }
}

/// Called in setup after the main window exists. No-op if the state file
/// is missing or corrupted — the window keeps the config default.
pub fn restore<R: Runtime>(app: &AppHandle<R>) {
    let Some(path) = state_path(app) else { return };
    let Ok(data) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(state) = serde_json::from_str::<SavedState>(&data) else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    // Sanity: reject obviously-bogus sizes so a corrupted file can't produce
    // an unusable window. Tauri's minWidth/minHeight also guard this.
    if state.width < 200.0 || state.height < 200.0 {
        return;
    }

    // Find the monitor the saved position lands on (macOS reports monitor
    // coordinates as global points, which match our logical units). Fall back
    // to the current monitor, then the primary, so a disconnected display still
    // gives us something to clamp against. If no monitor is resolvable we apply
    // the saved geometry unclamped rather than refusing to restore.
    let center_x = state.x + state.width / 2.0;
    let center_y = state.y + state.height / 2.0;
    let monitor = window
        .monitor_from_point(center_x, center_y)
        .ok()
        .flatten()
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());

    let target = match monitor {
        Some(m) => {
            let scale = m.scale_factor();
            let wa = m.work_area();
            let area = LogicalRect {
                x: wa.position.x as f64 / scale,
                y: wa.position.y as f64 / scale,
                width: wa.size.width as f64 / scale,
                height: wa.size.height as f64 / scale,
            };
            clamp_to_work_area(&state, area)
        }
        None => state,
    };

    let _ = window.set_size(LogicalSize::new(target.width, target.height));
    let _ = window.set_position(LogicalPosition::new(target.x, target.y));
}

/// Called on every WindowEvent::Resized/Moved (CloseRequested doesn't fire
/// reliably on macOS Cmd+Q — see lib.rs). Silently no-ops on any error.
pub fn save<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let Ok(size) = window.inner_size() else {
        return;
    };
    let Ok(pos) = window.outer_position() else {
        return;
    };

    let size = size.to_logical::<f64>(scale);
    let pos = pos.to_logical::<f64>(scale);
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

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: LogicalRect = LogicalRect {
        x: 0.0,
        y: 25.0, // e.g. menu-bar inset
        width: 1440.0,
        height: 875.0,
    };

    fn geom(width: f64, height: f64, x: f64, y: f64) -> SavedState {
        SavedState {
            width,
            height,
            x,
            y,
        }
    }

    #[test]
    fn leaves_a_window_that_already_fits_untouched() {
        let r = clamp_to_work_area(&geom(1000.0, 700.0, 100.0, 100.0), AREA);
        assert_eq!((r.width, r.height, r.x, r.y), (1000.0, 700.0, 100.0, 100.0));
    }

    #[test]
    fn shrinks_a_window_larger_than_the_work_area() {
        // The monitor-scale bug: physical size restored as logical is too big.
        let r = clamp_to_work_area(&geom(2880.0, 1800.0, 0.0, 25.0), AREA);
        assert_eq!((r.width, r.height), (1440.0, 875.0));
        // Position pinned to the work-area origin since the window fills it.
        assert_eq!((r.x, r.y), (0.0, 25.0));
    }

    #[test]
    fn pulls_an_offscreen_window_back_onto_the_work_area() {
        // Far off the bottom-right of the display.
        let r = clamp_to_work_area(&geom(800.0, 600.0, 5000.0, 5000.0), AREA);
        assert_eq!(r.x, AREA.x + AREA.width - 800.0);
        assert_eq!(r.y, AREA.y + AREA.height - 600.0);
        assert_eq!((r.width, r.height), (800.0, 600.0));
    }

    #[test]
    fn clamps_negative_position_to_the_work_area_origin() {
        let r = clamp_to_work_area(&geom(800.0, 600.0, -500.0, -500.0), AREA);
        assert_eq!((r.x, r.y), (AREA.x, AREA.y));
    }
}
