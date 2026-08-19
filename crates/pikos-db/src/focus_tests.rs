use super::*;
use crate::pool::{insert_test_page, test_pool, TestPage};

async fn seed_page(pool: &sqlx::SqlitePool, id: &str) {
    insert_test_page(pool, TestPage::new(id, id)).await.unwrap();
}

async fn session_rows(pool: &sqlx::SqlitePool) -> Vec<(String, Option<String>, String, i64)> {
    sqlx::query_as::<_, (String, Option<String>, String, i64)>(
        "SELECT id, page_id, started_at, duration_s FROM focus_sessions ORDER BY started_at",
    )
    .fetch_all(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn create_persists_and_returns_the_row() {
    let pool = test_pool().await;
    seed_page(&pool, "p1").await;

    let s = create_focus_session(
        &pool,
        "p1",
        "2026-06-01T09:00:00",
        "2026-06-01T09:25:00",
        1500,
    )
    .await
    .unwrap();

    assert_eq!(s.page_id, "p1");
    assert_eq!(s.started_at, "2026-06-01T09:00:00");
    assert_eq!(s.ended_at, "2026-06-01T09:25:00");
    assert_eq!(s.duration_s, 1500);
    assert!(!s.id.is_empty());

    let rows = session_rows(&pool).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, s.id);
    assert_eq!(rows[0].1.as_deref(), Some("p1"));
    assert_eq!(rows[0].3, 1500);
}

#[tokio::test]
async fn sessions_accumulate_on_one_page() {
    let pool = test_pool().await;
    seed_page(&pool, "p1").await;

    for (start, end) in [
        ("2026-06-01T09:00:00", "2026-06-01T09:10:00"),
        ("2026-06-01T14:00:00", "2026-06-01T14:30:00"),
    ] {
        create_focus_session(&pool, "p1", start, end, 600)
            .await
            .unwrap();
    }

    assert_eq!(session_rows(&pool).await.len(), 2);
}

#[tokio::test]
async fn a_non_positive_duration_is_refused() {
    let pool = test_pool().await;
    seed_page(&pool, "p1").await;

    for bad in [0, -1] {
        let err = create_focus_session(
            &pool,
            "p1",
            "2026-06-01T09:00:00",
            "2026-06-01T09:00:00",
            bad,
        )
        .await
        .unwrap_err();
        assert!(
            matches!(err, AppError::Invalid(_)),
            "duration {bad} should be Invalid, got {err:?}"
        );
    }
    // Nothing reached the table — the totals stay clean.
    assert!(session_rows(&pool).await.is_empty());
}

#[tokio::test]
async fn a_session_against_a_missing_page_is_refused() {
    let pool = test_pool().await;

    let err = create_focus_session(
        &pool,
        "ghost",
        "2026-06-01T09:00:00",
        "2026-06-01T09:25:00",
        1500,
    )
    .await
    .unwrap_err();

    assert!(
        matches!(err, AppError::NotFound(_)),
        "expected NotFound, got {err:?}"
    );
    assert!(session_rows(&pool).await.is_empty());
}

/// The column is `ON DELETE SET NULL`, so the session outlives the page it was
/// spent on and keeps counting toward the totals. Pinned here because the writer's
/// existence check would otherwise read as "sessions belong to live pages".
#[tokio::test]
async fn deleting_the_page_orphans_the_session_rather_than_removing_it() {
    let pool = test_pool().await;
    seed_page(&pool, "p1").await;
    create_focus_session(
        &pool,
        "p1",
        "2026-06-01T09:00:00",
        "2026-06-01T09:25:00",
        1500,
    )
    .await
    .unwrap();

    sqlx::query("DELETE FROM pages WHERE id = ?")
        .bind("p1")
        .execute(&pool)
        .await
        .unwrap();

    let rows = session_rows(&pool).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].1, None);
}
