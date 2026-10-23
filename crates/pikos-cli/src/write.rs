//! Write helpers that mirror the app's persistence path, so a CLI-written page is
//! indistinguishable from one the desktop app wrote.

use pikos_db::{
    fuzzy_match_folder, list_folders_impl, list_page_schedules_impl, update_page_impl,
    update_page_schedule_impl, AppError, NewPage, NewPageSchedule, PageUpdate,
};
use serde_json::Value;

use crate::error::CliError;
use sqlx::SqlitePool;

pub fn local_tz() -> String {
    pikos_db::device_zone().name().to_string()
}

pub fn base_page(folder_id: Option<String>, title: String) -> NewPage {
    NewPage {
        folder_id,
        title,
        subtitle: None,
        content: String::new(),
        status: "not_started".to_string(),
        priority: 0,
        tags: Vec::new(),
        scheduled_start: None,
        scheduled_end: None,
        completed_at: None,
        parent_id: None,
        last_opened_at: None,
        created_at: None,
        updated_at: None,
    }
}

/// [`base_page`] with a parsed `//` body already in it, so the page is written
/// once rather than created empty and immediately patched.
pub async fn page_with_body(
    pool: &SqlitePool,
    folder_id: Option<String>,
    title: String,
    body: Option<&String>,
) -> Result<NewPage, CliError> {
    let mut page = base_page(folder_id, title);
    if let Some(text) = body.filter(|t| !t.is_empty()) {
        page.content = markdown_to_tiptap(pool, text, &[]).await?;
    }
    Ok(page)
}

/// Write a parsed page's reminder rows. The values arrive already resolved
/// against the schedule shape, which is why this goes to `pikos_db` directly
/// rather than through `ops::add_reminder` — that one guards the hand-typed
/// `reminders add` range, where -2 would be a typo rather than the all-day
/// anchor.
pub async fn write_reminders(
    pool: &SqlitePool,
    page_id: &str,
    minutes: &[i64],
) -> Result<(), AppError> {
    for m in minutes {
        pikos_db::create_page_reminder(pool, page_id, *m).await?;
    }
    Ok(())
}

pub fn priority_num(word: &Option<String>) -> i64 {
    match word.as_deref() {
        Some("urgent") => 1,
        Some("high") => 2,
        Some("medium") => 3,
        Some("low") => 4,
        _ => 0,
    }
}

pub async fn apply_patch(
    pool: &SqlitePool,
    id: &str,
    priority: i64,
    tags: &[String],
) -> Result<(), AppError> {
    let mut patch = PageUpdate::default();
    let mut touched = false;
    if priority != 0 {
        patch.priority = Some(priority);
        touched = true;
    }
    if !tags.is_empty() {
        patch.tags = Some(tags.to_vec());
        touched = true;
    }
    if touched {
        update_page_impl(pool, id.to_string(), patch).await?;
    }
    Ok(())
}

pub async fn resolve_folder(
    pool: &SqlitePool,
    folder_query: &Option<String>,
) -> Result<Option<String>, AppError> {
    let q = match folder_query {
        Some(q) if !q.is_empty() => q,
        _ => return Ok(None),
    };
    // Calendar folders are off the candidate list, as they are in Quick Add:
    // matching one would resolve to a folder `create_page_impl` then refuses.
    let folders: Vec<_> = list_folders_impl(pool)
        .await?
        .into_iter()
        .filter(|f| !f.is_external_calendar)
        .collect();
    // A real folder outranks the literal word, matching Quick Add: "inbox" names
    // the view only when nothing is named for it.
    Ok(fuzzy_match_folder(q, &folders).map(|f| f.id.clone()))
}

pub async fn schedule_once(
    pool: &SqlitePool,
    page_id: &str,
    start: &str,
    end: Option<&str>,
) -> Result<(), AppError> {
    let schedules = list_page_schedules_impl(pool, page_id).await?;
    if let Some(existing) = schedules.iter().find(|s| s.rule_id.is_none()) {
        let upd = pikos_db::PageScheduleUpdate {
            scheduled_start: Some(start.to_string()),
            scheduled_end: Some(
                end.map(|e| Value::String(e.to_string()))
                    .unwrap_or(Value::Null),
            ),
            ..Default::default()
        };
        update_page_schedule_impl(pool, existing.id.clone(), upd).await?;
    } else {
        pikos_db::create_page_schedule_impl(
            pool,
            NewPageSchedule {
                page_id: page_id.to_string(),
                scheduled_start: start.to_string(),
                scheduled_end: end.map(str::to_string),
                timezone: Some(local_tz()),
                rule_id: None,
                original_date: None,
            },
        )
        .await?;
    }
    Ok(())
}

/// A markdown body as the app's markdown import reads it (see [`pikos_core::markdown_import`]),
/// or the reason the editor couldn't hold it.
pub fn markdown_to_doc(markdown: &str) -> Result<Value, CliError> {
    pikos_core::markdown_to_prosemirror(markdown)
        .map_err(|pikos_core::Refused(why)| CliError::usage(why))
}

/// A markdown body → the Tiptap doc a page write takes, with each `[[title]]` linked to its
/// page. `linked` is what the page linked to before this write.
pub async fn markdown_to_tiptap(
    pool: &SqlitePool,
    markdown: &str,
    linked: &[String],
) -> Result<String, CliError> {
    Ok(markdown_to_linked_doc(pool, markdown, linked)
        .await?
        .to_string())
}

pub async fn markdown_to_linked_doc(
    pool: &SqlitePool,
    markdown: &str,
    linked: &[String],
) -> Result<Value, CliError> {
    let mut doc = markdown_to_doc(markdown)?;
    pikos_db::page_links::link_titles(pool, &mut doc, linked)
        .await
        .map_err(crate::error::classify)?;
    Ok(doc)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn priority_num_maps_words() {
        assert_eq!(priority_num(&Some("urgent".into())), 1);
        assert_eq!(priority_num(&Some("high".into())), 2);
        assert_eq!(priority_num(&Some("medium".into())), 3);
        assert_eq!(priority_num(&Some("low".into())), 4);
        assert_eq!(priority_num(&None), 0);
        assert_eq!(priority_num(&Some("nonsense".into())), 0);
    }

    #[test]
    fn markdown_to_doc_keeps_structure() {
        let doc = markdown_to_doc("# Plan\n\n- [ ] **call** Sam").unwrap();
        assert_eq!(doc["content"][0]["type"], "heading");
        assert_eq!(doc["content"][2]["type"], "taskList");
    }

    #[test]
    fn markdown_to_doc_refuses_what_the_editor_cannot_hold() {
        let err = markdown_to_doc("a <b>bold</b> word").unwrap_err();
        assert_eq!(err.kind, "Usage");
    }
}
