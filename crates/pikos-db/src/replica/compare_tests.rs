use sqlx::SqlitePool;

use super::{differences, Difference, Side};
use crate::replica::state::synced_rows;
use crate::replica::two_devices::{device, new_page, send};
use crate::*;

async fn compare(first: &SqlitePool, second: &SqlitePool) -> Vec<Difference> {
    differences(
        synced_rows(first).await.unwrap(),
        synced_rows(second).await.unwrap(),
    )
}

#[tokio::test]
async fn devices_that_converged_have_no_differences() {
    let (mac, phone) = (device().await, device().await);
    create_page_impl(&mac, new_page("Groceries")).await.unwrap();
    send(&mac, &phone).await;

    assert_eq!(compare(&mac, &phone).await, vec![]);
}

#[tokio::test]
async fn an_edit_not_yet_carried_shows_as_its_field_and_a_page_not_yet_sent_as_one_side_only() {
    let (mac, phone) = (device().await, device().await);
    let shared = create_page_impl(&mac, new_page("Groceries")).await.unwrap();
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
    let only_phone = create_page_impl(&phone, new_page("Laundry")).await.unwrap();

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
