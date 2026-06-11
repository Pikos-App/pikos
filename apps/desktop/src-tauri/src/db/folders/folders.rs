//! Thin Tauri command wrappers over the shared pikos-db writer.
use tauri::State;

use pikos_db::*;

use super::DbState;

#[tauri::command]
pub async fn get_folder(state: State<'_, DbState>, id: String) -> AppResult<Option<Folder>> {
    let pool = state.get_pool().await?;
    get_folder_impl(&pool, &id).await
}

#[tauri::command]
pub async fn create_folder(state: State<'_, DbState>, data: NewFolder) -> AppResult<Folder> {
    let pool = state.get_pool().await?;
    create_folder_impl(&pool, data).await
}

#[tauri::command]
pub async fn update_folder(
    state: State<'_, DbState>,
    id: String,
    updates: FolderUpdate,
) -> AppResult<Folder> {
    let pool = state.get_pool().await?;
    update_folder_impl(&pool, id, updates).await
}

#[tauri::command]
pub async fn delete_folder(state: State<'_, DbState>, id: String) -> AppResult<()> {
    let pool = state.get_pool().await?;
    delete_folder_impl(&pool, id).await
}

#[tauri::command]
pub async fn soft_delete_folder(state: State<'_, DbState>, id: String) -> AppResult<()> {
    let pool = state.get_pool().await?;
    soft_delete_folder_impl(&pool, id).await
}

#[tauri::command]
pub async fn restore_folder(state: State<'_, DbState>, id: String) -> AppResult<()> {
    let pool = state.get_pool().await?;
    restore_folder_impl(&pool, id).await
}

#[tauri::command]
pub async fn list_folders(state: State<'_, DbState>) -> AppResult<Vec<Folder>> {
    let pool = state.get_pool().await?;
    list_folders_impl(&pool).await
}

#[tauri::command]
pub async fn reorder_folders(state: State<'_, DbState>, ordered_ids: Vec<String>) -> AppResult<()> {
    let pool = state.get_pool().await?;
    reorder_folders_impl(&pool, &ordered_ids).await
}
