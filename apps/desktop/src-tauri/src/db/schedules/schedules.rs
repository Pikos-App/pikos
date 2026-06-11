//! Thin Tauri command wrappers over the shared pikos-db writer.
use tauri::State;

use pikos_db::*;

use super::DbState;

#[tauri::command]
pub async fn create_page_schedule(
    state: State<'_, DbState>,
    data: NewPageSchedule,
) -> AppResult<PageSchedule> {
    let pool = state.get_pool().await?;
    create_page_schedule_impl(&pool, data).await
}

#[tauri::command]
pub async fn update_page_schedule(
    state: State<'_, DbState>,
    id: String,
    updates: PageScheduleUpdate,
) -> AppResult<PageSchedule> {
    let pool = state.get_pool().await?;
    update_page_schedule_impl(&pool, id, updates).await
}

#[tauri::command]
pub async fn delete_page_schedule(state: State<'_, DbState>, id: String) -> AppResult<()> {
    let pool = state.get_pool().await?;
    delete_page_schedule_impl(&pool, id).await
}

#[tauri::command]
pub async fn list_page_schedules(
    state: State<'_, DbState>,
    page_id: String,
) -> AppResult<Vec<PageSchedule>> {
    let pool = state.get_pool().await?;
    list_page_schedules_impl(&pool, &page_id).await
}

#[tauri::command]
pub async fn list_page_schedules_range(
    state: State<'_, DbState>,
    start: String,
    end: String,
) -> AppResult<Vec<PageSchedule>> {
    let pool = state.get_pool().await?;
    list_page_schedules_range_impl(&pool, &start, &end).await
}

#[tauri::command]
pub async fn create_recurrence_rule(
    state: State<'_, DbState>,
    data: NewRecurrenceRule,
) -> AppResult<PageRecurrenceRule> {
    let pool = state.get_pool().await?;
    create_recurrence_rule_impl(&pool, data).await
}

#[tauri::command]
pub async fn update_recurrence_rule(
    state: State<'_, DbState>,
    id: String,
    updates: RecurrenceRuleUpdate,
) -> AppResult<PageRecurrenceRule> {
    let pool = state.get_pool().await?;
    update_recurrence_rule_impl(&pool, id, updates).await
}

#[tauri::command]
pub async fn add_rule_exdates(
    state: State<'_, DbState>,
    id: String,
    dates: Vec<String>,
) -> AppResult<PageRecurrenceRule> {
    let pool = state.get_pool().await?;
    add_rule_exdates_impl(&pool, id, dates).await
}

#[tauri::command]
pub async fn remove_rule_exdate(
    state: State<'_, DbState>,
    id: String,
    date: String,
) -> AppResult<PageRecurrenceRule> {
    let pool = state.get_pool().await?;
    remove_rule_exdate_impl(&pool, id, date).await
}

#[tauri::command]
pub async fn delete_recurrence_rule(state: State<'_, DbState>, id: String) -> AppResult<()> {
    let pool = state.get_pool().await?;
    delete_recurrence_rule_impl(&pool, &id).await
}

#[tauri::command]
pub async fn list_recurrence_rules(
    state: State<'_, DbState>,
) -> AppResult<Vec<PageRecurrenceRule>> {
    let pool = state.get_pool().await?;
    list_recurrence_rules_impl(&pool).await
}

#[tauri::command]
pub async fn get_recurrence_rule(
    state: State<'_, DbState>,
    page_id: String,
) -> AppResult<Option<PageRecurrenceRule>> {
    let pool = state.get_pool().await?;
    get_recurrence_rule_impl(&pool, &page_id).await
}
