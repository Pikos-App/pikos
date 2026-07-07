//! Tests for the sync-settings writers: account/calendar CRUD, and the folder
//! lifecycle that toggling a calendar drives (create/re-flag on enable, teardown
//! on disable).

use super::*;
use crate::pool::{insert_test_page, test_pool, TestPage};

async fn account(pool: &sqlx::SqlitePool) -> String {
    insert_sync_account_impl(pool, "caldav", "Fastmail", "basic")
        .await
        .unwrap()
        .id
}

async fn folder_flag(pool: &sqlx::SqlitePool, folder_id: &str) -> Option<i64> {
    sqlx::query_scalar("SELECT is_external_calendar FROM folders WHERE id = ?")
        .bind(folder_id)
        .fetch_optional(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn status_lists_accounts_with_their_calendars() {
    let pool = test_pool().await;
    let acc = account(&pool).await;
    upsert_sync_calendar_impl(&pool, &acc, "cal-a", "Work", Some("#abc"))
        .await
        .unwrap();
    upsert_sync_calendar_impl(&pool, &acc, "cal-b", "Personal", None)
        .await
        .unwrap();

    let status = get_sync_status_impl(&pool).await.unwrap();
    assert_eq!(status.len(), 1);
    assert_eq!(status[0].account.display_name, "Fastmail");
    assert_eq!(status[0].calendars.len(), 2);
    assert!(status[0].calendars.iter().all(|c| !c.enabled));
}

#[tokio::test]
async fn dormant_account_is_hidden_and_reused_by_provider_and_name() {
    let pool = test_pool().await;
    let acc = insert_sync_account_impl(&pool, "caldav", "you · https://x", "basic")
        .await
        .unwrap()
        .id;
    let other = insert_sync_account_impl(&pool, "caldav", "someone · https://y", "basic")
        .await
        .unwrap()
        .id;

    // A live account never matches the dormant-reuse lookup.
    assert!(
        find_dormant_account_impl(&pool, "caldav", "you · https://x")
            .await
            .unwrap()
            .is_none(),
        "an active account is not a reuse target"
    );

    mark_account_disconnected_impl(&pool, &acc).await.unwrap();

    // Hidden from the panel, but still matchable for reconnect — by exact
    // provider+display_name only (the other account and a wrong name miss).
    let visible = get_sync_status_impl(&pool).await.unwrap();
    assert_eq!(visible.len(), 1, "dormant account hidden; the live one remains");
    assert_eq!(visible[0].account.id, other);
    assert!(find_dormant_account_impl(&pool, "caldav", "nope")
        .await
        .unwrap()
        .is_none());
    let matched = find_dormant_account_impl(&pool, "caldav", "you · https://x")
        .await
        .unwrap()
        .expect("dormant account found by provider+display_name");
    assert_eq!(matched.id, acc);

    reactivate_account_impl(&pool, &acc).await.unwrap();
    assert_eq!(
        get_sync_status_impl(&pool).await.unwrap().len(),
        2,
        "reactivated account reappears in the panel"
    );
    assert!(
        find_dormant_account_impl(&pool, "caldav", "you · https://x")
            .await
            .unwrap()
            .is_none(),
        "reactivated account is no longer a reuse target"
    );
}

#[tokio::test]
async fn upsert_calendar_is_idempotent_on_keys() {
    let pool = test_pool().await;
    let acc = account(&pool).await;
    let first = upsert_sync_calendar_impl(&pool, &acc, "cal-a", "Work", None)
        .await
        .unwrap();
    let second = upsert_sync_calendar_impl(&pool, &acc, "cal-a", "Work (renamed)", None)
        .await
        .unwrap();

    assert_eq!(first.id, second.id, "same row, not a duplicate");
    assert_eq!(second.display_name, "Work (renamed)");
    let all = list_sync_calendars_impl(&pool, &acc).await.unwrap();
    assert_eq!(all.len(), 1);
}

#[tokio::test]
async fn enable_creates_external_folder_and_links_it() {
    let pool = test_pool().await;
    let acc = account(&pool).await;
    let cal = upsert_sync_calendar_impl(&pool, &acc, "cal-a", "Work", None)
        .await
        .unwrap();

    let enabled = toggle_sync_calendar_impl(&pool, &cal.id, true, Some("#ff0"))
        .await
        .unwrap();

    assert!(enabled.enabled);
    assert_eq!(enabled.color.as_deref(), Some("#ff0"));
    let folder_id = enabled.folder_id.expect("folder linked on enable");
    assert_eq!(folder_flag(&pool, &folder_id).await, Some(1));
}

#[tokio::test]
async fn disable_tears_down_bare_folder_and_clears_cursor() {
    let pool = test_pool().await;
    let acc = account(&pool).await;
    let cal = upsert_sync_calendar_impl(&pool, &acc, "cal-a", "Work", None)
        .await
        .unwrap();
    let enabled = toggle_sync_calendar_impl(&pool, &cal.id, true, None)
        .await
        .unwrap();
    let folder_id = enabled.folder_id.clone().unwrap();
    // Pretend a sync ran and stored a cursor.
    sqlx::query("UPDATE sync_calendar SET sync_token = 'tok' WHERE id = ?")
        .bind(&cal.id)
        .execute(&pool)
        .await
        .unwrap();

    let disabled = toggle_sync_calendar_impl(&pool, &cal.id, false, None)
        .await
        .unwrap();

    assert!(!disabled.enabled);
    assert_eq!(disabled.folder_id, None, "bare folder removed → link cleared");
    assert_eq!(folder_flag(&pool, &folder_id).await, None, "folder deleted");
    let token: Option<String> = sqlx::query_scalar("SELECT sync_token FROM sync_calendar WHERE id = ?")
        .bind(&cal.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(token, None, "cursor cleared so re-enable backfills fresh");
}

#[tokio::test]
async fn disable_keeps_and_deflags_folder_with_a_survivor() {
    let pool = test_pool().await;
    let acc = account(&pool).await;
    let cal = upsert_sync_calendar_impl(&pool, &acc, "cal-a", "Work", None)
        .await
        .unwrap();
    let enabled = toggle_sync_calendar_impl(&pool, &cal.id, true, None)
        .await
        .unwrap();
    let folder_id = enabled.folder_id.clone().unwrap();
    // A page living in the folder survives teardown → folder is kept, de-flagged.
    insert_test_page(
        &pool,
        TestPage {
            folder_id: Some(&folder_id),
            ..TestPage::new("p-keep", "My note")
        },
    )
    .await
    .unwrap();

    let disabled = toggle_sync_calendar_impl(&pool, &cal.id, false, None)
        .await
        .unwrap();

    assert_eq!(disabled.folder_id.as_deref(), Some(folder_id.as_str()));
    assert_eq!(folder_flag(&pool, &folder_id).await, Some(0), "de-flagged, kept");
}

#[tokio::test]
async fn re_enable_reflags_the_same_folder() {
    let pool = test_pool().await;
    let acc = account(&pool).await;
    let cal = upsert_sync_calendar_impl(&pool, &acc, "cal-a", "Work", None)
        .await
        .unwrap();
    let enabled = toggle_sync_calendar_impl(&pool, &cal.id, true, None)
        .await
        .unwrap();
    let folder_id = enabled.folder_id.clone().unwrap();
    insert_test_page(
        &pool,
        TestPage {
            folder_id: Some(&folder_id),
            ..TestPage::new("p-keep", "My note")
        },
    )
    .await
    .unwrap();
    toggle_sync_calendar_impl(&pool, &cal.id, false, None)
        .await
        .unwrap();

    let re_enabled = toggle_sync_calendar_impl(&pool, &cal.id, true, None)
        .await
        .unwrap();

    assert_eq!(
        re_enabled.folder_id.as_deref(),
        Some(folder_id.as_str()),
        "re-link the same folder, not a new one"
    );
    assert_eq!(folder_flag(&pool, &folder_id).await, Some(1), "re-flagged external");
    let folder_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM folders")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(folder_count, 1, "no duplicate folder");
}
