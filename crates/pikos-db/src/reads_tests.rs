use super::*;
use crate::pool::test_pool;

async fn page(
    pool: &SqlitePool,
    id: &str,
    folder: Option<&str>,
    start: Option<&str>,
    end: Option<&str>,
) {
    sqlx::query(
        "INSERT INTO pages (id, folder_id, title, content, content_text, status, priority, tags,
           sort_order, scheduled_start, scheduled_end, created_at, updated_at)
         VALUES (?, ?, ?, '{}', '', 'not_started', 0, '[]', 0, ?, ?, '2026-06-01T09:00:00',
           '2026-06-01T09:00:00')",
    )
    .bind(id)
    .bind(folder)
    .bind(id)
    .bind(start)
    .bind(end)
    .execute(pool)
    .await
    .unwrap();
}

async fn exec(pool: &SqlitePool, sql: &str) {
    sqlx::query(sql).execute(pool).await.unwrap();
}

/// Make `id` a synced page whose stored times are wall clocks in `zone`.
async fn synced(pool: &SqlitePool, id: &str, zone: &str) {
    let now = crate::now_iso();
    exec(
        pool,
        "INSERT OR IGNORE INTO sync_account (id, provider, display_name, auth_kind, created_at,
           updated_at) VALUES ('a1', 'caldav', 'Fastmail', 'basic', '2026-06-01', '2026-06-01')",
    )
    .await;
    let start: Option<String> =
        sqlx::query_scalar("SELECT scheduled_start FROM pages WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap();
    sqlx::query(
        "INSERT INTO page_schedules (id, page_id, scheduled_start, timezone, status, created_at)
         VALUES (?, ?, ?, ?, 'not_started', ?)",
    )
    .bind(format!("s-{id}"))
    .bind(id)
    .bind(start)
    .bind(zone)
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO page_sync (id, page_id, account_id, provider, calendar_id, external_id,
           ical_uid, created_at) VALUES (?, ?, 'a1', 'caldav', 'cal', ?, ?, ?)",
    )
    .bind(format!("y-{id}"))
    .bind(id)
    .bind(format!("/{id}.ics"))
    .bind(id)
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
}

