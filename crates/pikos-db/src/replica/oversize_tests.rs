use pikos_replica::codec::FILE;
use pikos_replica::merge::Value;
use pikos_replica::Entity;

use super::INLINE_MAX;
use crate::replica::build::{build, pending, sent};
use crate::replica::two_devices::*;
use crate::*;

fn long_body() -> String {
    let words = "a long page of prose ".repeat(INLINE_MAX / 20 + 1);
    serde_json::json!({
        "type": "doc",
        "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": words }] }]
    })
    .to_string()
}

// qa: CLOUD-129
#[tokio::test]
async fn a_body_too_big_for_a_record_reaches_the_other_device_whole() {
    let (mac, phone) = (device().await, device().await);
    let mut page = new_page("Novel");
    page.content = long_body();
    let id = create_page_impl(&mac, page).await.unwrap().id;

    converge(&mac, &phone).await;

    assert_eq!(
        get_page(&phone, &id).await.unwrap().unwrap().content,
        long_body()
    );
}

#[tokio::test]
async fn a_body_too_big_for_a_record_is_sent_as_a_file_and_the_file_goes_once_sent() {
    let mac = device().await;
    let mut page = new_page("Novel");
    page.content = long_body();
    create_page_impl(&mac, page).await.unwrap();

    let names = pending(&mac, 100).await.unwrap();
    let built = build(&mac, &names).await.unwrap();
    let body = built
        .iter()
        .find(|b| b.name.entity == Entity::Body)
        .unwrap();
    let Some(Value::Text(file)) = body.fields.get(FILE) else {
        panic!("no file on the body record");
    };
    let file = std::path::PathBuf::from(file);
    assert!(!body.fields.contains_key("content_0"));
    assert!(file.is_file());

    sent(&mac, &[(body.name.clone(), body.clock)])
        .await
        .unwrap();

    assert!(!file.exists());
}

#[tokio::test]
async fn a_body_whose_file_is_gone_fails_the_apply_rather_than_emptying_the_page() {
    let (mac, phone) = (device().await, device().await);
    let mut page = new_page("Novel");
    page.content = long_body();
    create_page_impl(&mac, page).await.unwrap();
    let names = pending(&mac, 100).await.unwrap();
    let mut records: Vec<_> = build(&mac, &names)
        .await
        .unwrap()
        .into_iter()
        .map(|b| (b.name, b.fields))
        .collect();
    for (name, fields) in &mut records {
        if name.entity == Entity::Body {
            fields.insert(FILE.into(), Value::Text("/nonexistent/pikos-body".into()));
        }
    }

    let applied = crate::replica::apply::apply(&phone, &records).await;

    assert!(applied.is_err());
}
