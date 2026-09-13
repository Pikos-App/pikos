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
async fn a_read_only_handle_lists_folders() {
    // The Shortcuts folder picker runs as an `EntityQuery`, not an intent, and
    // opening a writable handle to populate a picker would put a second writer
    // on a database whose WAL mode permits one. It reads through this.
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    ws.create_folder("Work".to_string(), None).await.unwrap();
    ws.create_folder("Home".to_string(), None).await.unwrap();

    let reader = ReadOnlyWorkspace::open_existing(tmp.path.clone())
        .await
        .unwrap();
    let names: Vec<String> = reader
        .list_folders()
        .await
        .unwrap()
        .into_iter()
        .map(|f| f.name)
        .collect();
    assert_eq!(names.len(), 2);
    assert!(names.contains(&"Work".to_string()));
    assert!(names.contains(&"Home".to_string()));
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

#[tokio::test]
async fn a_created_date_survives_a_later_reschedule() {
    // `pages.scheduled_start` is a denormalised copy of the page's earliest
    // `page_schedules` row, recomputed from that table whenever a schedule
    // changes. A date written straight onto the page has no row behind it, so
    // it reads back correctly right up until something touches the schedule —
    // and then it is gone. Adding a *later* date is the cheapest way to make
    // that recomputation happen: the earlier one should win, and can only win
    // if it was ever really there.
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();

    let created = ws
        .create_page(NewPage {
            title: "Dentist".to_string(),
            scheduled_start: Some("2099-03-16T09:00:00".to_string()),
            ..new_page("Dentist")
        })
        .await
        .unwrap();
    assert_eq!(
        created.scheduled_start.as_deref(),
        Some("2099-03-16T09:00:00")
    );

    ws.schedule_page(created.id.clone(), "2099-03-20T09:00:00".to_string(), None)
        .await
        .unwrap();

    let refetched = ws.get_page(created.id.clone()).await.unwrap();
    assert_eq!(
        refetched.scheduled_start.as_deref(),
        Some("2099-03-16T09:00:00"),
        "the earliest date should still be the page's, so the original must have a schedule row"
    );
}

#[tokio::test]
async fn a_recurring_page_starts_on_a_day_its_rule_allows() {
    // A M/W/F rule anchored to a Sunday must not leave the page's head on the
    // Sunday — that day is not in the series, so it would render as a stray
    // first run detached from every occurrence after it.
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();

    let created = ws.create_page(new_page("Run")).await.unwrap();
    ws.set_recurrence(
        created.id.clone(),
        "FREQ=WEEKLY;BYDAY=MO,WE,FR".to_string(),
        // 2099-03-15 is a Sunday.
        "2099-03-15T07:00:00".to_string(),
        None,
        "UTC".to_string(),
    )
    .await
    .unwrap();

    let refetched = ws.get_page(created.id.clone()).await.unwrap();
    assert_eq!(
        refetched.scheduled_start.as_deref(),
        Some("2099-03-16T07:00:00"),
        "the head should have moved to the Monday"
    );
}

#[tokio::test]
async fn a_quick_add_line_becomes_a_page_with_everything_it_named() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();

    let pages = ws
        .create_from_quick_add(
            "call the plumber #home !urgent tomorrow at 3pm".to_string(),
            "2099-03-15T12:00:00".to_string(),
            None,
            "UTC".to_string(),
        )
        .await
        .unwrap();

    assert_eq!(pages.len(), 1);
    let page = &pages[0];
    assert_eq!(page.title, "call the plumber");
    assert_eq!(page.tags, ["home"]);
    assert_eq!(page.priority, 1);
    assert_eq!(page.scheduled_start.as_deref(), Some("2099-03-16T15:00:00"));
}

#[tokio::test]
async fn a_quick_add_line_naming_days_becomes_one_page_each() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();

    let pages = ws
        .create_from_quick_add(
            "run m/w/f at 7am".to_string(),
            "2099-03-15T12:00:00".to_string(),
            None,
            "UTC".to_string(),
        )
        .await
        .unwrap();

    let starts: Vec<_> = pages
        .iter()
        .map(|page| page.scheduled_start.as_deref().unwrap_or_default())
        .collect();
    assert_eq!(
        starts,
        [
            "2099-03-16T07:00:00",
            "2099-03-18T07:00:00",
            "2099-03-20T07:00:00"
        ]
    );
    assert!(pages.iter().all(|page| page.title == "run"));
}

#[tokio::test]
async fn a_recurring_quick_add_line_gets_a_rule_and_a_snapped_head() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();

    // 2099-03-15 is a Sunday, so a M/W/F rule has to start on the Monday.
    let pages = ws
        .create_from_quick_add(
            "standup every mon/wed/fri at 9am".to_string(),
            "2099-03-15T12:00:00".to_string(),
            None,
            "UTC".to_string(),
        )
        .await
        .unwrap();

    assert_eq!(pages.len(), 1);
    assert_eq!(pages[0].title, "standup");
    assert_eq!(
        pages[0].scheduled_start.as_deref(),
        Some("2099-03-16T09:00:00")
    );
}