async fn truth(pool: &SqlitePool) -> Vec<(String, i64, i64)> {
    sqlx::query_as(
        "SELECT COALESCE(folder_id, ''), SUM(status <> 'done'), SUM(status = 'done') FROM pages
         WHERE deleted_at IS NULL GROUP BY 1 ORDER BY 1",
    )
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn kept(pool: &SqlitePool) -> Vec<(String, i64, i64)> {
    sqlx::query_as(
        "SELECT folder_key, open, done FROM folder_counts WHERE open > 0 OR done > 0 ORDER BY 1",
    )
    .fetch_all(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn folder_counts_stay_exact_through_every_kind_of_write() {
    let pool = test_pool().await;
    for f in ["f1", "f2"] {
        crate::insert_test_folder(&pool, f, f).await.unwrap();
    }
    let mut seed = 0x5eed_u64;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed as usize
    };
    let folders = [None, Some("f1"), Some("f2")];
    for i in 0..300 {
        let id = format!("p{}", next() % 40);
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pages WHERE id = ?)")
            .bind(&id)
            .fetch_one(&pool)
            .await
            .unwrap();
        if !exists {
            page(&pool, &id, folders[next() % 3], None, None).await;
            continue;
        }
        let sql = match next() % 6 {
            0 => "UPDATE pages SET status = CASE status WHEN 'done' THEN 'not_started' ELSE 'done' END WHERE id = ?",
            1 => "UPDATE pages SET folder_id = 'f1' WHERE id = ?",
            2 => "UPDATE pages SET folder_id = NULL WHERE id = ?",
            3 => "UPDATE pages SET deleted_at = '2026-06-02' WHERE id = ?",
            4 => "UPDATE pages SET deleted_at = NULL WHERE id = ?",
            _ => "DELETE FROM pages WHERE id = ?",
        };
        sqlx::query(sql).bind(&id).execute(&pool).await.unwrap();
        assert_eq!(
            kept(&pool).await,
            truth(&pool).await,
            "after write {i}: {sql}"
        );
    }
    exec(&pool, "DELETE FROM folders WHERE id = 'f1'").await;
    assert_eq!(
        kept(&pool).await,
        truth(&pool).await,
        "after a folder delete"
    );
}

#[tokio::test]
async fn badges_count_a_synced_page_on_the_day_it_falls_in_the_viewers_zone() {
    let pool = test_pool().await;
    crate::insert_test_folder(&pool, "f1", "Work")
        .await
        .unwrap();
    page(&pool, "overdue", Some("f1"), Some("2026-06-01"), None).await;
    page(&pool, "all-day-today", None, Some("2026-06-15"), None).await;
    page(&pool, "late-tonight", None, Some("2026-06-15T23:59"), None).await;
    page(&pool, "tomorrow", None, Some("2026-06-16T08:00:00"), None).await;
    page(&pool, "day-7", None, Some("2026-06-21"), None).await;
    page(&pool, "day-8", None, Some("2026-06-22"), None).await;
    page(&pool, "unscheduled", None, None, None).await;
    page(&pool, "done-today", None, Some("2026-06-15"), None).await;
    exec(
        &pool,
        "UPDATE pages SET status = 'done' WHERE id = 'done-today'",
    )
    .await;
    // 1am Paris on the 16th: the 15th in New York, the 16th in Tokyo.
    page(&pool, "paris", None, Some("2026-06-16T01:00:00"), None).await;
    synced(&pool, "paris", "Europe/Paris").await;

    let today = NaiveDate::from_ymd_opt(2026, 6, 15).unwrap();
    let ny = count_views(&pool, "America/New_York", today).await.unwrap();
    assert_eq!(ny.today, 4, "overdue, all-day today, late tonight, Paris");
    assert_eq!(
        ny.upcoming, 5,
        "today's three, tomorrow, the seventh day; not the eighth"
    );
    assert_eq!(ny.inbox, 7);
    assert_eq!(ny.folders.get("f1"), Some(&1));

    let tokyo = count_views(&pool, "Asia/Tokyo", today).await.unwrap();
    assert_eq!(tokyo.today, 3, "Paris has moved to the 16th");
}

async fn ids_in(
    pool: &SqlitePool,
    start: Option<&str>,
    end: &str,
    zone: &str,
    open_only: bool,
) -> Vec<String> {
    let mut ids: Vec<String> = list_range(pool, start, end, zone, open_only)
        .await
        .unwrap()
        .into_iter()
        .map(|p| p.id)
        .collect();
    ids.sort();
    ids
}

#[tokio::test]
async fn a_range_holds_every_page_touching_it_in_the_viewers_zone() {
    let pool = test_pool().await;
    page(
        &pool,
        "last-day-timed",
        None,
        Some("2026-06-21T18:00:00"),
        None,
    )
    .await;
    page(
        &pool,
        "first-day-timed",
        None,
        Some("2026-06-15T09:00:00"),
        Some("2026-06-15T10:00:00"),
    )
    .await;
    page(&pool, "before", None, Some("2026-06-14T09:00:00"), None).await;
    page(&pool, "after", None, Some("2026-06-22T00:00:00"), None).await;
    page(
        &pool,
        "long-span",
        None,
        Some("2026-05-20"),
        Some("2026-06-16"),
    )
    .await;
    page(
        &pool,
        "long-span-ended",
        None,
        Some("2026-05-20"),
        Some("2026-06-14"),
    )
    .await;
    page(
        &pool,
        "overnight",
        None,
        Some("2026-06-14T22:00:00"),
        Some("2026-06-15T02:00:00"),
    )
    .await;
    page(
        &pool,
        "at-the-start",
        None,
        Some("2026-06-15T00:00:00"),
        None,
    )
    .await;
    page(&pool, "done", None, Some("2026-06-17T09:00:00"), None).await;
    exec(&pool, "UPDATE pages SET status = 'done' WHERE id = 'done'").await;
    // 11pm in LA on the 21st is 2am on the 22nd in New York: outside a week ending the 21st there.
    page(&pool, "la-late", None, Some("2026-06-21T23:00:00"), None).await;
    synced(&pool, "la-late", "America/Los_Angeles").await;
    // 11pm in LA on the 14th is 2am on the 15th in New York: inside.
    page(&pool, "la-early", None, Some("2026-06-14T23:00:00"), None).await;
    synced(&pool, "la-early", "America/Los_Angeles").await;

    // The week of the 15th to the 21st in New York, as instants.
    let (start, end) = ("2026-06-15T04:00:00Z", "2026-06-22T04:00:00Z");
    assert_eq!(
        ids_in(&pool, Some(start), end, "America/New_York", false).await,
        [
            "done",
            "first-day-timed",
            "la-early",
            "last-day-timed",
            "long-span",
            "overnight",
        ],
        "a timed page on the last day is in; a moment exactly at the start is out, as the grid has it"
    );
    assert!(!ids_in(&pool, Some(start), end, "America/New_York", true)
        .await
        .contains(&"done".to_string()));

    // The same week in LA: la-late is on the 21st there, la-early on the 14th.
    let la = ids_in(
        &pool,
        Some("2026-06-15T07:00:00Z"),
        "2026-06-22T07:00:00Z",
        "America/Los_Angeles",
        false,
    )
    .await;
    assert!(
        la.contains(&"la-late".to_string()) && !la.contains(&"la-early".to_string()),
        "{la:?}"
    );

    // Today's view: everything open up to the end of the 15th.
    let today = ids_in(
        &pool,
        None,
        "2026-06-16T04:00:00Z",
        "America/New_York",
        true,
    )
    .await;
    assert_eq!(
        today,
        [
            "at-the-start",
            "before",
            "first-day-timed",
            "la-early",
            "long-span",
            "long-span-ended",
            "overnight"
        ]
    );
}

#[tokio::test]
async fn series_heads_pages_by_id_and_newer_copies() {
    let pool = test_pool().await;
    for id in ["a", "b", "c", "series", "ended"] {
        page(&pool, id, None, Some("2026-06-15T09:00:00"), None).await;
    }
    for id in ["series", "ended"] {
        sqlx::query(
            "INSERT INTO page_recurrence_rules (id, page_id, rrule, scheduled_start, timezone, created_at)
             VALUES (?, ?, 'FREQ=WEEKLY', '2026-06-15T09:00:00', 'America/New_York', '2026-06-01')",
        )
        .bind(format!("r-{id}"))
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    }
    exec(&pool, "UPDATE pages SET status = 'done' WHERE id = 'ended'").await;
    let heads = |open| {
        let pool = pool.clone();
        async move {
            list_series_heads(&pool, open)
                .await
                .unwrap()
                .into_iter()
                .map(|p| p.id)
                .collect::<Vec<_>>()
        }
    };
    assert_eq!(heads(true).await, ["series"]);
    assert_eq!(heads(false).await.len(), 2);

    exec(
        &pool,
        "UPDATE pages SET deleted_at = '2026-06-02' WHERE id = 'b'",
    )
    .await;
    let got: Vec<String> = get_pages(
        &pool,
        &["c".into(), "missing".into(), "b".into(), "a".into()],
    )
    .await
    .unwrap()
    .into_iter()
    .map(|p| p.id)
    .collect();
    assert_eq!(
        got,
        ["c", "a"],
        "in the order asked, without the trashed or missing"
    );

    let PageIfNewer::Newer { row_seq, .. } = get_page_if_newer(&pool, "a", None).await.unwrap()
    else {
        panic!("a first read returns the page");
    };
    assert!(matches!(
        get_page_if_newer(&pool, "a", Some(row_seq)).await.unwrap(),
        PageIfNewer::Current
    ));
    exec(&pool, "UPDATE pages SET title = 'a, edited' WHERE id = 'a'").await;
    let PageIfNewer::Newer { page, .. } =
        get_page_if_newer(&pool, "a", Some(row_seq)).await.unwrap()
    else {
        panic!("an edit makes the held copy stale");
    };
    assert_eq!(page.title, "a, edited");
    assert!(matches!(
        get_page_if_newer(&pool, "b", Some(row_seq)).await.unwrap(),
        PageIfNewer::Missing
    ));
}

#[tokio::test]
async fn recents_are_the_open_pages_opened_last() {
    let pool = test_pool().await;
    for (id, opened, tags, order) in [
        ("a", Some("2026-06-10T09:00:00"), r#"["work","urgent"]"#, 3),
        ("b", Some("2026-06-12T09:00:00"), r#"["home"]"#, 1),
        ("c", None, r#"["urgent","later"]"#, 2),
        ("d", Some("2026-06-14T09:00:00"), r#"["home"]"#, 4),
        ("e", Some("2026-06-15T09:00:00"), r#"["done-only"]"#, 0),
    ] {
        page(&pool, id, None, None, None).await;
        sqlx::query("UPDATE pages SET last_opened_at = ?, tags = ?, sort_order = ? WHERE id = ?")
            .bind(opened)
            .bind(tags)
            .bind(order)
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
    }
    exec(&pool, "UPDATE pages SET status = 'done' WHERE id = 'e'").await;

    let recents: Vec<String> = list_recent_pages(&pool, Some("d"), 10)
        .await
        .unwrap()
        .into_iter()
        .map(|p| p.id)
        .collect();
    assert_eq!(
        recents,
        ["b", "a"],
        "most recent first, without the active page, done or never opened"
    );
}

async fn tag(pool: &SqlitePool, page_id: &str, name: &str) {
    sqlx::query("INSERT OR IGNORE INTO tags (id, name) VALUES (?, ?)")
        .bind(format!("t-{name}"))
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT OR IGNORE INTO page_tags (page_id, tag_id) VALUES (?, ?)")
        .bind(page_id)
        .bind(format!("t-{name}"))
        .execute(pool)
        .await
        .unwrap();
}

async fn tag_truth(pool: &SqlitePool) -> Vec<(String, i64)> {
    sqlx::query_as(
        "SELECT t.name, COUNT(*) FROM page_tags pt JOIN tags t ON t.id = pt.tag_id
         JOIN pages p ON p.id = pt.page_id WHERE p.deleted_at IS NULL AND p.status <> 'done'
         GROUP BY t.name ORDER BY COUNT(*) DESC, t.name",
    )
    .fetch_all(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn tags_list_most_used_first_and_stay_exact_through_every_write() {
    let pool = test_pool().await;
    let names = ["work", "home", "urgent", "later"];
    let mut seed = 0x7a95_u64;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed as usize
    };
    for i in 0..300 {
        let id = format!("p{}", next() % 25);
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pages WHERE id = ?)")
            .bind(&id)
            .fetch_one(&pool)
            .await
            .unwrap();
        if !exists {
            page(&pool, &id, None, None, None).await;
        }
        let name = names[next() % names.len()];
        let sql = match next() % 6 {
            0 | 1 => {
                tag(&pool, &id, name).await;
                None
            }
            2 => Some("DELETE FROM page_tags WHERE page_id = ?1 AND tag_id = 't-' || ?2"),
            3 => Some("UPDATE pages SET status = CASE status WHEN 'done' THEN 'not_started' ELSE 'done' END WHERE id = ?1 AND ?2 IS NOT NULL"),
            4 => Some("UPDATE pages SET deleted_at = CASE WHEN deleted_at IS NULL THEN '2026-06-02' END WHERE id = ?1 AND ?2 IS NOT NULL"),
            _ => Some("DELETE FROM pages WHERE id = ?1 AND ?2 IS NOT NULL"),
        };
        if let Some(sql) = sql {
            sqlx::query(sql)
                .bind(&id)
                .bind(name)
                .execute(&pool)
                .await
                .unwrap();
        }
        let listed: Vec<(String, i64)> = list_tags(&pool)
            .await
            .unwrap()
            .into_iter()
            .map(|t| (t.name, t.page_count))
            .collect();
        assert_eq!(listed, tag_truth(&pool).await, "after write {i}");
    }
}
