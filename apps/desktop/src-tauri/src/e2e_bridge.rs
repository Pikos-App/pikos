//! The real writer behind localhost HTTP, for the Playwright lane that runs in a
//! browser with no Tauri IPC. `apps/desktop/bridge/transport.ts` is the other half.
//!
//! Each spec names its own database with a token, and the bridge resolves the
//! token to a file inside a directory it owns. Specs run in parallel, and a
//! shared file would let one read another's rows; a token also keeps the browser
//! from naming a filesystem path.
//!
//! What a green run here cannot vouch for: IPC serialization, `asset://`, the
//! production CSP, native windows, the notification scheduler and the updater.

use std::collections::HashMap;
use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};

use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::header::{
    ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN,
    CONTENT_TYPE,
};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sqlx::SqlitePool;
use tokio::net::TcpListener;
use tokio::sync::{Mutex, OnceCell};

use crate::db;
use crate::error::{AppError, AppResult};

/// Must match `BRIDGE_ORIGIN` in `transport.ts`. Vite's HMR socket holds 1422.
const PORT: u16 = 1423;

pub type Args = Map<String, Value>;

/// A command's outcome as Tauri would settle it: the serialized value, or the
/// payload the promise rejects with.
pub type Reply = Result<Value, Value>;

#[derive(Deserialize)]
struct Call {
    command: String,
    #[serde(default)]
    args: Args,
    db: String,
}

struct Bridge {
    dir: PathBuf,
    /// A cell per token, so two tabs connecting one database at once (React's
    /// dev double-mount) open it once rather than racing its migrations.
    pools: Mutex<HashMap<String, Arc<OnceCell<SqlitePool>>>>,
}

/// What the writer logged, for `bridge_log`. The app sends the same `log` calls to
/// `pikos.log`; the lane has no such file, and a test asserting a logged warning
/// reads it here. One list for every database, so a test looks for its own line.
static LOGGED: LazyLock<std::sync::Mutex<Vec<String>>> = LazyLock::new(Default::default);

struct CaptureLog;

impl log::Log for CaptureLog {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let line = format!("{} {}", record.level(), record.args());
        eprintln!("e2e bridge: {line}");
        if let Ok(mut lines) = LOGGED.lock() {
            lines.push(line);
        }
    }

    fn flush(&self) {}
}

pub fn run() {
    if log::set_logger(&CaptureLog).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("e2e bridge: could not start the runtime");
    if let Err(e) = runtime.block_on(serve()) {
        eprintln!("e2e bridge: {e}");
        std::process::exit(1);
    }
}

async fn serve() -> std::io::Result<()> {
    // The lane pins the browser's zone and passes the same one here as `TZ`. The
    // writer reads its own zone elsewhere (on Linux, `/etc/localtime`), and a
    // mismatch renders every synced time shifted while the tests still find blocks.
    if let Ok(tz) = std::env::var("TZ") {
        let device = pikos_db::device_zone();
        if device.name() != tz {
            return Err(std::io::Error::other(format!(
                "TZ is {tz} but the writer's device zone is {device}; on Linux, /etc/localtime decides it"
            )));
        }
    }

    let listener = TcpListener::bind(("127.0.0.1", PORT)).await?;

    // Fixed rather than per-process: the port already makes the bridge one per
    // machine, and a fixed directory is one that the next run clears.
    let dir = std::env::temp_dir().join("pikos-e2e-bridge");
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    std::fs::create_dir_all(&dir)?;
    eprintln!(
        "e2e bridge: listening on 127.0.0.1:{PORT}, device zone {}, databases in {}",
        pikos_db::device_zone().name(),
        dir.display()
    );

    let bridge = Arc::new(Bridge {
        dir,
        pools: Mutex::default(),
    });
    loop {
        let (stream, _) = listener.accept().await?;
        let bridge = bridge.clone();
        tokio::spawn(async move {
            let service = service_fn(move |req| handle(bridge.clone(), req));
            if let Err(e) = http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .await
            {
                eprintln!("e2e bridge: connection error: {e}");
            }
        });
    }
}

