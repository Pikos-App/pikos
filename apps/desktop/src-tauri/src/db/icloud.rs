//! iCloud sync on the Mac: the workspace half of the bridge to the Swift transport, `PikosSyncMac`,
//! which the build script links in when the `icloud-sync` feature is on.
//!
//! Swift calls one function, [`pikos_replica_call`], with an operation name and JSON, and gets JSON
//! back; Rust calls `pikos_sync_start` once the workspace is open. A C ABI of two functions keeps
//! the Swift side free of a second copy of the Rust code, which linking the phone's bindings would
//! have brought.

use std::collections::BTreeMap;
use std::ffi::{c_char, CStr, CString};
use std::sync::OnceLock;

use pikos_replica::codec::FieldMap;
use pikos_replica::merge::Value;
use pikos_replica::{Hlc, RecordName};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter};

const CONTAINER: &str = "iCloud.app.pikos.staging";

static WORKSPACE: OnceLock<(SqlitePool, AppHandle)> = OnceLock::new();

extern "C" {
    fn pikos_sync_start(container: *const c_char, zone: *const c_char);
}

/// Turns sync on for the open workspace and hands it to the Swift transport.
pub fn start(app: AppHandle, pool: SqlitePool) {
    tauri::async_runtime::spawn(async move {
        let meta = match pikos_db::replica::start(&pool).await {
            Ok(meta) => meta,
            Err(e) => {
                log::error!("icloud: starting sync failed: {e}");
                return;
            }
        };
        if WORKSPACE.set((pool, app)).is_err() {
            return;
        }
        let zone = pikos_replica::zone::zone_name(&meta.workspace_id);
        log::info!("icloud: sync started in {zone}");
        let (Ok(container), Ok(zone)) = (CString::new(CONTAINER), CString::new(zone)) else {
            return;
        };
        unsafe { pikos_sync_start(container.as_ptr(), zone.as_ptr()) }; // SAFETY: NUL-terminated for the call, and Swift copies both
    });
}

/// Runs `op` with the JSON in `input` and returns `{"ok": …}` or `{"err": "…"}` as JSON, in a buffer
/// the caller frees with [`pikos_replica_free`].
///
/// # Safety
/// `op` must be a NUL-terminated string, `input` must point to `input_len` readable bytes, and
/// `output_len` must be writable.
#[no_mangle]
pub unsafe extern "C" fn pikos_replica_call(
    op: *const c_char,
    input: *const u8,
    input_len: usize,
    output_len: *mut usize,
) -> *mut u8 {
    // SAFETY: the caller guarantees `op` is NUL-terminated and `input` spans `input_len` bytes.
    let (op, input) = unsafe {
        (
            CStr::from_ptr(op).to_string_lossy().into_owned(),
            std::slice::from_raw_parts(input, input_len),
        )
    };
    let reply = match tauri::async_runtime::block_on(dispatch(&op, input)) {
        Ok(value) => serde_json::json!({ "ok": value }),
        Err(message) => {
            log::warn!("icloud: {op} failed: {message}");
            serde_json::json!({ "err": message })
        }
    };
    let mut bytes = reply.to_string().into_bytes().into_boxed_slice();
    unsafe { *output_len = bytes.len() }; // SAFETY: the caller guarantees `output_len` is writable

    let ptr = bytes.as_mut_ptr();
    std::mem::forget(bytes);
    ptr
}

/// Frees a buffer [`pikos_replica_call`] returned.
///
/// # Safety
/// `ptr` and `len` must be exactly what one call to [`pikos_replica_call`] returned, freed once.
#[no_mangle]
pub unsafe extern "C" fn pikos_replica_free(ptr: *mut u8, len: usize) {
    // SAFETY: the caller hands back the pointer and length of a boxed slice this module leaked.
    drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)) });
}

/// A field's value, tagged by type since JSON alone can't tell an integer from a real.
#[derive(Serialize, Deserialize)]
enum Wire {
    #[serde(rename = "i")]
    Integer(i64),
    #[serde(rename = "r")]
    Real(f64),
    #[serde(rename = "t")]
    Text(String),
}

#[derive(Serialize, Deserialize)]
struct WireRecord {
    name: String,
    fields: BTreeMap<String, Wire>,
}

#[derive(Serialize)]
struct Address {
    name: String,
    store_name: String,
}

#[derive(Serialize)]
struct Built {
    record: WireRecord,
    store_name: String,
    built_at: String,
    system_fields: Option<Vec<u8>>,
}

#[derive(Deserialize)]
struct Sent {
    name: String,
    built_at: String,
}

