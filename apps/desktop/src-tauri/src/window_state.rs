//! Window size and position, saved and restored.
//!
//! Geometry is persisted in **logical** pixels, not physical. A window saved on a 2x
//! display and restored at the same physical size on a 1x display comes back twice as
//! large, which macOS treats as zoomed and disables the native title-bar drag. Logical
//! pixels round-trip across scale factors. On restore, size and position are clamped to
//! the target monitor's visible work area, so a stale or corrupted file (or a
//! disconnected monitor) can never leave the window off-screen or larger than the screen.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Runtime};

const FILE_NAME: &str = "window-state.json";

#[derive(Debug, Serialize, Deserialize)]
struct SavedState {
    width: f64,
    height: f64,
    x: f64,
    y: f64,
}

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

/// Shrinks the size to the work area, then pulls the position back so the whole window stays visible.
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

/// No-op if the state file is missing or corrupted: the window keeps the config default.
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

    // Reject bogus sizes so a corrupted file can't produce an unusable window.
    if state.width < 200.0 || state.height < 200.0 {
        return;
    }

    // macOS reports monitor coordinates as global points, which match our logical units.
    // Falls back to the current then primary monitor; with none resolvable, geometry is applied unclamped.
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

/// Silently no-ops on any error.
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
        if let Err(e) = fs::create_dir_all(parent) {
            log::warn!("window state: could not create its folder: {e}");
        }
    }
    if let Ok(json) = serde_json::to_string_pretty(&state) {
        if let Err(e) = fs::write(&path, json) {
            log::warn!("window state: could not save the window's size and position: {e}");
        }
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
        // Physical size restored as logical is too big.
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
