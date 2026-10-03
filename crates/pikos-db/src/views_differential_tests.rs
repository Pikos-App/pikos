//! The database half of the views differential suite. A seeded generator makes a workspace and a
//! run of writes; this applies them through the real writers and records, after every write, what
//! each list read returns. `tests/fixtures/views-differential.json` holds the result, and
//! `adapters/views.differential.test.ts` replays the same workspace and writes into the mock,
//! which has to give the same answers. Regenerate with `UPDATE_GOLDEN=1` and review the diff: a
//! change here is a change to what someone sees.

use std::collections::BTreeMap;

use chrono::NaiveDate;
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::SqlitePool;

use crate::moves::{move_pages, Placement};
use crate::pool::test_pool;
use crate::reads::{count_views, list_range, list_recent_pages, list_tags};
use crate::views::{
    list_completed, list_view, DateBounds, ViewCursor, ViewKey, ViewScope, ViewSort,
};

const ZONES: [&str; 2] = ["America/New_York", "Asia/Tokyo"];
const FOLDERS: [&str; 3] = ["f1", "f2", "f3"];
const PAGES: usize = 30;
const WRITES: usize = 20;
/// Titles that order the same under every language's collation and under the root one, so the
/// file doesn't depend on the machine that wrote it.
const TITLES: [&str; 12] = [
    "Plan",
    "plan",
    "Item 2",
    "Item 10",
    "Item 9",
    "🎉 Party",
    "party",
    "Zebra",
    "apple",
    "Budget review",
    "Same",
    "Same",
];
const TAGS: [&str; 4] = ["work", "home", "urgent", "later"];

fn today() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 6, 15).unwrap()
}

struct Rng(u64);

impl Rng {
    fn next(&mut self, n: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 % n as u64) as usize
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SeedPage {
    id: String,
    title: String,
    folder_id: Option<String>,
    priority: i64,
    sort_order: i64,
    created_at: String,
    scheduled_start: Option<String>,
    scheduled_end: Option<String>,
    synced_in: Option<String>,
    status: String,
    completed_at: Option<String>,
    tags: Vec<String>,
    last_opened_at: Option<String>,
}

fn day(offset: i64) -> String {
    (today() + chrono::Duration::days(offset)).to_string()
}

fn seed_pages(rng: &mut Rng) -> Vec<SeedPage> {
    (0..PAGES)
        .map(|i| {
            let folder = match rng.next(4) {
                0 => None,
                n => Some(FOLDERS[n - 1].to_string()),
            };
            let offset = rng.next(21) as i64 - 10;
            let (start, end) = match rng.next(6) {
                0 => (None, None),
                1 => (Some(day(offset)), None),
                2 => (Some(day(offset)), Some(day(offset + 2))),
                3 => (
                    Some(format!("{}T{:02}:30", day(offset), 6 + rng.next(14))),
                    None,
                ),
                _ => {
                    let hour = rng.next(24);
                    (
                        Some(format!("{}T{hour:02}:00:00", day(offset))),
                        Some(format!("{}T{:02}:00:00", day(offset), (hour + 1).min(23))),
                    )
                }
            };
            let synced = start.as_deref().is_some_and(|s| s.len() > 10) && rng.next(4) == 0;
            let done = rng.next(5) == 0;
            SeedPage {
                id: format!("p{i:02}"),
                title: TITLES[rng.next(TITLES.len())].to_string(),
                folder_id: folder,
                priority: [0, 0, 1, 2, 3, 4][rng.next(6)],
                sort_order: (rng.next(8) as i64) * crate::moves::ORDER_SPACING,
                created_at: format!("2026-06-01T09:{:02}:00", rng.next(3)),
                scheduled_start: start,
                scheduled_end: end,
                synced_in: synced
                    .then(|| ["Europe/Paris", "America/Los_Angeles"][rng.next(2)].to_string()),
                status: if done { "done" } else { "not_started" }.into(),
                completed_at: done
                    .then(|| format!("{}T1{}:00:00", day(-(rng.next(5) as i64)), rng.next(3))),
                tags: (0..rng.next(3))
                    .map(|_| TAGS[rng.next(TAGS.len())].to_string())
                    .collect(),
                last_opened_at: (rng.next(3) == 0)
                    .then(|| format!("2026-06-14T{:02}:00:00", rng.next(24))),
            }
        })
        .collect()
}

async fn load(pool: &SqlitePool, pages: &[SeedPage]) {
    for f in FOLDERS {
        crate::insert_test_folder(pool, f, f).await.unwrap();
    }
    sqlx::query(
        "INSERT INTO sync_account (id, provider, display_name, auth_kind, created_at, updated_at)
         VALUES ('a1', 'caldav', 'Fastmail', 'basic', '2026-06-01', '2026-06-01')",
    )
    .execute(pool)
    .await
    .unwrap();
    for p in pages {
        sqlx::query(
            "INSERT INTO pages (id, folder_id, title, content, content_text, status, priority, tags,
               sort_order, scheduled_start, scheduled_end, completed_at, last_opened_at,
               created_at, updated_at)
             VALUES (?, ?, ?, '{}', '', ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&p.id)
        .bind(&p.folder_id)
        .bind(&p.title)
        .bind(&p.status)
        .bind(p.priority)
        .bind(p.sort_order)
        .bind(&p.scheduled_start)
        .bind(&p.scheduled_end)
        .bind(&p.completed_at)
        .bind(&p.last_opened_at)
        .bind(&p.created_at)
        .bind(&p.created_at)
        .execute(pool)
        .await
        .unwrap();
        if !p.tags.is_empty() {
            let updates = serde_json::from_value(json!({ "tags": p.tags })).unwrap();
            crate::update_page_impl(pool, p.id.clone(), updates)
                .await
                .unwrap();
        }
        if let Some(zone) = &p.synced_in {
            sqlx::query(
                "INSERT INTO page_schedules (id, page_id, scheduled_start, scheduled_end, timezone,
                   status, created_at) VALUES (?, ?, ?, ?, ?, 'not_started', '2026-06-01')",
            )
            .bind(format!("s-{}", p.id))
            .bind(&p.id)
            .bind(&p.scheduled_start)
            .bind(&p.scheduled_end)
            .bind(zone)
            .execute(pool)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO page_sync (id, page_id, account_id, provider, calendar_id, external_id,
                   ical_uid, created_at) VALUES (?, ?, 'a1', 'caldav', 'cal', ?, ?, '2026-06-01')",
            )
            .bind(format!("y-{}", p.id))
            .bind(&p.id)
            .bind(format!("/{}.ics", p.id))
            .bind(&p.id)
            .execute(pool)
            .await
            .unwrap();
        }
    }
}