async fn handle(
    bridge: Arc<Bridge>,
    req: Request<Incoming>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    // The page is served from Vite's port, so every call is cross-origin and a
    // JSON body makes the browser ask first.
    if req.method() == Method::OPTIONS {
        return Ok(respond(StatusCode::NO_CONTENT, Bytes::new()));
    }
    if req.method() != Method::POST || req.uri().path() != "/command" {
        return Ok(respond(StatusCode::NOT_FOUND, Bytes::new()));
    }

    let body = match req.into_body().collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(e) => {
            return Ok(respond_json(
                StatusCode::BAD_REQUEST,
                json!({ "error": e.to_string() }),
            ))
        }
    };
    let call = match serde_json::from_slice::<Call>(&body) {
        Ok(call) => call,
        Err(e) => {
            let error = format!("malformed bridge call: {e}");
            return Ok(respond_json(
                StatusCode::BAD_REQUEST,
                json!({ "error": error }),
            ));
        }
    };

    let payload = match bridge.call(call).await {
        Ok(value) => json!({ "value": value }),
        Err(error) => json!({ "error": error }),
    };
    Ok(respond_json(StatusCode::OK, payload))
}

impl Bridge {
    async fn call(
        &self,
        Call {
            command,
            mut args,
            db,
        }: Call,
    ) -> Reply {
        match command.as_str() {
            // The path the page passes is its token; the token alone decides the file.
            "connect_db" => return self.pool(&db).await.map(|_| Value::Null).map_err(app_error),
            "google_sync_available" => {
                return Ok(Value::Bool(db::sync::google_sync_available()));
            }
            "bridge_log" => return to_value(LOGGED.lock().map(|l| l.clone()).unwrap_or_default()),
            "expand_recurrence_range" => {
                let rules = arg(&mut args, "rules")?;
                let range_start = arg(&mut args, "range_start")?;
                let range_end = arg(&mut args, "range_end")?;
                return to_value(
                    db::schedules::expand_recurrence_range(rules, range_start, range_end).await,
                );
            }
            _ => {}
        }

        let pool = self.connected(&db).await.map_err(app_error)?;
        match command.as_str() {
            "dev_seed_synced_calendar" => {
                return reply(db::dev::dev_seed_synced_calendar_impl(&pool).await);
            }
            // Skips the app's keychain disconnect, which the bridge refuses everywhere.
            "reset_db" => return reply(db::dev::reset_db_impl(&pool).await),
            // The app writes these beside the workspace in its data directory; here the
            // token's own folder stands in for it, so one test never lists another's.
            "backup_db_before_import" => {
                let stamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S%.3f");
                let dir = pikos_db::backups_dir(&self.workspace_path(&db));
                std::fs::create_dir_all(&dir).map_err(|e| app_error(AppError::from(e)))?;
                let dest = dir
                    .join(format!("pre-import-{stamp}.sqlite"))
                    .to_string_lossy()
                    .into_owned();
                return reply(db::dev::vacuum_into(&pool, &dest).await.map(|()| dest));
            }
            "list_backups" => return reply(pikos_db::list_backups(&self.workspace_path(&db))),
            "get_usage_stats" => {
                let week_start = arg(&mut args, "week_start")?;
                return reply(db::dev::get_usage_stats_impl(&pool, week_start).await);
            }
            // The app also pokes the sync loop after enabling; the bridge runs none.
            "toggle_sync_calendar" => {
                let sync_calendar_id: String = arg(&mut args, "sync_calendar_id")?;
                let enabled = arg(&mut args, "enabled")?;
                let color: Option<String> = arg(&mut args, "color")?;
                return reply(
                    pikos_db::toggle_sync_calendar_impl(
                        &pool,
                        &sync_calendar_id,
                        enabled,
                        color.as_deref(),
                    )
                    .await,
                );
            }
            _ => {}
        }
        db::commands::bridge::dispatch(&pool, &command, args)
            .await
            .unwrap_or_else(|| {
                Err(Value::String(format!(
                    "{command} is not reachable over the e2e bridge"
                )))
            })
    }

    /// Open the token's database, creating and migrating it on first use.
    async fn pool(&self, token: &str) -> AppResult<SqlitePool> {
        let cell = self.cell(token).await?;
        let path = self.workspace_path(token);
        std::fs::create_dir_all(self.dir.join(token))?;
        cell.get_or_try_init(|| db::open_pool(&path)).await.cloned()
    }

