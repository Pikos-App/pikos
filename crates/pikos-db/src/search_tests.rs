use super::*;
use crate::pool::{insert_test_page, test_pool, TestPage};

async fn seed_pages(pool: &sqlx::SqlitePool) {
    for (id, title, subtitle, content_text, status, tags) in [
        (
            "p1",
            "Morning routine",
            None,
            "Coffee, journaling, exercise.",
            "not_started",
            "[]",
        ),
        (
            "p2",
            "Project notes",
            Some("morning sync"),
            "Discussed Q3 roadmap.",
            "not_started",
            "[]",
        ),
        (
            "p3",
            "Random journal",
            None,
            "Felt great this morning after a walk.",
            "not_started",
            "[]",
        ),
        (
            "p4",
            "Finished onboarding",
            None,
            "Closed the morning module last week.",
            "done",
            "[]",
        ),
        (
            "p5",
            "Deleted draft",
            None,
            "Should never appear in morning search.",
            "not_started",
            "[]",
        ),
        (
            "p6",
            "Multi-color palette",
            None,
            "Picking accent shades.",
            "not_started",
            "[]",
        ),
        (
            "p7",
            "Don't forget milk",
            None,
            "Grocery reminder.",
            "not_started",
            "[]",
        ),
        (
            "p8",
            "Tag-heavy",
            None,
            "Body has nothing relevant.",
            "not_started",
            r#"["mindfulness"]"#,
        ),
    ] {
        insert_test_page(
            pool,
            TestPage {
                id,
                title,
                subtitle,
                content_text,
                status,
                tags_json: tags,
                ..TestPage::new(id, title)
            },
        )
        .await
        .unwrap();
    }
    // Soft-delete p5 so deleted_at IS NOT NULL.
    sqlx::query("UPDATE pages SET deleted_at = '2026-01-01T00:00:00Z' WHERE id = 'p5'")
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn title_match_outranks_content_match() {
    let pool = test_pool().await;
    seed_pages(&pool).await;

    let resp = search_pages_impl(&pool, "morning".into(), None)
        .await
        .unwrap();
    // p1's title contains "Morning" — should rank above p3 whose match is body-only.
    let ids: Vec<&str> = resp.results.iter().map(|r| r.id.as_str()).collect();
    let p1 = ids.iter().position(|&i| i == "p1").expect("p1 present");
    let p3 = ids.iter().position(|&i| i == "p3").expect("p3 present");
    assert!(
        p1 < p3,
        "title match (p1) should outrank body match (p3): {ids:?}"
    );
}

#[tokio::test]
async fn excludes_deleted_and_completed_by_default() {
    let pool = test_pool().await;
    seed_pages(&pool).await;

    let resp = search_pages_impl(&pool, "morning".into(), None)
        .await
        .unwrap();
    let ids: Vec<&str> = resp.results.iter().map(|r| r.id.as_str()).collect();
    assert!(!ids.contains(&"p5"), "soft-deleted page leaked: {ids:?}");
    assert!(!ids.contains(&"p4"), "completed page leaked: {ids:?}");
    // completed_count counts matches regardless of include_completed.
    assert_eq!(resp.completed_count, 1, "p4 is the only done match");
}

#[tokio::test]
async fn include_completed_returns_done_pages() {
    let pool = test_pool().await;
    seed_pages(&pool).await;

    let resp = search_pages_impl(&pool, "morning".into(), Some(true))
        .await
        .unwrap();
    let ids: Vec<&str> = resp.results.iter().map(|r| r.id.as_str()).collect();
    // p4 is the only completed match — flag must let it through.
    assert!(ids.contains(&"p4"), "completed page absent: {ids:?}");
    assert!(!ids.contains(&"p5"), "soft-deleted page leaked: {ids:?}");
    assert_eq!(resp.completed_count, 1);
}

#[tokio::test]
async fn prefix_match_on_last_token() {
    let pool = test_pool().await;
    seed_pages(&pool).await;

    // "morn" alone should still match "morning" via the trailing `*`.
    let resp = search_pages_impl(&pool, "morn".into(), None).await.unwrap();
    let ids: Vec<&str> = resp.results.iter().map(|r| r.id.as_str()).collect();
    assert!(ids.contains(&"p1"), "prefix match missed p1: {ids:?}");
}

#[tokio::test]
async fn hyphenated_query_does_not_crash() {
    let pool = test_pool().await;
    seed_pages(&pool).await;

    // Naive FTS5 would treat `-` as NOT or column-qualifier and error out.
    // Tokenizer should split on hyphen.
    let resp = search_pages_impl(&pool, "multi-color".into(), None)
        .await
        .unwrap();
    let ids: Vec<&str> = resp.results.iter().map(|r| r.id.as_str()).collect();
    assert!(ids.contains(&"p6"), "hyphen query missed p6: {ids:?}");
}

#[tokio::test]
async fn apostrophe_query_does_not_crash() {
    let pool = test_pool().await;
    seed_pages(&pool).await;

    // `'` in FTS5 syntax is a phrase delimiter — must be stripped.
    let resp = search_pages_impl(&pool, "don't".into(), None)
        .await
        .unwrap();
    let ids: Vec<&str> = resp.results.iter().map(|r| r.id.as_str()).collect();
    assert!(ids.contains(&"p7"), "apostrophe query missed p7: {ids:?}");
}

#[tokio::test]
async fn tag_match_returns_result() {
    let pool = test_pool().await;
    seed_pages(&pool).await;

    // "mindfulness" only appears in p8's tags JSON.
    let resp = search_pages_impl(&pool, "mindfulness".into(), None)
        .await
        .unwrap();
    let ids: Vec<&str> = resp.results.iter().map(|r| r.id.as_str()).collect();
    assert!(ids.contains(&"p8"), "tag match missed p8: {ids:?}");
}

#[tokio::test]
async fn a_metadata_only_hit_quotes_the_metadata() {
    let pool = test_pool().await;
    seed_pages(&pool).await;
    insert_test_page(&pool, TestPage::new("p9", "Standup"))
        .await
        .unwrap();
    sqlx::query(
        "UPDATE pages SET mirror_search_text = 'Weyland Room' || CHAR(10) || 'priya@example.com'
         WHERE id = 'p9'",
    )
    .execute(&pool)
    .await
    .unwrap();

    for query in ["weyland", "priya"] {
        let resp = search_pages_impl(&pool, query.into(), None).await.unwrap();
        let hit = resp
            .results
            .iter()
            .find(|r| r.id == "p9")
            .unwrap_or_else(|| panic!("{query} missed p9"));
        assert!(
            hit.excerpt.to_lowercase().contains(query),
            "{query} excerpt: {:?}",
            hit.excerpt
        );
        assert_eq!(
            hit.match_source, "content",
            "{query}: this label hides the excerpt"
        );
    }
}

#[tokio::test]
async fn a_body_hit_outranks_the_metadata_for_the_excerpt() {
    let pool = test_pool().await;
    insert_test_page(
        &pool,
        TestPage {
            content_text: "moved to the annex",
            ..TestPage::new("p1", "Standup")
        },
    )
    .await
    .unwrap();
    sqlx::query("UPDATE pages SET mirror_search_text = 'Annex Room' WHERE id = 'p1'")
        .execute(&pool)
        .await
        .unwrap();

    let resp = search_pages_impl(&pool, "annex".into(), None)
        .await
        .unwrap();
    assert_eq!(resp.results[0].excerpt, "moved to the annex");
}

#[tokio::test]
async fn empty_query_returns_empty() {
    let pool = test_pool().await;
    seed_pages(&pool).await;

    let resp = search_pages_impl(&pool, "   ".into(), None).await.unwrap();
    assert!(resp.results.is_empty());
    assert_eq!(resp.completed_count, 0);
}

#[test]
fn build_excerpt_centers_on_match() {
    let body = "alpha beta gamma morning delta epsilon zeta";
    let out = build_excerpt(Some(body), "title", None, &["morning".into()]);
    assert!(out.contains("morning"), "{out:?}");
}

#[test]
fn build_excerpt_strips_title_and_subtitle() {
    // content_text often starts with title + subtitle (mirrors editor flow).
    let body = "My Page\nshort summary\nbody text with morning here";
    let out = build_excerpt(
        Some(body),
        "My Page",
        Some("short summary"),
        &["morning".into()],
    );
    assert!(!out.starts_with("My Page"), "title leaked: {out:?}");
    assert!(out.contains("morning"), "{out:?}");
}

/// Two blocks of a page are two sentences, and HTML would fold the newline between them into a
/// space: "the alcove Order the desktop top" reads as one phrase nobody wrote.
#[test]
fn build_excerpt_joins_blocks_rather_than_running_them_together() {
    let body = "My Page\nMeasure the alcove\n\nOrder the desktop top";
    let out = build_excerpt(Some(body), "My Page", None, &["alcove".into()]);
    assert_eq!(out, "Measure the alcove \u{00B7} Order the desktop top");
}

/// A pasted URL is a word with no whitespace in it, so the edge the window wanted has no
/// boundary to snap to. Cutting there is what makes an excerpt read as corrupted data.
#[test]
fn build_excerpt_never_cuts_a_word_in_half() {
    // The hit sits far enough into the URL that the window's left edge lands inside it.
    let body = "My Page\nSee https://example.com/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z/motorized-standing-desk";
    let out = build_excerpt(Some(body), "My Page", None, &["motorized".into()]);

    let first = out.trim_start_matches('\u{2026}');
    assert!(
        first.starts_with("https://"),
        "excerpt starts inside a word: {out:?}"
    );
}

/// The window has to hold the match. Snapping inward on a body with one space closed both
/// edges onto it and returned an excerpt of the wrong part of the page.
#[test]
fn build_excerpt_keeps_the_match_when_the_body_has_one_space() {
    let body = "My Page\nSee ".to_string() + &"a".repeat(200) + "motorized" + &"b".repeat(200);
    let out = build_excerpt(Some(&body), "My Page", None, &["motorized".into()]);
    assert!(out.contains("motorized"), "{out:?}");
}

/// A mirror's metadata gets the same treatment, and it is the half a blank line tells apart:
/// replacing every newline would leave an empty block between two separators.
#[test]
fn build_mirror_excerpt_joins_blocks_rather_than_running_them_together() {
    let metadata = "Weyland Room  \n\n priya@example.com \nstandup";
    let out = build_mirror_excerpt(Some(metadata), &["priya".into()]);
    assert_eq!(
        out,
        "Weyland Room \u{00B7} priya@example.com \u{00B7} standup"
    );
}

#[test]
fn strip_prefix_ci_handles_multibyte() {
    // Regression check: char-based prefix strip must not panic on UTF-8.
    let stripped = strip_prefix_ci("Café au lait\nbody", "café");
    assert_eq!(stripped, Some(" au lait\nbody"));
}

#[tokio::test]
async fn a_query_within_the_scan_ranks_exactly() {
    let pool = test_pool().await;
    seed_pages(&pool).await;
    let ids = |resp: SearchResponse| resp.results.into_iter().map(|r| r.id).collect::<Vec<_>>();

    let scanned = search_pages_scan(&pool, "morning".into(), None, SearchScan::Newest(10))
        .await
        .unwrap();
    assert!(!scanned.completed_count_capped);
    let exact = search_pages_scan(&pool, "morning".into(), None, SearchScan::All)
        .await
        .unwrap();
    assert_eq!(ids(scanned), ids(exact));
}

#[tokio::test]
async fn past_the_scan_title_matches_lead_and_older_body_matches_drop() {
    let pool = test_pool().await;
    seed_pages(&pool).await;
    // "morning" matches p1 (title), p2 (subtitle), p3, p4 (done) and p5 (deleted) in the body,
    // inserted in that order. A scan of two reads p5 and p4 as the newest matches, and p2 and p1
    // as the newest title matches; p3 is older than the scan and has no title hit.
    let resp = search_pages_scan(&pool, "morning".into(), None, SearchScan::Newest(2))
        .await
        .unwrap();
    let ids: Vec<&str> = resp.results.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, ["p1", "p2"]);
    assert_eq!(resp.completed_count, 1);
    assert!(resp.completed_count_capped);

    let with_done = search_pages_scan(&pool, "morning".into(), Some(true), SearchScan::Newest(2))
        .await
        .unwrap();
    let ids: Vec<&str> = with_done.results.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, ["p1", "p2", "p4"]);
}

