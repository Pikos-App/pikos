//! The in-app benchmark, compiled only with `--features bench`.
//!
//! A bench build (frontend built with `VITE_BENCH=true`) opens the workspace named by
//! `PIKOS_BENCH_DB` instead of the user's, lets the frontend time real interactions in the real
//! window, writes them to `PIKOS_BENCH_OUT`, and quits. `pikos stress bench` times the database;
//! this times what a person waits for, including the hop to the window and the drawing.

use std::sync::OnceLock;
use std::time::Instant;

use serde::Serialize;
use tauri::ipc::Invoke;

static STARTED: OnceLock<Instant> = OnceLock::new();

/// Called first thing in `run`, so launch time counts from process start rather than from the
/// window appearing.
pub fn mark_start() {
    STARTED.get_or_init(Instant::now);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchSession {
    db: String,
    uptime_ms: f64,
}

#[tauri::command]
pub fn bench_session() -> Result<BenchSession, String> {
    let db =
        std::env::var("PIKOS_BENCH_DB").map_err(|_| "PIKOS_BENCH_DB is not set".to_string())?;
    let uptime_ms = STARTED
        .get()
        .map_or(0.0, |s| s.elapsed().as_secs_f64() * 1000.0);
    Ok(BenchSession { db, uptime_ms })
}

#[tauri::command]
pub fn bench_finish(app: tauri::AppHandle, results: serde_json::Value) -> Result<(), String> {
    let out =
        std::env::var("PIKOS_BENCH_OUT").map_err(|_| "PIKOS_BENCH_OUT is not set".to_string())?;
    let body = serde_json::to_vec_pretty(&results).map_err(|e| e.to_string())?;
    std::fs::write(&out, body).map_err(|e| format!("writing {out}: {e}"))?;
    app.exit(0);
    Ok(())
}

/// The app's handler with the two bench commands answered first, so the main registration list
/// doesn't change shape for a build that carries them.
pub fn wrap(
    handler: impl Fn(Invoke) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke) -> bool + Send + Sync + 'static {
    let bench: fn(Invoke) -> bool = tauri::generate_handler![bench_session, bench_finish];
    move |invoke: Invoke| {
        if matches!(invoke.message.command(), "bench_session" | "bench_finish") {
            bench(invoke)
        } else {
            handler(invoke)
        }
    }
}