#[tokio::test]
async fn a_quick_add_line_with_a_malformed_reference_is_refused() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();

    let error = ws
        .create_from_quick_add(
            "call bob".to_string(),
            "not-a-datetime".to_string(),
            None,
            "UTC".to_string(),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(error, WorkspaceError::InvalidInput { .. }),
        "a malformed argument should not look like a broken database: {error:?}"
    );

    // And nothing was created on the way to failing.
    let pages = ws.list_pages(PageQuery::default()).await.unwrap();
    assert!(pages.is_empty());
}

// ─── Calendar range ──────────────────────────────────────────────────────────

/// The case the whole `calendar_range` design exists for.
///
/// A weekly series is stored once — a head row plus a rule — and its other
/// occurrences are projected at display time. A calendar that simply drew the
/// pages it queried would show a weekly standup anchored months ago exactly
/// zero times this week, and an empty calendar looks like an empty calendar.
#[tokio::test]
async fn a_recurring_series_appears_in_a_week_its_head_is_not_in() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws.create_page(new_page("Standup")).await.unwrap();

    ws.set_recurrence(
        page.id.clone(),
        "FREQ=WEEKLY;BYDAY=MO".to_string(),
        "2026-03-02T09:00:00".to_string(),
        Some("2026-03-02T09:15:00".to_string()),
        "UTC".to_string(),
    )
    .await
    .unwrap();

    // A week three Mondays later. The head sits outside it entirely.
    let entries = ws
        .calendar_range("2026-03-23".to_string(), "2026-03-29".to_string())
        .await
        .unwrap();

    let drawn: Vec<&str> = entries.iter().map(|e| e.scheduled_start.as_str()).collect();
    assert_eq!(
        drawn,
        ["2026-03-23T09:00:00"],
        "the series should project onto the visible Monday"
    );
    assert!(entries[0].is_virtual);
    assert_eq!(entries[0].original_date.as_deref(), Some("2026-03-23"));
    assert_eq!(entries[0].page_id, page.id);
    assert_eq!(
        entries[0].title, "Standup",
        "a virtual carries its page's title"
    );
}

/// The last visible day is inclusive. Off by one here and the final column of
/// a week grid silently never shows a recurring occurrence — the kind of bug
/// that survives a demo because nobody scrolls to Sunday.
#[tokio::test]
async fn the_last_day_of_the_range_is_included() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws.create_page(new_page("Daily")).await.unwrap();
    ws.set_recurrence(
        page.id.clone(),
        "FREQ=DAILY".to_string(),
        "2026-03-02T09:00:00".to_string(),
        None,
        "UTC".to_string(),
    )
    .await
    .unwrap();

    let entries = ws
        .calendar_range("2026-03-23".to_string(), "2026-03-29".to_string())
        .await
        .unwrap();

    let dates: Vec<String> = entries
        .iter()
        .filter_map(|e| e.original_date.clone())
        .collect();
    assert_eq!(dates.len(), 7, "seven days, inclusive of both ends");
    assert_eq!(dates.first().map(String::as_str), Some("2026-03-23"));
    assert_eq!(dates.last().map(String::as_str), Some("2026-03-29"));
}

/// A page that began before the range and is still running through it. Filtering
/// on `scheduled_start` alone would drop it, which is why the query is an
/// overlap rather than a bound.
#[tokio::test]
async fn a_multi_day_page_spanning_into_the_range_is_included() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws.create_page(new_page("Conference")).await.unwrap();
    ws.schedule_page(
        page.id.clone(),
        "2026-03-20".to_string(),
        Some("2026-03-25".to_string()),
    )
    .await
    .unwrap();

    let entries = ws
        .calendar_range("2026-03-23".to_string(), "2026-03-29".to_string())
        .await
        .unwrap();

    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].page_id, page.id);
    assert!(!entries[0].is_virtual);
    assert_eq!(entries[0].scheduled_start, "2026-03-20");
    assert_eq!(entries[0].scheduled_end.as_deref(), Some("2026-03-25"));
}

/// A plain page in the range, and nothing invented around it.
#[tokio::test]
async fn a_scheduled_page_is_drawn_once_and_is_not_virtual() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws.create_page(new_page("Dentist")).await.unwrap();
    ws.schedule_page(
        page.id.clone(),
        "2026-03-24T14:00:00".to_string(),
        Some("2026-03-24T15:00:00".to_string()),
    )
    .await
    .unwrap();

    let entries = ws
        .calendar_range("2026-03-23".to_string(), "2026-03-29".to_string())
        .await
        .unwrap();

    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].key, page.id,
        "a real block keys on the page alone"
    );
    assert!(!entries[0].is_virtual);
    assert!(entries[0].original_date.is_none());
}

