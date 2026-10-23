use std::collections::HashSet;

use super::{asset_paths_in, pikos_file_name, referenced_asset_paths};
use crate::backups::{backups_dir, snapshot_workspace};
use crate::*;

fn page_with_images(title: &str, srcs: &[&str]) -> NewPage {
    let images: Vec<_> = srcs
        .iter()
        .map(|src| serde_json::json!({ "type": "image", "attrs": { "src": src } }))
        .collect();
    NewPage {
        folder_id: None,
        title: title.into(),
        subtitle: None,
        content: serde_json::json!({ "type": "doc", "content": images }).to_string(),
        status: "not_started".into(),
        priority: 0,
        tags: vec![],
        scheduled_start: None,
        scheduled_end: None,
        completed_at: None,
        parent_id: None,
        last_opened_at: None,
        created_at: None,
        updated_at: None,
    }
}

fn set(paths: &[&str]) -> HashSet<String> {
    paths.iter().map(ToString::to_string).collect()
}

#[tokio::test]
async fn images_on_live_and_trashed_pages_are_referenced_and_a_deleted_pages_are_not() {
    let pool = test_pool().await;
    create_page_impl(&pool, page_with_images("Live", &["assets/live.png"]))
        .await
        .unwrap();
    let trashed = create_page_impl(&pool, page_with_images("Trashed", &["assets/trashed.png"]))
        .await
        .unwrap();
    soft_delete_page_impl(&pool, &trashed.id).await.unwrap();
    let gone = create_page_impl(&pool, page_with_images("Gone", &["assets/gone.png"]))
        .await
        .unwrap();
    delete_page_impl(&pool, &gone.id).await.unwrap();

    let found = asset_paths_in(&pool).await.unwrap();

    assert_eq!(found, set(&["assets/live.png", "assets/trashed.png"]));
}

// qa: EDIT-24:3
#[tokio::test]
async fn an_image_only_a_backup_still_refers_to_is_referenced() {
    let dir = std::env::temp_dir().join(format!("pkos_assets_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("workspace.sqlite").to_string_lossy().to_string();
    let pool = open_pool(&path).await.unwrap();
    let page = create_page_impl(&pool, page_with_images("Before", &["assets/old.png"]))
        .await
        .unwrap();
    std::fs::create_dir_all(backups_dir(&path)).unwrap();
    snapshot_workspace(
        &path,
        &backups_dir(&path).join("pre-import-20260101T000000Z.sqlite"),
    )
    .await
    .unwrap();
    delete_page_impl(&pool, &page.id).await.unwrap();

    let found = referenced_asset_paths(&pool, &path).await.unwrap();

    assert_eq!(found, set(&["assets/old.png"]));
    pool.close().await;
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn only_a_file_pikos_saved_is_named_as_one() {
    let name = "0f8a1b6e-2c3d-4e5f-8a9b-0c1d2e3f4a5b.png";

    assert_eq!(pikos_file_name(&format!("assets/{name}")), Some(name));
    assert_eq!(
        pikos_file_name(&format!("/abs/app.pikos.desktop/assets/{name}")),
        Some(name)
    );
    assert_eq!(pikos_file_name("assets/holiday.png"), None);
    assert_eq!(pikos_file_name(&format!("photos/{name}")), None);
    assert_eq!(pikos_file_name(&format!("assets/../{name}")), None);
}
