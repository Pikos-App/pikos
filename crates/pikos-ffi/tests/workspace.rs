//! Tests for the workspace binding.
//!
//! `pikos-db` already tests the storage behaviour underneath; these cover the
//! translation layer, which is where this crate can be wrong: the tri-state
//! folder fields that become enums, the not-found case that becomes a distinct
//! error, and the read-only handle that must actually be read-only.

use pikos_ffi::workspace::{
    FolderAssignment, FolderScope, NewPage, PageEdit, PageQuery, ReadOnlyWorkspace, Workspace,
    WorkspaceError,
};

/// A workspace in a fresh temporary file.
///
/// A file rather than `:memory:` because the read-only handle opens the same
/// path a second time, which an in-memory database cannot express — and
/// because that second open is the thing being tested.
struct TempWorkspace {
    path: String,
}

impl TempWorkspace {
    fn new() -> Self {
        let path = std::env::temp_dir()
            .join(format!("pikos-ffi-{}.db", unique_suffix()))
            .to_string_lossy()
            .into_owned();
        TempWorkspace { path }
    }
}

impl Drop for TempWorkspace {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", self.path));
        }
    }
}

/// Enough uniqueness for a temp filename without pulling in a uuid dependency.
fn unique_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock is after the epoch")
        .as_nanos();
    format!("{nanos}-{:?}", std::thread::current().id()).replace(['(', ')', ' '], "")
}

fn new_page(title: &str) -> NewPage {
    NewPage {
        title: title.to_string(),
        folder_id: None,
        content: None,
        tags: None,
        scheduled_start: None,
        scheduled_end: None,
    }
}

#[tokio::test]
async fn opens_creates_and_reads_back_a_page() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();

    let created = ws.create_page(new_page("First")).await.unwrap();
    assert_eq!(created.title, "First");
    // A new page gets the current schema version rather than the column
    // default, so the stamp reflects the writer.
    assert_eq!(created.content_schema_version, ws.content_schema_version());

    let fetched = ws.get_page(created.id.clone()).await.unwrap();
    assert_eq!(fetched.id, created.id);
    assert_eq!(fetched.title, "First");
}

#[tokio::test]
async fn a_missing_page_is_not_found_rather_than_a_failure() {
    // A widget or deep link can hold an id that has since been deleted. The
    // caller needs to tell that apart from a database that is broken.
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();

    match ws.get_page("does-not-exist".to_string()).await {
        Err(WorkspaceError::NotFound { entity, id }) => {
            assert_eq!(entity, "page");
            assert_eq!(id, "does-not-exist");
        }
        other => panic!("expected NotFound, got {other:?}"),
    }
}

