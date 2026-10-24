use super::*;
use crate::pool::test_pool;
use serde_json::json;

async fn page(pool: &SqlitePool, id: &str, title: &str) {
    sqlx::query(
        "INSERT INTO pages (id, title, content, content_text, status, priority, tags, sort_order,
           created_at, updated_at)
         VALUES (?, ?, '{}', '', 'not_started', 0, '[]', 0, '2026-06-01T09:00:00',
           '2026-06-01T09:00:00')",
    )
    .bind(id)
    .bind(title)
    .execute(pool)
    .await
    .unwrap();
}

fn text(s: &str) -> Value {
    json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [
        { "type": "text", "text": s }
    ]}]})
}

#[tokio::test]
async fn a_title_links_its_page_whatever_its_case() {
    let pool = test_pool().await;
    page(&pool, "plans", "Plans").await;
    let mut doc = text("See [[plans]] and [[Nobody]]");

    link_titles(&pool, &mut doc, &[]).await.unwrap();

    assert_eq!(link_targets(&doc), ["plans"]);
}

#[tokio::test]
async fn a_shared_title_links_the_page_linked_before_or_nothing() {
    let pool = test_pool().await;
    page(&pool, "first", "Notes").await;
    page(&pool, "second", "Notes").await;

    let mut kept = text("[[Notes]]");
    link_titles(&pool, &mut kept, &["second".to_string()])
        .await
        .unwrap();
    let mut guessed = text("[[Notes]]");
    link_titles(&pool, &mut guessed, &[]).await.unwrap();

    assert_eq!(link_targets(&kept), ["second"]);
    assert!(link_targets(&guessed).is_empty());
}

#[tokio::test]
async fn markdown_names_a_renamed_page_by_its_new_title() {
    let pool = test_pool().await;
    page(&pool, "plans", "Plans for spring").await;
    let mut doc = json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [
        { "type": "pageLink", "attrs": { "pageId": "plans", "title": "Plans" } }
    ]}]});

    refresh_titles(&pool, &mut doc).await.unwrap();

    assert_eq!(
        pikos_core::prosemirror_to_markdown(&doc),
        "[[Plans for spring]]\n"
    );
}