fn keys() -> Vec<(String, ViewKey)> {
    let mut keys = Vec::new();
    let scopes = [
        ("inbox".to_string(), ViewScope::Inbox),
        ("f1".to_string(), ViewScope::Folder("f1".into())),
        ("f2".to_string(), ViewScope::Folder("f2".into())),
    ];
    for zone in ZONES {
        for (name, scope) in &scopes {
            for (sort_name, sort) in [
                ("manual", ViewSort::Manual),
                ("date", ViewSort::Date),
                ("title", ViewSort::Title),
                ("priority", ViewSort::Priority),
            ] {
                keys.push((
                    format!("{name}/{sort_name}/{zone}"),
                    ViewKey {
                        scope: scope.clone(),
                        sort,
                        zone: zone.into(),
                        dates: None,
                    },
                ));
            }
        }
        for (name, from, until) in [
            ("overdue", None, today()),
            ("today", Some(today()), today() + chrono::Days::new(1)),
            ("upcoming", Some(today()), today() + chrono::Days::new(7)),
        ] {
            keys.push((
                format!("everywhere/{name}/{zone}"),
                ViewKey {
                    scope: ViewScope::Everywhere,
                    sort: ViewSort::Date,
                    zone: zone.into(),
                    dates: Some(DateBounds { from, until }),
                },
            ));
        }
    }
    keys
}

async fn paged(pool: &SqlitePool, key: &ViewKey) -> Vec<String> {
    let mut ids = Vec::new();
    let mut after: Option<ViewCursor> = None;
    loop {
        let window = list_view(pool, key, after.as_ref(), 3).await.unwrap();
        ids.extend(window.rows.into_iter().map(|r| r.id));
        match window.next {
            Some(next) => after = Some(next),
            None => return ids,
        }
    }
}

/// Everything the read side answers, keyed the way the mock's runner reads it.
async fn observe(pool: &SqlitePool) -> Value {
    let mut lists = BTreeMap::new();
    for (name, key) in keys() {
        lists.insert(name, paged(pool, &key).await);
    }
    let mut completed = BTreeMap::new();
    for (name, scope) in [
        ("inbox", Some(ViewScope::Inbox)),
        ("f1", Some(ViewScope::Folder("f1".into()))),
        ("everywhere", None),
    ] {
        let window = list_completed(pool, scope.as_ref(), None, None, 50)
            .await
            .unwrap();
        completed.insert(
            name,
            window.rows.into_iter().map(|r| r.id).collect::<Vec<_>>(),
        );
    }
    let mut counts = BTreeMap::new();
    let mut ranges = BTreeMap::new();
    for zone in ZONES {
        let mut c = serde_json::to_value(count_views(pool, zone, today()).await.unwrap()).unwrap();
        // A folder emptied keeps a zero row in the database; the mock never lists one.
        if let Some(folders) = c["folders"].as_object_mut() {
            folders.retain(|_, v| v.as_i64() != Some(0));
        }
        counts.insert(zone, c);
        let start = crate::views::utc_of(&format!("{}T00:00:00", today()), zone).unwrap();
        let end = crate::views::utc_of(&format!("{}T00:00:00", day(7)), zone).unwrap();
        let mut ids: Vec<String> = list_range(pool, Some(&start), &end, zone, false)
            .await
            .unwrap()
            .into_iter()
            .map(|p| p.id)
            .collect();
        ids.sort();
        ranges.insert(zone, ids);
    }
    let tags: Vec<(String, i64)> = list_tags(pool)
        .await
        .unwrap()
        .into_iter()
        .map(|t| (t.name, t.page_count))
        .collect();
    let recents: Vec<String> = list_recent_pages(pool, None, 10)
        .await
        .unwrap()
        .into_iter()
        .map(|p| p.id)
        .collect();
    json!({
        "lists": lists,
        "completed": completed,
        "counts": counts,
        "ranges": ranges,
        "tags": tags,
        "recents": recents,
    })
}

