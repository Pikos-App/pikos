use std::collections::BTreeMap;

use super::*;
use crate::pool::test_pool;
use crate::title_key::title_key;

const ZONES: [&str; 2] = ["America/New_York", "Asia/Tokyo"];
const SORTS: [ViewSort; 4] = [
    ViewSort::Manual,
    ViewSort::Date,
    ViewSort::Title,
    ViewSort::Priority,
];

#[derive(Clone, Copy)]
struct Seed {
    id: &'static str,
    title: &'static str,
    folder: Option<&'static str>,
    priority: i64,
    sort_order: i64,
    created_at: &'static str,
    start: Option<&'static str>,
    /// A synced page's zone: the page is locked to that calendar and its start is an instant.
    synced_in: Option<&'static str>,
    done_at: Option<&'static str>,
}

const fn page(id: &'static str, title: &'static str) -> Seed {
    Seed {
        id,
        title,
        folder: None,
        priority: 0,
        sort_order: 0,
        created_at: "2026-06-01T09:00:00",
        start: None,
        synced_in: None,
        done_at: None,
    }
}

/// Every case the order has to get right: all-day against a timed midnight, minutes against
/// seconds, both sides of a spring-forward gap, synced instants in another zone, numeric and
/// emoji titles, every priority, and ties on order and creation that only the id breaks.
fn seeds() -> Vec<Seed> {
    let mut s = vec![
        Seed {
            start: Some("2026-06-15"),
            sort_order: 3,
            ..page("all-day", "Item 10")
        },
        Seed {
            start: Some("2026-06-15T00:00:00"),
            sort_order: 3,
            ..page("midnight", "item 2")
        },
        Seed {
            start: Some("2026-06-15T09:30"),
            priority: 2,
            ..page("minutes", "Élan")
        },
        Seed {
            start: Some("2026-06-15T09:30:00"),
            priority: 2,
            ..page("seconds", "elan")
        },
        Seed {
            start: Some("2026-03-08T02:30:00"),
            priority: 1,
            ..page("gap", "🎉 Party")
        },
        Seed {
            start: Some("2026-03-08T03:30:00"),
            ..page("after-gap", "party")
        },
        Seed {
            synced_in: Some("Europe/Paris"),
            start: Some("2026-06-15T15:00:00"),
            priority: 1,
            ..page("paris-3pm", "Standup")
        },
        Seed {
            synced_in: Some("America/Los_Angeles"),
            start: Some("2026-06-15T06:00:00"),
            ..page("la-6am", "Review")
        },
        Seed {
            synced_in: Some("Europe/Paris"),
            start: Some("2026-06-15"),
            ..page("paris-all-day", "Offsite")
        },
        Seed {
            sort_order: 1,
            created_at: "2026-06-01T08:00:00",
            ..page("tie-a", "Same title")
        },
        Seed {
            sort_order: 1,
            created_at: "2026-06-01T08:00:00",
            ..page("tie-b", "Same title")
        },
        Seed {
            sort_order: 1,
            created_at: "2026-06-01T07:00:00",
            priority: 4,
            ..page("tie-c", "Same title")
        },
        Seed {
            sort_order: -2,
            priority: 3,
            ..page("first", "zebra")
        },
        Seed {
            done_at: Some("2026-06-10T10:00:00"),
            ..page("done-1", "Old task")
        },
        Seed {
            done_at: Some("2026-06-10T10:00:00"),
            ..page("done-2", "Old task")
        },
        Seed {
            done_at: Some("2026-06-11T08:00:00"),
            ..page("done-3", "Newer task")
        },
    ];
    let folder: Vec<Seed> = s
        .iter()
        .map(|p| Seed {
            folder: Some("f1"),
            id: Box::leak(format!("f-{}", p.id).into_boxed_str()),
            ..*p
        })
        .collect();
    s.extend(folder);
    s
}

