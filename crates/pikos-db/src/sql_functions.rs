//! Functions registered on every connection the workspace pool opens, for triggers to call.
//!
//! A trigger runs on whatever connection made the write, so a connection opened any other way
//! fails its first write to a table whose trigger calls one: "no such function".

use std::ffi::{c_int, CStr};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicU64, Ordering};
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

/// Where `pikos_now_ms()` reads the time: the system clock, or for tests a shared value they move
/// themselves, so a run that compares clocks across databases replays the same way every time.
#[derive(Clone, Copy)]
pub enum Clock {
    System,
    Manual(&'static AtomicU64),
}

pub(crate) async fn register(conn: &mut SqliteConnection, clock: Clock) -> Result<(), sqlx::Error> {
    let mut handle = conn.lock_handle().await?;
    let db = handle.as_raw_handle().as_ptr();
    let clock_source = match clock {
        Clock::System => std::ptr::null_mut(),
        Clock::Manual(now) => std::ptr::from_ref(now).cast_mut().cast(),
    };
    let functions: [(&CStr, c_int, c_int, ScalarFn); 6] = [
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
        (
            c"pikos_hlc_next",
            2,
            ffi::SQLITE_UTF8 | ffi::SQLITE_DETERMINISTIC | ffi::SQLITE_INNOCUOUS,
            pikos_hlc_next,
        ),
        (c"pikos_now_ms", 0, ffi::SQLITE_UTF8, pikos_now_ms),
        (
            c"pikos_chunk_writes",
            2,
            ffi::SQLITE_UTF8 | ffi::SQLITE_DETERMINISTIC | ffi::SQLITE_INNOCUOUS,
            pikos_chunk_writes,
        ),
    ];
    for (name, args, flags, function) in functions {
        let user_data = if name == c"pikos_now_ms" {
            clock_source
        } else {
            std::ptr::null_mut()
        };
        // SAFETY: `db` is this connection's open handle, held locked for the call; the name is a
        // static C string; each function matches SQLite's scalar-function signature and keeps no
        // per-call state. The clock's user data is null or a `&'static AtomicU64`, which outlives
        // the connection.
        let rc = unsafe {
            ffi::sqlite3_create_function_v2(
                db,
                name.as_ptr(),
                args,
                flags,
                user_data,
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

/// `pikos_now_ms()`: milliseconds since the Unix epoch, from the connection's [`Clock`]. Called
/// only by SQLite, with a live context.
extern "C" fn pikos_now_ms(ctx: Context, _argc: c_int, _argv: Values) {
    // SAFETY: `ctx` is the live context of the call; its user data was set at registration.
    let source = unsafe { ffi::sqlite3_user_data(ctx) }.cast::<AtomicU64>();
    let now = if source.is_null() {
        chrono::Utc::now().timestamp_millis()
    } else {
        // SAFETY: a non-null source is the `&'static AtomicU64` given to `register`.
        let manual = unsafe { &*source };
        manual.load(Ordering::SeqCst) as i64
    };
    // SAFETY: `ctx` is the live context of the call SQLite is making.
    let () = unsafe { ffi::sqlite3_result_int64(ctx, now) };
}

/// The replica clock after `previous` for a write at `now_ms`, as [`pikos_replica::Hlc::next`].
pub fn hlc_next(previous: &str, now_ms: i64) -> Option<String> {
    let previous: pikos_replica::Hlc = previous.parse().ok()?;
    Some(previous.next(now_ms.max(0) as u64).to_string())
}

/// `pikos_hlc_next(previous, now_ms)`: [`hlc_next`]. An unreadable clock fails the write rather
/// than restarting the clock, which could stamp a new edit behind one already sent. Called only by
/// SQLite, with a live context and two values.
extern "C" fn pikos_hlc_next(ctx: Context, _argc: c_int, argv: Values) {
    let previous = arg_text(argv, 0);
    // SAFETY: SQLite's `argv` holds two live values for this two-argument function.
    let now_ms = unsafe { ffi::sqlite3_value_int64(*argv.add(1)) };
    let next = catch_unwind(AssertUnwindSafe(|| hlc_next(&previous?, now_ms)))
        .ok()
        .flatten();
    match next {
        Some(clock) => result_text(ctx, &clock),
        None => {
            let message = c"replica clock is unreadable";
            // SAFETY: `ctx` is the live context of the call; -1 reads the static message to its NUL.
            let () = unsafe { ffi::sqlite3_result_error(ctx, message.as_ptr(), -1) };
        }
    }
}

/// `pikos_chunk_writes(content, previous)`: [`crate::page_chunks::chunk_writes`], `previous` NULL
/// for a page with no chunks yet. A panic fails the write, so chunks never fall out of step with the
/// body unnoticed. Called only by SQLite, with a live context and two values.
extern "C" fn pikos_chunk_writes(ctx: Context, _argc: c_int, argv: Values) {
    let content = arg_text(argv, 0).unwrap_or_default();
    let previous = arg_text(argv, 1).unwrap_or_default();
    let writes = catch_unwind(AssertUnwindSafe(|| {
        crate::page_chunks::chunk_writes(&content, &previous)
    }));
    match writes {
        Ok(writes) => result_text(ctx, &writes),
        Err(_) => {
            let message = c"chunking a page body failed";
            // SAFETY: `ctx` is the live context of the call; -1 reads the static message to its NUL.
            let () = unsafe { ffi::sqlite3_result_error(ctx, message.as_ptr(), -1) };
        }
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
    use super::{hlc_next, utc_of};

    #[test]
    fn the_clock_moves_to_wall_time_or_past_the_last_clock() {
        let previous = pikos_replica::Hlc::new(1_000, 4).to_string();

        assert_eq!(
            hlc_next(&previous, 2_000),
            Some(pikos_replica::Hlc::new(2_000, 0).to_string())
        );
        assert_eq!(
            hlc_next(&previous, 500),
            Some(pikos_replica::Hlc::new(1_000, 5).to_string()),
            "a wall clock behind the last clock still moves past it"
        );
        assert_eq!(hlc_next("garbage", 2_000), None);
    }

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
