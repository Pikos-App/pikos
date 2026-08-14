//! Core-lifecycle conformance — the third shared table, over the page/folder/
//! reminder surface and, mostly, over search.
//!
//! Search is the reason this table exists. The writer matches through FTS5 —
//! tokens split on non-alphanumeric, implicit AND between them, a prefix `*` on the
//! last — while a mock has nothing to run a full-text index with. Whatever it does
//! instead is a guess, and every search assertion in the Playwright suite rests on
//! that guess being close enough. The rows below are the cases where a plausible
//! guess and the index disagree.

use serde::Deserialize;
use std::collections::HashMap;

use crate::folders::{create_folder_impl, soft_delete_folder_impl, NewFolder};
use crate::pages::{
    create_page_impl, delete_page_impl, list_pages_impl, restore_page_impl, set_pages_status_impl,
    soft_delete_page_impl, NewPage,
};
use crate::pool::test_pool;
use crate::reminders::{create_page_reminder, list_page_reminders};
use crate::search::search_pages_impl;

const TABLE: &str = include_str!("../tests/fixtures/core-lifecycle.json");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Table {
    scenarios: Vec<Scenario>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Scenario {
    name: String,
    steps: Vec<Step>,
    expect: Expect,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Step {
    #[serde(rename_all = "camelCase")]
    Page {
        id: String,
        title: String,
        content_text: Option<String>,
        tags: Option<Vec<String>>,
        folder: Option<String>,
    },
    Folder {
        id: String,
        name: String,
    },
    SoftDeletePage {
        page: String,
    },
    RestorePage {
        page: String,
    },
    SoftDeleteFolder {
        folder: String,
    },
    DeletePage {
        page: String,
    },
    #[serde(rename_all = "camelCase")]
    Reminder {
        page: String,
        minutes_before: i64,
    },
    SetStatus {
        pages: Vec<String>,
        status: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Expect {
    search: Option<SearchExpect>,
    list_query: Option<ListQueryExpect>,
    visible_pages: Option<Vec<String>>,
    reminder_count: Option<ReminderExpect>,
}

/// `PageFilter.query` — a plain LIKE over title and extracted text, and a separate
/// surface from `search_pages`. No production caller passes it today, which is
/// exactly why it drifts unnoticed.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListQueryExpect {
    query: String,
    matches: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchExpect {
    query: String,
    include_completed: Option<bool>,
    matches: Vec<String>,
    completed_count: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReminderExpect {
    page: String,
    count: usize,
}

#[tokio::test]
async fn writers_satisfy_the_core_lifecycle_table() {
    let table: Table = serde_json::from_str(TABLE).expect("core-lifecycle.json parses");
    assert!(!table.scenarios.is_empty());
    for scenario in &table.scenarios {
        run(scenario).await;
    }
}

async fn run(scenario: &Scenario) {
    let pool = test_pool().await;
    let mut ids = HashMap::new();
    for step in &scenario.steps {
        apply(&pool, &mut ids, step).await;
    }
    check(&pool, &ids, scenario).await;
}

/// The fixture names pages and folders; the writers mint the ids. Rewriting a row's
/// id after the fact trips the foreign keys the schema relies on, so the mapping is
/// kept here instead.
async fn apply(pool: &sqlx::SqlitePool, ids: &mut HashMap<String, String>, step: &Step) {
    match step {
        Step::Page {
            id,
            title,
            content_text,
            tags,
            folder,
        } => {
            let page = create_page_impl(
                pool,
                NewPage {
                    folder_id: folder.as_ref().map(|f| ids[f].clone()),
                    title: title.clone(),
                    subtitle: None,
                    content: "{}".into(),
                    content_text: content_text.clone(),
                    status: "not_started".into(),
                    priority: 0,
                    tags: tags.clone().unwrap_or_default(),
                    scheduled_start: None,
                    scheduled_end: None,
                    completed_at: None,
                    links: vec![],
                    parent_id: None,
                    last_opened_at: None,
                    created_at: None,
                    updated_at: None,
                },
            )
            .await
            .unwrap();
            ids.insert(id.clone(), page.id);
        }

        Step::Folder { id, name } => {
            let folder = create_folder_impl(
                pool,
                NewFolder {
                    name: name.clone(),
                    parent_id: None,
                    color: None,
                    icon: None,
                },
            )
            .await
            .unwrap();
            ids.insert(id.clone(), folder.id);
        }

        Step::SoftDeletePage { page } => soft_delete_page_impl(pool, &ids[page]).await.unwrap(),
        Step::RestorePage { page } => restore_page_impl(pool, &ids[page]).await.unwrap(),
        Step::SoftDeleteFolder { folder } => soft_delete_folder_impl(pool, ids[folder].clone())
            .await
            .unwrap(),
        Step::DeletePage { page } => delete_page_impl(pool, &ids[page]).await.unwrap(),

        Step::Reminder {
            page,
            minutes_before,
        } => {
            create_page_reminder(pool, &ids[page], *minutes_before)
                .await
                .unwrap();
        }

        Step::SetStatus { pages, status } => {
            let real: Vec<String> = pages.iter().map(|p| ids[p].clone()).collect();
            set_pages_status_impl(pool, &real, status, Some(&crate::now_local_iso()))
                .await
                .unwrap();
        }
    }
}

async fn check(pool: &sqlx::SqlitePool, ids: &HashMap<String, String>, scenario: &Scenario) {
    let at = &scenario.name;
    let named = |real: &str| {
        ids.iter()
            .find(|(_, v)| v.as_str() == real)
            .map(|(k, _)| k.clone())
            .unwrap_or_else(|| real.to_string())
    };

    if let Some(want) = &scenario.expect.search {
        let res = search_pages_impl(pool, want.query.clone(), want.include_completed)
            .await
            .unwrap();
        let mut got: Vec<String> = res.results.iter().map(|r| named(&r.id)).collect();
        got.sort();
        let mut expected = want.matches.clone();
        expected.sort();
        assert_eq!(got, expected, "{at}: search hits for {:?}", want.query);
        if let Some(count) = want.completed_count {
            assert_eq!(res.completed_count, count, "{at}: completed count");
        }
    }

    if let Some(want) = &scenario.expect.list_query {
        let filter = crate::pages::PageFilter {
            query: Some(want.query.clone()),
            ..Default::default()
        };
        let mut got: Vec<String> = list_pages_impl(pool, Some(filter))
            .await
            .unwrap()
            .iter()
            .map(|p| named(&p.id))
            .collect();
        got.sort();
        let mut expected = want.matches.clone();
        expected.sort();
        assert_eq!(got, expected, "{at}: list filter for {:?}", want.query);
    }

    if let Some(want) = &scenario.expect.visible_pages {
        let mut got: Vec<String> = list_pages_impl(pool, None)
            .await
            .unwrap()
            .iter()
            .map(|p| named(&p.id))
            .collect();
        got.sort();
        let mut expected = want.clone();
        expected.sort();
        assert_eq!(got, expected, "{at}: pages in the list");
    }

    if let Some(want) = &scenario.expect.reminder_count {
        let got = list_page_reminders(pool, &ids[&want.page]).await.unwrap();
        assert_eq!(got.len(), want.count, "{at}: reminders on {}", want.page);
    }
}