async fn workspace() -> SqlitePool {
    let pool = test_pool().await;
    crate::insert_test_folder(&pool, "f1", "Work")
        .await
        .unwrap();
    let now = crate::now_iso();
    sqlx::query(
        "INSERT INTO sync_account (id, provider, display_name, auth_kind, created_at, updated_at)
         VALUES ('a1', 'caldav', 'Fastmail', 'basic', ?1, ?1)",
    )
    .bind(&now)
    .execute(&pool)
    .await
    .unwrap();
    for p in seeds() {
        sqlx::query(
            "INSERT INTO pages (id, folder_id, title, content, content_text, status, priority, tags,
               sort_order, scheduled_start, completed_at, created_at, updated_at)
             VALUES (?, ?, ?, '{}', '', ?, ?, '[]', ?, ?, ?, ?, ?)",
        )
        .bind(p.id)
        .bind(p.folder)
        .bind(p.title)
        .bind(if p.done_at.is_some() { "done" } else { "not_started" })
        .bind(p.priority)
        .bind(p.sort_order)
        .bind(p.start)
        .bind(p.done_at)
        .bind(p.created_at)
        .bind(p.created_at)
        .execute(&pool)
        .await
        .unwrap();
        if let (Some(zone), Some(start)) = (p.synced_in, p.start) {
            sqlx::query(
                "INSERT INTO page_schedules (id, page_id, scheduled_start, timezone, status, created_at)
                 VALUES (?, ?, ?, ?, 'not_started', ?)",
            )
            .bind(format!("s-{}", p.id))
            .bind(p.id)
            .bind(start)
            .bind(zone)
            .bind(&now)
            .execute(&pool)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO page_sync (id, page_id, account_id, provider, calendar_id, external_id,
                   ical_uid, created_at)
                 VALUES (?, ?, 'a1', 'caldav', 'cal', ?, ?, ?)",
            )
            .bind(format!("y-{}", p.id))
            .bind(p.id)
            .bind(format!("/{}.ics", p.id))
            .bind(p.id)
            .bind(&now)
            .execute(&pool)
            .await
            .unwrap();
        }
    }
    pool
}

/// The app's comparator (`sortPages` in packages/core, ties broken by order value, then creation
/// time, then id), written out plainly over the seeds, independent of the stored columns and the
/// indexes.
fn reference_order(scope: &ViewScope, sort: ViewSort, zone: &str) -> Vec<String> {
    let mut rows: Vec<Seed> = seeds()
        .into_iter()
        .filter(|p| p.done_at.is_none())
        .filter(|p| match scope {
            ViewScope::Inbox => p.folder.is_none(),
            ViewScope::Folder(id) => p.folder == Some(id.as_str()),
            ViewScope::Everywhere => true,
        })
        .collect();
    let date = |p: &Seed| -> Option<String> {
        let start = p.start?;
        match p.synced_in {
            Some(source) if start.len() > 10 => {
                let utc = crate::sql_functions::utc_of(start, source)?;
                wall_of(&utc, zone)
            }
            _ => Some(crate::views::wall_clock(start)),
        }
    };
    let tie = |p: &Seed| (p.sort_order, p.created_at, p.id);
    rows.sort_by(|a, b| match sort {
        ViewSort::Manual => tie(a).cmp(&tie(b)),
        ViewSort::Title => (title_key(a.title), tie(a)).cmp(&(title_key(b.title), tie(b))),
        ViewSort::Date => {
            (date(a).is_none(), date(a), tie(a)).cmp(&(date(b).is_none(), date(b), tie(b)))
        }
        ViewSort::Priority => {
            let rank = |p: &Seed| if p.priority == 0 { 5 } else { p.priority };
            (rank(a), date(a).is_none(), date(a), tie(a)).cmp(&(
                rank(b),
                date(b).is_none(),
                date(b),
                tie(b),
            ))
        }
    });
    rows.into_iter().map(|p| p.id.to_string()).collect()
}

fn keys() -> Vec<ViewKey> {
    let mut keys = Vec::new();
    for scope in [ViewScope::Inbox, ViewScope::Folder("f1".into())] {
        for sort in SORTS {
            for zone in ZONES {
                keys.push(ViewKey {
                    scope: scope.clone(),
                    sort,
                    zone: zone.into(),
                    dates: None,
                });
            }
        }
    }
    keys
}

async fn paged(pool: &SqlitePool, key: &ViewKey, size: usize) -> Vec<String> {
    let mut ids = Vec::new();
    let mut after: Option<ViewCursor> = None;
    loop {
        let window = list_view(pool, key, after.as_ref(), size).await.unwrap();
        assert!(window.rows.len() <= size);
        ids.extend(window.rows.iter().map(|r| r.id.clone()));
        match window.next {
            Some(next) => after = Some(next),
            None => return ids,
        }
    }
}