/// Every drawn item needs a distinct identity, or a list rendering them
/// collapses duplicates. Page ids will not do: a weekly series shares one
/// across every occurrence, deliberately.
#[tokio::test]
async fn occurrences_of_one_series_have_distinct_keys() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws.create_page(new_page("Daily")).await.unwrap();
    ws.set_recurrence(
        page.id.clone(),
        "FREQ=DAILY".to_string(),
        "2026-03-02T09:00:00".to_string(),
        None,
        "UTC".to_string(),
    )
    .await
    .unwrap();

    let entries = ws
        .calendar_range("2026-03-23".to_string(), "2026-03-29".to_string())
        .await
        .unwrap();

    let mut keys: Vec<&str> = entries.iter().map(|e| e.key.as_str()).collect();
    let total = keys.len();
    keys.sort_unstable();
    keys.dedup();
    assert_eq!(keys.len(), total, "keys must be unique across occurrences");
    assert!(
        entries.iter().all(|e| e.page_id == page.id),
        "while the page id stays shared, which all-day row assignment relies on"
    );
}

/// Nothing scheduled is not an error, and an empty range is not a failure.
#[tokio::test]
async fn an_empty_range_is_empty_rather_than_an_error() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    ws.create_page(new_page("Unscheduled")).await.unwrap();

    let entries = ws
        .calendar_range("2026-03-23".to_string(), "2026-03-29".to_string())
        .await
        .unwrap();
    assert!(entries.is_empty());
}

#[tokio::test]
async fn a_malformed_range_is_refused() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    match ws
        .calendar_range("not-a-date".to_string(), "2026-03-29".to_string())
        .await
    {
        Err(WorkspaceError::InvalidInput { .. }) => {}
        other => panic!("expected InvalidInput, got {other:?}"),
    }
}

/// The read-only handle serves the calendar too — a widget showing a day must
/// not be able to open a writable one to get it.
#[tokio::test]
async fn the_read_only_handle_serves_the_calendar() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws.create_page(new_page("Dentist")).await.unwrap();
    ws.schedule_page(page.id.clone(), "2026-03-24T14:00:00".to_string(), None)
        .await
        .unwrap();

    let reader = ReadOnlyWorkspace::open_existing(tmp.path.clone())
        .await
        .unwrap();
    let entries = reader
        .calendar_range("2026-03-23".to_string(), "2026-03-29".to_string())
        .await
        .unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].page_id, page.id);
}

/// An override written by the *other* app must suppress the projection.
///
/// The desktop can materialise a real schedule row for one occurrence of a
/// series, carrying the rule id and the date it replaces. Both apps share one
/// database, so iOS meets these rows without having any way to create one, and
/// a rule that still projected onto that date would draw the occurrence twice.
///
/// Pairs with `a_recurring_series_appears_in_a_week_its_head_is_not_in`, which
/// is the same setup without the override and *does* get a block on the 23rd.
/// Neither test means much alone: together they say the override is what
/// removed it.
///
/// Written through `pikos-db` rather than the FFI because the FFI has no writer
/// for it. That is the point — this stands in for the desktop.
///
/// Note what is deliberately not asserted: that the override row is *drawn*.
/// It is not, and the desktop does not draw it either. Both read one block per
/// page from `pages.scheduled_start`, and for an rrule-backed page that column
/// is owned by the recurring logic — `refresh_schedule_denorm` returns early
/// rather than letting a new schedule row move the head. Drawing overrides
/// would be a change to both apps, not to this one.
#[tokio::test]
async fn an_overridden_occurrence_is_not_also_projected() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws.create_page(new_page("Standup")).await.unwrap();
    ws.set_recurrence(
        page.id.clone(),
        "FREQ=WEEKLY;BYDAY=MO".to_string(),
        "2026-03-02T09:00:00".to_string(),
        None,
        "UTC".to_string(),
    )
    .await
    .unwrap();

    {
        let pool = pikos_db::open_pool(&tmp.path).await.unwrap();
        let rule = pikos_db::get_recurrence_rule_impl(&pool, &page.id)
            .await
            .unwrap()
            .expect("the rule was just created");
        // The user moved the 23rd's standup to 11:00. The row replaces it.
        pikos_db::create_page_schedule_impl(
            &pool,
            pikos_db::NewPageSchedule {
                page_id: page.id.clone(),
                scheduled_start: "2026-03-23T11:00:00".to_string(),
                scheduled_end: None,
                timezone: Some("UTC".to_string()),
                rule_id: Some(rule.id.clone()),
                original_date: Some("2026-03-23".to_string()),
            },
        )
        .await
        .unwrap();
    }

    let entries = ws
        .calendar_range("2026-03-23".to_string(), "2026-03-29".to_string())
        .await
        .unwrap();

    assert!(
        !entries
            .iter()
            .any(|e| e.is_virtual && e.original_date.as_deref() == Some("2026-03-23")),
        "the rule must not project onto a date it has been overridden on, got {entries:#?}"
    );
}
