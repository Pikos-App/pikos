use std::path::PathBuf;

use pikos_replica::codec::FILE;
use pikos_replica::merge::Value;
use pikos_replica::{Entity, RecordName};
use sqlx::SqlitePool;

use super::set_assets_dir;
use crate::replica::build::{build, pending};
use crate::replica::two_devices::*;
use crate::*;

fn images_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pkos_sync_images_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn with_images() -> (SqlitePool, PathBuf) {
    let pool = device().await;
    let dir = images_dir();
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

// qa: CLOUD-134
#[tokio::test]
async fn a_photo_landing_after_its_page_counts_as_a_change_so_an_open_page_redraws() {
    let (phone, phone_images) = with_images().await;
    let (mac, mac_images) = with_images().await;
    let name = saved_image(&phone_images, b"a photo of the tram");
    page_showing(&phone, "Lisbon", &name).await;

    send(&phone, &mac).await;
    let before = mac_images.join(&name).exists();
    let landed = send(&phone, &mac).await;

    assert!(!before);
    assert_eq!(landed.changed, 1);
    assert_eq!(
        std::fs::read(mac_images.join(&name)).unwrap(),
        b"a photo of the tram"
    );
}

// qa: CLOUD-128
#[tokio::test]
async fn turning_sync_on_over_pages_that_already_show_photos_sends_every_photo() {
    let mac = test_pool().await;
    let mac_images = images_dir();
    set_assets_dir(&mac, &mac_images).await.unwrap();
    let harbour = saved_image(&mac_images, b"harbour");
    let tram = saved_image(&mac_images, b"tram");
    page_showing(&mac, "Harbour", &harbour).await;
    page_showing(&mac, "Tram", &tram).await;
    let (phone, phone_images) = with_images().await;

    crate::replica::start(&mac).await.unwrap();
    converge(&mac, &phone).await;

    assert_eq!(
        std::fs::read(phone_images.join(&harbour)).unwrap(),
        b"harbour"
    );
    assert_eq!(std::fs::read(phone_images.join(&tram)).unwrap(), b"tram");
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

fn image_record(
    name: &str,
    download: &std::path::Path,
) -> (RecordName, pikos_replica::codec::FieldMap) {
    let record_name = RecordName::live(Entity::Asset, name.to_owned());
    let mut fields = pikos_replica::codec::encode(
        &pikos_replica::codec::Record {
            name: record_name.clone(),
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
        Value::Text(download.to_string_lossy().into_owned()),
    );
    (record_name, fields)
}

#[tokio::test]
async fn an_image_arriving_before_its_folder_is_set_fails_the_apply_so_it_is_fetched_again() {
    let phone = device().await;
    let download = std::env::temp_dir().join(format!("pkos_download_{}", uuid::Uuid::new_v4()));
    std::fs::write(&download, b"photo").unwrap();
    let name = format!("{}.png", uuid::Uuid::new_v4());

    let applied = crate::replica::apply::apply(&phone, &[image_record(&name, &download)]).await;

    assert!(applied.is_err());
}

#[tokio::test]
async fn an_image_whose_download_is_gone_is_dropped_and_the_rest_still_apply() {
    let (mac, _) = with_images().await;
    let (phone, phone_images) = with_images().await;
    let id = page_showing(&mac, "Harbour", &format!("{}.png", uuid::Uuid::new_v4())).await;
    let names = pending(&mac, 1_000).await.unwrap();
    let mut records: Vec<_> = build(&mac, &names)
        .await
        .unwrap()
        .into_iter()
        .map(|b| (b.name, b.fields))
        .collect();
    let gone = format!("{}.png", uuid::Uuid::new_v4());
    records.push(image_record(
        &gone,
        &std::env::temp_dir().join("pkos_no_such_download"),
    ));

    crate::replica::apply::apply(&phone, &records)
        .await
        .unwrap();

    assert!(get_page(&phone, &id).await.unwrap().is_some());
    assert!(!phone_images.join(&gone).exists());
}

#[tokio::test]
async fn an_image_that_cannot_be_written_waits_and_the_rest_of_its_batch_still_applies() {
    use std::os::unix::fs::PermissionsExt;

    let (mac, _) = with_images().await;
    let (phone, phone_images) = with_images().await;
    let name = format!("{}.png", uuid::Uuid::new_v4());
    let id = page_showing(&mac, "Harbour", &name).await;
    let names = pending(&mac, 1_000).await.unwrap();
    let mut records: Vec<_> = build(&mac, &names)
        .await
        .unwrap()
        .into_iter()
        .map(|b| (b.name, b.fields))
        .collect();
    let download = std::env::temp_dir().join(format!("pkos_download_{}", uuid::Uuid::new_v4()));
    std::fs::write(&download, b"photo").unwrap();
    let image = image_record(&name, &download);
    records.push(image.clone());
    let set_mode = |mode| {
        std::fs::set_permissions(&phone_images, std::fs::Permissions::from_mode(mode)).unwrap()
    };

    set_mode(0o555);
    let applied = crate::replica::apply::apply(&phone, &records).await;
    set_mode(0o755);

    assert_eq!(applied.unwrap().held, 1);
    assert!(get_page(&phone, &id).await.unwrap().is_some());
    let reason: String = sqlx::query_scalar("SELECT reason FROM replica_pen WHERE name = ?")
        .bind(image.0.to_string())
        .fetch_one(&phone)
        .await
        .unwrap();
    assert_eq!(reason, "failed");

    crate::replica::apply::retry_held(&phone).await.unwrap();

    assert_eq!(std::fs::read(phone_images.join(&name)).unwrap(), b"photo");
}

#[tokio::test]
async fn a_restore_queues_again_the_images_its_backup_had_only_queued() {
    let (mac, mac_images) = with_images().await;
    let name = saved_image(&mac_images, b"queued, never sent");
    page_showing(&mac, "Draft", &name).await;
    build(&mac, &pending(&mac, 1_000).await.unwrap())
        .await
        .unwrap();
    assert_eq!(images_pending(&mac).await, vec![name.clone()]);

    let displaced = crate::replica::before_restore(&mac).await.unwrap().unwrap();
    crate::replica::after_restore(&mac, displaced)
        .await
        .unwrap();
    build(&mac, &pending(&mac, 100_000).await.unwrap())
        .await
        .unwrap();

    assert_eq!(images_pending(&mac).await, vec![name]);
}
