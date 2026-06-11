//! Thin Tauri command wrappers over the shared pikos-db writer.
use tauri::State;

use pikos_db::*;

use super::DbState;

#[tauri::command]
pub async fn get_page(state: State<'_, DbState>, id: String) -> AppResult<Option<Page>> {
    let pool = state.get_pool().await?;
    pikos_db::get_page(&pool, &id).await
}

#[tauri::command]
pub async fn create_page(state: State<'_, DbState>, data: NewPage) -> AppResult<Page> {
    let pool = state.get_pool().await?;
    create_page_impl(&pool, data).await
}

#[tauri::command]
pub async fn update_page(
    state: State<'_, DbState>,
    id: String,
    updates: PageUpdate,
) -> AppResult<Page> {
    let pool = state.get_pool().await?;
    update_page_impl(&pool, id, updates).await
}

#[tauri::command]
pub async fn delete_page(state: State<'_, DbState>, id: String) -> AppResult<()> {
    let pool = state.get_pool().await?;
    delete_page_impl(&pool, &id).await
}

#[tauri::command]
pub async fn soft_delete_page(state: State<'_, DbState>, id: String) -> AppResult<()> {
    let pool = state.get_pool().await?;
    soft_delete_page_impl(&pool, &id).await
}

#[tauri::command]
pub async fn restore_page(state: State<'_, DbState>, id: String) -> AppResult<()> {
    let pool = state.get_pool().await?;
    restore_page_impl(&pool, &id).await
}

#[tauri::command]
pub async fn list_pages(
    state: State<'_, DbState>,
    filter: Option<PageFilter>,
) -> AppResult<Vec<PageSummary>> {
    let pool = state.get_pool().await?;
    list_pages_impl(&pool, filter).await
}

#[tauri::command]
pub async fn list_pages_today(state: State<'_, DbState>) -> AppResult<Vec<PageSummary>> {
    let pool = state.get_pool().await?;
    list_pages_today_impl(&pool).await
}

#[tauri::command]
pub async fn reorder_pages(
    state: State<'_, DbState>,
    folder_id: Option<String>,
    ordered_ids: Vec<String>,
) -> AppResult<()> {
    let pool = state.get_pool().await?;
    reorder_pages_impl(&pool, folder_id.as_deref(), &ordered_ids).await
}

#[tauri::command]
pub async fn list_completed_pages(
    state: State<'_, DbState>,
    filter: CompletedPagesFilter,
) -> AppResult<CompletedPagesResponse> {
    let pool = state.get_pool().await?;
    list_completed_pages_impl(&pool, filter).await
}

#[tauri::command]
pub async fn set_pages_status(
    state: State<'_, DbState>,
    ids: Vec<String>,
    status: String,
    completed_at: Option<String>,
) -> AppResult<Vec<PageSummary>> {
    let pool = state.get_pool().await?;
    set_pages_status_impl(&pool, &ids, &status, completed_at.as_deref()).await
}

#[tauri::command]
pub async fn complete_recurring_page(
    state: State<'_, DbState>,
    data: CompleteRecurringInput,
) -> AppResult<CompleteRecurringResult> {
    let pool = state.get_pool().await?;
    complete_recurring_page_impl(&pool, data).await
}

#[tauri::command]
pub async fn reschedule_virtual_occurrence(
    state: State<'_, DbState>,
    data: RescheduleVirtualInput,
) -> AppResult<RescheduleVirtualResult> {
    let pool = state.get_pool().await?;
    reschedule_virtual_occurrence_impl(&pool, data).await
}
