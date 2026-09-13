//! The calendar-sync commands that are not pure delegation. The other nine —
//! connect/reconnect, disconnect, resync, refresh, status and the calendar
//! reads — are declared in `commands.rs` and pulled in below, so `db::sync`
//! still names every sync command.

use tauri::State;

use pikos_calendar_sync::{connect_google, google, Keychain};
use pikos_db::sync_commands::{toggle_sync_calendar_impl, AccountWithCalendars, SyncCalendar};

pub use super::commands::sync::*;

use super::DbState;
use crate::error::AppResult;

/// Whether this build carries the Google OAuth client. The panel disables the
/// Google option when it doesn't, rather than offering a connect that can only fail.
#[tauri::command]
pub fn google_sync_available() -> bool {
    google::is_available()
}

#[tauri::command]
pub async fn connect_google_account(state: State<'_, DbState>) -> AppResult<AccountWithCalendars> {
    let pool = state.get_pool().await?;
    connect_google(&pool, Keychain::system(), |url| {
        tauri_plugin_opener::open_url(url, None::<&str>)
            .map_err(|e| pikos_db::error::AppError::Internal(format!("open browser: {e}")))?;
        Ok(())
    })
    .await
}

/// Generic over the runtime so a `MockRuntime` test can invoke it — the wire
/// test reaches this command's `syncCalendarId`, which a concrete `Wry` handle
/// would put out of reach.
#[tauri::command]
pub async fn toggle_sync_calendar<R: tauri::Runtime>(
    state: State<'_, DbState>,
    app: tauri::AppHandle<R>,
    sync_calendar_id: String,
    enabled: bool,
    color: Option<String>,
) -> AppResult<SyncCalendar> {
    let pool = state.get_pool().await?;
    let cal =
        toggle_sync_calendar_impl(&pool, &sync_calendar_id, enabled, color.as_deref()).await?;
    if enabled {
        crate::db::sync_loop::poke(&app);
    }
    Ok(cal)
}
