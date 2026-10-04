use super::*;

#[test]
fn the_strip_matches_the_apps() {
    for (title, stripped) in [
        ("🎉 Party", "Party"),
        ("🎉Party", "Party"),
        ("❤️ heart", "heart"),
        ("👨‍👩‍👧 family", "family"),
        ("  leading space", "leading space"),
        ("\u{FEFF}bom", "bom"),
        ("\u{0085}next line", "\u{0085}next line"),
        ("🙂", ""),
        ("Plain 🎉", "Plain 🎉"),
        ("1st", "1st"),
    ] {
        assert_eq!(strip_leading_emoji(title), stripped, "{title:?}");
    }
}

/// `title_order_fixture.json` holds WebKit's order, from `scripts/title-order-fixture.mjs`, as
/// groups of titles its collator calls equal. The keys have to make the same groups in the same
/// order.
#[test]
fn keys_order_titles_as_webkit_does_in_every_language() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("title_order_fixture.json")).unwrap();
    let mut differences = Vec::new();
    for (locale, expected) in fixture["groups"].as_object().unwrap() {
        let expected: Vec<Vec<String>> = serde_json::from_value(expected.clone()).unwrap();
        let collator = collator_for(&Locale::try_from_str(locale).unwrap());
        let mut keyed: Vec<(Vec<u8>, String)> = expected
            .iter()
            .flatten()
            .map(|t| (key_with(&collator, t), t.clone()))
            .collect();
        keyed.sort();
        let mut groups: Vec<Vec<String>> = Vec::new();
        let mut last: Option<&Vec<u8>> = None;
        for (key, title) in &keyed {
            if last == Some(key) {
                groups.last_mut().unwrap().push(title.clone());
            } else {
                groups.push(vec![title.clone()]);
            }
            last = Some(key);
        }
        let normalise = |gs: &[Vec<String>]| -> Vec<Vec<String>> {
            gs.iter()
                .map(|g| {
                    let mut g = g.clone();
                    g.sort();
                    g
                })
                .collect()
        };
        let (ours, theirs) = (normalise(&groups), normalise(&expected));
        if ours != theirs {
            differences.push(format!(
                "{locale}:\n  keys:   {ours:?}\n  webkit: {theirs:?}"
            ));
        }
    }
    assert!(differences.is_empty(), "{}", differences.join("\n"));
}

async fn stored_key(pool: &sqlx::SqlitePool, id: &str) -> Option<Vec<u8>> {
    sqlx::query_scalar("SELECT title_key FROM pages WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_page_is_keyed_when_written_and_rekeyed_when_renamed() {
    let pool = crate::pool::test_pool().await;
    crate::pool::insert_test_page(&pool, crate::pool::TestPage::new("p1", "🎉 Party"))
        .await
        .unwrap();
    assert_eq!(stored_key(&pool, "p1").await, Some(title_key("🎉 Party")));

    let before = crate::changes::change_state(&pool).await.unwrap().seq;
    sqlx::query("UPDATE pages SET title = 'Item 10' WHERE id = 'p1'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(stored_key(&pool, "p1").await, Some(title_key("Item 10")));
    assert_eq!(
        crate::changes::change_state(&pool).await.unwrap().seq,
        before + 1,
        "a rename is one change, not two"
    );
}

#[tokio::test]
async fn the_database_orders_titles_by_their_keys() {
    let pool = crate::pool::test_pool().await;
    for (id, title) in [
        ("a", "Item 10"),
        ("b", "🎉 zebra"),
        ("c", "Item 2"),
        ("d", "apple"),
    ] {
        crate::pool::insert_test_page(&pool, crate::pool::TestPage::new(id, title))
            .await
            .unwrap();
    }
    let titles: Vec<String> = sqlx::query_scalar("SELECT title FROM pages ORDER BY title_key")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(titles, ["apple", "Item 2", "Item 10", "🎉 zebra"]);
}

#[tokio::test]
async fn stale_keys_are_rebuilt_without_counting_a_change() {
    let pool = crate::pool::test_pool().await;
    for (id, title) in [("a", "Item 10"), ("b", "Item 2")] {
        crate::pool::insert_test_page(&pool, crate::pool::TestPage::new(id, title))
            .await
            .unwrap();
    }
    sqlx::query("UPDATE pages SET title_key = NULL WHERE id = 'a'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE pages SET title_key = X'00' WHERE id = 'b'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE title_key_version SET version = 'icu_collator-1/strip-0/xx'")
        .execute(&pool)
        .await
        .unwrap();
    let before = crate::changes::change_state(&pool).await.unwrap().seq;

    rekey_if_stale(&pool).await.unwrap();

    assert_eq!(stored_key(&pool, "a").await, Some(title_key("Item 10")));
    assert_eq!(stored_key(&pool, "b").await, Some(title_key("Item 2")));
    let version: Option<String> = sqlx::query_scalar("SELECT version FROM title_key_version")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(version, Some(key_version()));
    assert_eq!(
        crate::changes::change_state(&pool).await.unwrap().seq,
        before
    );
}
