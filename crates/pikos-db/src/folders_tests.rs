use super::*;
use crate::pool::{insert_test_folder, insert_test_page, test_pool, TestPage};
use crate::soft_delete_page_impl;

async fn page_deleted_at(pool: &sqlx::SqlitePool, id: &str) -> Option<String> {
    sqlx::query_scalar::<_, Option<String>>("SELECT deleted_at FROM pages WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn folder_deleted_at(pool: &sqlx::SqlitePool, id: &str) -> Option<String> {
    sqlx::query_scalar::<_, Option<String>>("SELECT deleted_at FROM folders WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn seed_folder_with_pages(pool: &sqlx::SqlitePool) {
    insert_test_folder(pool, "f1", "Work").await.unwrap();
    insert_test_folder(pool, "f2", "Personal").await.unwrap();
    for (id, folder) in [("p1", Some("f1")), ("p2", Some("f1")), ("p3", Some("f2"))] {
        insert_test_page(
            pool,
            TestPage {
                folder_id: folder,
                ..TestPage::new(id, id)
            },
        )
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn soft_delete_cascades_to_folder_pages() {
    let pool = test_pool().await;
    seed_folder_with_pages(&pool).await;

    soft_delete_folder_impl(&pool, "f1".into()).await.unwrap();

    assert!(folder_deleted_at(&pool, "f1").await.is_some());
    assert!(page_deleted_at(&pool, "p1").await.is_some());
    assert!(page_deleted_at(&pool, "p2").await.is_some());
    // Other folder's pages are untouched.
    assert!(page_deleted_at(&pool, "p3").await.is_none());
    assert!(folder_deleted_at(&pool, "f2").await.is_none());
}

#[tokio::test]
async fn soft_delete_is_noop_when_already_deleted() {
    let pool = test_pool().await;
    seed_folder_with_pages(&pool).await;

    // Pre-soft-delete a single page with a recognizable timestamp.
    sqlx::query("UPDATE pages SET deleted_at = '2026-01-01T00:00:00Z' WHERE id = 'p1'")
        .execute(&pool)
        .await
        .unwrap();

    soft_delete_folder_impl(&pool, "f1".into()).await.unwrap();

    // The pre-existing deleted_at on p1 should be preserved (WHERE deleted_at IS NULL guard).
    assert_eq!(
        page_deleted_at(&pool, "p1").await.as_deref(),
        Some("2026-01-01T00:00:00Z"),
        "soft-delete overwrote an earlier trash timestamp"
    );
    // p2 gets a fresh deleted_at.
    assert!(page_deleted_at(&pool, "p2").await.is_some());
}

#[tokio::test]
async fn restore_folder_restores_its_pages() {
    let pool = test_pool().await;
    seed_folder_with_pages(&pool).await;

    soft_delete_folder_impl(&pool, "f1".into()).await.unwrap();
    // Sanity precondition
    assert!(page_deleted_at(&pool, "p1").await.is_some());

    restore_folder_impl(&pool, "f1".into()).await.unwrap();

    assert!(folder_deleted_at(&pool, "f1").await.is_none());
    assert!(page_deleted_at(&pool, "p1").await.is_none());
    assert!(page_deleted_at(&pool, "p2").await.is_none());
}

#[tokio::test]
async fn restore_folder_preserves_individually_trashed_pages() {
    // A page the user trashed *before* the folder must stay trashed after the
    // folder is restored — only the pages this folder deletion cascaded to
    // should revive.
    let pool = test_pool().await;
    seed_folder_with_pages(&pool).await;

    // Trash p1 on its own first. The 2ms gap guarantees a distinct (ms-precision)
    // deleted_at from the folder cascade below, so the restore can tell them apart.
    soft_delete_page_impl(&pool, "p1").await.unwrap();
    std::thread::sleep(std::time::Duration::from_millis(2));
    let p1_trashed_at = page_deleted_at(&pool, "p1").await;
    assert!(p1_trashed_at.is_some());

    // Now trash the whole folder; the cascade skips p1 (already trashed) and
    // stamps p2 with the folder's timestamp.
    soft_delete_folder_impl(&pool, "f1".into()).await.unwrap();
    assert_ne!(
        page_deleted_at(&pool, "p1").await,
        folder_deleted_at(&pool, "f1").await,
        "cascade must not overwrite the earlier individual-trash timestamp"
    );

    restore_folder_impl(&pool, "f1".into()).await.unwrap();

    assert!(folder_deleted_at(&pool, "f1").await.is_none());
    assert!(
        page_deleted_at(&pool, "p2").await.is_none(),
        "cascade-trashed page should be revived"
    );
    assert_eq!(
        page_deleted_at(&pool, "p1").await,
        p1_trashed_at,
        "individually-trashed page must stay trashed with its original timestamp"
    );
}

#[tokio::test]
async fn hard_delete_drops_folder_and_soft_deletes_pages() {
    let pool = test_pool().await;
    seed_folder_with_pages(&pool).await;

    delete_folder_impl(&pool, "f1".into()).await.unwrap();

    // Folder row is gone.
    let folder_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM folders WHERE id = 'f1'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(folder_count, 0);

    // Pages still exist but are soft-deleted, and the FK SET NULL fired
    // because the folder row was dropped.
    let p1_folder: Option<String> =
        sqlx::query_scalar("SELECT folder_id FROM pages WHERE id = 'p1'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(p1_folder.is_none(), "FK ON DELETE SET NULL did not fire");
    assert!(page_deleted_at(&pool, "p1").await.is_some());
    assert!(page_deleted_at(&pool, "p2").await.is_some());
    // Sibling folder's pages unaffected.
    assert!(page_deleted_at(&pool, "p3").await.is_none());
}

// ── CRUD round-trips ───────────────────────────────────────────────────────

fn new_folder(name: &str) -> NewFolder {
    NewFolder {
        name: name.into(),
        parent_id: None,
        color: None,
        icon: None,
    }
}

async fn fetch_sort_order(pool: &sqlx::SqlitePool, id: &str) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT sort_order FROM folders WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn create_folder_assigns_incrementing_sort_order() {
    let pool = test_pool().await;
    let first = create_folder_impl(&pool, new_folder("First"))
        .await
        .unwrap();
    let second = create_folder_impl(&pool, new_folder("Second"))
        .await
        .unwrap();
    let third = create_folder_impl(&pool, new_folder("Third"))
        .await
        .unwrap();

    assert_eq!(first.sort_order, 0);
    assert_eq!(second.sort_order, 1);
    assert_eq!(third.sort_order, 2);
    assert_ne!(first.id, second.id);
}

#[tokio::test]
async fn create_folder_persists_color_and_icon() {
    let pool = test_pool().await;
    let folder = create_folder_impl(
        &pool,
        NewFolder {
            name: "Coloured".into(),
            parent_id: None,
            color: Some("#6366f1".into()),
            icon: Some("inbox".into()),
        },
    )
    .await
    .unwrap();

    assert_eq!(folder.color.as_deref(), Some("#6366f1"));
    assert_eq!(folder.icon.as_deref(), Some("inbox"));
}

#[tokio::test]
async fn get_folder_returns_none_for_missing_id() {
    let pool = test_pool().await;
    let result = get_folder_impl(&pool, "no-such-folder").await.unwrap();
    assert!(result.is_none());
}

#[tokio::test]
async fn update_folder_applies_partial_changes_and_clears_nullable_fields() {
    let pool = test_pool().await;
    let folder = create_folder_impl(
        &pool,
        NewFolder {
            name: "Before".into(),
            parent_id: None,
            color: Some("#000000".into()),
            icon: Some("inbox".into()),
        },
    )
    .await
    .unwrap();

    // Rename + clear color via Value::Null.
    let updated = update_folder_impl(
        &pool,
        folder.id.clone(),
        FolderUpdate {
            name: Some("After".into()),
            color: Some(serde_json::Value::Null),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    assert_eq!(updated.name, "After");
    assert!(updated.color.is_none(), "color must be cleared");
    assert_eq!(
        updated.icon.as_deref(),
        Some("inbox"),
        "untouched field preserved"
    );
}

#[tokio::test]
async fn list_folders_excludes_soft_deleted_and_sorts_by_sort_order() {
    let pool = test_pool().await;
    let a = create_folder_impl(&pool, new_folder("A")).await.unwrap();
    let b = create_folder_impl(&pool, new_folder("B")).await.unwrap();
    let c = create_folder_impl(&pool, new_folder("C")).await.unwrap();

    // Soft-delete the middle one.
    soft_delete_folder_impl(&pool, b.id.clone()).await.unwrap();

    let visible = list_folders_impl(&pool).await.unwrap();
    let ids: Vec<&str> = visible.iter().map(|f| f.id.as_str()).collect();
    assert_eq!(ids, vec![a.id.as_str(), c.id.as_str()]);
}

#[tokio::test]
async fn reorder_folders_assigns_positional_indices() {
    let pool = test_pool().await;
    let a = create_folder_impl(&pool, new_folder("A")).await.unwrap();
    let b = create_folder_impl(&pool, new_folder("B")).await.unwrap();
    let c = create_folder_impl(&pool, new_folder("C")).await.unwrap();

    // Reverse the order.
    reorder_folders_impl(&pool, &[c.id.clone(), b.id.clone(), a.id.clone()])
        .await
        .unwrap();

    assert_eq!(fetch_sort_order(&pool, &c.id).await, 0);
    assert_eq!(fetch_sort_order(&pool, &b.id).await, 1);
    assert_eq!(fetch_sort_order(&pool, &a.id).await, 2);
}
