use super::*;
use crate::pool::test_pool;

async fn insert_tag(pool: &sqlx::SqlitePool, name: &str) {
    sqlx::query("INSERT INTO tags (id, name, created_at) VALUES (?, ?, '2026-01-01T00:00:00Z')")
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn matches_prefix_only() {
    let pool = test_pool().await;
    for name in ["work", "workout", "home", "rework"] {
        insert_tag(&pool, name).await;
    }

    let hits = search_tags(&pool, "work").await.unwrap();
    // Prefix anchored: "rework" is excluded, "work"/"workout" included.
    assert_eq!(hits, vec!["work", "workout"]);
}

#[tokio::test]
async fn is_case_insensitive() {
    let pool = test_pool().await;
    insert_tag(&pool, "Health").await;
    insert_tag(&pool, "HOME").await;

    assert_eq!(search_tags(&pool, "he").await.unwrap(), vec!["Health"]);
    assert_eq!(search_tags(&pool, "HO").await.unwrap(), vec!["HOME"]);
}

#[tokio::test]
async fn orders_results_alphabetically() {
    let pool = test_pool().await;
    for name in ["banana", "apple", "cherry"] {
        insert_tag(&pool, name).await;
    }

    // Empty query matches everything; assert the ORDER BY name ASC.
    assert_eq!(
        search_tags(&pool, "").await.unwrap(),
        vec!["apple", "banana", "cherry"]
    );
}

#[tokio::test]
async fn caps_at_twenty_results() {
    let pool = test_pool().await;
    for i in 0..25 {
        insert_tag(&pool, &format!("tag{i:02}")).await;
    }

    let hits = search_tags(&pool, "tag").await.unwrap();
    assert_eq!(hits.len(), 20);
    // LIMIT applies after ordering, so the first 20 by name are returned.
    assert_eq!(hits.first().unwrap(), "tag00");
    assert_eq!(hits.last().unwrap(), "tag19");
}

#[tokio::test]
async fn no_match_returns_empty() {
    let pool = test_pool().await;
    insert_tag(&pool, "work").await;
    assert!(search_tags(&pool, "xyz").await.unwrap().is_empty());
}

#[tokio::test]
async fn escapes_nothing_but_handles_special_chars() {
    let pool = test_pool().await;
    // A literal "%" in a stored tag should still be matchable by its prefix.
    insert_tag(&pool, "100%done").await;
    assert_eq!(search_tags(&pool, "100").await.unwrap(), vec!["100%done"]);
}
