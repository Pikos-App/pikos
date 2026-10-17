//! The Settings half of iCloud sync on the Mac: whether it's on, the line under the switch, and the
//! switch itself. Every build registers these commands. One compiled without the `icloud-sync`
//! feature answers that sync isn't in it, and its frontend, built without `VITE_ICLOUD_SYNC`, never
//! asks.

use serde::Serialize;
use tauri::State;

use super::DbState;
use crate::error::AppResult;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ICloudSyncState {
    pub on: bool,
    pub text: String,
    /// What the line offers: `none`, `useThisAccount` or `uploadAgain`.
    pub action: String,
}

#[cfg(not(all(target_os = "macos", feature = "icloud-sync")))]
fn unavailable() -> crate::error::AppError {
    crate::error::AppError::Invalid("iCloud sync isn't in this build".into())
}

#[tauri::command]
pub async fn icloud_sync_state(state: State<'_, DbState>) -> AppResult<ICloudSyncState> {
    #[cfg(all(target_os = "macos", feature = "icloud-sync"))]
    return super::icloud::state(&state.get_pool().await?).await;
    #[cfg(not(all(target_os = "macos", feature = "icloud-sync")))]
    {
        let _ = state;
        Err(unavailable())
    }
}

#[tauri::command]
pub async fn icloud_sync_set(state: State<'_, DbState>, on: bool) -> AppResult<()> {
    #[cfg(all(target_os = "macos", feature = "icloud-sync"))]
    return super::icloud::set_on(&state.get_pool().await?, on).await;
    #[cfg(not(all(target_os = "macos", feature = "icloud-sync")))]
    {
        let _ = (state, on);
        Err(unavailable())
    }
}

#[tauri::command]
pub async fn icloud_sync_act(state: State<'_, DbState>) -> AppResult<()> {
    #[cfg(all(target_os = "macos", feature = "icloud-sync"))]
    return super::icloud::act(&state.get_pool().await?).await;
    #[cfg(not(all(target_os = "macos", feature = "icloud-sync")))]
    {
        let _ = state;
        Err(unavailable())
    }
}