#[tokio::test]
async fn the_index_drives_the_join_to_pages_without_statistics() {
    let pool = test_pool().await;
    sqlx::query("DELETE FROM sqlite_stat1")
        .execute(&pool)
        .await
        .ok();
    let sql = format!(
        "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM {MATCHED_PAGES}
         WHERE pages_fts MATCH 'word*' AND pages.deleted_at IS NULL AND pages.status = 'done'"
    );
    let plan: Vec<(i64, i64, i64, String)> = sqlx::query_as(&sql).fetch_all(&pool).await.unwrap();
    let first = &plan.first().unwrap().3;
    assert!(first.starts_with("SCAN pages_fts"), "{plan:?}");
}

/// The index updates only when an indexed column is written, so the trigger names them. A column
/// added to the index and not to the trigger would stop updating search for edits to it alone.
#[tokio::test]
async fn the_index_update_trigger_names_every_indexed_column() {
    let pool = test_pool().await;
    let mut indexed: Vec<String> =
        sqlx::query_scalar("SELECT name FROM pragma_table_info('pages_fts')")
            .fetch_all(&pool)
            .await
            .unwrap();
    let sql: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE name = 'pages_fts_update'")
            .fetch_one(&pool)
            .await
            .unwrap();
    let list = sql
        .split("UPDATE OF")
        .nth(1)
        .and_then(|rest| rest.split(" ON pages").next())
        .expect("the trigger is narrowed to UPDATE OF its columns");
    let mut named: Vec<String> = list.split(',').map(|c| c.trim().to_string()).collect();
    indexed.sort();
    named.sort();
    assert_eq!(named, indexed);
}
