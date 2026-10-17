use std::sync::Arc;

use super::{JoinPlan, SentRecord, SyncRecord, SyncValue};
use crate::workspace::{NewPage, Workspace};

/// A workspace in its own temporary file, removed when dropped.
struct Temp {
    path: String,
    workspace: Arc<Workspace>,
}

impl Temp {
    async fn new(label: &str) -> Temp {
        let path = std::env::temp_dir()
            .join(format!(
                "pikos-ffi-replica-{label}-{}-{:?}.db",
                std::process::id(),
                std::time::SystemTime::now()
            ))
            .to_string_lossy()
            .replace([' ', ':', '{', '}', ','], "");
        let workspace = Workspace::open(path.clone()).await.unwrap();
        Temp { path, workspace }
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", self.path));
        }
    }
}

fn page(title: &str) -> NewPage {
    NewPage {
        title: title.to_string(),
        subtitle: None,
        folder_id: None,
        content: None,
        tags: Some(vec!["errands".to_string()]),
        scheduled_start: None,
        scheduled_end: None,
    }
}

/// One send from `from` to `to`, as the CloudKit adapter makes it.
async fn send(from: &Workspace, to: &Workspace) {
    let names = from.pending_records(1_000).await.unwrap();
    let built = from.build_records(names).await.unwrap();
    let records: Vec<SyncRecord> = built.iter().map(|b| b.record.clone()).collect();
    to.apply_records(records).await.unwrap();
    let sent = built
        .iter()
        .map(|b| SentRecord {
            name: b.record.name.clone(),
            built_at: b.built_at.clone(),
        })
        .collect();
    assert!(from.records_sent(sent).await.unwrap().is_empty());
}

#[tokio::test]
async fn a_page_made_on_the_phone_reaches_the_mac_through_the_bridge() {
    let (phone, mac) = (Temp::new("phone").await, Temp::new("mac").await);
    let started = phone.workspace.start_sync().await.unwrap();
    mac.workspace.start_sync().await.unwrap();
    let made = phone
        .workspace
        .create_page(page("Groceries"))
        .await
        .unwrap();

    send(&phone.workspace, &mac.workspace).await;

    let arrived = mac.workspace.get_page(made.id.clone()).await.unwrap();
    assert_eq!(arrived.title, "Groceries");
    assert_eq!(arrived.tags, vec!["errands"]);
    assert!(started.zone.starts_with("ws-"));
    assert!(started.device_id.is_some());
}

#[tokio::test]
async fn records_cross_as_plain_fields_without_nulls() {
    let phone = Temp::new("fields").await;
    phone.workspace.start_sync().await.unwrap();
    let made = phone
        .workspace
        .create_page(page("Groceries"))
        .await
        .unwrap();

    let built = phone
        .workspace
        .build_records(vec![format!("page:{}", made.id)])
        .await
        .unwrap();

    let fields = &built[0].record.fields;
    assert_eq!(
        fields.get("title.0"),
        Some(&SyncValue::Text {
            value: "Groceries".to_string()
        })
    );
    assert!(
        !fields.contains_key("subtitle.0"),
        "a NULL column is left out"
    );
}

#[tokio::test]
async fn a_bad_record_name_is_refused_rather_than_applied() {
    let mac = Temp::new("bad").await;
    mac.workspace.start_sync().await.unwrap();

    let result = mac
        .workspace
        .apply_records(vec![SyncRecord {
            name: "nonsense".to_string(),
            fields: Default::default(),
        }])
        .await;

    assert!(result.is_err());
}

#[tokio::test]
async fn a_fresh_workspace_takes_the_accounts_and_a_copied_one_gets_a_new_device_id() {
    let phone = Temp::new("join").await;
    phone.workspace.record_first_run_seed().await.unwrap();
    let started = phone.workspace.start_sync().await.unwrap();

    assert_eq!(
        phone.workspace.plan_join().await.unwrap(),
        JoinPlan::Replace
    );
    assert_eq!(
        phone
            .workspace
            .claim_device(started.device_id.clone())
            .await
            .unwrap(),
        started.device_id
    );
    assert_ne!(
        phone.workspace.claim_device(None).await.unwrap(),
        started.device_id
    );
}