#[tokio::test]
async fn editing_content_restamps_the_schema_version() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws.create_page(new_page("Doc")).await.unwrap();

    let updated = ws
        .update_page(
            page.id.clone(),
            PageEdit {
                content: Some(r#"{"type":"doc","content":[]}"#.to_string()),
                content_text: Some(String::new()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

    assert_eq!(updated.content, r#"{"type":"doc","content":[]}"#);
    assert_eq!(updated.content_schema_version, ws.content_schema_version());
}

#[tokio::test]
async fn folder_scope_distinguishes_inbox_from_any() {
    // The data layer models this as an optional JSON value where absent means
    // "any" and null means "inbox". Collapsing those two is the obvious bug
    // this enum exists to prevent, so it is asserted directly.
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();

    // Both an unfiled page and a filed one, so Any and Inbox give different
    // answers. With only an unfiled page they agree, and an earlier version of
    // this test passed even with Inbox collapsed into Any.
    ws.create_page(new_page("Inbox page")).await.unwrap();
    let folder = ws.create_folder("Work".to_string(), None).await.unwrap();
    let mut filed = new_page("Filed page");
    filed.folder_id = Some(folder.id.clone());
    ws.create_page(filed).await.unwrap();

    let any = ws
        .list_pages(PageQuery {
            folder: Some(FolderScope::Any),
            ..Default::default()
        })
        .await
        .unwrap();
    let inbox = ws
        .list_pages(PageQuery {
            folder: Some(FolderScope::Inbox),
            ..Default::default()
        })
        .await
        .unwrap();
    let in_folder = ws
        .list_pages(PageQuery {
            folder: Some(FolderScope::Folder {
                id: folder.id.clone(),
            }),
            ..Default::default()
        })
        .await
        .unwrap();
    let elsewhere = ws
        .list_pages(PageQuery {
            folder: Some(FolderScope::Folder {
                id: "no-such-folder".to_string(),
            }),
            ..Default::default()
        })
        .await
        .unwrap();

    assert_eq!(any.len(), 2, "Any spans the inbox and every folder");
    assert_eq!(inbox.len(), 1, "Inbox is only the unfiled page");
    assert_eq!(inbox[0].title, "Inbox page");
    assert_eq!(in_folder.len(), 1);
    assert_eq!(in_folder[0].title, "Filed page");
    assert_eq!(elsewhere.len(), 0);
}

#[tokio::test]
async fn assigning_a_folder_round_trips_and_clears() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let work = ws.create_folder("Work".to_string(), None).await.unwrap();
    let archive = ws.create_folder("Archive".to_string(), None).await.unwrap();

    // Starts unfiled, so each step below changes something. A page that begins
    // with no folder makes "clear it" indistinguishable from "leave it alone",
    // and an earlier version of this test passed with the two collapsed.
    let page = ws.create_page(new_page("Filed")).await.unwrap();
    assert_eq!(page.folder_id, None);

    let filed = ws
        .update_page(
            page.id.clone(),
            PageEdit {
                folder: Some(FolderAssignment::Folder {
                    id: work.id.clone(),
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(filed.folder_id, Some(work.id.clone()));

    // An absent folder must leave the page where it is, not move it.
    let renamed = ws
        .update_page(
            page.id.clone(),
            PageEdit {
                title: Some("Renamed".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(renamed.title, "Renamed");
    assert_eq!(
        renamed.folder_id,
        Some(work.id.clone()),
        "an absent folder must leave the page filed"
    );

    let moved = ws
        .update_page(
            page.id.clone(),
            PageEdit {
                folder: Some(FolderAssignment::Folder {
                    id: archive.id.clone(),
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(moved.folder_id, Some(archive.id));

    // Clearing must be expressible distinctly from "leave alone" — the same
    // tri-state as the listing filter, in the opposite direction.
    let cleared = ws
        .update_page(
            page.id.clone(),
            PageEdit {
                folder: Some(FolderAssignment::Inbox),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(cleared.folder_id, None, "Inbox must clear the folder");
}

#[tokio::test]
async fn trashed_pages_leave_the_listing_and_come_back() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws.create_page(new_page("Temporary")).await.unwrap();

    ws.trash_page(page.id.clone()).await.unwrap();
    assert_eq!(ws.list_pages(PageQuery::default()).await.unwrap().len(), 0);

    ws.restore_page(page.id.clone()).await.unwrap();
    assert_eq!(ws.list_pages(PageQuery::default()).await.unwrap().len(), 1);
}

#[tokio::test]
async fn search_finds_a_page_by_its_body() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws.create_page(new_page("Notes")).await.unwrap();
    ws.update_page(
        page.id.clone(),
        PageEdit {
            content: Some(r#"{"type":"doc"}"#.to_string()),
            content_text: Some("the quick brown fox".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let hits = ws.search("brown".to_string(), 10).await.unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].page_id, page.id);
}

#[tokio::test]
async fn search_respects_its_limit() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    for i in 0..5 {
        let page = ws
            .create_page(new_page(&format!("Page {i}")))
            .await
            .unwrap();
        ws.update_page(
            page.id,
            PageEdit {
                content: Some(r#"{"type":"doc"}"#.to_string()),
                content_text: Some("shared keyword".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }
    assert_eq!(ws.search("keyword".to_string(), 2).await.unwrap().len(), 2);
}

#[tokio::test]
async fn a_read_only_handle_sees_the_same_data() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    ws.create_page(new_page("Visible to widgets"))
        .await
        .unwrap();

    let reader = ws.read_only();
    let pages = reader.list_pages(PageQuery::default()).await.unwrap();
    assert_eq!(pages.len(), 1);
    assert_eq!(pages[0].title, "Visible to widgets");
}

#[tokio::test]
async fn a_read_only_workspace_refuses_to_create_a_database() {
    // A widget that silently creates an empty workspace looks to the user like
    // their notes have vanished. It must fail instead.
    let tmp = TempWorkspace::new();
    match ReadOnlyWorkspace::open_existing(tmp.path.clone()).await {
        Err(WorkspaceError::Open { message }) => assert!(message.contains("no workspace")),
        other => panic!("expected an Open error, got {other:?}"),
    }
    assert!(
        !std::path::Path::new(&tmp.path).exists(),
        "the failed open must not have left a file behind"
    );
}

#[tokio::test]
async fn opening_a_workspace_twice_shares_its_contents() {
    // The app and an extension open the same path independently. WAL mode
    // permits that; this pins it rather than assuming it.
    let tmp = TempWorkspace::new();
    let writer = Workspace::open(tmp.path.clone()).await.unwrap();
    writer.create_page(new_page("From the app")).await.unwrap();

    let reader = ReadOnlyWorkspace::open_existing(tmp.path.clone())
        .await
        .unwrap();
    let pages = reader.list_pages(PageQuery::default()).await.unwrap();
    assert_eq!(pages.len(), 1);
}
