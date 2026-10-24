use super::*;
use serde_json::Value;

const EXPORT_TABLE: &str = include_str!("../../pikos-db/tests/fixtures/markdown-export.json");
const TEXT_TABLE: &str = include_str!("../../pikos-db/tests/fixtures/content-text-projection.json");

fn para(text: &str) -> String {
    format!(r#"{{"type":"paragraph","content":[{{"type":"text","text":"{text}"}}]}}"#)
}

fn body(blocks: &[String]) -> String {
    format!(r#"{{"type":"doc","content":[{}]}}"#, blocks.join(","))
}

/// About a kilobyte each, so a page of `n` holds roughly `n` KB.
fn long_page(n: usize) -> Vec<String> {
    (0..n)
        .map(|i| para(&format!("block {i} {}", "word ".repeat(200))))
        .collect()
}

fn huge_list() -> String {
    let items: Vec<String> = (0..5_000)
        .map(|i| {
            format!(
                r#"{{"type":"listItem","content":[{}]}}"#,
                para(&format!("item {i}"))
            )
        })
        .collect();
    format!(r#"{{"type":"bulletList","content":[{}]}}"#, items.join(","))
}

fn huge_table() -> String {
    let rows: Vec<String> = (0..2_000)
        .map(|r| {
            let cells: Vec<String> = (0..4)
                .map(|c| {
                    format!(
                        r#"{{"type":"tableCell","content":[{}]}}"#,
                        para(&format!("r{r}c{c}"))
                    )
                })
                .collect();
            format!(r#"{{"type":"tableRow","content":[{}]}}"#, cells.join(","))
        })
        .collect();
    format!(r#"{{"type":"table","content":[{}]}}"#, rows.join(","))
}

fn fixture_docs(table: &str) -> Vec<String> {
    let table: Value = serde_json::from_str(table).unwrap();
    table["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|case| case.get("doc"))
        .map(Value::to_string)
        .collect()
}

fn parsed(json: &str) -> Value {
    serde_json::from_str(json).unwrap()
}

fn joined(chunks: &[Chunk]) -> String {
    join_chunks(chunks.iter().map(|chunk| chunk.body.as_str()))
}

#[test]
fn every_body_shape_round_trips_through_its_chunks() {
    let mut bodies = fixture_docs(EXPORT_TABLE);
    bodies.extend(fixture_docs(TEXT_TABLE));
    bodies.push(body(&long_page(300)));
    bodies.push(body(&[para("before"), huge_list(), para("after")]));
    bodies.push(body(&[para("before"), huge_table(), para("after")]));
    let imported = crate::markdown_import::markdown_to_prosemirror(&"A line.\n\n".repeat(20_000));
    bodies.push(imported.unwrap().to_string());

    for content in &bodies {
        let chunks = chunk_body(content, &[]);

        let has_blocks = parsed(content).get("content").is_some();
        if !has_blocks {
            assert!(chunks.is_empty());
            continue;
        }
        assert_eq!(
            parsed(&joined(&chunks)),
            parsed(content),
            "{}",
            &content[..content.len().min(120)]
        );
    }
}

#[test]
fn chunks_join_back_to_the_stored_bytes_of_every_block() {
    let blocks = long_page(100);
    let content = body(&blocks);

    let chunks = chunk_body(&content, &[]);

    assert_eq!(joined(&chunks), content);
}

#[test]
fn chunks_are_whole_blocks_between_the_limits() {
    let chunks = chunk_body(&body(&long_page(300)), &[]);

    assert!(chunks.len() > 1);
    for chunk in &chunks[..chunks.len() - 1] {
        assert!(chunk.body.len() >= CHUNK_MIN_BYTES, "{}", chunk.body.len());
    }
    for chunk in &chunks {
        assert!(chunk.body.len() <= CHUNK_MAX_BYTES, "{}", chunk.body.len());
    }
}

#[test]
fn a_huge_list_or_table_is_never_split() {
    for block in [huge_list(), huge_table()] {
        let content = body(&[para("before"), block.clone(), para("after")]);

        let chunks = chunk_body(&content, &[]);

        assert!(block.len() > CHUNK_MAX_BYTES);
        assert!(
            chunks.iter().any(|chunk| chunk.body.contains(&block)),
            "the whole block sits in one chunk"
        );
    }
}

#[test]
fn an_edit_to_one_block_keeps_every_other_chunk() {
    let mut blocks = long_page(300);
    let before = chunk_body(&body(&blocks), &[]);

    for at in [0, 150, 299] {
        let mut edited = blocks.clone();
        edited[at] = para(&format!("rewritten block {at}"));

        let after = chunk_body(&body(&edited), &before);

        assert_eq!(after.len(), before.len());
        let changed: Vec<usize> = (0..after.len())
            .filter(|&i| after[i] != before[i])
            .collect();
        assert_eq!(changed.len(), 1, "block {at}");
        let i = changed[0];
        assert_eq!(after[i].id, before[i].id, "the edited chunk keeps its id");
        assert!(after[i].body.contains(&format!("rewritten block {at}")));
        assert_eq!(parsed(&joined(&after)), parsed(&body(&edited)));
    }

    blocks.insert(150, para("a new block"));
    let after = chunk_body(&body(&blocks), &before);
    let unchanged = after.iter().filter(|chunk| before.contains(chunk)).count();
    assert_eq!(
        unchanged,
        before.len() - 1,
        "an insert rewrites one chunk too"
    );
}

#[test]
fn a_chunk_that_outgrows_the_limit_splits_under_its_old_id_and_a_new_one() {
    let mut blocks = long_page(300);
    let before = chunk_body(&body(&blocks), &[]);

    let middle = array_items(&before[0].body).len() / 2;
    for i in 0..40 {
        blocks.insert(middle, para(&format!("typed {i} {}", "more ".repeat(100))));
    }
    let after = chunk_body(&body(&blocks), &before);

    assert_eq!(after.len(), before.len() + 1);
    assert_eq!(after[0].id, before[0].id);
    assert!(!before.iter().any(|chunk| chunk.id == after[1].id));
    assert_eq!(after[2..], before[1..]);
    assert_eq!(parsed(&joined(&after)), parsed(&body(&blocks)));
}

#[test]
fn blocks_added_between_chunks_join_the_chunk_before_them() {
    let mut blocks = long_page(300);
    let before = chunk_body(&body(&blocks), &[]);
    let boundary = array_items(&before[0].body).len();

    blocks.insert(boundary, para("at the boundary"));
    let after = chunk_body(&body(&blocks), &before);

    assert_eq!(after.len(), before.len());
    assert_eq!(after[0].id, before[0].id);
    assert!(after[0].body.contains("at the boundary"));
    assert_eq!(after[1..], before[1..]);
}

#[test]
fn appending_grows_the_last_chunk_instead_of_adding_one_per_block() {
    let mut blocks = long_page(40);
    let mut chunks = chunk_body(&body(&blocks), &[]);
    let before = chunks.len();

    for i in 0..5 {
        blocks.push(para(&format!("appended {i}")));
        chunks = chunk_body(&body(&blocks), &chunks);
    }

    assert_eq!(chunks.len(), before);
    assert_eq!(parsed(&joined(&chunks)), parsed(&body(&blocks)));
}

#[test]
fn deleting_a_chunks_blocks_drops_only_that_chunk() {
    let blocks = long_page(300);
    let before = chunk_body(&body(&blocks), &[]);
    let first = array_items(&before[0].body).len();
    let second = array_items(&before[1].body).len();

    let mut remaining = blocks.clone();
    remaining.drain(first..first + second);
    let after = chunk_body(&body(&remaining), &before);

    let mut expected = before.clone();
    expected.remove(1);
    assert_eq!(after, expected);
}

#[test]
fn the_same_body_chunks_to_the_same_ids() {
    let content = body(&long_page(100));

    assert_eq!(chunk_body(&content, &[]), chunk_body(&content, &[]));
}

#[test]
fn identical_chunks_get_ids_of_their_own() {
    let block = para(&"same ".repeat(4_000));
    let content = body(&[block.clone(), block.clone(), block]);

    let chunks = chunk_body(&content, &[]);

    let ids: HashSet<&str> = chunks.iter().map(|chunk| chunk.id.as_str()).collect();
    assert_eq!(ids.len(), 3);
}

#[test]
fn a_body_that_is_not_a_document_has_no_chunks() {
    for content in ["", "{}", r#"{"type":"doc","content":[]}"#, "not json"] {
        assert!(chunk_body(content, &[]).is_empty(), "{content:?}");
    }
}

#[test]
fn an_emptied_page_drops_every_chunk() {
    let before = chunk_body(&body(&long_page(100)), &[]);

    assert!(chunk_body(r#"{"type":"doc","content":[]}"#, &before).is_empty());
}

#[test]
fn a_body_holds_its_chunks_blocks_whatever_the_order_of_its_keys() {
    let blocks = long_page(100);
    let chunks = chunk_body(&body(&blocks), &[]);
    let reordered: Vec<String> = blocks
        .iter()
        .map(|block| parsed(block).to_string())
        .collect();
    assert_ne!(reordered, blocks);

    assert!(has_blocks_of(&body(&reordered), &chunks));
}

#[test]
fn a_body_with_one_block_changed_added_or_gone_does_not_hold_the_chunks() {
    let blocks = long_page(100);
    let chunks = chunk_body(&body(&blocks), &[]);
    let mut changed = blocks.clone();
    changed[50] = para("typed");
    let mut added = blocks.clone();
    added.push(para("typed"));

    for content in [body(&changed), body(&added), body(&blocks[1..])] {
        assert!(!has_blocks_of(&content, &chunks));
    }
}

#[test]
fn a_body_rejoins_as_its_blocks_alone_the_way_its_chunks_join() {
    let blocks = long_page(100);
    let wrapped = format!(
        r#"{{"content":[{}],"type":"doc","attrs":{{}}}}"#,
        blocks.join(",")
    );

    assert_eq!(rejoined(&wrapped), Some(joined(&chunk_body(&wrapped, &[]))));
    assert_eq!(rejoined(r#"{"type":"doc","content":[]}"#), None);
}
