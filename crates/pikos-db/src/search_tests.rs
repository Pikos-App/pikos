use super::*;
use crate::pool::{insert_test_page, test_pool, TestPage};

async fn seed_pages(pool: &sqlx::SqlitePool) {
    for (id, title, subtitle, content_text, status, tags) in [
        (
            "p1",
            "Morning routine",
            None,
            "Coffee, journaling, exercise.",
            "not_started",
            "[]",
        ),
        (
            "p2",
            "Project notes",
            Some("morning sync"),
            "Discussed Q3 roadmap.",
            "not_started",
            "[]",
        ),
        (
            "p3",
            "Random journal",
            None,
            "Felt great this morning after a walk.",
            "not_started",
            "[]",
        ),
        (
            "p4",
            "Finished onboarding",
            None,
            "Closed the morning module last week.",
            "done",
            "[]",
        ),
        (
            "p5",
            "Deleted draft",
            None,
            "Should never appear in morning search.",
            "not_started",
            "[]",
        ),
        (
            "p6",
            "Multi-color palette",
            None,
            "Picking accent shades.",
            "not_started",
            "[]",
        ),
        (
            "p7",
            "Don't forget milk",
            None,
            "Grocery reminder.",
            "not_started",
            "[]",
        ),
        (
            "p8",
            "Tag-heavy",
            None,
            "Body has nothing relevant.",
            "not_started",
            r#"["mindfulness"]"#,
        ),
    ] {
        insert_test_page(
            pool,
            TestPage {
                id,
                title,
                subtitle,
                content_text,
                status,
                tags_json: tags,
                ..TestPage::new(id, title)
            },
        )
        .await
        .unwrap();
    }
    // Soft-delete p5 so deleted_at IS NOT NULL.
    sqlx::query("UPDATE pages SET deleted_at = '2026-01-01T00:00:00Z' WHERE id = 'p5'")
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn title_match_outranks_content_match() {
    let pool = test_pool().await;
    seed_pages(&pool).await;

    let resp = search_pages_impl(&pool, "morning".into(), None)
        .await
        .unwrap();
    // p1's title contains "Morning" — should rank above p3 whose match is body-only.
    let ids: Vec<&str> = resp.results.iter().map(|r| r.id.as_str()).collect();
    let p1 = ids.iter().position(|&i| i == "p1").expect("p1 present");
    let p3 = ids.iter().position(|&i| i == "p3").expect("p3 present");
    assert!(
        p1 < p3,
        "title match (p1) should outrank body match (p3): {ids:?}"
    );
}

#[tokio::test]
async fn excludes_deleted_and_completed_by_default() {
    let pool = test_pool().await;
    seed_pages(&pool).await;

    let resp = search_pages_impl(&pool, "morning".into(), None)
        .await
        .unwrap();
    let ids: Vec<&str> = resp.results.iter().map(|r| r.id.as_str()).collect();
    assert!(!ids.contains(&"p5"), "soft-deleted page leaked: {ids:?}");
    assert!(!ids.contains(&"p4"), "completed page leaked: {ids:?}");
    // completed_count counts matches regardless of include_completed.
    assert_eq!(resp.completed_count, 1, "p4 is the only done match");
}

#[tokio::test]
async fn include_completed_returns_done_pages() {
    let pool = test_pool().await;
    seed_pages(&pool).await;

    let resp = search_pages_impl(&pool, "morning".into(), Some(true))
        .await
        .unwrap();
    let ids: Vec<&str> = resp.results.iter().map(|r| r.id.as_str()).collect();
    // p4 is the only completed match — flag must let it through.
    assert!(ids.contains(&"p4"), "completed page absent: {ids:?}");
    assert!(!ids.contains(&"p5"), "soft-deleted page leaked: {ids:?}");
    assert_eq!(resp.completed_count, 1);
}

#[tokio::test]
async fn prefix_match_on_last_token() {
    let pool = test_pool().await;
    seed_pages(&pool).await;

    // "morn" alone should still match "morning" via the trailing `*`.
    let resp = search_pages_impl(&pool, "morn".into(), None).await.unwrap();
    let ids: Vec<&str> = resp.results.iter().map(|r| r.id.as_str()).collect();
    assert!(ids.contains(&"p1"), "prefix match missed p1: {ids:?}");
}

#[tokio::test]
async fn hyphenated_query_does_not_crash() {
    let pool = test_pool().await;
    seed_pages(&pool).await;

    // Naive FTS5 would treat `-` as NOT or column-qualifier and error out.
    // Tokenizer should split on hyphen.
    let resp = search_pages_impl(&pool, "multi-color".into(), None)
        .await
        .unwrap();
    let ids: Vec<&str> = resp.results.iter().map(|r| r.id.as_str()).collect();
    assert!(ids.contains(&"p6"), "hyphen query missed p6: {ids:?}");
}

#[tokio::test]
async fn apostrophe_query_does_not_crash() {
    let pool = test_pool().await;
    seed_pages(&pool).await;

    // `'` in FTS5 syntax is a phrase delimiter — must be stripped.
    let resp = search_pages_impl(&pool, "don't".into(), None)
        .await
        .unwrap();
    let ids: Vec<&str> = resp.results.iter().map(|r| r.id.as_str()).collect();
    assert!(ids.contains(&"p7"), "apostrophe query missed p7: {ids:?}");
}

#[tokio::test]
async fn tag_match_returns_result() {
    let pool = test_pool().await;
    seed_pages(&pool).await;

    // "mindfulness" only appears in p8's tags JSON.
    let resp = search_pages_impl(&pool, "mindfulness".into(), None)
        .await
        .unwrap();
    let ids: Vec<&str> = resp.results.iter().map(|r| r.id.as_str()).collect();
    assert!(ids.contains(&"p8"), "tag match missed p8: {ids:?}");
}

#[tokio::test]
async fn empty_query_returns_empty() {
    let pool = test_pool().await;
    seed_pages(&pool).await;

    let resp = search_pages_impl(&pool, "   ".into(), None).await.unwrap();
    assert!(resp.results.is_empty());
    assert_eq!(resp.completed_count, 0);
}

#[test]
fn build_excerpt_centers_on_match() {
    let body = "alpha beta gamma morning delta epsilon zeta";
    let out = build_excerpt(Some(body), "title", None, &["morning".into()]);
    assert!(out.contains("morning"), "{out:?}");
}

#[test]
fn build_excerpt_strips_title_and_subtitle() {
    // content_text often starts with title + subtitle (mirrors editor flow).
    let body = "My Page\nshort summary\nbody text with morning here";
    let out = build_excerpt(
        Some(body),
        "My Page",
        Some("short summary"),
        &["morning".into()],
    );
    assert!(!out.starts_with("My Page"), "title leaked: {out:?}");
    assert!(out.contains("morning"), "{out:?}");
}

#[test]
fn strip_prefix_ci_handles_multibyte() {
    // Regression check: char-based prefix strip must not panic on UTF-8.
    let stripped = strip_prefix_ci("Café au lait\nbody", "café");
    assert_eq!(stripped, Some(" au lait\nbody"));
}