#[derive(Deserialize)]
struct NamedData {
    name: String,
    data: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Request {
    Pending { limit: i64 },
    Build { names: Vec<String> },
    Sent { sent: Vec<Sent> },
    Apply { records: Vec<WireRecord> },
    EngineState {},
    SetEngineState { state: Vec<u8> },
    Expire {},
    SaveSystemFields { records: Vec<NamedData> },
    Join { zones: Vec<String> },
}

async fn dispatch(op: &str, input: &[u8]) -> Result<serde_json::Value, String> {
    let (pool, app) = WORKSPACE.get().ok_or("sync hasn't started")?;
    let body: serde_json::Value = serde_json::from_slice(input).map_err(|e| e.to_string())?;
    let request: Request = serde_json::from_value(serde_json::json!({ op: body }))
        .map_err(|e| format!("{op}: {e}"))?;
    let failed = |e: pikos_db::error::AppError| e.to_string();

    match request {
        Request::Pending { limit } => {
            let names = pikos_db::replica::build::pending(pool, limit)
                .await
                .map_err(failed)?;
            json(&names.iter().map(address).collect::<Vec<_>>())
        }
        Request::Build { names } => {
            let names = names
                .iter()
                .map(|n| parse_name(n))
                .collect::<Result<Vec<_>, _>>()?;
            let built = pikos_db::replica::build::build(pool, &names)
                .await
                .map_err(failed)?;
            let built: Vec<Built> = built
                .into_iter()
                .map(|b| Built {
                    store_name: b.name.store_name(),
                    record: WireRecord {
                        name: b.name.to_string(),
                        fields: to_wire(&b.fields),
                    },
                    built_at: b.clock.to_string(),
                    system_fields: b.system_fields,
                })
                .collect();
            json(&built)
        }
        Request::Sent { sent } => {
            let sent = sent
                .iter()
                .map(|s| Ok((parse_name(&s.name)?, parse_clock(&s.built_at)?)))
                .collect::<Result<Vec<_>, String>>()?;
            let still = pikos_db::replica::build::sent(pool, &sent)
                .await
                .map_err(failed)?;
            json(&still.iter().map(ToString::to_string).collect::<Vec<_>>())
        }
        Request::Apply { records } => {
            let records = records
                .into_iter()
                .map(|r| Ok((parse_name(&r.name)?, from_wire(r.fields))))
                .collect::<Result<Vec<_>, String>>()?;
            let applied = pikos_db::replica::apply::apply(pool, &records)
                .await
                .map_err(failed)?;
            if applied.changed > 0 {
                let _ = app.emit(super::sync_loop::SYNC_APPLIED_EVENT, ());
            }
            Ok(serde_json::json!({ "changed": applied.changed, "held": applied.held }))
        }
        Request::EngineState {} => {
            let state = pikos_db::replica::engine_state(pool)
                .await
                .map_err(failed)?;
            json(&state)
        }
        Request::SetEngineState { state } => {
            pikos_db::replica::set_engine_state(pool, &state)
                .await
                .map_err(failed)?;
            Ok(serde_json::Value::Null)
        }
        Request::Expire {} => {
            let forgotten = pikos_db::replica::expire(pool).await.map_err(failed)?;
            json(&forgotten.iter().map(address).collect::<Vec<_>>())
        }
        Request::SaveSystemFields { records } => {
            let records = records
                .into_iter()
                .map(|r| Ok((parse_name(&r.name)?, r.data)))
                .collect::<Result<Vec<_>, String>>()?;
            pikos_db::replica::build::save_system_fields(pool, &records)
                .await
                .map_err(failed)?;
            Ok(serde_json::Value::Null)
        }
        Request::Join { zones } => {
            let zone = pikos_db::replica::join(pool, &zones)
                .await
                .map_err(failed)?;
            json(&zone)
        }
    }
}

fn json<T: Serialize>(value: &T) -> Result<serde_json::Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

fn address(name: &RecordName) -> Address {
    Address {
        name: name.to_string(),
        store_name: name.store_name(),
    }
}

fn parse_name(name: &str) -> Result<RecordName, String> {
    name.parse().map_err(|e| format!("{name}: {e}"))
}

fn parse_clock(clock: &str) -> Result<Hlc, String> {
    clock.parse().map_err(|e| format!("{clock}: {e}"))
}

fn to_wire(map: &FieldMap) -> BTreeMap<String, Wire> {
    map.iter()
        .filter_map(|(key, value)| {
            let wire = match value {
                Value::Null => return None,
                Value::Integer(v) => Wire::Integer(*v),
                Value::Real(v) => Wire::Real(*v),
                Value::Text(v) => Wire::Text(v.clone()),
            };
            Some((key.clone(), wire))
        })
        .collect()
}

fn from_wire(fields: BTreeMap<String, Wire>) -> FieldMap {
    fields
        .into_iter()
        .map(|(key, wire)| {
            let value = match wire {
                Wire::Integer(v) => Value::Integer(v),
                Wire::Real(v) => Value::Real(v),
                Wire::Text(v) => Value::Text(v),
            };
            (key, value)
        })
        .collect()
}
