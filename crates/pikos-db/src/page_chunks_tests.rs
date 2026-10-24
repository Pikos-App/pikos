use super::*;
use crate::pages::pages_tests::new_page;
use crate::pool::test_pool;
use crate::PageUpdate;
use pikos_core::body_section::SectionEdit;
use pikos_core::chunks::join_chunks;
use sqlx::SqlitePool;

fn para(text: &str) -> String {
    format!(r#"{{"type":"paragraph","content":[{{"type":"text","text":"{text}"}}]}}"#)
}

/// About `n` KB of body, in blocks of about one.
fn long_body(n: usize, label: &str) -> String {
    let blocks: Vec<String> = (0..n)
        .map(|i| para(&format!("{label} {i} {}", "word ".repeat(200))))
        .collect();
    format!(r#"{{"type":"doc","content":[{}]}}"#, blocks.join(","))
}

async fn stored_chunks(pool: &SqlitePool, page_id: &str) -> Vec<(String, String)> {
    sqlx::query_as("SELECT chunk_id, body FROM page_chunks WHERE page_id = ? ORDER BY ord")
        .bind(page_id)
        .fetch_all(pool)
        .await
        .unwrap()
}

/// Every page's chunks, joined, are its body's blocks; a body with no blocks has no chunks. Blocks,
/// not the whole document: a section edit to an empty page writes one without `"type":"doc"`.
async fn assert_chunks_are_every_body(pool: &SqlitePool) {
    let pages: Vec<(String, String)> = sqlx::query_as("SELECT id, content FROM pages")
        .fetch_all(pool)
        .await
        .unwrap();

    for (id, content) in pages {
        let chunks = stored_chunks(pool, &id).await;
        let body: serde_json::Value = serde_json::from_str(&content).unwrap_or_default();

        let has_blocks = body["content"]
            .as_array()
            .is_some_and(|blocks| !blocks.is_empty());
        if !has_blocks {
            assert!(chunks.is_empty(), "{id} has no blocks but has chunks");
            continue;
        }
        let joined = join_chunks(chunks.iter().map(|(_, body)| body.as_str()));
        let joined: serde_json::Value = serde_json::from_str(&joined).unwrap();
        assert_eq!(
            joined["content"], body["content"],
            "{id}'s chunks are not its body"
        );
    }
}

/// One calendar event with `description`, synced in at `etag`: the reconciler seeds a page's body
/// from it, and rewrites the body when it changes.
async fn synced_event(pool: &SqlitePool, etag: &str, description: &str) {
    use crate::sync_delta::{
        EventCore, EventSchedule, EventUpsert, ExclusiveEnd, SyncDelta, UpsertItem,
    };

    sqlx::query(
        "INSERT OR IGNORE INTO sync_account (id, provider, display_name, auth_kind, created_at, updated_at)
         VALUES ('a1', 'caldav', 'Fastmail', 'basic', '2026-06-01T00:00:00', '2026-06-01T00:00:00')",
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT OR IGNORE INTO folders (id, name, sort_order, created_at, updated_at) VALUES ('f1', 'Cal', 0, '2026-06-01T00:00:00', '2026-06-01T00:00:00')")
        .execute(pool)
        .await
        .unwrap();
    crate::reconciler::reconcile(
        pool,
        &crate::reconciler::ReconcileContext {
            account_id: "a1".into(),
            calendar_id: "cal".into(),
            provider: "caldav".into(),
            folder_id: "f1".into(),
            window_start: chrono::NaiveDate::MIN,
        },
        &SyncDelta {
            upserts: vec![UpsertItem::Event(EventUpsert {
                core: EventCore {
                    external_id: "/ev.ics".into(),
                    ical_uid: "uid-1".into(),
                    etag: Some(etag.into()),
                    title: "Meeting".into(),
                    description: Some(description.into()),
                    location: None,
                    attendees: vec![],
                },
                schedule: EventSchedule {
                    start: "2026-06-15T09:00:00".into(),
                    end: ExclusiveEnd::new(None),
                    timezone: Some("America/New_York".into()),
                },
                recurrence: None,
            })],
            ..Default::default()
        },
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn every_content_write_leaves_chunks_equal_to_the_body() {
    let pool = test_pool().await;

    let mut data = new_page("Long");
    data.content = long_body(200, "first");
    let page = crate::create_page_impl(&pool, data).await.unwrap();
    let empty = crate::create_page_impl(&pool, new_page("Empty"))
        .await
        .unwrap();
    assert_chunks_are_every_body(&pool).await;

    let loaded = long_body(200, "first");
    let typed = long_body(220, "first");
    crate::update_page_impl(
        &pool,
        page.id.clone(),
        PageUpdate {
            content: Some(typed.clone()),
            base_content: Some(loaded.clone()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_chunks_are_every_body(&pool).await;

    let over_a_stale_base = long_body(210, "first").replace("first 5 ", "edited 5 ");
    crate::update_page_impl(
        &pool,
        page.id.clone(),
        PageUpdate {
            content: Some(over_a_stale_base),
            base_content: Some(loaded),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_chunks_are_every_body(&pool).await;

    let block: serde_json::Value = serde_json::from_str(&para("from the CLI")).unwrap();
    let blocks = [block];
    crate::edit_page_section_impl(&pool, &page.id, &SectionEdit::Append, &blocks)
        .await
        .unwrap();
    crate::edit_page_section_impl(&pool, &empty.id, &SectionEdit::Append, &blocks)
        .await
        .unwrap();
    assert_chunks_are_every_body(&pool).await;

    sqlx::query("UPDATE pages SET content = ? WHERE id = ?")
        .bind(long_body(50, "raw"))
        .bind(&page.id)
        .execute(&pool)
        .await
        .unwrap();
    assert_chunks_are_every_body(&pool).await;

    sqlx::query("UPDATE pages SET content = '{}' WHERE id = ?")
        .bind(&page.id)
        .execute(&pool)
        .await
        .unwrap();
    assert_chunks_are_every_body(&pool).await;

    synced_event(&pool, "v1", &"A long agenda line.\n".repeat(2_000)).await;
    synced_event(&pool, "v2", &"A changed agenda line.\n".repeat(2_000)).await;
    assert_chunks_are_every_body(&pool).await;

    crate::hard_delete_page_impl(&pool, &empty.id)
        .await
        .unwrap();
    let orphans: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM page_chunks WHERE page_id NOT IN (SELECT id FROM pages)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(orphans, 0);
}

#[tokio::test]
async fn a_one_block_edit_rewrites_one_chunk_under_its_id() {
    let pool = test_pool().await;
    let mut data = new_page("Long");
    data.content = long_body(300, "block");
    let page = crate::create_page_impl(&pool, data).await.unwrap();
    let before = stored_chunks(&pool, &page.id).await;

    let edited = long_body(300, "block").replace("block 150 ", "rewritten 150 ");
    sqlx::query("UPDATE pages SET content = ? WHERE id = ?")
        .bind(&edited)
        .bind(&page.id)
        .execute(&pool)
        .await
        .unwrap();
    let after = stored_chunks(&pool, &page.id).await;

    assert!(before.len() > 1);
    assert_eq!(after.len(), before.len());
    let changed: Vec<usize> = (0..after.len())
        .filter(|&i| after[i] != before[i])
        .collect();
    assert_eq!(changed.len(), 1);
    assert_eq!(after[changed[0]].0, before[changed[0]].0);
}

#[tokio::test]
async fn a_chunk_added_mid_page_leaves_the_place_of_every_other_chunk() {
    let pool = test_pool().await;
    let mut data = new_page("Long");
    data.content = long_body(300, "block");
    let page = crate::create_page_impl(&pool, data).await.unwrap();
    let ords = |pool: SqlitePool, id: String| async move {
        sqlx::query_as::<_, (String, i64)>(
            "SELECT chunk_id, ord FROM page_chunks WHERE page_id = ? ORDER BY ord",
        )
        .bind(id)
        .fetch_all(&pool)
        .await
        .unwrap()
    };
    let before = ords(pool.clone(), page.id.clone()).await;

    let grown = long_body(300, "block")
        .replace("block 20 ", &format!("block 20 {}", "typed ".repeat(4_000)));
    sqlx::query("UPDATE pages SET content = ? WHERE id = ?")
        .bind(&grown)
        .bind(&page.id)
        .execute(&pool)
        .await
        .unwrap();
    let after = ords(pool.clone(), page.id.clone()).await;

    assert_eq!(after.len(), before.len() + 1);
    let kept = after.iter().filter(|chunk| before.contains(chunk)).count();
    assert_eq!(kept, before.len(), "every chunk keeps its id and ord");
    assert_chunks_are_every_body(&pool).await;
}

#[test]
fn chunks_take_numbers_between_neighbours_until_a_gap_runs_out() {
    let chunk = |id: &str| Chunk {
        id: id.into(),
        body: "[]".into(),
    };
    let chunks = [chunk("a"), chunk("new"), chunk("b")];

    let roomy = place(&chunks, |id| match id {
        "a" => Some(10),
        "b" => Some(20),
        _ => None,
    });
    let full = place(&chunks, |id| match id {
        "a" => Some(10),
        "b" => Some(11),
        _ => None,
    });

    assert_eq!(roomy, [10, 15, 20]);
    assert_eq!(full, [ORD_SPACING, 2 * ORD_SPACING, 3 * ORD_SPACING]);
}

fn doc_of(blocks: &[String]) -> String {
    format!(r#"{{"type":"doc","content":[{}]}}"#, blocks.join(","))
}

/// One list or table block of `rows` rows, far past a chunk.
fn huge_list(rows: usize) -> String {
    let items: Vec<String> = (0..rows)
        .map(|i| {
            format!(
                r#"{{"type":"listItem","content":[{}]}}"#,
                para(&format!("item {i}"))
            )
        })
        .collect();
    format!(r#"{{"type":"bulletList","content":[{}]}}"#, items.join(","))
}

fn huge_table(rows: usize) -> String {
    let cell = |text: String| format!(r#"{{"type":"tableCell","content":[{}]}}"#, para(&text));
    let rows: Vec<String> = (0..rows)
        .map(|i| {
            let cells = [cell(format!("r{i} a")), cell(format!("r{i} b"))];
            format!(r#"{{"type":"tableRow","content":[{}]}}"#, cells.join(","))
        })
        .collect();
    format!(r#"{{"type":"table","content":[{}]}}"#, rows.join(","))
}

#[tokio::test]
async fn every_reader_returns_the_blocks_the_page_was_saved_with() {
    let pool = test_pool().await;
    let log: Vec<String> = (0..5_000).map(|i| para(&format!("12:{i:04} ok"))).collect();
    let bodies = [
        ("Prose", long_body(300, "prose")),
        ("Log", doc_of(&log)),
        (
            "List",
            doc_of(&[para("before"), huge_list(3_000), para("after")]),
        ),
        ("Table", doc_of(&[huge_table(2_000)])),
        (
            "Keys reordered",
            format!(r#"{{"content":[{}],"type":"doc"}}"#, para("one")),
        ),
        (
            "No type",
            format!(r#"{{"content":[{}]}}"#, para("appended")),
        ),
    ];

    for (title, stored) in bodies {
        let mut data = new_page(title);
        data.content = stored.clone();
        let page = crate::create_page_impl(&pool, data).await.unwrap();
        let read = crate::get_page(&pool, &page.id).await.unwrap().unwrap();
        let exported = crate::plan_markdown_page(&pool, &page.id)
            .await
            .unwrap()
            .unwrap();

        let stored_doc: serde_json::Value = serde_json::from_str(&stored).unwrap();
        let read_doc: serde_json::Value = serde_json::from_str(&read.content).unwrap();
        assert_eq!(read_doc["type"], "doc", "{title}");
        assert_eq!(read_doc["content"], stored_doc["content"], "{title}");
        let markdown = crate::markdown_body(&stored, &Default::default());
        assert!(exported.contents.ends_with(&markdown), "{title}'s export");
    }
}

#[tokio::test]
async fn a_page_with_no_blocks_reads_as_one_empty_paragraph() {
    let pool = test_pool().await;

    for stored in ["", "{}", r#"{"type":"doc","content":[]}"#] {
        let mut data = new_page("Empty");
        data.content = stored.to_string();
        let page = crate::create_page_impl(&pool, data).await.unwrap();

        assert_eq!(page.content, EMPTY_BODY, "stored as {stored:?}");
    }
}

#[tokio::test]
async fn a_body_typed_over_the_one_read_lands_as_typed() {
    let pool = test_pool().await;
    let mut data = new_page("Quick add");
    data.content = format!(r#"{{"content":[{}],"type":"doc"}}"#, para("one"));
    let page = crate::create_page_impl(&pool, data).await.unwrap();

    let typed = doc_of(&[para("one"), para("two")]);
    let saved = crate::update_page_impl(
        &pool,
        page.id.clone(),
        PageUpdate {
            content: Some(typed.clone()),
            base_content: Some(page.content),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    assert_eq!(
        saved.content, typed,
        "merged rather than written over its own base"
    );
}