/// A write a person could make, through the same command both adapters expose.
async fn random_write(pool: &SqlitePool, pages: &[SeedPage], rng: &mut Rng, step: usize) -> Value {
    let page = &pages[rng.next(pages.len())];
    let editable = page.synced_in.is_none();
    match rng.next(7) {
        0 | 1 => {
            let folder = page
                .folder_id
                .clone()
                .map_or(ViewScope::Inbox, ViewScope::Folder);
            let order = crate::views::list_view_ids(
                pool,
                &ViewKey {
                    scope: folder,
                    sort: ViewSort::Manual,
                    zone: ZONES[0].into(),
                    dates: None,
                },
                None,
                None,
            )
            .await
            .unwrap();
            let rest: Vec<String> = order.iter().filter(|id| **id != page.id).cloned().collect();
            let slot = rng.next(rest.len() + 1);
            // Now and then name neighbours that aren't adjacent, as a stale window would.
            let stale = rest.len() > 2 && rng.next(5) == 0;
            let after = slot.checked_sub(1).map(|i| rest[i].clone());
            let before = if stale {
                rest.get(slot + 1)
            } else {
                rest.get(slot)
            }
            .cloned();
            json!({ "op": "move", "ids": [page.id], "after": after, "before": before })
        }
        2 if editable => json!({ "op": "update", "id": page.id,
            "updates": { "title": format!("{} {step}", TITLES[rng.next(TITLES.len())]) } }),
        3 => json!({ "op": "update", "id": page.id, "updates": if rng.next(2) == 0 {
            json!({ "status": "done", "completedAt": format!("2026-06-15T1{}:00:00", rng.next(9)) })
        } else {
            json!({ "status": "not_started", "completedAt": null })
        } }),
        4 if editable => json!({ "op": "update", "id": page.id,
            "updates": { "scheduledStart": format!("{}T{:02}:00:00", day(rng.next(9) as i64 - 4), rng.next(24)), "scheduledEnd": null } }),
        5 => {
            let priority = [0, 1, 2, 3, 4][rng.next(5)];
            let tag = TAGS[rng.next(TAGS.len())];
            json!({ "op": "update", "id": page.id, "updates": { "priority": priority, "tags": [tag] } })
        }
        _ => json!({ "op": "trash", "id": page.id }),
    }
}

async fn apply(pool: &SqlitePool, write: &Value) -> bool {
    let id = write["id"].as_str().map(str::to_string);
    let result = match write["op"].as_str().unwrap() {
        "move" => {
            let ids: Vec<String> = serde_json::from_value(write["ids"].clone()).unwrap();
            let place = Placement {
                after: write["after"].as_str().map(Into::into),
                before: write["before"].as_str().map(Into::into),
            };
            move_pages(pool, &ids, &place).await.map(|_| ())
        }
        "update" => {
            let updates = serde_json::from_value(write["updates"].clone()).unwrap();
            crate::update_page_impl(pool, id.unwrap(), updates)
                .await
                .map(|_| ())
        }
        _ => crate::soft_delete_page_impl(pool, &id.unwrap()).await,
    };
    result.is_ok()
}

#[tokio::test]
async fn the_database_side_matches_the_golden_file() {
    let mut rng = Rng(0x5eed_d1ff);
    let pages = seed_pages(&mut rng);
    let pool = test_pool().await;
    load(&pool, &pages).await;

    let mut steps =
        vec![json!({ "write": null, "accepted": true, "expect": observe(&pool).await })];
    for step in 0..WRITES {
        let write = random_write(&pool, &pages, &mut rng, step).await;
        let accepted = apply(&pool, &write).await;
        steps.push(json!({ "write": write, "accepted": accepted, "expect": observe(&pool).await }));
    }
    let fixture = json!({
        "today": today().to_string(),
        "zones": ZONES,
        "folders": FOLDERS,
        "pages": pages,
        "steps": steps,
    });

    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/views-differential.json");
    let current = format!("{}\n", serde_json::to_string_pretty(&fixture).unwrap());
    if std::env::var("UPDATE_GOLDEN").is_ok() {
        std::fs::write(&path, &current).unwrap();
    }
    let golden = std::fs::read_to_string(&path).expect("run once with UPDATE_GOLDEN=1");
    assert!(
        current == golden,
        "views-differential.json is stale; regenerate with UPDATE_GOLDEN=1 and review the diff"
    );
}
