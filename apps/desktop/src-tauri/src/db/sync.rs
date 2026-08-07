//! Calendar-sync command shims. Thin wrappers over `pikos-calendar-sync`
//! (networked orchestration: keychain + provider + engine) and `pikos-db`'s sync
//! writers. The keychain is constructed per call — there's no shared sync state to
//! hold; credentials live in the OS keychain, keyed by the account id.

use tauri::State;

use pikos_calendar_sync::{
    connect_caldav, connect_google, disconnect_account, google, release_all_credentials,
    resync_account_auto, CalendarSyncResult, Keychain,
};
use pikos_db::sync_commands::{
    get_sync_status_impl, list_sync_calendars_impl, toggle_sync_calendar_impl,
    AccountWithCalendars, SyncCalendar,
};

use super::DbState;
use crate::error::AppResult;

#[tauri::command]
pub async fn connect_caldav_account(
    state: State<'_, DbState>,
    base_url: String,
    username: String,
    password: String,
    display_name: String,
) -> AppResult<AccountWithCalendars> {
    let pool = state.get_pool().await?;
    connect_caldav(
        &pool,
        Keychain::system(),
        base_url,
        username,
        password,
        display_name,
    )
    .await
}

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

#[tauri::command]
pub async fn disconnect_sync_account(
    state: State<'_, DbState>,
    account_id: String,
) -> AppResult<()> {
    let pool = state.get_pool().await?;
    disconnect_account(&pool, Keychain::system(), &account_id).await
}

/// Credential teardown for a full data wipe — `wipe_app_data` doesn't reach the
/// keychain.
#[tauri::command]
pub async fn release_sync_credentials(state: State<'_, DbState>) -> AppResult<()> {
    let pool = state.get_pool().await?;
    release_all_credentials(&pool, Keychain::system()).await
}

#[tauri::command]
pub async fn list_sync_calendars(
    state: State<'_, DbState>,
    account_id: String,
) -> AppResult<Vec<SyncCalendar>> {
    let pool = state.get_pool().await?;
    list_sync_calendars_impl(&pool, &account_id).await
}

#[tauri::command]
pub async fn toggle_sync_calendar(
    state: State<'_, DbState>,
    app: tauri::AppHandle,
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

#[tauri::command]
pub async fn resync_sync_account(
    state: State<'_, DbState>,
    account_id: String,
) -> AppResult<Vec<CalendarSyncResult>> {
    let pool = state.get_pool().await?;
    resync_account_auto(&pool, Keychain::system(), &account_id).await
}

#[tauri::command]
pub async fn get_sync_status(state: State<'_, DbState>) -> AppResult<Vec<AccountWithCalendars>> {
    let pool = state.get_pool().await?;
    get_sync_status_impl(&pool).await
}