    /// A folder per token, as a workspace has its own directory: snapshots are found
    /// beside the database, so a shared folder would list every test's.
    fn workspace_path(&self, token: &str) -> String {
        self.dir
            .join(token)
            .join("workspace.sqlite")
            .to_string_lossy()
            .into_owned()
    }

    /// The token's database, refusing one that `connect_db` never opened, the
    /// way the app refuses a command before its workspace is connected.
    async fn connected(&self, token: &str) -> AppResult<SqlitePool> {
        self.cell(token).await?.get().cloned().ok_or_else(|| {
            AppError::Internal("No database connected. Call connect_db first.".into())
        })
    }

    async fn cell(&self, token: &str) -> AppResult<Arc<OnceCell<SqlitePool>>> {
        let valid = (1..=128).contains(&token.len())
            && token
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if !valid {
            return Err(AppError::Invalid(format!(
                "not a bridge database token: {token:?}"
            )));
        }
        Ok(self
            .pools
            .lock()
            .await
            .entry(token.to_owned())
            .or_default()
            .clone())
    }
}

/// Take one argument out of a call, keyed the way Tauri keys it: the Rust name
/// in camelCase. A missing key reads as null, so an `Option` argument can be
/// left out, as it can over IPC.
pub fn arg<T: DeserializeOwned>(args: &mut Args, name: &str) -> Result<T, Value> {
    let key = camel_case(name);
    let raw = args.remove(&key).unwrap_or(Value::Null);
    serde_json::from_value(raw).map_err(|e| Value::String(format!("invalid args `{key}`: {e}")))
}

pub fn reply<T: Serialize>(result: AppResult<T>) -> Reply {
    to_value(result.map_err(app_error)?)
}

fn to_value<T: Serialize>(value: T) -> Reply {
    serde_json::to_value(value).map_err(|e| Value::String(format!("unserializable reply: {e}")))
}

fn app_error(e: AppError) -> Value {
    serde_json::to_value(&e).unwrap_or_else(|_| Value::String(e.to_string()))
}

fn camel_case(snake: &str) -> String {
    let mut out = String::with_capacity(snake.len());
    let mut upper = false;
    for c in snake.chars() {
        if c == '_' {
            upper = true;
        } else if upper {
            out.push(c.to_ascii_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

fn respond(status: StatusCode, body: Bytes) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(ACCESS_CONTROL_ALLOW_HEADERS, "content-type")
        .header(ACCESS_CONTROL_ALLOW_METHODS, "POST")
        .body(Full::new(body))
        .expect("static response parts are valid")
}

fn respond_json(status: StatusCode, payload: Value) -> Response<Full<Bytes>> {
    let mut response = respond(status, Bytes::from(payload.to_string()));
    response.headers_mut().insert(
        CONTENT_TYPE,
        "application/json".parse().expect("valid header value"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_arguments_the_way_tauri_does() {
        assert_eq!(camel_case("folder_id"), "folderId");
        assert_eq!(camel_case("include_completed"), "includeCompleted");
        assert_eq!(camel_case("id"), "id");
    }

    #[test]
    fn reads_a_missing_optional_argument_as_none() {
        let mut args = Args::new();
        let filter: Option<String> = arg(&mut args, "filter").unwrap();
        assert_eq!(filter, None);
    }

    #[test]
    fn refuses_a_missing_required_argument() {
        let mut args = Args::new();
        assert!(arg::<String>(&mut args, "page_id").is_err());
    }

    #[tokio::test]
    async fn refuses_every_command_that_reaches_the_keychain() {
        let pool = pikos_db::test_pool().await;
        for command in [
            "connect_caldav_account",
            "reconnect_caldav_account",
            "disconnect_sync_account",
            "release_sync_credentials",
            "resync_sync_account",
            "refresh_sync_account",
        ] {
            let reply = db::commands::bridge::dispatch(&pool, command, Args::new())
                .await
                .expect("declared by db_commands!");
            let error = reply.expect_err(command);
            assert!(error.to_string().contains("keychain"), "{command}: {error}");
        }
    }

    #[tokio::test]
    async fn refuses_a_token_that_could_name_a_path() {
        let bridge = Bridge {
            dir: std::env::temp_dir(),
            pools: Mutex::default(),
        };
        for token in ["../escape", "a/b", "", &"x".repeat(129)] {
            assert!(bridge.cell(token).await.is_err(), "{token:?} was accepted");
        }
    }
}
