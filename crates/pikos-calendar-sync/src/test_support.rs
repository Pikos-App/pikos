//! Shared `#[cfg(test)]` builders for the Layer-3 engine and scheduler tests:
//! the `event`/`delta` value constructors and the account+calendar seed SQL that
//! otherwise lived in a copy per test file.

use sqlx::SqlitePool;

use pikos_db::sync_delta::{
    EventCore, EventSchedule, EventUpsert, SyncDelta, SyncToken, UpsertItem,
};
use pikos_db::{insert_test_folder, now_iso};

pub(crate) fn event(external_id: &str, uid: &str, etag: &str, title: &str) -> UpsertItem {
    UpsertItem::Event(EventUpsert {
        core: EventCore {
            external_id: external_id.into(),
            ical_uid: uid.into(),
            etag: Some(etag.into()),
            title: title.into(),
            description: None,
            location: None,
            attendees: vec![],
        },
        schedule: EventSchedule {
            start: "2026-06-20T09:00:00".into(),
            end: Some("2026-06-20T10:00:00".into()),
            timezone: Some("America/New_York".into()),
        },
        recurrence: None,
    })
}

pub(crate) fn delta(upserts: Vec<UpsertItem>, token: Option<&str>) -> SyncDelta {
    SyncDelta { upserts, next_token: token.map(|t| SyncToken(t.into())), ..Default::default() }
}

/// One account + one enabled calendar (and its folder). `link_folder` sets the
/// calendar's `folder_id` column — the scheduler polls by that link, while the
/// engine passes the folder to `sync_calendar` directly and leaves the column NULL.
pub(crate) struct CalSeed<'a> {
    pub account_id: &'a str,
    pub cal_row_id: &'a str,
    pub calendar_id: &'a str,
    pub display_name: &'a str,
    pub folder_id: &'a str,
    pub folder_name: &'a str,
    pub link_folder: bool,
    pub sync_token: Option<&'a str>,
}

pub(crate) async fn seed_calendar(pool: &SqlitePool, s: CalSeed<'_>) {
    insert_test_folder(pool, s.folder_id, s.folder_name).await.unwrap();
    let now = now_iso();
    sqlx::query(
        "INSERT INTO sync_account (id, provider, display_name, auth_kind, created_at, updated_at)
         VALUES (?, 'caldav', 'Test', 'basic', ?, ?)",
    )
    .bind(s.account_id)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO sync_calendar
         (id, account_id, calendar_id, display_name, color, enabled, folder_id, sync_token, ctag,
          last_full_sync_at, last_synced_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, 1, ?, ?, NULL, NULL, NULL, ?, ?)",
    )
    .bind(s.cal_row_id)
    .bind(s.account_id)
    .bind(s.calendar_id)
    .bind(s.display_name)
    .bind(s.link_folder.then_some(s.folder_id))
    .bind(s.sync_token)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
}

pub(crate) async fn page_count(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM pages")
        .fetch_one(pool)
        .await
        .unwrap()
}
