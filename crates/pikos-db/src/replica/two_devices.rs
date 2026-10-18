//! Two devices for tests: workspaces with sync started, and a transport that carries one's pending
//! records to the other.

use std::collections::BTreeMap;

use pikos_replica::codec::FieldMap;
use pikos_replica::RecordName;
use sqlx::SqlitePool;

use super::apply::{apply, Applied};
use super::build::{build, pending, sent};
use super::{start, state};
use crate::*;

pub async fn device() -> SqlitePool {
    let pool = test_pool().await;
    start(&pool).await.unwrap();
    pool
}

/// What a transport carries from `from` to `to` in one round: every pending record, applied in
/// one batch, then reported sent.
pub async fn send(from: &SqlitePool, to: &SqlitePool) -> Applied {
    let names = pending(from, 100_000).await.unwrap();
    let built = build(from, &names).await.unwrap();
    let records: Vec<(RecordName, FieldMap)> = built
        .iter()
        .map(|b| (b.name.clone(), b.fields.clone()))
        .collect();
    let applied = apply(to, &records).await.unwrap();
    let acked: Vec<_> = built.iter().map(|b| (b.name.clone(), b.clock)).collect();
    sent(from, &acked).await.unwrap();
    applied
}

pub async fn converge(a: &SqlitePool, b: &SqlitePool) {
    for _ in 0..3 {
        send(a, b).await;
        send(b, a).await;
    }
}

/// Every synced row's values, by record name.
pub async fn synced(pool: &SqlitePool) -> BTreeMap<String, Vec<Vec<String>>> {
    state::synced_rows(pool)
        .await
        .unwrap()
        .into_iter()
        .map(|row| (row.name.to_string(), row.fields))
        .collect()
}

pub async fn assert_converged(a: &SqlitePool, b: &SqlitePool) {
    assert_eq!(synced(a).await, synced(b).await);
}

pub async fn text(pool: &SqlitePool, sql: &str) -> Option<String> {
    sqlx::query_scalar(sql)
        .fetch_optional(pool)
        .await
        .unwrap()
        .flatten()
}

pub fn new_page(title: &str) -> NewPage {
    NewPage {
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
        parent_id: None,
        last_opened_at: None,
        created_at: None,
        updated_at: None,
    }
}

/// Sets a calendar page's link state, as the reconciler does when it detaches or re-links.
pub async fn link_state(pool: &SqlitePool, page: &str, state: &str) {
    sqlx::query("UPDATE page_sync SET sync_state = ? WHERE page_id = ?")
        .bind(state)
        .bind(page)
        .execute(pool)
        .await
        .unwrap();
}

/// A page's reminder leads, in minutes, smallest first.
pub async fn leads(pool: &SqlitePool, page: &str) -> Vec<i64> {
    sqlx::query_scalar(
        "SELECT minutes_before FROM page_reminders WHERE page_id = ? ORDER BY minutes_before",
    )
    .bind(page)
    .fetch_all(pool)
    .await
    .unwrap()
}
