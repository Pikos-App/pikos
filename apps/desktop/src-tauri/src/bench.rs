//! The in-app benchmark, compiled only with `--features bench`.
//!
//! A bench build (frontend built with `VITE_BENCH=true`) opens the workspace named by
//! `PIKOS_BENCH_DB` instead of the user's, lets the frontend time real interactions in the real
//! window, writes them to `PIKOS_BENCH_OUT`, and quits. `pikos stress bench` times the database;
//! this times what a person waits for, including the hop to the window and the drawing.

use std::process::Command;
use std::sync::OnceLock;
use std::time::Instant;

use serde::Serialize;
use tauri::ipc::Invoke;

use crate::db::DbState;

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchFolder {
    id: String,
    name: String,
}

/// What a launch opens and visits, chosen by querying the database rather than reading the
/// window's state, so the choice doesn't depend on how much of the workspace the window holds.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchPlan {
    open_pages: i64,
    /// Folders with at least one open page, by name.
    folders: Vec<BenchFolder>,
    /// Open pages spread across the whole workspace, the same ones on every launch of a corpus.
    pages: Vec<String>,
}

#[tauri::command]
pub async fn bench_plan(
    state: tauri::State<'_, DbState>,
    pages: usize,
) -> Result<BenchPlan, String> {
    let pool = state.get_pool().await.map_err(|e| e.to_string())?;
    let open_pages: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL AND status <> 'done'",
    )
    .fetch_one(&pool)
    .await
    .map_err(|e| e.to_string())?;
    let folders = sqlx::query_as::<_, (String, String)>(
        "SELECT f.id, f.name FROM folders f WHERE f.deleted_at IS NULL AND EXISTS (
           SELECT 1 FROM pages p
           WHERE p.folder_id = f.id AND p.deleted_at IS NULL AND p.status <> 'done')
         ORDER BY f.name",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| e.to_string())?
    .into_iter()
    .map(|(id, name)| BenchFolder { id, name })
    .collect();
    let max_rowid: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(rowid), 0) FROM pages")
        .fetch_one(&pool)
        .await
        .map_err(|e| e.to_string())?;
    let mut picked = Vec::new();
    let mut state = 0x5eed_u64;
    for _ in 0..pages * 20 {
        if picked.len() == pages || max_rowid == 0 {
            break;
        }
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        let rowid = (state >> 33) as i64 % max_rowid + 1;
        let id: Option<String> = sqlx::query_scalar(
            "SELECT id FROM pages WHERE rowid = ? AND deleted_at IS NULL AND status <> 'done'",
        )
        .bind(rowid)
        .fetch_optional(&pool)
        .await
        .map_err(|e| e.to_string())?;
        if let Some(id) = id.filter(|id| !picked.contains(id)) {
            picked.push(id);
        }
    }
    Ok(BenchPlan {
        open_pages,
        folders,
        pages: picked,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Footprint {
    bytes: u64,
    peak_bytes: u64,
}

/// Memory as Activity Monitor counts it, for this process and for the window's web content
/// process. WebKit starts that process outside this one's tree, so the benchmark script lists
/// the web content processes already running in `PIKOS_BENCH_KNOWN_WEBKIT` and the new one is
/// the window's.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchMemory {
    app: Option<Footprint>,
    window: Option<Footprint>,
    /// More than one means another app started a web view during the launch, and `window` is
    /// the largest of them.
    window_candidates: usize,
}

#[tauri::command]
pub fn bench_memory() -> BenchMemory {
    let known: Vec<u32> = std::env::var("PIKOS_BENCH_KNOWN_WEBKIT")
        .unwrap_or_default()
        .split(',')
        .filter_map(|p| p.trim().parse().ok())
        .collect();
    let candidates: Vec<u32> = Command::new("pgrep")
        .args(["-f", "com.apple.WebKit.WebContent"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
        .lines()
        .filter_map(|p| p.trim().parse().ok())
        .filter(|p| !known.contains(p))
        .collect();
    BenchMemory {
        app: footprint(std::process::id()),
        window: candidates
            .iter()
            .filter_map(|&pid| footprint(pid))
            .max_by_key(|f| f.bytes),
        window_candidates: candidates.len(),
    }
}

fn footprint(pid: u32) -> Option<Footprint> {
    let out = Command::new("footprint")
        .args(["--noCategories", "-f", "bytes", "--pid", &pid.to_string()])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let field = |name: &str| -> Option<u64> {
        text.lines()
            .find_map(|l| l.trim().strip_prefix(name))?
            .trim()
            .trim_end_matches('B')
            .trim()
            .parse()
            .ok()
    };
    Some(Footprint {
        bytes: field("phys_footprint:")?,
        peak_bytes: field("phys_footprint_peak:")?,
    })
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

/// The app's handler with the bench commands answered first, so the main registration list
/// doesn't change shape for a build that carries them.
pub fn wrap(
    handler: impl Fn(Invoke) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke) -> bool + Send + Sync + 'static {
    let bench: fn(Invoke) -> bool =
        tauri::generate_handler![bench_session, bench_plan, bench_memory, bench_finish];
    move |invoke: Invoke| {
        if matches!(
            invoke.message.command(),
            "bench_session" | "bench_plan" | "bench_memory" | "bench_finish"
        ) {
            bench(invoke)
        } else {
            handler(invoke)
        }
    }
}
