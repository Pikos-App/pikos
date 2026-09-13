//! Write helpers that mirror the app's persistence path, so a CLI-written page is
//! indistinguishable from one the desktop app wrote.

use pikos_db::{
    build_tiptap_doc, fuzzy_match_folder, list_folders_impl, list_page_schedules_impl,
    update_page_impl, update_page_schedule_impl, AppError, NewPage, NewPageSchedule, PageUpdate,
};
use serde_json::Value;
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
        content_text: Some(String::new()),
        status: "not_started".to_string(),
        priority: 0,
        tags: Vec::new(),
        scheduled_start: None,
        scheduled_end: None,
        completed_at: None,
        links: Vec::new(),
        parent_id: None,
        last_opened_at: None,
        created_at: None,
        updated_at: None,
    }
}

/// [`base_page`] with a parsed `//` body already in it, so the page is written
/// once rather than created empty and immediately patched.
pub fn page_with_body(folder_id: Option<String>, title: String, body: Option<&String>) -> NewPage {
    let mut page = base_page(folder_id, title);
    if let Some(text) = body.filter(|t| !t.is_empty()) {
        let (doc, plain) = text_to_tiptap(text);
        page.content = doc;
        page.content_text = Some(plain);
    }
    page
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

/// `--content` text → the (Tiptap doc, `content_text`) pair a page write takes.
/// The doc itself comes from [`pikos_db::build_tiptap_doc`], the same builder the
/// reconciler seeds descriptions with, so a CLI-written body is byte-identical to
/// one the app wrote.
pub fn text_to_tiptap(text: &str) -> (String, String) {
    (build_tiptap_doc(text), text.to_string())
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
    fn text_to_tiptap_wraps_lines_and_keeps_plaintext() {
        let (content, text) = text_to_tiptap("hello\nworld");
        assert_eq!(text, "hello\nworld");
        let doc: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(doc["type"], "doc");
        assert_eq!(doc["content"][0]["content"][0]["text"], "hello");
        assert_eq!(doc["content"][1]["content"][0]["text"], "world");
    }
}
