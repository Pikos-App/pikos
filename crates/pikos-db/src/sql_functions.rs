//! Functions registered on every connection the workspace pool opens, for triggers to call.
//!
//! A trigger runs on whatever connection made the write, so a connection opened any other way
//! fails its first write to a table whose trigger calls one: "no such function".

use std::ffi::{c_int, CStr};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::OnceLock;

use chrono::NaiveDateTime;
use libsqlite3_sys as ffi;
use sqlx::sqlite::SqliteConnection;

/// The UTC instant of a wall clock in an IANA zone, as `YYYY-MM-DDTHH:MM:SSZ`, by the daylight-saving
/// rules of `pikos_recurrence::zoned`. None for a date with no time, an unknown zone, or text
/// that isn't a wall clock.
pub fn utc_of(wall: &str, zone: &str) -> Option<String> {
    let wall = NaiveDateTime::parse_from_str(wall.get(..19).unwrap_or(wall), "%Y-%m-%dT%H:%M:%S")
        .or_else(|_| NaiveDateTime::parse_from_str(wall, "%Y-%m-%dT%H:%M"))
        .ok()?;
    let utc = pikos_recurrence::zoned::wall_clock_to_utc(zone, wall)?;
    Some(utc.format("%Y-%m-%dT%H:%M:%SZ").to_string())
}

/// This process's name in `change_writers`: random, made once, the same on every connection it
/// opens, so the app can count its own changes apart from the CLI's or another window's.
pub fn writer_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| uuid::Uuid::new_v4().to_string())
}

type Context = *mut ffi::sqlite3_context;
type Values = *mut *mut ffi::sqlite3_value;
type ScalarFn = extern "C" fn(Context, c_int, Values);

pub(crate) async fn register(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    let mut handle = conn.lock_handle().await?;
    let db = handle.as_raw_handle().as_ptr();
    let functions: [(&CStr, c_int, c_int, ScalarFn); 3] = [
        (
            c"pikos_utc",
            2,
            ffi::SQLITE_UTF8 | ffi::SQLITE_DETERMINISTIC | ffi::SQLITE_INNOCUOUS,
            pikos_utc,
        ),
        (
            c"pikos_writer",
            0,
            ffi::SQLITE_UTF8 | ffi::SQLITE_INNOCUOUS,
            pikos_writer,
        ),
        (
            c"pikos_title_key",
            1,
            ffi::SQLITE_UTF8 | ffi::SQLITE_INNOCUOUS,
            pikos_title_key,
        ),
    ];
    for (name, args, flags, function) in functions {
        // SAFETY: `db` is this connection's open handle, held locked for the call; the name is a
        // static C string; each function matches SQLite's scalar-function signature and keeps no
        // per-call state.
        let rc = unsafe {
            ffi::sqlite3_create_function_v2(
                db,
                name.as_ptr(),
                args,
                flags,
                std::ptr::null_mut(),
                Some(function),
                None,
                None,
                None,
            )
        };
        if rc != ffi::SQLITE_OK {
            return Err(sqlx::Error::Protocol(format!(
                "registering {} failed: {rc}",
                name.to_string_lossy()
            )));
        }
    }
    Ok(())
}

/// Hands `text` to SQLite as the call's result, copied before it returns.
fn result_text(ctx: Context, text: &str) {
    let len = text.len() as c_int;
    let bytes = text.as_ptr().cast();
    // SAFETY: `ctx` is the live context of the call SQLite is making; SQLITE_TRANSIENT copies.
    let () = unsafe { ffi::sqlite3_result_text(ctx, bytes, len, ffi::SQLITE_TRANSIENT()) };
}

/// `pikos_writer()`: [`writer_id`]. Called only by SQLite, with a live context.
extern "C" fn pikos_writer(ctx: Context, _argc: c_int, _argv: Values) {
    result_text(ctx, writer_id());
}

/// `pikos_title_key(title)`: [`crate::title_key::title_key`], or NULL for NULL. Called only by
/// SQLite, with a live context and one value.
extern "C" fn pikos_title_key(ctx: Context, _argc: c_int, argv: Values) {
    let title = arg_text(argv, 0);
    match catch_unwind(AssertUnwindSafe(|| {
        title.map(|t| crate::title_key::title_key(&t))
    })) {
        Ok(Some(key)) => {
            let len = key.len() as c_int;
            let bytes = key.as_ptr().cast();
            // SAFETY: `ctx` is the live context of the call; SQLITE_TRANSIENT copies the bytes.
            let () = unsafe { ffi::sqlite3_result_blob(ctx, bytes, len, ffi::SQLITE_TRANSIENT()) };
        }
        // SAFETY: `ctx` is the live context of the call SQLite is making.
        _ => unsafe { ffi::sqlite3_result_null(ctx) },
    }
}

/// The text of value `i`, or None for NULL. Only for `argv` as SQLite passes it to a function,
/// holding more than `i` values that live for the duration of the call.
fn arg_text(argv: Values, i: usize) -> Option<String> {
    // SAFETY: SQLite's `argv` holds more than `i` live values; the text is NUL-terminated or null.
    let ptr = unsafe { ffi::sqlite3_value_text(*argv.add(i)) };
    let ptr = (!ptr.is_null()).then_some(ptr)?;
    // SAFETY: non-null, and lives until the call returns.
    let text = unsafe { CStr::from_ptr(ptr.cast()) };
    Some(text.to_string_lossy().into_owned())
}

/// `pikos_utc(wall, zone)`: [`utc_of`], or NULL. Called only by SQLite, with a live context and
/// `argc` values.
extern "C" fn pikos_utc(ctx: Context, argc: c_int, argv: Values) {
    let text = |i: usize| (i < argc as usize).then(|| arg_text(argv, i)).flatten();
    let result = catch_unwind(AssertUnwindSafe(|| {
        if argc != 2 {
            return None;
        }
        utc_of(&text(0)?, &text(1)?)
    }))
    .ok()
    .flatten();
    match result {
        Some(instant) => result_text(ctx, &instant),
        // SAFETY: `ctx` is the live context of the call SQLite is making.
        None => unsafe { ffi::sqlite3_result_null(ctx) },
    }
}

#[cfg(test)]
mod tests {
    use super::utc_of;

    #[test]
    fn a_wall_clock_resolves_in_its_zone() {
        assert_eq!(
            utc_of("2026-07-01T09:00:00", "America/New_York").as_deref(),
            Some("2026-07-01T13:00:00Z")
        );
        assert_eq!(
            utc_of("2026-07-01T09:00", "America/New_York").as_deref(),
            Some("2026-07-01T13:00:00Z")
        );
    }

    #[test]
    fn daylight_saving_edges_follow_the_zoned_policy() {
        // Spring forward: 02:30 never happens, and reads as 03:30 daylight time.
        assert_eq!(
            utc_of("2026-03-08T02:30:00", "America/New_York").as_deref(),
            Some("2026-03-08T07:30:00Z")
        );
        // Fall back: 01:30 happens twice, and reads as the first.
        assert_eq!(
            utc_of("2026-11-01T01:30:00", "America/New_York").as_deref(),
            Some("2026-11-01T05:30:00Z")
        );
    }

    #[test]
    fn dates_unknown_zones_and_junk_have_no_instant() {
        assert_eq!(utc_of("2026-07-01", "America/New_York"), None);
        assert_eq!(utc_of("2026-07-01T09:00:00", "Mars/Olympus"), None);
        assert_eq!(utc_of("tomorrow", "America/New_York"), None);
    }
}
