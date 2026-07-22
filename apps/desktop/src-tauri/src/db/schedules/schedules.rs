//! Thin Tauri command wrappers over the shared pikos-db writer.
use pikos_recurrence::expand_range;
use serde::{Deserialize, Serialize};
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

/// A visible recurrence rule to expand. The completed/skip exclusion union is
/// kept client-side, so only rule-level EXDATEs travel with the rule here.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpandRuleInput {
    pub rule_id: String,
    pub rrule: String,
    pub scheduled_start: String,
    pub scheduled_end: Option<String>,
    pub rrule_exdates: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpandedOccurrence {
    pub original_date: String,
    pub scheduled_start: String,
    pub scheduled_end: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpandedRule {
    pub rule_id: String,
    pub occurrences: Vec<ExpandedOccurrence>,
}

/// Batched raw expansion for the calendar's visible range. Stateless — the
/// caller passes the visible rules, so no DB access. A rule this stricter engine
/// can't parse is OMITTED, not errored, so one out-of-envelope RRULE can't fail
/// the batch (the caller falls back to rrule.js for it). Async so the CPU work
/// runs off the webview's main thread.
#[tauri::command]
pub async fn expand_recurrence_range(
    rules: Vec<ExpandRuleInput>,
    range_start: String,
    range_end: String,
) -> Vec<ExpandedRule> {
    rules
        .into_iter()
        .filter_map(|r| {
            let occurrences = expand_range(
                &r.rrule,
                &r.scheduled_start,
                r.scheduled_end.as_deref(),
                &range_start,
                &range_end,
                &r.rrule_exdates,
            )
            .ok()?;
            Some(ExpandedRule {
                rule_id: r.rule_id,
                occurrences: occurrences
                    .into_iter()
                    .map(|o| ExpandedOccurrence {
                        original_date: o.original_date,
                        scheduled_start: o.scheduled_start,
                        scheduled_end: o.scheduled_end,
                    })
                    .collect(),
            })
        })
        .collect()
}

#[cfg(test)]
mod expand_recurrence_range_tests {
    use super::*;

    fn rule(rule_id: &str, rrule: &str, start: &str) -> ExpandRuleInput {
        ExpandRuleInput {
            rule_id: rule_id.to_string(),
            rrule: rrule.to_string(),
            scheduled_start: start.to_string(),
            scheduled_end: None,
            rrule_exdates: vec![],
        }
    }

    #[tokio::test]
    async fn expands_multiple_rules_keyed_by_id() {
        let out = expand_recurrence_range(
            vec![
                rule("rule-a", "FREQ=WEEKLY;BYDAY=MO", "2026-03-02T09:00:00"),
                rule("rule-b", "FREQ=WEEKLY;BYDAY=WE", "2026-03-04T15:00:00"),
            ],
            "2026-03-09".to_string(),
            "2026-03-16".to_string(),
        )
        .await;

        assert_eq!(out.len(), 2);
        let a = out.iter().find(|r| r.rule_id == "rule-a").unwrap();
        assert_eq!(
            a.occurrences
                .iter()
                .map(|o| o.original_date.as_str())
                .collect::<Vec<_>>(),
            ["2026-03-09"]
        );
        let b = out.iter().find(|r| r.rule_id == "rule-b").unwrap();
        assert_eq!(
            b.occurrences
                .iter()
                .map(|o| o.original_date.as_str())
                .collect::<Vec<_>>(),
            ["2026-03-11"]
        );
    }

    #[tokio::test]
    async fn applies_rule_exdates_but_not_the_completed_skip_union() {
        // Only rule-level EXDATEs are honored here (Mar 9 removed); the completed/
        // skip union is the caller's synchronous concern, absent from the input.
        let mut r = rule("rule-a", "FREQ=DAILY", "2026-03-09T09:00:00");
        r.rrule_exdates = vec!["2026-03-10".to_string()];
        let out =
            expand_recurrence_range(vec![r], "2026-03-09".to_string(), "2026-03-13".to_string())
                .await;

        let dates: Vec<_> = out[0]
            .occurrences
            .iter()
            .map(|o| o.original_date.as_str())
            .collect();
        assert_eq!(dates, ["2026-03-09", "2026-03-11", "2026-03-12"]);
    }

    #[tokio::test]
    async fn omits_an_unparseable_rule_instead_of_erroring_the_batch() {
        // A garbage RRULE stands in for an out-of-envelope provider rule: it drops
        // out of the result while the valid rule still expands, so the caller can
        // fall back to rrule.js for the omitted one.
        let out = expand_recurrence_range(
            vec![
                rule("bad", "FREQ=NONSENSE;BYWHATEVER=1", "2026-03-09T09:00:00"),
                rule("good", "FREQ=WEEKLY;BYDAY=MO", "2026-03-09T09:00:00"),
            ],
            "2026-03-09".to_string(),
            "2026-03-16".to_string(),
        )
        .await;

        assert_eq!(out.len(), 1);
        assert_eq!(out[0].rule_id, "good");
    }
}
