//! Sync-lifecycle conformance — the Rust half of a table both storage adapters run.
//!
//! `MockStorageAdapter` re-implements the sync lifecycle in TypeScript because test
//! mode has no writer behind it, and every Playwright run in the repo rests on that
//! re-implementation being faithful. It has drifted three times, each drift silently
//! voiding a test written against it. The table in `tests/fixtures/sync-lifecycle.json`
//! is the contract: this runner asserts the writers satisfy it, and
//! `syncLifecycle.conformance.test.ts` asserts the mock satisfies the same rows.
//!
//! Steps describe intent, not calls — each side realizes them against its own store,
//! and only the end state has to agree. `syncEvent` diverges the most: a reconcile
//! against a synthetic delta here, a seeded page and its provenance in the mock.

use serde::Deserialize;
use std::collections::HashMap;

use crate::now_local_iso;
use crate::pool::test_pool;
use crate::reconciler::{reconcile, ReconcileContext};
use crate::sync_commands::{
    find_account_by_identity_impl, get_sync_status_impl, insert_sync_account_impl,
    list_sync_calendars_impl, mark_account_disconnected_impl, reactivate_account_impl,
    toggle_sync_calendar_impl, upsert_sync_calendar_impl,
};
use crate::sync_delta::{
    EventCore, EventSchedule, EventUpsert, ExclusiveEnd, SyncDelta, UpsertItem,
};

const TABLE: &str = include_str!("../tests/fixtures/sync-lifecycle.json");

