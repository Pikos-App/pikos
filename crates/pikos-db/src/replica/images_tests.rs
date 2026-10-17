use std::path::PathBuf;

use pikos_replica::codec::FILE;
use pikos_replica::merge::Value;
use pikos_replica::{Entity, RecordName};
use sqlx::SqlitePool;

use super::set_assets_dir;
use crate::replica::build::{build, pending};
use crate::replica::two_devices::*;
use crate::*;

async fn with_images() -> (SqlitePool, PathBuf) {
    let pool = device().await;
    let dir = std::env::temp_dir().join(format!("pkos_sync_images_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    set_assets_dir(&pool, &dir).await.unwrap();
    (pool, dir)
}

fn saved_image(dir: &std::path::Path, bytes: &[u8]) -> String {
    let name = format!("{}.png", uuid::Uuid::new_v4());
    std::fs::write(dir.join(&name), bytes).unwrap();
    name
}

fn showing(name: &str) -> String {
    serde_json::json!({
        "type": "doc",
        "content": [{ "type": "image", "attrs": { "src": format!("assets/{name}") } }]
    })
    .to_string()
}

async fn page_showing(pool: &SqlitePool, title: &str, name: &str) -> String {
    let mut page = new_page(title);
    page.content = showing(name);
    create_page_impl(pool, page).await.unwrap().id
}

async fn images_pending(pool: &SqlitePool) -> Vec<String> {
    pending(pool, 1_000)
        .await
        .unwrap()
        .into_iter()
        .filter(|name| name.entity == Entity::Asset)
        .map(|name| name.key)
        .collect()
}

// qa: CLOUD-126:2
#[tokio::test]
async fn an_image_a_page_shows_reaches_the_other_device_with_the_page() {
    let (mac, mac_images) = with_images().await;
    let (phone, phone_images) = with_images().await;
    let name = saved_image(&mac_images, b"a photo of the harbour");
    page_showing(&mac, "Lisbon", &name).await;

    converge(&mac, &phone).await;

    assert_eq!(
        std::fs::read(phone_images.join(&name)).unwrap(),
        b"a photo of the harbour"
    );
}

#[tokio::test]
async fn an_image_is_sent_once_and_never_back() {
    let (mac, mac_images) = with_images().await;
    let (phone, _) = with_images().await;
    let name = saved_image(&mac_images, b"one");
    let first = page_showing(&mac, "First", &name).await;
    converge(&mac, &phone).await;

    let mut again = new_page("Second");
    again.content = showing(&name);
    create_page_impl(&mac, again).await.unwrap();
    update_page_impl(
        &phone,
        first.clone(),
        PageUpdate {
            title: Some("First, renamed".into()),
            content: Some(showing(&name)),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    build(&mac, &pending(&mac, 1_000).await.unwrap())
        .await
        .unwrap();
    build(&phone, &pending(&phone, 1_000).await.unwrap())
        .await
        .unwrap();

    assert!(images_pending(&mac).await.is_empty());
    assert!(images_pending(&phone).await.is_empty());
}

#[tokio::test]
async fn an_image_deleted_before_it_was_sent_is_dropped_rather_than_retried() {
    let (mac, mac_images) = with_images().await;
    let name = saved_image(&mac_images, b"gone soon");
    page_showing(&mac, "Draft", &name).await;
    build(&mac, &pending(&mac, 1_000).await.unwrap())
        .await
        .unwrap();
    assert_eq!(images_pending(&mac).await, vec![name.clone()]);

    std::fs::remove_file(mac_images.join(&name)).unwrap();
    let names = pending(&mac, 1_000).await.unwrap();
    let built = build(&mac, &names).await.unwrap();

    assert!(built.iter().all(|b| b.name.entity != Entity::Asset));
    assert!(images_pending(&mac).await.is_empty());
}

#[tokio::test]
async fn an_image_record_whose_name_is_not_one_pikos_makes_writes_nothing() {
    let (phone, phone_images) = with_images().await;
    let outside = std::env::temp_dir().join(format!("pkos_outside_{}", uuid::Uuid::new_v4()));
    std::fs::write(&outside, b"anything").unwrap();
    let escape = format!("../{}.png", uuid::Uuid::new_v4());
    let mut fields = pikos_replica::codec::encode(
        &pikos_replica::codec::Record {
            name: RecordName::live(Entity::Asset, escape.clone()),
            row: pikos_replica::merge::RowState {
                born: pikos_replica::Hlc::new(1, 0),
                fields: vec![],
                tomb: None,
            },
        },
        &[],
    );
    fields.insert(
        FILE.into(),
        Value::Text(outside.to_string_lossy().into_owned()),
    );

    let applied = crate::replica::apply::apply(
        &phone,
        &[(RecordName::live(Entity::Asset, escape.clone()), fields)],
    )
    .await
    .unwrap();

    assert_eq!(applied.changed, 0);
    assert!(!phone_images.join(&escape).exists());
}

#[tokio::test]
async fn a_device_that_moves_into_another_zone_sends_its_images_again() {
    let (mac, mac_images) = with_images().await;
    let name = saved_image(&mac_images, b"moving");
    page_showing(&mac, "Moving", &name).await;
    let names = pending(&mac, 1_000).await.unwrap();
    let built = build(&mac, &names).await.unwrap();
    crate::replica::build::sent(
        &mac,
        &built
            .iter()
            .map(|b| (b.name.clone(), b.clock))
            .collect::<Vec<_>>(),
    )
    .await
    .unwrap();
    let names = pending(&mac, 1_000).await.unwrap();
    let built = build(&mac, &names).await.unwrap();
    crate::replica::build::sent(
        &mac,
        &built
            .iter()
            .map(|b| (b.name.clone(), b.clock))
            .collect::<Vec<_>>(),
    )
    .await
    .unwrap();
    assert!(images_pending(&mac).await.is_empty());

    crate::replica::adopt_workspace_id(&mac, "00000000-0000-4000-8000-000000000000")
        .await
        .unwrap();
    build(&mac, &pending(&mac, 100_000).await.unwrap())
        .await
        .unwrap();

    assert_eq!(images_pending(&mac).await, vec![name]);
}