#[tokio::test]
async fn every_view_pages_out_in_the_apps_order_at_any_window_size() {
    let pool = workspace().await;
    for key in keys() {
        let expected = reference_order(&key.scope, key.sort, &key.zone);
        for size in [1, 2, 3, 5, 50] {
            assert_eq!(
                paged(&pool, &key, size).await,
                expected,
                "{key:?} in windows of {size}"
            );
        }
        assert_eq!(
            list_view_ids(&pool, &key, None, None).await.unwrap(),
            expected,
            "{key:?} ids"
        );
        let window = list_view(&pool, &key, None, 2).await.unwrap();
        assert_eq!(window.total, Some(expected.len() as i64), "{key:?} total");
    }
}

/// `views_golden.json` holds every view's order. A change to it is a change to what people see,
/// so it fails here until the file is regenerated with `UPDATE_GOLDEN=1` and the diff reviewed.
#[tokio::test]
async fn the_order_matches_the_golden_file() {
    let pool = workspace().await;
    let mut orders = BTreeMap::new();
    for key in keys() {
        orders.insert(
            format!("{:?}/{:?}/{}", key.scope, key.sort, key.zone),
            paged(&pool, &key, 3).await,
        );
    }
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/views_golden.json");
    let current = format!("{}\n", serde_json::to_string_pretty(&orders).unwrap());
    if std::env::var("UPDATE_GOLDEN").is_ok() {
        std::fs::write(&path, &current).unwrap();
    }
    let golden = std::fs::read_to_string(&path).expect("run once with UPDATE_GOLDEN=1");
    assert_eq!(
        current, golden,
        "the order changed; review and regenerate with UPDATE_GOLDEN=1"
    );
}

#[tokio::test]
async fn a_window_continues_after_its_cursor_whatever_changed() {
    let pool = workspace().await;
    let key = ViewKey {
        scope: ViewScope::Inbox,
        sort: ViewSort::Manual,
        zone: "America/New_York".into(),
        dates: None,
    };
    let first = list_view(&pool, &key, None, 3).await.unwrap();
    let seen: Vec<String> = first.rows.iter().map(|r| r.id.clone()).collect();

    // A page added before the cursor, and one after it removed.
    sqlx::query("UPDATE pages SET sort_order = -100 WHERE id = 'all-day'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE pages SET deleted_at = '2026-06-20T00:00:00' WHERE id = 'gap'")
        .execute(&pool)
        .await
        .unwrap();

    let rest = paged_from(&pool, &key, first.next.unwrap()).await;
    let now = paged(&pool, &key, 50).await;
    let after_cursor: Vec<String> = now
        .into_iter()
        .filter(|id| !seen.contains(id) && id != "all-day")
        .collect();
    assert_eq!(
        rest, after_cursor,
        "everything after the cursor, nothing twice, nothing skipped"
    );
}

async fn paged_from(pool: &SqlitePool, key: &ViewKey, after: ViewCursor) -> Vec<String> {
    let mut ids = Vec::new();
    let mut after = Some(after);
    while let Some(cursor) = after {
        let window = list_view(pool, key, Some(&cursor), 3).await.unwrap();
        ids.extend(window.rows.iter().map(|r| r.id.clone()));
        after = window.next;
    }
    ids
}

#[tokio::test]
async fn completed_pages_page_out_once_each_even_when_one_is_unticked() {
    let pool = workspace().await;
    let scope = ViewScope::Inbox;
    let first = list_completed(&pool, Some(&scope), None, None, 2)
        .await
        .unwrap();
    assert_eq!(first.total, Some(3));
    let firsts: Vec<&str> = first.rows.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(firsts, ["done-3", "done-2"]);

    sqlx::query("UPDATE pages SET status = 'not_started', completed_at = NULL WHERE id = 'done-3'")
        .execute(&pool)
        .await
        .unwrap();
    let second = list_completed(&pool, Some(&scope), None, first.next.as_ref(), 2)
        .await
        .unwrap();
    let seconds: Vec<&str> = second.rows.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(seconds, ["done-1"]);
    assert!(second.next.is_none());
    assert_eq!(second.total, None, "only the first window counts");

    let today = list_completed(&pool, None, Some("2026-06-11"), None, 10)
        .await
        .unwrap();
    assert_eq!(
        today.total,
        Some(1),
        "f-done-3 is the only page done on or after the 11th now"
    );
}

