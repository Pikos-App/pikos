//! Per-page reminder CRUD. The write/read logic lives in `pikos_db::reminders`
//! (pool-based, unit-tested); these commands just resolve the pool and delegate.

use pikos_db::PageReminder;
use serde::Deserialize;
use tauri::State;

use super::DbState;
use crate::error::AppResult;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewPageReminder {
    pub page_id: String,
    pub minutes_before: i64,
}

#[tauri::command]
pub async fn create_page_reminder(
    state: State<'_, DbState>,
    data: NewPageReminder,
) -> AppResult<PageReminder> {
    let pool = state.get_pool().await?;
    pikos_db::create_page_reminder(&pool, &data.page_id, data.minutes_before).await
}

#[tauri::command]
pub async fn list_page_reminders(
    state: State<'_, DbState>,
    page_id: String,
) -> AppResult<Vec<PageReminder>> {
    let pool = state.get_pool().await?;
    pikos_db::list_page_reminders(&pool, &page_id).await
}

#[tauri::command]
pub async fn delete_page_reminder(state: State<'_, DbState>, id: String) -> AppResult<()> {
    let pool = state.get_pool().await?;
    pikos_db::delete_page_reminder(&pool, &id).await
}

#[tauri::command]
pub async fn delete_page_reminders(state: State<'_, DbState>, page_id: String) -> AppResult<()> {
    let pool = state.get_pool().await?;
    pikos_db::delete_page_reminders(&pool, &page_id).await
}
