use super::*;
use crate::pool::test_pool;
use crate::views::{list_view_ids, ViewKey, ViewScope, ViewSort};

fn manual(scope: ViewScope) -> ViewKey {
    ViewKey {
        scope,
        sort: ViewSort::Manual,
        zone: "America/New_York".into(),
        dates: None,
    }
}

async fn order(pool: &SqlitePool) -> Vec<String> {
    list_view_ids(pool, &manual(ViewScope::Folder("f1".into())), None, None)
        .await
        .unwrap()
}

/// Pages a to f in folder f1, a full gap apart, with `c` done among them.
async fn folder_of_six() -> SqlitePool {
    let pool = test_pool().await;
    crate::insert_test_folder(&pool, "f1", "Work")
        .await
        .unwrap();
    for (i, id) in ["a", "b", "c", "d", "e", "f"].into_iter().enumerate() {
        let mut page = crate::TestPage::new(id, id);
        page.folder_id = Some("f1");
        crate::insert_test_page(&pool, page).await.unwrap();
        sqlx::query("UPDATE pages SET sort_order = ? WHERE id = ?")
            .bind(i as i64 * ORDER_SPACING)
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
    }
    sqlx::query(
        "UPDATE pages SET status = 'done', completed_at = '2026-06-01T09:00:00' WHERE id = 'c'",
    )
    .execute(&pool)
    .await
    .unwrap();
    pool
}

fn ids(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

fn at(after: Option<&str>, before: Option<&str>) -> Placement {
    Placement {
        after: after.map(Into::into),
        before: before.map(Into::into),
    }
}

#[tokio::test]
async fn a_page_lands_between_its_new_neighbours() {
    let pool = folder_of_six().await;
    move_pages(&pool, &ids(&["f"]), &at(Some("a"), Some("b")))
        .await
        .unwrap();
    assert_eq!(order(&pool).await, ids(&["a", "f", "b", "d", "e"]));

    move_pages(&pool, &ids(&["e"]), &at(None, Some("a")))
        .await
        .unwrap();
    move_pages(&pool, &ids(&["a"]), &at(Some("d"), None))
        .await
        .unwrap();
    assert_eq!(order(&pool).await, ids(&["e", "f", "b", "d", "a"]));
}

#[tokio::test]
async fn several_pages_land_together_in_the_order_given() {
    let pool = folder_of_six().await;
    let outcome = move_pages(&pool, &ids(&["e", "a"]), &at(Some("b"), Some("d")))
        .await
        .unwrap();
    assert!(!outcome.renumbered);
    assert_eq!(order(&pool).await, ids(&["b", "e", "a", "d", "f"]));
}

#[tokio::test]
async fn a_move_against_a_stale_list_is_refused_and_changes_nothing() {
    let pool = folder_of_six().await;
    let before = order(&pool).await;

    // `b` and `e` aren't next to each other: `d` is between them.
    let err = move_pages(&pool, &ids(&["a"]), &at(Some("b"), Some("e")))
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::Conflict(_)), "{err:?}");

    // A neighbour that moved to another folder.
    sqlx::query("UPDATE pages SET folder_id = NULL WHERE id = 'e'")
        .execute(&pool)
        .await
        .unwrap();
    let err = move_pages(&pool, &ids(&["a"]), &at(Some("d"), Some("e")))
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::Conflict(_)), "{err:?}");

    let left: Vec<String> = before.into_iter().filter(|id| id != "e").collect();
    assert_eq!(order(&pool).await, left);
}

#[tokio::test]
async fn running_out_of_room_renumbers_the_folder_and_keeps_every_place() {
    let pool = folder_of_six().await;
    sqlx::query("UPDATE pages SET sort_order = 5 WHERE id = 'a'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE pages SET sort_order = 6 WHERE id IN ('b', 'c')")
        .execute(&pool)
        .await
        .unwrap();

    let outcome = move_pages(&pool, &ids(&["f"]), &at(Some("a"), Some("b")))
        .await
        .unwrap();
    assert!(outcome.renumbered);
    assert_eq!(order(&pool).await, ids(&["a", "f", "b", "d", "e"]));

    let everything: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM pages WHERE folder_id = 'f1' AND deleted_at IS NULL
         ORDER BY sort_order, created_at, id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        everything,
        ids(&["a", "f", "b", "c", "d", "e"]),
        "the done page keeps its place too, for when it's unticked"
    );
}

#[tokio::test]
async fn pages_from_two_folders_are_refused_together() {
    let pool = folder_of_six().await;
    sqlx::query("UPDATE pages SET folder_id = NULL WHERE id = 'e'")
        .execute(&pool)
        .await
        .unwrap();
    let before = order(&pool).await;

    let err = move_pages(&pool, &ids(&["a", "e"]), &at(Some("b"), Some("d")))
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::Invalid(_)), "{err:?}");
    assert_eq!(order(&pool).await, before);
}

/// A simple xorshift, so the run is the same every time.
fn rng(seed: &mut u64) -> usize {
    *seed ^= *seed << 13;
    *seed ^= *seed >> 7;
    *seed ^= *seed << 17;
    *seed as usize
}

#[tokio::test]
async fn two_hundred_random_moves_match_a_plain_list() {
    let pool = folder_of_six().await;
    let mut expected = order(&pool).await;
    let mut seed = 0x5eed_u64;
    for _ in 0..200 {
        let count = 1 + rng(&mut seed) % 2;
        let mut moved = Vec::new();
        while moved.len() < count {
            let id = expected[rng(&mut seed) % expected.len()].clone();
            if !moved.contains(&id) {
                moved.push(id);
            }
        }
        let rest: Vec<String> = expected
            .iter()
            .filter(|id| !moved.contains(id))
            .cloned()
            .collect();
        let slot = rng(&mut seed) % (rest.len() + 1);
        let place = Placement {
            after: slot.checked_sub(1).map(|i| rest[i].clone()),
            before: rest.get(slot).cloned(),
        };
        move_pages(&pool, &moved, &place).await.unwrap();
        expected = rest.clone();
        expected.splice(slot..slot, moved.iter().cloned());
        assert_eq!(order(&pool).await, expected);
    }
}

#[tokio::test]
async fn a_done_clone_names_its_series() {
    let pool = test_pool().await;
    crate::insert_test_page(&pool, crate::TestPage::new("series", "Standup"))
        .await
        .unwrap();
    crate::insert_test_page(&pool, crate::TestPage::new("clone", "Standup"))
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO completed_set (page_id, occurrence_date, clone_id)
         VALUES ('series', '2026-06-15', 'clone')",
    )
    .execute(&pool)
    .await
    .unwrap();
    let page = crate::get_page(&pool, "clone").await.unwrap().unwrap();
    assert_eq!(page.series_id.as_deref(), Some("series"));
    let series = crate::get_page(&pool, "series").await.unwrap().unwrap();
    assert_eq!(series.series_id, None);
}
