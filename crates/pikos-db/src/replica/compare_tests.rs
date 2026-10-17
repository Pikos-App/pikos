use pikos_replica::codec::FieldMap;
use pikos_replica::RecordName;
use sqlx::SqlitePool;

use super::{differences, Difference, Side};
use crate::replica::apply::apply;
use crate::replica::build::{build, pending, sent};
use crate::replica::start;
use crate::replica::state::synced_rows;
use crate::*;

async fn device() -> SqlitePool {
    let pool = test_pool().await;
    start(&pool).await.unwrap();
    pool
}

async fn send(from: &SqlitePool, to: &SqlitePool) {
    let names = pending(from, 100_000).await.unwrap();
    let built = build(from, &names).await.unwrap();
    let records: Vec<(RecordName, FieldMap)> = built
        .iter()
        .map(|b| (b.name.clone(), b.fields.clone()))
        .collect();
    apply(to, &records).await.unwrap();
    let acked: Vec<_> = built.iter().map(|b| (b.name.clone(), b.clock)).collect();
    sent(from, &acked).await.unwrap();
}

fn page(title: &str) -> NewPage {
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
        links: vec![],
        parent_id: None,
        last_opened_at: None,
        created_at: None,
        updated_at: None,
    }
}

async fn compare(first: &SqlitePool, second: &SqlitePool) -> Vec<Difference> {
    differences(
        synced_rows(first).await.unwrap(),
        synced_rows(second).await.unwrap(),
    )
}

#[tokio::test]
async fn devices_that_converged_have_no_differences() {
    let (mac, phone) = (device().await, device().await);
    create_page_impl(&mac, page("Groceries")).await.unwrap();
    send(&mac, &phone).await;

    assert_eq!(compare(&mac, &phone).await, vec![]);
}

#[tokio::test]
async fn an_edit_not_yet_carried_shows_as_its_field_and_a_page_not_yet_sent_as_one_side_only() {
    let (mac, phone) = (device().await, device().await);
    let shared = create_page_impl(&mac, page("Groceries")).await.unwrap();
    send(&mac, &phone).await;
    update_page_impl(
        &mac,
        shared.id.clone(),
        PageUpdate {
            title: Some("Groceries, Saturday".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let only_phone = create_page_impl(&phone, page("Laundry")).await.unwrap();

    let found = compare(&mac, &phone).await;

    let title_differs = found.iter().any(|d| {
        matches!(d, Difference::Field { record, field: "title", first, second }
            if *record == format!("page:{}", shared.id)
                && first == &["'Groceries, Saturday'".to_owned()]
                && second == &["'Groceries'".to_owned()])
    });
    assert!(title_differs, "{found:?}");
    let laundry_on_phone_only = found.contains(&Difference::OnlyIn {
        record: format!("page:{}", only_phone.id),
        side: Side::Second,
    });
    assert!(laundry_on_phone_only, "{found:?}");
}
