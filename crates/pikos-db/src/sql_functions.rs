//! Functions registered on every connection the workspace pool opens, for triggers to call.
//!
//! A trigger runs on whatever connection made the write, so a connection opened any other way
//! fails its first write to a table whose trigger calls one: "no such function".

use std::ffi::{c_int, CStr};
use std::panic::{catch_unwind, AssertUnwindSafe};

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

pub(crate) async fn register(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    let mut handle = conn.lock_handle().await?;
    let db = handle.as_raw_handle().as_ptr();
    let flags = ffi::SQLITE_UTF8 | ffi::SQLITE_DETERMINISTIC | ffi::SQLITE_INNOCUOUS;
    // SAFETY: `db` is this connection's open handle, held locked for the call; the name is a
    // static C string; `pikos_utc` matches SQLite's scalar-function signature and keeps no state.
    let rc = unsafe {
        ffi::sqlite3_create_function_v2(
            db,
            c"pikos_utc".as_ptr(),
            2,
            flags,
            std::ptr::null_mut(),
            Some(pikos_utc),
            None,
            None,
            None,
        )
    };
    if rc == ffi::SQLITE_OK {
        Ok(())
    } else {
        Err(sqlx::Error::Protocol(format!(
            "registering pikos_utc failed: {rc}"
        )))
    }
}

/// `pikos_utc(wall, zone)`: [`utc_of`], or NULL.
unsafe extern "C" fn pikos_utc(
    ctx: *mut ffi::sqlite3_context,
    argc: c_int,
    argv: *mut *mut ffi::sqlite3_value,
) {
    let text = |i: usize| -> Option<String> {
        // SAFETY: SQLite passes `argc` valid values in `argv` for the duration of the call, and
        // `sqlite3_value_text` returns NUL-terminated UTF-8 or null.
        let ptr = unsafe { ffi::sqlite3_value_text(*argv.add(i)) };
        // SAFETY: checked non-null above; the text lives until the call returns.
        (!ptr.is_null()).then(|| {
            unsafe { CStr::from_ptr(ptr.cast()) }
                .to_string_lossy()
                .into_owned()
        })
    };
    let result = catch_unwind(AssertUnwindSafe(|| {
        if argc != 2 {
            return None;
        }
        utc_of(&text(0)?, &text(1)?)
    }))
    .ok()
    .flatten();
    match result {
        // SAFETY: `ctx` is the call's context; SQLITE_TRANSIENT makes SQLite copy the bytes
        // before `instant` is dropped.
        Some(instant) => unsafe {
            ffi::sqlite3_result_text(
                ctx,
                instant.as_ptr().cast(),
                instant.len() as c_int,
                ffi::SQLITE_TRANSIENT(),
            )
        },
        // SAFETY: `ctx` is the call's context.
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