#[tokio::test]
async fn every_stream_reads_through_its_index_without_sorting() {
    let pool = workspace().await;
    let streams = [
        ("", "sort_order, created_at, id"),
        ("", "title_key, sort_order, created_at, id"),
        (
            " AND is_absolute = 0 AND order_start IS NOT NULL",
            "order_start, sort_order, created_at, id",
        ),
        (
            " AND is_absolute = 1",
            "abs_start_utc, sort_order, created_at, id",
        ),
        (" AND scheduled_start IS NULL", "sort_order, created_at, id"),
        (
            " AND is_absolute = 0 AND order_start IS NOT NULL AND priority = 1",
            "order_start, sort_order, created_at, id",
        ),
        (
            " AND is_absolute = 1 AND priority = 1",
            "abs_start_utc, sort_order, created_at, id",
        ),
        (
            " AND scheduled_start IS NULL AND priority = 1",
            "sort_order, created_at, id",
        ),
    ];
    for (filter, order) in streams {
        for scope in ["folder_id IS NULL", "folder_id = 'f1'"] {
            let sql = format!(
                "EXPLAIN QUERY PLAN SELECT id FROM pages WHERE deleted_at IS NULL \
                 AND status <> 'done'{filter} AND {scope} ORDER BY {order} LIMIT 50"
            );
            let plan: Vec<(i64, i64, i64, String)> =
                sqlx::query_as(&sql).fetch_all(&pool).await.unwrap();
            let text: String = plan
                .into_iter()
                .map(|(_, _, _, d)| d)
                .collect::<Vec<_>>()
                .join(" | ");
            assert!(
                text.contains("USING INDEX idx_view_")
                    || text.contains("USING COVERING INDEX idx_view_"),
                "{filter} {scope}: {text}"
            );
            assert!(
                !text.contains("TEMP B-TREE"),
                "{filter} {scope} sorts: {text}"
            );
        }
    }
}

/// Today's two sections and an Upcoming day, as the app splits them: overdue is everything open
/// before today, today is today's day, each in date order.
#[tokio::test]
async fn todays_sections_and_upcomings_days_page_out_in_date_order() {
    let pool = workspace().await;
    let day = |d: u32| chrono::NaiveDate::from_ymd_opt(2026, 6, d).unwrap();
    for zone in ZONES {
        let everything = reference_order(&ViewScope::Everywhere, ViewSort::Date, zone);
        let start_of = |id: &str| -> Option<String> {
            let p = seeds().into_iter().find(|p| p.id == id)?;
            let start = p.start?;
            match p.synced_in {
                Some(source) if start.len() > 10 => {
                    wall_of(&crate::sql_functions::utc_of(start, source)?, zone)
                }
                _ => Some(crate::views::wall_clock(start)),
            }
        };
        for (from, until) in [
            (None, day(15)),
            (Some(day(15)), day(16)),
            (Some(day(16)), day(17)),
        ] {
            let expected: Vec<String> = everything
                .iter()
                .filter(|id| {
                    start_of(id).is_some_and(|s| {
                        let date = &s[..10];
                        from.is_none_or(|f: chrono::NaiveDate| date >= f.to_string().as_str())
                            && date < until.to_string().as_str()
                    })
                })
                .cloned()
                .collect();
            let key = ViewKey {
                scope: ViewScope::Everywhere,
                sort: ViewSort::Date,
                zone: zone.into(),
                dates: Some(DateBounds { from, until }),
            };
            for size in [1, 3, 50] {
                assert_eq!(
                    paged(&pool, &key, size).await,
                    expected,
                    "{zone} {from:?}..{until}"
                );
            }
            let first = list_view(&pool, &key, None, 2).await.unwrap();
            assert_eq!(
                first.total,
                Some(expected.len() as i64),
                "{zone} {from:?}..{until} total"
            );
        }
    }
}