const PROVIDER: &str = crate::sync::PROVIDER_CALDAV;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Table {
    scenarios: Vec<Scenario>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Scenario {
    name: String,
    steps: Vec<Step>,
    expect: Expect,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Step {
    #[serde(rename_all = "camelCase")]
    Connect {
        display_name: String,
        calendars: Vec<String>,
    },
    Enable {
        calendar: String,
    },
    #[serde(rename_all = "camelCase")]
    SyncEvent {
        calendar: String,
        uid: String,
        title: String,
    },
    Own {
        uid: String,
    },
    Complete {
        uid: String,
    },
    /// A page the user made, to file against the placement lock.
    NativePage {
        uid: String,
        title: String,
    },
    /// Refile a page, asserting on the spot: `rejected_with` present means the
    /// writer must refuse with that exact message, absent means it must allow it.
    #[serde(rename_all = "camelCase")]
    MovePage {
        page: String,
        target: MoveTarget,
        rejected_with: Option<String>,
    },
    Disable {
        calendar: String,
    },
    Disconnect,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
enum MoveTarget {
    CalendarFolder,
    Inbox,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Expect {
    account_visible: Option<bool>,
    account_count: Option<usize>,
    folder_count: Option<usize>,
    calendars: Option<Vec<CalExpect>>,
    folder: Option<FolderExpect>,
    pages: Option<Vec<PageExpect>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CalExpect {
    name: String,
    enabled: bool,
    has_folder: bool,
    detached_pages: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FolderExpect {
    calendar: String,
    exists: bool,
    is_external_calendar: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PageExpect {
    uid: String,
    exists: bool,
    sync_state: Option<String>,
    schedule_locked: Option<bool>,
    in_calendar_folder: Option<bool>,
}

/// What the runner has to remember across steps: the id a name maps to. `folders`
/// outlives `sync_calendar.folder_id` on purpose — teardown clears the link, and a
/// scenario still needs to ask whether that folder survived and how it is flagged.
#[derive(Default)]
struct World {
    account_id: String,
    calendars: HashMap<String, String>,
    folders: HashMap<String, String>,
    pages: HashMap<String, String>,
}

#[tokio::test]
async fn writers_satisfy_the_sync_lifecycle_table() {
    let table: Table = serde_json::from_str(TABLE).expect("sync-lifecycle.json parses");
    assert!(!table.scenarios.is_empty());
    for scenario in &table.scenarios {
        run(scenario).await;
    }
}

async fn run(scenario: &Scenario) {
    let pool = test_pool().await;
    let mut world = World::default();
    for step in &scenario.steps {
        apply(&pool, &mut world, step).await;
    }
    check(&pool, &world, scenario).await;
}

async fn apply(pool: &sqlx::SqlitePool, world: &mut World, step: &Step) {
    match step {
        Step::Connect {
            display_name,
            calendars,
        } => {
            let account = match find_account_by_identity_impl(pool, PROVIDER, display_name)
                .await
                .unwrap()
            {
                Some(existing) => {
                    reactivate_account_impl(pool, &existing.id).await.unwrap();
                    existing
                }
                None => insert_sync_account_impl(pool, PROVIDER, display_name, "basic")
                    .await
                    .unwrap(),
            };
            world.account_id = account.id.clone();
            for name in calendars {
                let cal = upsert_sync_calendar_impl(
                    pool,
                    &account.id,
                    &format!("cal-{}", name.to_lowercase()),
                    name,
                    None,
                )
                .await
                .unwrap();
                world.calendars.insert(name.clone(), cal.id);
            }
        }

        Step::Enable { calendar } => {
            let cal = toggle_sync_calendar_impl(pool, &world.calendars[calendar], true, None)
                .await
                .unwrap();
            if let Some(folder_id) = cal.folder_id {
                world.folders.insert(calendar.clone(), folder_id);
            }
        }

        Step::Disable { calendar } => {
            toggle_sync_calendar_impl(pool, &world.calendars[calendar], false, None)
                .await
                .unwrap();
        }

        Step::SyncEvent {
            calendar,
            uid,
            title,
        } => {
            let cal_id = &world.calendars[calendar];
            let cal = list_sync_calendars_impl(pool, &world.account_id)
                .await
                .unwrap()
                .into_iter()
                .find(|c| &c.id == cal_id)
                .expect("calendar row");
            let ctx = ReconcileContext {
                account_id: world.account_id.clone(),
                calendar_id: cal.calendar_id.clone(),
                provider: PROVIDER.into(),
                folder_id: cal.folder_id.clone().expect("enable it before syncing"),
            };
            reconcile(pool, &ctx, &event_delta(uid, title))
                .await
                .unwrap();
            let page_id = page_id_for(pool, &ctx, uid).await;
            world.pages.insert(uid.clone(), page_id);
        }

        // The editor command path: any authored edit flips `user_modified`, which is
        // what teardown reads to keep the page instead of destroying it.
        Step::Own { uid } => {
            let page_id = &world.pages[uid];
            sqlx::query("UPDATE pages SET content_text = 'edited' WHERE id = ?")
                .bind(page_id)
                .execute(pool)
                .await
                .unwrap();
            sqlx::query("UPDATE page_sync SET user_modified = 1 WHERE page_id = ?")
                .bind(page_id)
                .execute(pool)
                .await
                .unwrap();
        }

        Step::Complete { uid } => {
            crate::pages::set_pages_status_impl(
                pool,
                &[world.pages[uid].clone()],
                "done",
                Some(&now_local_iso()),
            )
            .await
            .unwrap();
        }

        Step::NativePage { uid, title } => {
            let page = crate::pages::create_page_impl(pool, new_page(title))
                .await
                .unwrap();
            world.pages.insert(uid.clone(), page.id);
        }

        Step::MovePage {
            page,
            target,
            rejected_with,
        } => {
            let folder_id = match target {
                MoveTarget::CalendarFolder => {
                    serde_json::Value::String(world.folders.values().next().unwrap().clone())
                }
                MoveTarget::Inbox => serde_json::Value::Null,
            };
            let result = crate::pages::update_page_impl(
                pool,
                world.pages[page].clone(),
                crate::pages::PageUpdate {
                    folder_id: Some(folder_id),
                    ..Default::default()
                },
            )
            .await;
            match rejected_with {
                Some(msg) => {
                    let err = result.err().expect("the move should have been refused");
                    assert!(
                        format!("{err}").contains(msg.as_str()),
                        "wrong refusal: {err}"
                    );
                }
                None => {
                    result.expect("the move should have been allowed");
                }
            }
        }

        // The local half of a disconnect: unsync each calendar, then hide the account.
        Step::Disconnect => {
            for cal in list_sync_calendars_impl(pool, &world.account_id)
                .await
                .unwrap()
            {
                toggle_sync_calendar_impl(pool, &cal.id, false, None)
                    .await
                    .unwrap();
            }
            mark_account_disconnected_impl(pool, &world.account_id)
                .await
                .unwrap();
        }
    }
}

fn new_page(title: &str) -> crate::pages::NewPage {
    crate::pages::NewPage {
        folder_id: None,
        title: title.into(),
        subtitle: None,
        content: "{}".into(),
        content_text: None,
        status: "not_started".into(),
        priority: 0,
        tags: vec![],
        scheduled_start: None,
        scheduled_end: None,
        completed_at: None,
        links: vec![],
        parent_id: None,
        last_opened_at: None,
        created_at: None,
        updated_at: None,
    }
}

fn event_delta(uid: &str, title: &str) -> SyncDelta {
    SyncDelta {
        upserts: vec![UpsertItem::Event(EventUpsert {
            core: EventCore {
                external_id: format!("href-{uid}"),
                ical_uid: uid.into(),
                etag: Some(format!("etag-{uid}")),
                title: title.into(),
                description: None,
                location: None,
                attendees: vec![],
            },
            schedule: EventSchedule {
                start: "2026-06-15T09:00:00".into(),
                end: ExclusiveEnd::new(Some("2026-06-15T10:00:00".into())),
                timezone: Some("UTC".into()),
            },
            recurrence: None,
        })],
        ..Default::default()
    }
}

/// Scoped to the calendar, not just the uid: the same meeting synced from two
/// calendars is two pages by design, so a uid-only lookup would silently pick one.
async fn page_id_for(pool: &sqlx::SqlitePool, ctx: &ReconcileContext, uid: &str) -> String {
    sqlx::query_scalar(
        "SELECT page_id FROM page_sync
         WHERE account_id = ? AND calendar_id = ? AND ical_uid = ?",
    )
    .bind(&ctx.account_id)
    .bind(&ctx.calendar_id)
    .bind(uid)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn check(pool: &sqlx::SqlitePool, world: &World, scenario: &Scenario) {
    let at = &scenario.name;
    let expect = &scenario.expect;

    if let Some(want) = expect.account_visible {
        let visible = get_sync_status_impl(pool)
            .await
            .unwrap()
            .iter()
            .any(|a| a.account.id == world.account_id);
        assert_eq!(visible, want, "{at}: account visible in the panel");
    }

    // Panel-visible rather than total rows: a dormant row is invisible to the mock
    // by construction, so counting every row would be a question only one side can
    // answer. A twin still shows up here, which is what the count is guarding.
    if let Some(want) = expect.account_count {
        let n = get_sync_status_impl(pool).await.unwrap().len();
        assert_eq!(n, want, "{at}: accounts in the panel");
    }

    if let Some(want) = expect.folder_count {
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM folders")
            .fetch_one(pool)
            .await
            .unwrap();
        assert_eq!(n as usize, want, "{at}: folders");
    }

    if let Some(wants) = &expect.calendars {
        let rows = list_sync_calendars_impl(pool, &world.account_id)
            .await
            .unwrap();
        for want in wants {
            let row = rows
                .iter()
                .find(|c| c.display_name == want.name)
                .unwrap_or_else(|| panic!("{at}: no calendar named {}", want.name));
            assert_eq!(row.enabled, want.enabled, "{at}: {} enabled", want.name);
            assert_eq!(
                row.folder_id.is_some(),
                want.has_folder,
                "{at}: {} linked to a folder",
                want.name
            );
            assert_eq!(
                row.detached_pages, want.detached_pages,
                "{at}: {} detached pages",
                want.name
            );
        }
    }

    if let Some(want) = &expect.folder {
        let folder_id = &world.folders[&want.calendar];
        let flag: Option<bool> =
            sqlx::query_scalar("SELECT is_external_calendar FROM folders WHERE id = ?")
                .bind(folder_id)
                .fetch_optional(pool)
                .await
                .unwrap();
        assert_eq!(flag.is_some(), want.exists, "{at}: folder exists");
        if let Some(want_flag) = want.is_external_calendar {
            assert_eq!(flag, Some(want_flag), "{at}: folder is_external_calendar");
        }
    }

    for want in expect.pages.iter().flatten() {
        let page_id = &world.pages[&want.uid];
        let live: Option<(Option<String>,)> =
            sqlx::query_as("SELECT folder_id FROM pages WHERE id = ? AND deleted_at IS NULL")
                .bind(page_id)
                .fetch_optional(pool)
                .await
                .unwrap();
        assert_eq!(live.is_some(), want.exists, "{at}: {} exists", want.uid);
        let Some((folder_id,)) = live else { continue };

        if let Some(want_state) = &want.sync_state {
            let state: Option<String> =
                sqlx::query_scalar("SELECT sync_state FROM page_sync WHERE page_id = ?")
                    .bind(page_id)
                    .fetch_optional(pool)
                    .await
                    .unwrap();
            assert_eq!(
                state.as_deref(),
                Some(want_state.as_str()),
                "{at}: {} sync_state",
                want.uid
            );
        }

        if let Some(want_locked) = want.schedule_locked {
            let locked = crate::sync::page_schedule_locked(pool, page_id)
                .await
                .unwrap();
            assert_eq!(locked, want_locked, "{at}: {} schedule_locked", want.uid);
        }

        if let Some(want_in) = want.in_calendar_folder {
            let cal_folder = world
                .folders
                .values()
                .find(|f| Some(*f) == folder_id.as_ref());
            assert_eq!(
                cal_folder.is_some(),
                want_in,
                "{at}: {} sits in its calendar folder",
                want.uid
            );
        }
    }
}
