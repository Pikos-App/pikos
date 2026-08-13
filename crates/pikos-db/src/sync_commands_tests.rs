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

async fn folder_name_color(
    pool: &sqlx::SqlitePool,
    folder_id: &str,
) -> (String, Option<String>, String) {
    sqlx::query_as("SELECT name, color, updated_at FROM folders WHERE id = ?")
        .bind(folder_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn enabled_calendar(
    pool: &sqlx::SqlitePool,
    acc: &str,
    name: &str,
    color: Option<&str>,
) -> (SyncCalendar, String) {
    let cal = upsert_sync_calendar_impl(pool, acc, "cal-a", name, color)
        .await
        .unwrap();
    let enabled = toggle_sync_calendar_impl(pool, &cal.id, true, color)
        .await
        .unwrap();
    let folder_id = enabled.folder_id.clone().expect("folder linked on enable");
    (enabled, folder_id)
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
async fn account_is_reused_by_identity_whether_dormant_or_active() {
    let pool = test_pool().await;
    let acc = insert_sync_account_impl(&pool, "caldav", "you · https://x", "basic")
        .await
        .unwrap()
        .id;
    let other = insert_sync_account_impl(&pool, "caldav", "someone · https://y", "basic")
        .await
        .unwrap()
        .id;

    // An *active* account is a reuse target too — reconnecting it refreshes in place
    // instead of inserting a duplicate. Matched by exact provider+display_name;
    // the other account and a wrong name miss.
    let matched = find_account_by_identity_impl(&pool, "caldav", "you · https://x")
        .await
        .unwrap()
        .expect("active account matched by provider+display_name");
    assert_eq!(matched.id, acc);
    assert!(find_account_by_identity_impl(&pool, "caldav", "nope")
        .await
        .unwrap()
        .is_none());

    mark_account_disconnected_impl(&pool, &acc).await.unwrap();

    // Dormant: hidden from the panel, but still matchable for reconnect.
    let visible = get_sync_status_impl(&pool).await.unwrap();
    assert_eq!(
        visible.len(),
        1,
        "dormant account hidden; the live one remains"
    );
    assert_eq!(visible[0].account.id, other);
    let matched = find_account_by_identity_impl(&pool, "caldav", "you · https://x")
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
    assert_eq!(
        disabled.folder_id, None,
        "bare folder removed → link cleared"
    );
    assert_eq!(folder_flag(&pool, &folder_id).await, None, "folder deleted");
    let token: Option<String> =
        sqlx::query_scalar("SELECT sync_token FROM sync_calendar WHERE id = ?")
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
    assert_eq!(
        folder_flag(&pool, &folder_id).await,
        Some(0),
        "de-flagged, kept"
    );
}

/// The poll loop selects on `enabled`, so it is only excluded from the teardown
/// window if disable clears the flag before severing anything. Witnessed through a
/// trigger, since the ordering is invisible in the end state.
#[tokio::test]
async fn disable_clears_enabled_before_severing_any_page() {
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
            ..TestPage::new("p-owned", "Mine")
        },
    )
    .await
    .unwrap();
    // user_modified → owned → teardown detaches rather than deleting, so the
    // severing is an UPDATE the trigger can hang off.
    sqlx::query(
        "INSERT INTO page_sync
           (id, page_id, account_id, provider, calendar_id, external_id, ical_uid,
            user_modified, created_at)
         VALUES ('ps-owned', 'p-owned', ?, 'caldav', 'cal-a', '/ev.ics', 'uid-1', 1, ?)",
    )
    .bind(&acc)
    .bind(now_iso())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("CREATE TABLE witness (enabled INTEGER)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "CREATE TRIGGER witness_enabled AFTER UPDATE OF sync_state ON page_sync
         BEGIN
           INSERT INTO witness SELECT enabled FROM sync_calendar WHERE calendar_id = 'cal-a';
         END",
    )
    .execute(&pool)
    .await
    .unwrap();

    toggle_sync_calendar_impl(&pool, &cal.id, false, None)
        .await
        .unwrap();

    let seen: Vec<i64> = sqlx::query_scalar("SELECT enabled FROM witness")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(
        seen,
        vec![0],
        "already disabled when the first page was cut"
    );
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
    assert_eq!(
        folder_flag(&pool, &folder_id).await,
        Some(1),
        "re-flagged external"
    );
    let folder_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM folders")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(folder_count, 1, "no duplicate folder");
}

#[tokio::test]
async fn an_upstream_rename_reaches_the_calendars_folder() {
    let pool = test_pool().await;
    let acc = account(&pool).await;
    let (_, folder_id) = enabled_calendar(&pool, &acc, "Work", None).await;

    upsert_sync_calendar_impl(&pool, &acc, "cal-a", "Work (renamed)", None)
        .await
        .unwrap();

    let (name, _, _) = folder_name_color(&pool, &folder_id).await;
    assert_eq!(
        name, "Work (renamed)",
        "the sidebar folder follows the calendar's name"
    );
}

#[tokio::test]
async fn re_enable_re_asserts_the_calendars_name_onto_a_surviving_folder() {
    let pool = test_pool().await;
    let acc = account(&pool).await;
    let (cal, folder_id) = enabled_calendar(&pool, &acc, "Work", None).await;
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
    upsert_sync_calendar_impl(&pool, &acc, "cal-a", "Renamed while off", None)
        .await
        .unwrap();

    toggle_sync_calendar_impl(&pool, &cal.id, true, None)
        .await
        .unwrap();

    let (name, _, _) = folder_name_color(&pool, &folder_id).await;
    assert_eq!(
        name, "Renamed while off",
        "the re-flag arm renames the folder it reclaims"
    );
}

#[tokio::test]
async fn re_discovery_follows_the_provider_colour_until_the_user_picks_one() {
    let pool = test_pool().await;
    let acc = account(&pool).await;
    let (cal, folder_id) = enabled_calendar(&pool, &acc, "Work", Some("#aaa")).await;

    let followed = upsert_sync_calendar_impl(&pool, &acc, "cal-a", "Work", Some("#bbb"))
        .await
        .unwrap();
    assert_eq!(
        followed.color.as_deref(),
        Some("#bbb"),
        "sync owns the colour while the user has not chosen one"
    );

    set_sync_calendar_color_impl(&pool, &cal.id, "#ccc")
        .await
        .unwrap();
    let after_pick = upsert_sync_calendar_impl(&pool, &acc, "cal-a", "Work", Some("#ddd"))
        .await
        .unwrap();

    assert_eq!(
        after_pick.color.as_deref(),
        Some("#ccc"),
        "the user's pick outranks the provider from then on"
    );
    let (_, color, _) = folder_name_color(&pool, &folder_id).await;
    assert_eq!(color.as_deref(), Some("#ccc"), "and the folder matches it");
}

#[tokio::test]
async fn a_colourless_provider_never_clears_the_stored_colour() {
    let pool = test_pool().await;
    let acc = account(&pool).await;
    enabled_calendar(&pool, &acc, "Work", Some("#aaa")).await;

    let after = upsert_sync_calendar_impl(&pool, &acc, "cal-a", "Work", None)
        .await
        .unwrap();

    assert_eq!(after.color.as_deref(), Some("#aaa"));
}

#[tokio::test]
async fn recolouring_the_folder_reaches_the_calendar_and_latches() {
    let pool = test_pool().await;
    let acc = account(&pool).await;
    let (_, folder_id) = enabled_calendar(&pool, &acc, "Work", Some("#aaa")).await;

    crate::folders::update_folder_impl(
        &pool,
        folder_id.clone(),
        crate::folders::FolderUpdate {
            color: Some(serde_json::Value::String("#ccc".into())),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let after = upsert_sync_calendar_impl(&pool, &acc, "cal-a", "Work", Some("#ddd"))
        .await
        .unwrap();
    assert_eq!(
        after.color.as_deref(),
        Some("#ccc"),
        "a sidebar recolour is a user pick, so re-discovery leaves it alone"
    );
}

#[tokio::test]
async fn an_unchanged_re_discovery_does_not_restamp_the_folder() {
    let pool = test_pool().await;
    let acc = account(&pool).await;
    let (_, folder_id) = enabled_calendar(&pool, &acc, "Work", Some("#aaa")).await;
    let (_, _, before) = folder_name_color(&pool, &folder_id).await;

    upsert_sync_calendar_impl(&pool, &acc, "cal-a", "Work", Some("#aaa"))
        .await
        .unwrap();

    let (_, _, after) = folder_name_color(&pool, &folder_id).await;
    assert_eq!(
        before, after,
        "every discovery pass hits this, so an unchanged one must not churn updated_at"
    );
}
