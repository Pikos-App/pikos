//! Plants the desktop's seed scenarios into a workspace file outside the app, for
//! a device that cannot run the TypeScript seeds itself: the iOS simulator.
//!
//! `apps/desktop/scripts/seed-workspace/main.ts` drives it. That script runs the
//! desktop's own storage adapter with its Tauri `invoke` pointed at this process,
//! so each request line is `{id, cmd, args}` carrying exactly the command name and
//! args the app would send.

use std::io::{BufRead, Write};

use pikos_db::{AppError, AppResult};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
struct Request {
    id: u64,
    cmd: String,
    #[serde(default)]
    args: Value,
}

/// The two dev commands a seed calls that are written by hand rather than
/// declared in `db_commands!`, so the generated dispatcher cannot answer them.
async fn dispatch(pool: &sqlx::SqlitePool, cmd: &str, args: &Value) -> AppResult<Value> {
    match cmd {
        "backdate_page" => {
            let params = serde_json::from_value(args.get("params").cloned().unwrap_or_default())?;
            pikos_lib::backdate_page_impl(pool, params).await?;
            Ok(Value::Null)
        }
        "dev_seed_synced_calendar" => {
            pikos_lib::dev_seed_synced_calendar_impl(pool).await?;
            Ok(Value::Null)
        }
        other => pikos_lib::dispatch_db_command(pool, other, args)
            .await
            .unwrap_or_else(|| {
                Err(AppError::Invalid(format!(
                    "seed_workspace does not answer `{other}`"
                )))
            }),
    }
}

async fn serve(path: &str) {
    let pool = match pikos_db::open_pool(path).await {
        Ok(pool) => pool,
        Err(e) => {
            eprintln!("seed_workspace: could not open {path}: {e}");
            std::process::exit(1);
        }
    };

    let mut stdout = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines() {
        let line = line.expect("read stdin");
        if line.trim().is_empty() {
            continue;
        }
        let request: Request = serde_json::from_str(&line).expect("malformed request line");
        let reply = match dispatch(&pool, &request.cmd, &request.args).await {
            Ok(value) => json!({ "id": request.id, "ok": true, "value": value }),
            Err(error) => json!({ "id": request.id, "ok": false, "error": error }),
        };
        writeln!(stdout, "{reply}").expect("write stdout");
        stdout.flush().expect("flush stdout");
    }

    // The file alone is what gets copied onto a device, so the WAL is folded in
    // here rather than left to close: the pool's connections close on worker
    // threads, and the process can exit before the last one checkpoints.
    let (busy, _, _): (i64, i64, i64) = sqlx::query_as("PRAGMA wal_checkpoint(TRUNCATE)")
        .fetch_one(&pool)
        .await
        .expect("checkpoint the workspace");
    if busy != 0 {
        eprintln!("seed_workspace: checkpoint was blocked; {path}-wal still holds data");
        std::process::exit(1);
    }
    pool.close().await;
}

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: seed_workspace <workspace.sqlite>");
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
        .block_on(serve(&path));
}
