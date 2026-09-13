//! Tests for the workspace binding.
//!
//! `pikos-db` already tests the storage behaviour underneath; these cover the
//! translation layer, which is where this crate can be wrong: the tri-state
//! folder fields that become enums, the not-found case that becomes a distinct
//! error, and the read-only handle that must actually be read-only.

use pikos_ffi::workspace::{
    CompletedScope, FolderAssignment, FolderScope, NewPage, PageEdit, PageQuery, PageRepeat,
    ReadOnlyWorkspace, Repeat, RepeatFreq, Workspace, WorkspaceError,
};
use pikos_ffi::Occurrence;

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

// ─── Recurring completion ────────────────────────────────────────────────────

/// Completing an occurrence must advance the series, not end it.
///
/// `pikos-db` states the hazard directly above `set_pages_status_impl`:
/// "Recurring heads must NOT be passed here — completing a recurring page
/// clones the head and advances it; a plain status flip would corrupt the
/// series." A checkbox that routes every page through `update_page` does
/// exactly that, and the damage is invisible at the moment it happens: the row
/// reads `done`, which is what the user asked for. What is gone is every
/// occurrence that had not happened yet.
#[tokio::test]
async fn completing_an_occurrence_advances_the_head_rather_than_ending_the_series() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws.create_page(new_page("Standup")).await.unwrap();
    ws.set_recurrence(
        page.id.clone(),
        "FREQ=DAILY".to_string(),
        "2099-03-02T09:00:00".to_string(),
        None,
        "UTC".to_string(),
    )
    .await
    .unwrap();

    let before = ws.get_page(page.id.clone()).await.unwrap();
    let first = before
        .scheduled_start
        .clone()
        .expect("the head is scheduled");

    let result = ws
        .complete_recurring_occurrence(page.id.clone(), None)
        .await
        .unwrap();

    assert!(
        !result.clone_id.is_empty(),
        "the completed occurrence is recorded as its own page"
    );
    assert_eq!(
        result.head_status, "not_started",
        "a daily series with no end is never finished by one completion"
    );

    let after = ws.get_page(page.id.clone()).await.unwrap();
    assert_eq!(after.status, "not_started", "the head is still open");
    assert!(
        after.scheduled_start.as_deref() > Some(first.as_str()),
        "the head must advance past the completed occurrence: was {first}, now {:?}",
        after.scheduled_start
    );
}

/// The clone is a real page, and it is the thing that reads as done.
#[tokio::test]
async fn the_completed_occurrence_becomes_a_done_page_of_its_own() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws.create_page(new_page("Standup")).await.unwrap();
    ws.set_recurrence(
        page.id.clone(),
        "FREQ=DAILY".to_string(),
        "2099-03-02T09:00:00".to_string(),
        None,
        "UTC".to_string(),
    )
    .await
    .unwrap();

    let result = ws
        .complete_recurring_occurrence(page.id.clone(), None)
        .await
        .unwrap();

    let clone = ws.get_page(result.clone_id.clone()).await.unwrap();
    assert_eq!(clone.status, "done");
    assert_eq!(clone.title, "Standup", "it carries the series' title");
    assert_ne!(clone.id, page.id, "and it is not the head");
}

/// Undo has to walk the head back, or completing by mistake costs the
/// occurrence permanently.
#[tokio::test]
async fn uncompleting_an_occurrence_walks_the_head_back() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws.create_page(new_page("Standup")).await.unwrap();
    ws.set_recurrence(
        page.id.clone(),
        "FREQ=DAILY".to_string(),
        "2099-03-02T09:00:00".to_string(),
        None,
        "UTC".to_string(),
    )
    .await
    .unwrap();

    let original = ws
        .get_page(page.id.clone())
        .await
        .unwrap()
        .scheduled_start
        .expect("the head is scheduled");
    let occurrence_date = original[..10].to_string();

    ws.complete_recurring_occurrence(page.id.clone(), None)
        .await
        .unwrap();
    let advanced = ws.get_page(page.id.clone()).await.unwrap().scheduled_start;
    assert_ne!(
        advanced,
        Some(original.clone()),
        "precondition: it advanced"
    );

    ws.uncomplete_recurring_occurrence(page.id.clone(), occurrence_date)
        .await
        .unwrap();

    let restored = ws.get_page(page.id.clone()).await.unwrap();
    assert_eq!(
        restored.scheduled_start,
        Some(original),
        "the head returns to the re-opened occurrence"
    );
    assert_eq!(restored.status, "not_started");
}
/// What the wrong path does, pinned so nobody reintroduces it.
///
/// This is not a test of desired behaviour — it is a record of the damage, kept
/// because the damage is invisible at the moment it happens. Setting `status` on
/// a recurring head leaves the head exactly where it was and marks it done: no
/// clone, no completion record, and the head never advances. A daily series
/// stops dead at its first occurrence, and the row reads `done`, which is what
/// the user asked for. Everything that had not happened yet is simply gone.
///
/// If this assertion ever starts failing because `update_page` learned to route
/// recurring heads itself, that is good news — delete this test and simplify
/// the callers. Until then it is the reason `complete_recurring_occurrence`
/// exists as a separate call.
#[tokio::test]
async fn a_plain_status_flip_on_a_recurring_head_ends_the_series() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws.create_page(new_page("Standup")).await.unwrap();
    ws.set_recurrence(
        page.id.clone(),
        "FREQ=DAILY".to_string(),
        "2099-03-02T09:00:00".to_string(),
        None,
        "UTC".to_string(),
    )
    .await
    .unwrap();

    let before = ws.get_page(page.id.clone()).await.unwrap();
    ws.update_page(
        page.id.clone(),
        PageEdit {
            status: Some("done".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let after = ws.get_page(page.id.clone()).await.unwrap();

    assert_eq!(after.status, "done");
    assert_eq!(
        after.scheduled_start, before.scheduled_start,
        "the head did not advance — which is the whole problem"
    );
}

/// The list has to be able to tell a recurring page from a plain one, because
/// the checkbox means something different on each.
#[tokio::test]
async fn a_summary_says_whether_its_page_repeats() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let plain = ws.create_page(new_page("Buy milk")).await.unwrap();
    let series = ws.create_page(new_page("Standup")).await.unwrap();
    ws.set_recurrence(
        series.id.clone(),
        "FREQ=DAILY".to_string(),
        "2099-03-02T09:00:00".to_string(),
        None,
        "UTC".to_string(),
    )
    .await
    .unwrap();

    let pages = ws.list_pages(PageQuery::default()).await.unwrap();
    let by_id = |id: &str| pages.iter().find(|p| p.id == id).unwrap();
    assert!(by_id(&series.id).is_recurring);
    assert!(!by_id(&plain.id).is_recurring);
}

/// Undo picks the newest completed occurrence, and says so when there is
/// nothing to pick — which is what tells the caller to fall back to a plain
/// status flip rather than silently doing nothing.
#[tokio::test]
async fn undoing_the_latest_completion_reports_whether_it_had_one() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();

    let plain = ws.create_page(new_page("Buy milk")).await.unwrap();
    assert!(
        !ws.uncomplete_latest_recurring_occurrence(plain.id.clone())
            .await
            .unwrap(),
        "a page with no rule has no occurrence to undo"
    );

    let series = ws.create_page(new_page("Standup")).await.unwrap();
    ws.set_recurrence(
        series.id.clone(),
        "FREQ=DAILY".to_string(),
        "2099-03-02T09:00:00".to_string(),
        None,
        "UTC".to_string(),
    )
    .await
    .unwrap();
    assert!(
        !ws.uncomplete_latest_recurring_occurrence(series.id.clone())
            .await
            .unwrap(),
        "a series with nothing completed has nothing to undo either"
    );

    let first = ws
        .get_page(series.id.clone())
        .await
        .unwrap()
        .scheduled_start
        .unwrap();
    ws.complete_recurring_occurrence(series.id.clone(), None)
        .await
        .unwrap();
    ws.complete_recurring_occurrence(series.id.clone(), None)
        .await
        .unwrap();

    assert!(
        ws.uncomplete_latest_recurring_occurrence(series.id.clone())
            .await
            .unwrap(),
        "two completions, so there is one to undo"
    );
    let after_one = ws
        .get_page(series.id.clone())
        .await
        .unwrap()
        .scheduled_start;
    assert_ne!(
        after_one,
        Some(first.clone()),
        "undoing the newest walks back one occurrence, not all of them"
    );

    assert!(ws
        .uncomplete_latest_recurring_occurrence(series.id.clone())
        .await
        .unwrap());
    assert_eq!(
        ws.get_page(series.id.clone())
            .await
            .unwrap()
            .scheduled_start,
        Some(first),
        "and undoing the second returns the head to where it started"
    );
}

// ─── Folders ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_folder_can_be_renamed() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let folder = ws.create_folder("Wrok".to_string(), None).await.unwrap();

    let renamed = ws
        .rename_folder(folder.id.clone(), "  Work  ".to_string())
        .await
        .unwrap();
    assert_eq!(renamed.name, "Work", "and the name is trimmed");

    let listed = ws.list_folders().await.unwrap();
    assert_eq!(
        listed.iter().find(|f| f.id == folder.id).unwrap().name,
        "Work"
    );
}

/// A blank name would leave a row in the sidebar with nothing to tap.
#[tokio::test]
async fn a_folder_cannot_be_renamed_to_nothing() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let folder = ws.create_folder("Work".to_string(), None).await.unwrap();

    for blank in ["", "   "] {
        match ws.rename_folder(folder.id.clone(), blank.to_string()).await {
            Err(WorkspaceError::InvalidInput { .. }) => {}
            other => panic!("expected InvalidInput for {blank:?}, got {other:?}"),
        }
    }
    assert_eq!(ws.list_folders().await.unwrap()[0].name, "Work");
}

/// Deleting a folder takes its pages with it, in one transaction — the sidebar
/// must not lose the folder while its pages stay listed.
#[tokio::test]
async fn trashing_a_folder_takes_its_pages_and_restoring_brings_them_back() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let folder = ws.create_folder("Work".to_string(), None).await.unwrap();
    let mut filed = new_page("Filed");
    filed.folder_id = Some(folder.id.clone());
    ws.create_page(filed).await.unwrap();
    ws.create_page(new_page("Unfiled")).await.unwrap();

    ws.trash_folder(folder.id.clone()).await.unwrap();

    assert!(
        ws.list_folders().await.unwrap().is_empty(),
        "the folder is gone from the sidebar"
    );
    let titles: Vec<String> = ws
        .list_pages(PageQuery::default())
        .await
        .unwrap()
        .into_iter()
        .map(|p| p.title)
        .collect();
    assert_eq!(titles, ["Unfiled"], "and its pages went with it");

    ws.restore_folder(folder.id.clone()).await.unwrap();
    assert_eq!(ws.list_folders().await.unwrap().len(), 1);
    let restored: Vec<String> = ws
        .list_pages(PageQuery::default())
        .await
        .unwrap()
        .into_iter()
        .map(|p| p.title)
        .collect();
    assert!(restored.contains(&"Filed".to_string()), "got {restored:?}");
}

/// A folder a calendar owns is not the user's to file into. The picker needs to
/// know which those are so it can leave them out rather than offering a choice
/// the workspace will refuse.
#[tokio::test]
async fn a_folder_says_whether_a_calendar_owns_it() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let folder = ws.create_folder("Work".to_string(), None).await.unwrap();
    assert!(!folder.is_external_calendar, "one the user made is theirs");
    assert!(!ws.list_folders().await.unwrap()[0].is_external_calendar);
}

/// A refusal is not a failure, and the message the data layer wrote is already
/// addressed to the user. Wrapping it in "could not read or write" reads as the
/// app breaking rather than as a rule being enforced.
///
/// The flag is set through `pikos-db` because only the sync reconciler sets it
/// in production — the same standing-in-for-the-desktop trick the override test
/// uses.
#[tokio::test]
async fn filing_into_a_calendars_folder_is_refused_not_failed() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let folder = ws.create_folder("Work".to_string(), None).await.unwrap();
    let page = ws.create_page(new_page("Notes")).await.unwrap();

    {
        let pool = pikos_db::open_pool(&tmp.path).await.unwrap();
        sqlx::query("UPDATE folders SET is_external_calendar = 1 WHERE id = ?")
            .bind(&folder.id)
            .execute(&pool)
            .await
            .unwrap();
    }

    assert!(
        ws.list_folders().await.unwrap()[0].is_external_calendar,
        "the flag reaches the UI, so a picker can leave it out"
    );

    match ws
        .update_page(
            page.id.clone(),
            PageEdit {
                folder: Some(FolderAssignment::Folder {
                    id: folder.id.clone(),
                }),
                ..Default::default()
            },
        )
        .await
    {
        Err(WorkspaceError::Refused { message }) => assert!(
            message.contains("external calendar"),
            "the data layer's own sentence survives: {message}"
        ),
        other => panic!("expected Refused, got {other:?}"),
    }

    match ws.trash_folder(folder.id.clone()).await {
        Err(WorkspaceError::Refused { .. }) => {}
        other => panic!("deleting one is refused too, got {other:?}"),
    }
}

/// The safe checkbox, on every kind of page.
///
/// The point of testing this rather than only the two paths underneath is that
/// the *routing* is the part a caller cannot see. A caller holding a page id and
/// a boolean has no way to know which of two destructive-if-wrong operations it
/// is asking for, which is why the decision does not belong at the call site.
#[tokio::test]
async fn the_status_toggle_routes_by_kind_without_being_told() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();

    let plain = ws.create_page(new_page("Buy milk")).await.unwrap();
    ws.set_page_status(plain.id.clone(), true).await.unwrap();
    assert_eq!(ws.get_page(plain.id.clone()).await.unwrap().status, "done");
    ws.set_page_status(plain.id.clone(), false).await.unwrap();
    assert_eq!(
        ws.get_page(plain.id.clone()).await.unwrap().status,
        "not_started"
    );

    let series = ws.create_page(new_page("Standup")).await.unwrap();
    ws.set_recurrence(
        series.id.clone(),
        "FREQ=DAILY".to_string(),
        "2099-03-02T09:00:00".to_string(),
        None,
        "UTC".to_string(),
    )
    .await
    .unwrap();
    let first = ws
        .get_page(series.id.clone())
        .await
        .unwrap()
        .scheduled_start
        .unwrap();

    ws.set_page_status(series.id.clone(), true).await.unwrap();
    let after = ws.get_page(series.id.clone()).await.unwrap();
    assert_eq!(
        after.status, "not_started",
        "the series is not finished by one tick"
    );
    assert!(
        after.scheduled_start.as_deref() > Some(first.as_str()),
        "the head advanced instead"
    );

    ws.set_page_status(series.id.clone(), false).await.unwrap();
    assert_eq!(
        ws.get_page(series.id.clone())
            .await
            .unwrap()
            .scheduled_start,
        Some(first),
        "and unticking walks it back"
    );
}

/// Unticking a recurring head that is `done` with nothing completed recovers it.
///
/// That state should not arise from this app any more, but it is exactly what a
/// plain status flip leaves behind — and such rows already exist in databases
/// this app will open, because that is the bug being fixed. Without the
/// fallback, `uncomplete_latest` finds no occurrence to reopen, returns false,
/// and the tap does nothing at all: a checkbox stuck on with no way to clear it.
#[tokio::test]
async fn unticking_recovers_a_head_left_done_with_no_completions() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let series = ws.create_page(new_page("Standup")).await.unwrap();
    ws.set_recurrence(
        series.id.clone(),
        "FREQ=DAILY".to_string(),
        "2099-03-02T09:00:00".to_string(),
        None,
        "UTC".to_string(),
    )
    .await
    .unwrap();

    // The damaged state, produced the way it gets produced.
    ws.update_page(
        series.id.clone(),
        PageEdit {
            status: Some("done".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(ws.get_page(series.id.clone()).await.unwrap().status, "done");

    ws.set_page_status(series.id.clone(), false).await.unwrap();
    assert_eq!(
        ws.get_page(series.id.clone()).await.unwrap().status,
        "not_started",
        "the head is tickable again rather than stuck on"
    );
}

/// A caller holding a stale id — a widget timeline, a restored navigation
/// stack — gets a distinct answer rather than a silent no-op.
#[tokio::test]
async fn toggling_a_page_that_is_gone_is_not_found() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    match ws.set_page_status("no-such-page".to_string(), true).await {
        Err(WorkspaceError::NotFound { entity, .. }) => assert_eq!(entity, "page"),
        other => panic!("expected NotFound, got {other:?}"),
    }
}

// ─── Trash ───────────────────────────────────────────────────────────────────

/// The round trip a mis-swipe depends on. Without the listing there is no way
/// back on a phone, which is the device most likely to produce one.
#[tokio::test]
async fn a_trashed_page_can_be_found_and_brought_back() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let folder = ws.create_folder("Work".to_string(), None).await.unwrap();
    let mut filed = new_page("Filed");
    filed.folder_id = Some(folder.id.clone());
    let filed = ws.create_page(filed).await.unwrap();
    let loose = ws.create_page(new_page("Unfiled")).await.unwrap();

    assert!(ws.list_trashed_pages().await.unwrap().is_empty());

    ws.trash_page(filed.id.clone()).await.unwrap();
    ws.trash_page(loose.id.clone()).await.unwrap();

    let trashed = ws.list_trashed_pages().await.unwrap();
    assert_eq!(trashed.len(), 2);
    let of = |id: &str| trashed.iter().find(|t| t.id == id).unwrap();
    assert_eq!(of(&filed.id).folder_name.as_deref(), Some("Work"));
    assert_eq!(
        of(&loose.id).folder_name,
        None,
        "an Inbox page has no folder to name"
    );
    assert!(!of(&filed.id).deleted_at.is_empty());

    ws.restore_page(filed.id.clone()).await.unwrap();
    assert_eq!(
        ws.list_trashed_pages().await.unwrap().len(),
        1,
        "restoring takes it out of the trash"
    );
    assert!(ws
        .list_pages(PageQuery::default())
        .await
        .unwrap()
        .iter()
        .any(|p| p.id == filed.id));
}

/// A folder trashed with its pages leaves them with no name to show. Naming the
/// folder anyway would promise a restore that does not happen — the page comes
/// back, the folder does not.
#[tokio::test]
async fn a_page_whose_folder_went_with_it_has_no_folder_name() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let folder = ws.create_folder("Work".to_string(), None).await.unwrap();
    let mut filed = new_page("Filed");
    filed.folder_id = Some(folder.id.clone());
    let filed = ws.create_page(filed).await.unwrap();

    ws.trash_folder(folder.id.clone()).await.unwrap();

    let trashed = ws.list_trashed_pages().await.unwrap();
    let entry = trashed.iter().find(|t| t.id == filed.id).unwrap();
    assert_eq!(entry.folder_name, None);
}

/// The UI states the retention window, so it has to read the one the purge
/// actually uses rather than carry a second copy that drifts.
#[tokio::test]
async fn the_retention_window_comes_from_the_data_layer() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    assert_eq!(ws.trash_retention_days(), 30);
}

/// Clearing a date, and the rows it must not touch.
///
/// The interesting half is what survives. A page's schedule rows are not all
/// the same kind: a row carrying a `rule_id` is a materialised occurrence of a
/// series — one instance somebody moved — and a bulk delete of "this page's
/// schedules" would silently undo those moves. The desktop path draws the line
/// at `rule_id`, so this checks the line is in the same place here.
#[tokio::test]
async fn clearing_a_date_takes_the_one_offs_and_leaves_the_series() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();

    let page = ws
        .create_page(NewPage {
            scheduled_start: Some("2099-03-16T09:00:00".to_string()),
            ..new_page("Dentist")
        })
        .await
        .unwrap();
    ws.schedule_page(page.id.clone(), "2099-03-20T09:00:00".to_string(), None)
        .await
        .unwrap();

    // A rule-backed row, seeded the way the reconciler and the drag path do:
    // a rule for the page, then a schedule row naming it.
    let rule_id = {
        let pool = pikos_db::open_pool(&tmp.path).await.unwrap();
        let rule = pikos_db::create_recurrence_rule_impl(
            &pool,
            pikos_db::NewRecurrenceRule {
                page_id: page.id.clone(),
                rrule: "FREQ=WEEKLY;BYDAY=MO".to_string(),
                rrule_exdates: Vec::new(),
                scheduled_start: "2099-03-16T09:00:00".to_string(),
                scheduled_end: None,
                timezone: "UTC".to_string(),
            },
        )
        .await
        .unwrap();
        pikos_db::create_page_schedule_impl(
            &pool,
            pikos_db::NewPageSchedule {
                page_id: page.id.clone(),
                scheduled_start: "2099-03-23T09:00:00".to_string(),
                scheduled_end: None,
                timezone: None,
                rule_id: Some(rule.id.clone()),
                original_date: Some("2099-03-22".to_string()),
            },
        )
        .await
        .unwrap();
        rule.id
    };

    let cleared = ws.clear_page_schedule(page.id.clone()).await.unwrap();
    assert_eq!(cleared, 2, "both one-off rows, and only those two");

    let pool = pikos_db::open_pool(&tmp.path).await.unwrap();
    let left = pikos_db::list_page_schedules_impl(&pool, &page.id)
        .await
        .unwrap();
    assert_eq!(left.len(), 1, "the materialised occurrence stays: {left:?}");
    assert_eq!(left[0].rule_id.as_deref(), Some(rule_id.as_str()));
}

/// Clearing is not a bulk `DELETE`, and this is why: the denorm has to follow.
///
/// `pages.scheduled_start` is a copy of the earliest schedule row. Deleting the
/// rows without recomputing it leaves the page showing a date that no longer
/// exists anywhere — which reads as "the clear didn't work" and survives a
/// restart.
#[tokio::test]
async fn clearing_a_date_takes_the_page_s_own_copy_of_it_too() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();

    let page = ws
        .create_page(NewPage {
            scheduled_start: Some("2099-03-16T09:00:00".to_string()),
            ..new_page("Dentist")
        })
        .await
        .unwrap();
    assert_eq!(
        page.scheduled_start.as_deref(),
        Some("2099-03-16T09:00:00"),
        "precondition: the page has a date to lose"
    );

    assert_eq!(ws.clear_page_schedule(page.id.clone()).await.unwrap(), 1);

    let after = ws.get_page(page.id.clone()).await.unwrap();
    assert_eq!(after.scheduled_start, None, "the page shows no date");
    assert_eq!(after.scheduled_end, None);
}

/// Nothing to clear is not a failure. The menu entry is offered whenever a page
/// shows a date, and a date can be gone by the time the tap lands — from
/// another window, a sync poll, or a second tap.
#[tokio::test]
async fn clearing_a_page_with_no_date_reports_nothing_rather_than_failing() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws.create_page(new_page("Someday")).await.unwrap();
    assert_eq!(ws.clear_page_schedule(page.id.clone()).await.unwrap(), 0);
}

/// A calendar's page cannot have its date taken away here, and the refusal has
/// to arrive as a refusal.
///
/// This is the flag's whole purpose: `schedule_locked` on a summary is what
/// lets the UI leave the entry out, and this is the guard behind it for every
/// caller that does not — a widget, an intent, a stale list.
#[tokio::test]
async fn a_calendar_owned_date_cannot_be_cleared() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();

    let page = ws
        .create_page(NewPage {
            scheduled_start: Some("2099-03-16T09:00:00".to_string()),
            ..new_page("Standup")
        })
        .await
        .unwrap();

    link_to_a_calendar(&tmp.path, &page.id).await;

    match ws.clear_page_schedule(page.id.clone()).await {
        Err(WorkspaceError::Refused { .. }) => {}
        other => panic!("expected Refused, got {other:?}"),
    }
    assert_eq!(
        ws.get_page(page.id.clone())
            .await
            .unwrap()
            .scheduled_start
            .as_deref(),
        Some("2099-03-16T09:00:00"),
        "and the date is still there"
    );
}

/// The summary carries the lock, so a list can decide what to offer without
/// fetching every page.
///
/// A page list draws dozens of rows and each one's context menu has to know
/// whether rename, move and clear-date are available. Asking per row would be
/// dozens of round trips for a flag the summary query already computes.
#[tokio::test]
async fn a_summary_says_whether_a_calendar_owns_its_schedule() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();

    let native = ws.create_page(new_page("Mine")).await.unwrap();
    let mirrored = ws.create_page(new_page("Theirs")).await.unwrap();
    link_to_a_calendar(&tmp.path, &mirrored.id).await;

    let pages = ws.list_pages(PageQuery::default()).await.unwrap();
    let locked = |id: &str| {
        pages
            .iter()
            .find(|p| p.id == id)
            .unwrap_or_else(|| panic!("{id} should be listed"))
            .schedule_locked
    };
    assert!(!locked(&native.id), "a page made here is the user's");
    assert!(locked(&mirrored.id), "a mirror is not");
}

/// Give a page an active calendar link, the way the reconciler seeds one.
///
/// Written against the tables rather than through a sync API because this crate
/// does not expose one — `pikos-calendar-sync` is not a dependency of the FFI.
/// What matters to the tests above is only the derived flag, and that reads
/// `page_sync.sync_state = 'active'`.
async fn link_to_a_calendar(path: &str, page_id: &str) {
    let pool = pikos_db::open_pool(path).await.unwrap();
    let now = "2026-01-01T00:00:00.000Z";
    sqlx::query(
        "INSERT OR IGNORE INTO sync_account
           (id, provider, display_name, auth_kind, created_at, updated_at)
         VALUES ('acct', 'caldav', 'Test calendar', 'basic', ?, ?)",
    )
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO page_sync
           (id, page_id, account_id, provider, calendar_id, external_id, ical_uid, created_at)
         VALUES (?, ?, 'acct', 'caldav', 'cal', ?, ?, ?)",
    )
    .bind(format!("ps-{page_id}"))
    .bind(page_id)
    .bind(format!("/dav/{page_id}.ics"))
    .bind(format!("uid-{page_id}"))
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();
}

/// What clearing does on a repeating page, which is nothing visible.
///
/// A record of the behaviour rather than an endorsement of it. A page with a
/// rule owns its `scheduled_start` directly — the denorm refresh returns early
/// for exactly that case, because the head's date is advanced by the recurring
/// logic and recomputing it from `page_schedules` would drag the head back to
/// whatever anchor row predates the rule. So the one-off rows do go, and the
/// date the user is looking at does not move.
///
/// That is why the iOS menu leaves "Clear Date" out on a repeating page: not a
/// different rule from desktop's, but a refusal to offer an entry whose only
/// outcome is nothing happening. Ending a series is a different action and
/// needs its own affordance.
#[tokio::test]
async fn clearing_a_repeating_page_s_date_leaves_the_head_where_it_is() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();

    let page = ws
        .create_page(NewPage {
            scheduled_start: Some("2099-03-16T09:00:00".to_string()),
            ..new_page("Standup")
        })
        .await
        .unwrap();
    ws.set_recurrence(
        page.id.clone(),
        "FREQ=WEEKLY;BYDAY=MO".to_string(),
        "2099-03-16T09:00:00".to_string(),
        None,
        "UTC".to_string(),
    )
    .await
    .unwrap();

    let before = ws.get_page(page.id.clone()).await.unwrap().scheduled_start;
    assert!(before.is_some(), "precondition: the head shows a date");

    ws.clear_page_schedule(page.id.clone()).await.unwrap();

    assert_eq!(
        ws.get_page(page.id.clone()).await.unwrap().scheduled_start,
        before,
        "the head keeps its date — the series still owns it"
    );
}

/// A list of open work leaves out what is finished.
///
/// The filter is a negation rather than `status = "not_started"`: today those
/// are the same set, and the point of the negation is that a status added later
/// keeps showing up in the list of things still to do instead of disappearing
/// from every view at once with nothing logged.
#[tokio::test]
async fn an_open_listing_leaves_out_finished_pages() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();

    let open = ws.create_page(new_page("Still to do")).await.unwrap();
    let done = ws.create_page(new_page("Finished")).await.unwrap();
    ws.set_page_status(done.id.clone(), true).await.unwrap();

    let everything = ws.list_pages(PageQuery::default()).await.unwrap();
    assert_eq!(everything.len(), 2, "unfiltered, both are there");

    let listed = ws
        .list_pages(PageQuery {
            open_only: Some(true),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        listed.iter().map(|p| p.id.clone()).collect::<Vec<_>>(),
        vec![open.id],
        "only the open one"
    );
}

/// The Completed section for a folder: everything ever finished in it, newest
/// first, and nothing from anywhere else.
#[tokio::test]
async fn completed_pages_are_scoped_to_their_folder_and_ordered_newest_first() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let folder = ws.create_folder("Work".to_string(), None).await.unwrap();

    let mut ids = Vec::new();
    for title in ["First", "Second", "Third"] {
        let page = ws
            .create_page(NewPage {
                folder_id: Some(folder.id.clone()),
                ..new_page(title)
            })
            .await
            .unwrap();
        ws.set_page_status(page.id.clone(), true).await.unwrap();
        ids.push(page.id);
        // `completed_at` has one-second resolution, and the order is the whole
        // assertion — without this the three stamps can be identical and the
        // test passes on whatever order SQLite happens to return.
        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    }

    let elsewhere = ws.create_page(new_page("Inbox thing")).await.unwrap();
    ws.set_page_status(elsewhere.id.clone(), true)
        .await
        .unwrap();

    let completed = ws
        .list_completed(
            CompletedScope::Folder {
                id: folder.id.clone(),
            },
            10,
            0,
        )
        .await
        .unwrap();

    assert_eq!(
        completed.total, 3,
        "the page in the inbox is not this view's"
    );
    ids.reverse();
    assert_eq!(
        completed
            .pages
            .iter()
            .map(|p| p.id.clone())
            .collect::<Vec<_>>(),
        ids,
        "newest completion first"
    );
}

/// Paging through a folder's completed pages.
///
/// `total` is the count for the whole scope rather than the length of the page
/// returned, which is what lets a "Show more" control know there is more to
/// show without fetching a page to find out.
#[tokio::test]
async fn completed_pages_page_through_with_a_total_for_the_whole_scope() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let folder = ws.create_folder("Work".to_string(), None).await.unwrap();

    for title in ["a", "b", "c", "d", "e"] {
        let page = ws
            .create_page(NewPage {
                folder_id: Some(folder.id.clone()),
                ..new_page(title)
            })
            .await
            .unwrap();
        ws.set_page_status(page.id.clone(), true).await.unwrap();
    }

    let scope = || CompletedScope::Folder {
        id: folder.id.clone(),
    };
    let first = ws.list_completed(scope(), 2, 0).await.unwrap();
    assert_eq!(first.pages.len(), 2);
    assert_eq!(first.total, 5, "the count is of the scope, not of the page");

    let second = ws.list_completed(scope(), 2, 2).await.unwrap();
    assert_eq!(second.pages.len(), 2);
    let last = ws.list_completed(scope(), 2, 4).await.unwrap();
    assert_eq!(last.pages.len(), 1, "the tail is short, not empty");

    let mut seen: Vec<String> = first
        .pages
        .iter()
        .chain(&second.pages)
        .chain(&last.pages)
        .map(|p| p.id.clone())
        .collect();
    seen.sort();
    seen.dedup();
    assert_eq!(seen.len(), 5, "the three pages do not overlap or skip");
}

/// Today's Completed section is a different question from a folder's, and the
/// scope enum is what keeps a caller from asking the wrong one.
///
/// It means "completed today, wherever it lives" — the things that left Today's
/// list since this morning. A page finished long ago in some folder is not part
/// of that, even though it is completed and even though Today has no folder of
/// its own to exclude it.
#[tokio::test]
async fn todays_completed_section_is_scoped_by_day_rather_than_by_folder() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let folder = ws.create_folder("Work".to_string(), None).await.unwrap();

    let today = ws
        .create_page(NewPage {
            folder_id: Some(folder.id.clone()),
            ..new_page("Ticked off just now")
        })
        .await
        .unwrap();
    ws.set_page_status(today.id.clone(), true).await.unwrap();

    let long_ago = ws
        .create_page(new_page("Ticked off in 2020"))
        .await
        .unwrap();
    ws.set_page_status(long_ago.id.clone(), true).await.unwrap();
    {
        let pool = pikos_db::open_pool(&tmp.path).await.unwrap();
        sqlx::query("UPDATE pages SET completed_at = '2020-01-01T09:00:00' WHERE id = ?")
            .bind(&long_ago.id)
            .execute(&pool)
            .await
            .unwrap();
    }

    let completed = ws
        .list_completed(CompletedScope::Today, 10, 0)
        .await
        .unwrap();
    assert_eq!(
        completed
            .pages
            .iter()
            .map(|p| p.id.clone())
            .collect::<Vec<_>>(),
        vec![today.id],
        "today's, across every folder — and only today's"
    );
    assert_eq!(completed.total, 1);
}

/// Ticking a box records *when*, and unticking takes it back.
///
/// Found by writing the Completed section, not by reading the code: the page
/// vanished from Today and then failed to appear anywhere else. `set_page_status`
/// went through `update_page_impl`, which writes `completed_at` only when a
/// caller supplies one — and nothing did. The page was finished with no record
/// of when, which is not a cosmetic gap: the Completed section for a date view
/// selects on `date(completed_at)`, so a page ticked on the phone was done and
/// invisible everywhere, including on the desktop reading the same file.
#[tokio::test]
async fn ticking_a_box_records_when_and_unticking_clears_it() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws.create_page(new_page("Buy milk")).await.unwrap();
    assert_eq!(page.completed_at, None, "precondition: never completed");

    ws.set_page_status(page.id.clone(), true).await.unwrap();
    let done = ws.get_page(page.id.clone()).await.unwrap();
    let stamp = done.completed_at.expect("a completed page knows when");

    // Local wall clock, not UTC — the same convention `scheduled_start` uses,
    // and what the Completed view's date comparison depends on. A `Z` here
    // would mean the page hides from "completed today" whenever UTC's date is
    // not the reader's.
    assert!(
        !stamp.ends_with('Z') && stamp.contains('T'),
        "wall-clock ISO with no zone suffix, got {stamp}"
    );
    assert_eq!(
        stamp.len(),
        "2026-09-13T14:30:00".len(),
        "no milliseconds either: {stamp}"
    );

    ws.set_page_status(page.id.clone(), false).await.unwrap();
    assert_eq!(
        ws.get_page(page.id.clone()).await.unwrap().completed_at,
        None,
        "reopening takes the completion date with it, rather than leaving a \
         stale one for the next tick to look already-set"
    );
}

/// A limit of zero counts without reading.
///
/// The page list leans on this every refresh: it needs to know whether a view
/// has any finished pages — a view whose work is all done is not empty, and
/// showing "nothing here yet" over a full Completed section would put that work
/// out of reach — but it must not pay to build summaries nobody is looking at.
/// Zero has to mean "none of them", not "all of them".
#[tokio::test]
async fn a_limit_of_zero_returns_the_count_and_no_rows() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();

    for title in ["a", "b", "c"] {
        let page = ws.create_page(new_page(title)).await.unwrap();
        ws.set_page_status(page.id.clone(), true).await.unwrap();
    }

    let counted = ws
        .list_completed(CompletedScope::Inbox, 0, 0)
        .await
        .unwrap();
    assert_eq!(counted.total, 3);
    assert!(counted.pages.is_empty(), "no rows were asked for");
}

/// Today arrives already split, and the split is by the clock rather than by
/// the day.
///
/// The pikos-core port is graded against the TypeScript on a corpus; what this
/// covers is the wiring — that the rows reaching the sections are the right
/// rows, and that the two halves are not silently the same list twice.
#[tokio::test]
async fn todays_sections_separate_what_slipped_from_what_is_still_due() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();

    // Relative to the machine clock, because the view is. Yesterday is overdue
    // whatever the hour; a bare date for today never is; a time far enough
    // ahead is not yet. The core's own tests stand on the boundary itself —
    // here the cases are chosen so no reasonable run time can flip them.
    let today = chrono::Local::now().date_naive();
    let yesterday = (today - chrono::Duration::days(1))
        .format("%Y-%m-%d")
        .to_string();
    let today_str = today.format("%Y-%m-%d").to_string();

    let slipped = ws
        .create_page(NewPage {
            scheduled_start: Some(yesterday.clone()),
            ..new_page("Yesterday's")
        })
        .await
        .unwrap();
    let all_day = ws
        .create_page(NewPage {
            scheduled_start: Some(today_str.clone()),
            ..new_page("Sometime today")
        })
        .await
        .unwrap();

    let sections = ws.list_today_sections().await.unwrap();
    let ids = |pages: &[pikos_ffi::workspace::PageSummary]| {
        pages.iter().map(|p| p.id.clone()).collect::<Vec<_>>()
    };
    assert_eq!(ids(&sections.overdue), vec![slipped.id.clone()]);
    assert_eq!(
        ids(&sections.today),
        vec![all_day.id.clone()],
        "a bare date for today is not overdue at any hour"
    );

    // Ticking it takes it out of both, rather than out of one.
    ws.set_page_status(slipped.id.clone(), true).await.unwrap();
    let after = ws.list_today_sections().await.unwrap();
    assert!(after.overdue.is_empty());
    assert_eq!(ids(&after.today), vec![all_day.id]);
}

/// Upcoming's window, at both ends.
///
/// The upper bound is the one worth a test with a database behind it: the
/// column is compared lexicographically and holds two different shapes, so a
/// bare date as the bound admits the last day's all-day rows and silently drops
/// every timed row on it. That failure looks like a calendar that just forgets
/// next Saturday's meetings.
#[tokio::test]
async fn upcoming_spans_seven_days_and_keeps_the_last_days_timed_pages() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();

    let today = chrono::Local::now().date_naive();
    let day = |offset: i64| {
        (today + chrono::Duration::days(offset))
            .format("%Y-%m-%d")
            .to_string()
    };

    let mut expected: Vec<(String, Vec<String>)> = Vec::new();
    for offset in [0_i64, 3, 6] {
        let timed = ws
            .create_page(NewPage {
                scheduled_start: Some(format!("{}T14:00:00", day(offset))),
                ..new_page(&format!("timed +{offset}"))
            })
            .await
            .unwrap();
        expected.push((day(offset), vec![timed.id]));
    }
    // The eighth day is out.
    ws.create_page(NewPage {
        scheduled_start: Some(format!("{}T09:00:00", day(7))),
        ..new_page("too far")
    })
    .await
    .unwrap();
    // So is yesterday — Upcoming does not carry the backlog.
    ws.create_page(NewPage {
        scheduled_start: Some(day(-1)),
        ..new_page("already slipped")
    })
    .await
    .unwrap();

    let days = ws.list_upcoming().await.unwrap();
    let actual: Vec<(String, Vec<String>)> = days
        .into_iter()
        .map(|d| (d.date, d.pages.into_iter().map(|p| p.id).collect()))
        .collect();
    assert_eq!(actual, expected);
}

/// Only days holding something get a section, and the pages inside one are in
/// schedule order rather than in creation order.
#[tokio::test]
async fn upcoming_skips_empty_days_and_orders_within_one() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();

    let today = chrono::Local::now().date_naive();
    let in_two = (today + chrono::Duration::days(2))
        .format("%Y-%m-%d")
        .to_string();

    // Created late-first, so creation order and schedule order disagree.
    let late = ws
        .create_page(NewPage {
            scheduled_start: Some(format!("{in_two}T17:00:00")),
            ..new_page("Evening")
        })
        .await
        .unwrap();
    let early = ws
        .create_page(NewPage {
            scheduled_start: Some(format!("{in_two}T08:00:00")),
            ..new_page("Morning")
        })
        .await
        .unwrap();

    let days = ws.list_upcoming().await.unwrap();
    assert_eq!(days.len(), 1, "the empty days in between get no section");
    assert_eq!(days[0].date, in_two);
    assert_eq!(
        days[0]
            .pages
            .iter()
            .map(|p| p.id.clone())
            .collect::<Vec<_>>(),
        vec![early.id, late.id],
        "soonest first, not newest first"
    );
}

/// Finished work is not what is coming.
#[tokio::test]
async fn upcoming_lists_open_work_only() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();

    let today = chrono::Local::now().date_naive();
    let tomorrow = (today + chrono::Duration::days(1))
        .format("%Y-%m-%d")
        .to_string();

    let done = ws
        .create_page(NewPage {
            scheduled_start: Some(format!("{tomorrow}T09:00:00")),
            ..new_page("Already handled")
        })
        .await
        .unwrap();
    ws.set_page_status(done.id.clone(), true).await.unwrap();

    assert!(
        ws.list_upcoming().await.unwrap().is_empty(),
        "a finished page is not upcoming work"
    );
}

// ─── External calendars ──────────────────────────────────────────────────────
//
// What is testable here is the half that does not need a server: the status
// read, the calendar toggle, and the error a call makes when the network is the
// problem. Connecting is a live CalDAV discovery and belongs to the sync
// crate's own suite, which has the transport to fake.

/// An account and its calendars arrive in one read, dormant accounts included.
///
/// Listing dormant accounts is deliberate rather than an oversight. A
/// disconnect keeps the row so a later reconnect re-links the pages it
/// mirrored; a screen that hid them would make reconnecting look like
/// connecting, which is what duplicates a calendar.
#[tokio::test]
async fn sync_status_lists_accounts_with_their_calendars() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    seed_account(
        &tmp.path,
        "acct",
        "Fastmail",
        &[("cal-work", "Work"), ("cal-home", "Home")],
    )
    .await;

    let status = ws.sync_status().await.unwrap();
    assert_eq!(status.len(), 1);
    assert_eq!(status[0].account.display_name, "Fastmail");
    assert!(!status[0].account.reconnect_needed);

    let mut names: Vec<String> = status[0]
        .calendars
        .iter()
        .map(|c| c.display_name.clone())
        .collect();
    names.sort();
    assert_eq!(names, vec!["Home".to_string(), "Work".to_string()]);
}

/// A rejected credential has to reach the screen.
///
/// The scheduler skips a flagged account entirely, so an interface that does
/// not carry this flag shows an account that looks connected and silently syncs
/// nothing — the failure mode the flag exists to make visible.
#[tokio::test]
async fn an_account_needing_reconnection_says_so() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    seed_account(&tmp.path, "acct", "Fastmail", &[("cal-work", "Work")]).await;

    {
        let pool = pikos_db::open_pool(&tmp.path).await.unwrap();
        pikos_db::set_reconnect_needed_impl(&pool, "acct", true)
            .await
            .unwrap();
    }

    assert!(ws.sync_status().await.unwrap()[0].account.reconnect_needed);
}

/// Toggling a calendar round-trips, and the returned row is the new state
/// rather than the old one — a screen that redrew from the argument it sent
/// would be right by luck.
#[tokio::test]
async fn a_calendar_can_be_switched_off_and_back_on() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    seed_account(&tmp.path, "acct", "Fastmail", &[("cal-work", "Work")]).await;

    let id = ws.sync_status().await.unwrap()[0].calendars[0].id.clone();

    let off = ws.set_calendar_enabled(id.clone(), false).await.unwrap();
    assert!(!off.enabled);
    assert!(!ws.sync_status().await.unwrap()[0].calendars[0].enabled);

    let on = ws.set_calendar_enabled(id.clone(), true).await.unwrap();
    assert!(on.enabled);
    assert!(ws.sync_status().await.unwrap()[0].calendars[0].enabled);
}

/// A server that cannot be reached is not a broken workspace.
///
/// The distinction is the whole reason `WorkspaceError::Network` exists: it is
/// the one failure here worth retrying unchanged, and the only one where "try
/// again" is honest advice. Folded into `Database` it would tell somebody on a
/// train that their notes are damaged.
#[tokio::test]
async fn an_unreachable_server_reads_as_a_network_problem() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();

    // A host that resolves nowhere. `.invalid` is reserved by RFC 2606
    // precisely so a test can be sure it will never be registered.
    match ws
        .connect_caldav(
            "https://nothing.invalid/dav/".to_string(),
            "someone".to_string(),
            "hunter2".to_string(),
            "Nowhere".to_string(),
        )
        .await
    {
        Err(WorkspaceError::Network { .. }) => {}
        other => panic!("expected Network, got {other:?}"),
    }

    assert!(
        ws.sync_status().await.unwrap().is_empty(),
        "a failed connection stores nothing — discovery runs before the write"
    );
}

/// Repairing an account that does not exist is a not-found, not a crash.
#[tokio::test]
async fn reconnecting_an_unknown_account_is_an_error_rather_than_a_panic() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    assert!(ws
        .reconnect_caldav("nope".to_string(), "hunter2".to_string())
        .await
        .is_err());
}

/// Seed an account and its calendars directly.
///
/// Written against the tables because the real path is a live CalDAV discovery,
/// and the behaviour under test here is the read and the toggle rather than the
/// transport. Enabled by default, matching what discovery produces.
async fn seed_account(path: &str, account_id: &str, name: &str, calendars: &[(&str, &str)]) {
    let pool = pikos_db::open_pool(path).await.unwrap();
    let now = "2026-01-01T00:00:00.000Z";
    sqlx::query(
        "INSERT INTO sync_account
           (id, provider, display_name, auth_kind, created_at, updated_at)
         VALUES (?, 'caldav', ?, 'basic', ?, ?)",
    )
    .bind(account_id)
    .bind(name)
    .bind(now)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    for (calendar_id, display) in calendars {
        sqlx::query(
            "INSERT INTO sync_calendar
               (id, account_id, calendar_id, display_name, enabled, created_at, updated_at)
             VALUES (?, ?, ?, ?, 1, ?, ?)",
        )
        .bind(format!("sc-{calendar_id}"))
        .bind(account_id)
        .bind(calendar_id)
        .bind(display)
        .bind(now)
        .bind(now)
        .execute(&pool)
        .await
        .unwrap();
    }
}

/// Moving a page replaces its date rather than adding a second one.
///
/// The distinction matters because `schedule_page` *adds*: a page can hold
/// several schedule rows and shows the earliest still ahead. An "edit" built on
/// that leaves the old date behind to resurface once the new one passes, which
/// reads as the app forgetting the change days later.
#[tokio::test]
async fn setting_a_date_replaces_the_one_that_was_there() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();

    let page = ws
        .create_page(NewPage {
            scheduled_start: Some("2099-03-16T09:00:00".to_string()),
            ..new_page("Dentist")
        })
        .await
        .unwrap();

    let moved = ws
        .set_page_schedule(
            page.id.clone(),
            "2099-03-20T14:00:00".to_string(),
            Some("2099-03-20T15:00:00".to_string()),
        )
        .await
        .unwrap();
    assert_eq!(
        moved.scheduled_start.as_deref(),
        Some("2099-03-20T14:00:00")
    );
    assert_eq!(moved.scheduled_end.as_deref(), Some("2099-03-20T15:00:00"));

    let pool = pikos_db::open_pool(&tmp.path).await.unwrap();
    let rows = pikos_db::list_page_schedules_impl(&pool, &page.id)
        .await
        .unwrap();
    assert_eq!(
        rows.len(),
        1,
        "the old row is gone, not sitting behind the new one: {rows:?}"
    );
}

/// A page with no date can be given one — the case quick add cannot reach
/// afterwards, and the reason this exists.
#[tokio::test]
async fn an_unscheduled_page_can_be_given_a_date() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws.create_page(new_page("Someday")).await.unwrap();
    assert_eq!(page.scheduled_start, None, "precondition: no date");

    let scheduled = ws
        .set_page_schedule(page.id.clone(), "2099-04-01".to_string(), None)
        .await
        .unwrap();
    assert_eq!(scheduled.scheduled_start.as_deref(), Some("2099-04-01"));
}

/// Timed and all-day are the same field in two shapes, so converting between
/// them is just writing the other one.
#[tokio::test]
async fn a_timed_page_can_become_all_day_and_back() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws
        .create_page(NewPage {
            scheduled_start: Some("2099-03-16T09:00:00".to_string()),
            ..new_page("Conference")
        })
        .await
        .unwrap();

    let all_day = ws
        .set_page_schedule(page.id.clone(), "2099-03-16".to_string(), None)
        .await
        .unwrap();
    assert_eq!(all_day.scheduled_start.as_deref(), Some("2099-03-16"));

    let timed = ws
        .set_page_schedule(page.id.clone(), "2099-03-16T11:00:00".to_string(), None)
        .await
        .unwrap();
    assert_eq!(
        timed.scheduled_start.as_deref(),
        Some("2099-03-16T11:00:00")
    );
}

/// A multi-day all-day span survives, which is what the matching-shapes rule
/// protects.
#[tokio::test]
async fn an_all_day_span_keeps_both_ends() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws.create_page(new_page("Holiday")).await.unwrap();

    let spanned = ws
        .set_page_schedule(
            page.id.clone(),
            "2099-07-01".to_string(),
            Some("2099-07-08".to_string()),
        )
        .await
        .unwrap();
    assert_eq!(spanned.scheduled_start.as_deref(), Some("2099-07-01"));
    assert_eq!(spanned.scheduled_end.as_deref(), Some("2099-07-08"));
}

/// Mixed shapes are refused rather than stored.
///
/// The storage format has no way to say "all day, ending at 3pm", so a mixed
/// pair would be written and then read back as something nobody asked for.
#[tokio::test]
async fn a_start_and_end_of_different_shapes_are_refused() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws.create_page(new_page("Muddle")).await.unwrap();

    for (start, end) in [
        ("2099-07-01", "2099-07-08T15:00:00"),
        ("2099-07-01T09:00:00", "2099-07-08"),
    ] {
        match ws
            .set_page_schedule(page.id.clone(), start.to_string(), Some(end.to_string()))
            .await
        {
            Err(WorkspaceError::InvalidInput { .. }) => {}
            other => panic!("expected InvalidInput for {start}..{end}, got {other:?}"),
        }
    }
    assert_eq!(
        ws.get_page(page.id.clone()).await.unwrap().scheduled_start,
        None,
        "and nothing was written"
    );
}

/// An end before its start is refused. Stored, it gives every occurrence
/// derived from the page a negative span.
#[tokio::test]
async fn an_end_before_the_start_is_refused() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws.create_page(new_page("Backwards")).await.unwrap();

    match ws
        .set_page_schedule(
            page.id.clone(),
            "2099-07-08T15:00:00".to_string(),
            Some("2099-07-08T14:00:00".to_string()),
        )
        .await
    {
        Err(WorkspaceError::InvalidInput { .. }) => {}
        other => panic!("expected InvalidInput, got {other:?}"),
    }
}

/// A repeating page is refused, and the refusal arrives as a refusal.
///
/// Its date belongs to the rule: moving it has to realign the anchor and snap
/// onto a day the rule yields, and without that the next recompute reverts the
/// edit. Refusing is the honest version of not having ported that yet — the
/// same line `pikos update --due` draws.
#[tokio::test]
async fn a_repeating_page_refuses_a_plain_date_change() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws
        .create_page(NewPage {
            scheduled_start: Some("2099-03-16T09:00:00".to_string()),
            ..new_page("Standup")
        })
        .await
        .unwrap();
    ws.set_recurrence(
        page.id.clone(),
        "FREQ=WEEKLY;BYDAY=MO".to_string(),
        "2099-03-16T09:00:00".to_string(),
        None,
        "UTC".to_string(),
    )
    .await
    .unwrap();

    let before = ws.get_page(page.id.clone()).await.unwrap().scheduled_start;
    match ws
        .set_page_schedule(page.id.clone(), "2099-03-18T09:00:00".to_string(), None)
        .await
    {
        Err(WorkspaceError::Refused { message }) => {
            assert!(message.contains("repeat"), "explains itself: {message}")
        }
        other => panic!("expected Refused, got {other:?}"),
    }
    assert_eq!(
        ws.get_page(page.id.clone()).await.unwrap().scheduled_start,
        before,
        "and the series is untouched"
    );
}

/// A calendar's page is refused by the data layer's own guard, reached through
/// this path like any other.
#[tokio::test]
async fn a_calendar_owned_page_refuses_a_date_change() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws
        .create_page(NewPage {
            scheduled_start: Some("2099-03-16T09:00:00".to_string()),
            ..new_page("Standup")
        })
        .await
        .unwrap();
    link_to_a_calendar(&tmp.path, &page.id).await;

    match ws
        .set_page_schedule(page.id.clone(), "2099-03-18T09:00:00".to_string(), None)
        .await
    {
        Err(WorkspaceError::Refused { .. }) => {}
        other => panic!("expected Refused, got {other:?}"),
    }
    assert_eq!(
        ws.get_page(page.id.clone())
            .await
            .unwrap()
            .scheduled_start
            .as_deref(),
        Some("2099-03-16T09:00:00"),
        "and the date the calendar owns is unchanged"
    );
}

/// Nonsense in, error out — rather than a row nothing can read back.
#[tokio::test]
async fn a_malformed_date_is_refused() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws.create_page(new_page("Whenever")).await.unwrap();

    for bad in ["", "tomorrow", "2099-13-45", "2099-07-01T25:00:00"] {
        match ws
            .set_page_schedule(page.id.clone(), bad.to_string(), None)
            .await
        {
            Err(WorkspaceError::InvalidInput { .. }) => {}
            other => panic!("expected InvalidInput for {bad:?}, got {other:?}"),
        }
    }
}

// ─── Repeats ─────────────────────────────────────────────────────────────────

/// A page that does not repeat says so, rather than reporting a repeat of
/// nothing.
#[tokio::test]
async fn a_plain_page_has_no_repeat() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws.create_page(new_page("Once")).await.unwrap();
    assert!(matches!(
        ws.page_repeat(page.id).await.unwrap(),
        PageRepeat::Never
    ));
}

/// Setting a repeat, reading it back, and changing it — the round-trip the
/// picker depends on. A shape that does not survive it would show the user
/// something other than what they saved.
#[tokio::test]
async fn a_repeat_survives_being_read_back_and_changed() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws
        .create_page(NewPage {
            scheduled_start: Some("2099-03-16T09:00:00".to_string()),
            ..new_page("Standup")
        })
        .await
        .unwrap();

    ws.set_page_repeat(
        page.id.clone(),
        Repeat {
            freq: RepeatFreq::Weekly,
            interval: 2,
            weekdays: vec![0, 2],
        },
    )
    .await
    .unwrap();

    match ws.page_repeat(page.id.clone()).await.unwrap() {
        PageRepeat::Editable { repeat, label } => {
            assert_eq!(repeat.freq, RepeatFreq::Weekly);
            assert_eq!(repeat.interval, 2);
            assert_eq!(repeat.weekdays, vec![0u32, 2]);
            assert!(!label.is_empty(), "a repeat is described, not just flagged");
        }
        other => panic!("expected Editable, got {other:?}"),
    }

    // Changing it rewrites the one rule rather than adding a second — two rules
    // on a page is a series that expands twice.
    ws.set_page_repeat(
        page.id.clone(),
        Repeat {
            freq: RepeatFreq::Daily,
            interval: 1,
            weekdays: vec![],
        },
    )
    .await
    .unwrap();

    let pool = pikos_db::open_pool(&tmp.path).await.unwrap();
    let rules = pikos_db::list_recurrence_rules_impl(&pool).await.unwrap();
    assert_eq!(rules.len(), 1, "one rule, rewritten: {rules:?}");
    assert!(rules[0].rrule.contains("FREQ=DAILY"), "{}", rules[0].rrule);
}

/// The anchor moves with the rule.
///
/// A weekly repeat switched to a different weekday has to leave the head on a
/// day the rule yields, or the next recompute drags it back and the edit looks
/// like it did not take.
#[tokio::test]
async fn changing_the_weekday_moves_the_head_onto_it() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    // 2099-03-16 is a Monday.
    let page = ws
        .create_page(NewPage {
            scheduled_start: Some("2099-03-16T09:00:00".to_string()),
            ..new_page("Standup")
        })
        .await
        .unwrap();

    ws.set_page_repeat(
        page.id.clone(),
        Repeat {
            freq: RepeatFreq::Weekly,
            interval: 1,
            weekdays: vec![0],
        },
    )
    .await
    .unwrap();
    assert_eq!(
        ws.get_page(page.id.clone())
            .await
            .unwrap()
            .scheduled_start
            .as_deref(),
        Some("2099-03-16T09:00:00"),
        "precondition: the head sits on its Monday"
    );

    // Wednesday.
    ws.set_page_repeat(
        page.id.clone(),
        Repeat {
            freq: RepeatFreq::Weekly,
            interval: 1,
            weekdays: vec![2],
        },
    )
    .await
    .unwrap();
    assert_eq!(
        ws.get_page(page.id.clone())
            .await
            .unwrap()
            .scheduled_start
            .as_deref(),
        Some("2099-03-18T09:00:00"),
        "the head follows the rule onto the Wednesday"
    );

    // And the rule's own anchor moves with it. The head is re-derived by
    // `recompute_recurring_schedule` either way, so this is the half that
    // testing the page alone would miss: an anchor left on a Monday under
    // BYDAY=WE is a rule whose stated start is a day it never yields, which
    // anything reading the rule row directly — the calendar's connect-day
    // floor, a future exporter — would have to second-guess.
    let pool = pikos_db::open_pool(&tmp.path).await.unwrap();
    let rule = pikos_db::get_recurrence_rule_impl(&pool, &page.id)
        .await
        .unwrap()
        .expect("the rule is still there");
    assert_eq!(
        rule.scheduled_start, "2099-03-18T09:00:00",
        "the rule's anchor is snapped onto a day it yields"
    );
}

/// Weekdays are dropped when the frequency cannot carry them.
///
/// The engine rejects a monthly rule with a BYDAY set it did not ask for, so
/// passing the picker's leftover weekdays through would build a rule that fails
/// to enumerate — a series that silently stops.
#[tokio::test]
async fn switching_away_from_weekly_drops_the_weekdays() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws
        .create_page(NewPage {
            scheduled_start: Some("2099-03-16T09:00:00".to_string()),
            ..new_page("Report")
        })
        .await
        .unwrap();

    ws.set_page_repeat(
        page.id.clone(),
        Repeat {
            freq: RepeatFreq::Monthly,
            interval: 1,
            weekdays: vec![0, 2, 4],
        },
    )
    .await
    .unwrap();

    let pool = pikos_db::open_pool(&tmp.path).await.unwrap();
    let rules = pikos_db::list_recurrence_rules_impl(&pool).await.unwrap();
    assert!(
        !rules[0].rrule.contains("BYDAY"),
        "weekdays should not survive onto a monthly rule: {}",
        rules[0].rrule
    );
}

/// Stopping a repeat leaves the page, on the date it was last sitting on.
///
/// "Never" means stop repeating, not delete — and a head that vanished with its
/// rule would take the user's page with it.
#[tokio::test]
async fn removing_a_repeat_keeps_the_page_and_its_date() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws
        .create_page(NewPage {
            scheduled_start: Some("2099-03-16T09:00:00".to_string()),
            ..new_page("Standup")
        })
        .await
        .unwrap();
    ws.set_page_repeat(
        page.id.clone(),
        Repeat {
            freq: RepeatFreq::Weekly,
            interval: 1,
            weekdays: vec![0],
        },
    )
    .await
    .unwrap();

    ws.remove_page_repeat(page.id.clone()).await.unwrap();

    let after = ws.get_page(page.id.clone()).await.unwrap();
    assert_eq!(
        after.scheduled_start.as_deref(),
        Some("2099-03-16T09:00:00")
    );
    assert!(matches!(
        ws.page_repeat(page.id).await.unwrap(),
        PageRepeat::Never
    ));
}

/// Removing a repeat a page does not have is a no-op, not an error. The menu
/// offers "Never" whatever the page is, and a list row can be stale.
#[tokio::test]
async fn removing_a_repeat_that_is_not_there_is_harmless() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws.create_page(new_page("Once")).await.unwrap();
    ws.remove_page_repeat(page.id.clone()).await.unwrap();
    assert!(matches!(
        ws.page_repeat(page.id).await.unwrap(),
        PageRepeat::Never
    ));
}

/// A repeat needs somewhere to start.
///
/// Every occurrence is derived from the anchor, so inventing one would put the
/// series on a day the user never chose — and they would have to work out why
/// their weekly meeting is on a Thursday.
#[tokio::test]
async fn a_page_with_no_date_cannot_be_made_to_repeat() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws.create_page(new_page("Someday")).await.unwrap();

    match ws
        .set_page_repeat(
            page.id.clone(),
            Repeat {
                freq: RepeatFreq::Daily,
                interval: 1,
                weekdays: vec![],
            },
        )
        .await
    {
        Err(WorkspaceError::Refused { message }) => {
            assert!(message.contains("date"), "explains itself: {message}")
        }
        other => panic!("expected Refused, got {other:?}"),
    }
    assert!(matches!(
        ws.page_repeat(page.id).await.unwrap(),
        PageRepeat::Never
    ));
}

/// A rule the picker cannot represent is shown, never offered for editing.
///
/// This is the whole point of the degrade guard reaching the FFI: a "last
/// Friday of the month" rule has no place in a frequency-and-weekdays picker,
/// and rebuilding it through one would quietly turn it into "every Friday".
#[tokio::test]
async fn a_rule_beyond_the_picker_is_shown_but_locked() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws
        .create_page(NewPage {
            scheduled_start: Some("2099-03-27T09:00:00".to_string()),
            ..new_page("Payroll")
        })
        .await
        .unwrap();
    ws.set_recurrence(
        page.id.clone(),
        "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1".to_string(),
        "2099-03-27T09:00:00".to_string(),
        None,
        "UTC".to_string(),
    )
    .await
    .unwrap();

    match ws.page_repeat(page.id.clone()).await.unwrap() {
        PageRepeat::Fixed { label } => assert!(!label.is_empty(), "still described"),
        other => panic!("expected Fixed, got {other:?}"),
    }

    // And the write refuses too, for a caller holding a stale row.
    match ws
        .set_page_repeat(
            page.id.clone(),
            Repeat {
                freq: RepeatFreq::Weekly,
                interval: 1,
                weekdays: vec![4],
            },
        )
        .await
    {
        Err(WorkspaceError::Refused { .. }) => {}
        other => panic!("expected Refused, got {other:?}"),
    }
}

/// Every term the picker has no control for locks the rule, not just the ones
/// that happen to carry a weekday.
///
/// Written after a mutation survived: deleting the envelope check left the
/// suite green, because the one locked rule it had also tripped the separate
/// "weekdays on a non-weekly rule" guard. These carry none, so only the
/// envelope can catch them — and each would be silently dropped by a save.
#[tokio::test]
async fn a_rule_with_terms_the_picker_lacks_controls_for_is_locked() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();

    for (rrule, what) in [
        ("FREQ=MONTHLY;BYMONTHDAY=15", "on the 15th"),
        ("FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15", "every 15 March"),
        ("FREQ=DAILY;COUNT=10", "ten times and stop"),
        ("FREQ=DAILY;UNTIL=20990401T235959", "until April"),
        ("FREQ=WEEKLY;BYDAY=MO;WKST=SU", "a different week start"),
    ] {
        let page = ws
            .create_page(NewPage {
                scheduled_start: Some("2099-03-16T09:00:00".to_string()),
                ..new_page(what)
            })
            .await
            .unwrap();
        ws.set_recurrence(
            page.id.clone(),
            rrule.to_string(),
            "2099-03-16T09:00:00".to_string(),
            None,
            "UTC".to_string(),
        )
        .await
        .unwrap();

        match ws.page_repeat(page.id.clone()).await.unwrap() {
            PageRepeat::Fixed { .. } => {}
            other => panic!("{rrule} ({what}) should be locked, got {other:?}"),
        }
        match ws
            .set_page_repeat(
                page.id.clone(),
                Repeat {
                    freq: RepeatFreq::Daily,
                    interval: 1,
                    weekdays: vec![],
                },
            )
            .await
        {
            Err(WorkspaceError::Refused { .. }) => {}
            other => panic!("{rrule} ({what}) should refuse the write, got {other:?}"),
        }
    }
}

/// A calendar's repeat is upstream's. Shown, not edited.
#[tokio::test]
async fn a_calendar_owned_repeat_is_locked() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws
        .create_page(NewPage {
            scheduled_start: Some("2099-03-16T09:00:00".to_string()),
            ..new_page("Standup")
        })
        .await
        .unwrap();
    ws.set_recurrence(
        page.id.clone(),
        "FREQ=WEEKLY;BYDAY=MO".to_string(),
        "2099-03-16T09:00:00".to_string(),
        None,
        "UTC".to_string(),
    )
    .await
    .unwrap();
    link_to_a_calendar(&tmp.path, &page.id).await;

    match ws.page_repeat(page.id.clone()).await.unwrap() {
        PageRepeat::Fixed { .. } => {}
        other => panic!("expected Fixed for a mirror, got {other:?}"),
    }
    assert!(
        ws.remove_page_repeat(page.id.clone()).await.is_err(),
        "and the calendar's rule cannot be deleted from here"
    );
}

/// An interval of zero would build a rule that never yields.
#[tokio::test]
async fn an_interval_of_zero_is_refused() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let page = ws
        .create_page(NewPage {
            scheduled_start: Some("2099-03-16T09:00:00".to_string()),
            ..new_page("Standup")
        })
        .await
        .unwrap();

    for bad in [
        Repeat {
            freq: RepeatFreq::Daily,
            interval: 0,
            weekdays: vec![],
        },
        Repeat {
            freq: RepeatFreq::Weekly,
            interval: 1,
            weekdays: vec![9],
        },
    ] {
        match ws.set_page_repeat(page.id.clone(), bad).await {
            Err(WorkspaceError::InvalidInput { .. }) => {}
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }
    assert!(matches!(
        ws.page_repeat(page.id).await.unwrap(),
        PageRepeat::Never
    ));
}

// ─── One occurrence at a time ────────────────────────────────────────────────
//
// A repeating page is one row plus a rule, and everything the calendar draws
// beyond the head is a projection. So the three things a person can do to a
// single occurrence — finish it, drop it, put it back — all come down to
// writing a date into a set and re-deriving the head from what is left. What
// makes them worth testing at this layer is that the wrong call is quiet: the
// destructive one and the correct one both leave a screen that looks right.

/// Seeds a daily series and returns its id and the head's first occurrence.
async fn daily_series(ws: &Workspace, title: &str, from: &str) -> (String, String) {
    let page = ws.create_page(new_page(title)).await.unwrap();
    ws.set_recurrence(
        page.id.clone(),
        "FREQ=DAILY".to_string(),
        format!("{from}T09:00:00"),
        None,
        "UTC".to_string(),
    )
    .await
    .unwrap();
    let head = ws.get_page(page.id.clone()).await.unwrap();
    (
        page.id,
        head.scheduled_start.expect("the head is scheduled"),
    )
}

/// Skipping is the third verb, and the one with no home before this.
///
/// Without it the only way to make one occurrence go away is to trash the head,
/// which takes the entire series — every occurrence behind it and every one
/// ahead. The user reaching for "not this week" means neither.
#[tokio::test]
async fn skipping_an_occurrence_advances_the_head_past_it() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let (id, first) = daily_series(&ws, "Standup", "2099-03-02").await;

    ws.skip_occurrence(id.clone(), first[..10].to_string())
        .await
        .unwrap();

    let after = ws.get_page(id).await.unwrap();
    assert_eq!(
        after.scheduled_start.as_deref(),
        Some("2099-03-03T09:00:00"),
        "the series carries on at the next occurrence"
    );
    assert_eq!(
        after.status, "not_started",
        "dropping one occurrence does not finish the series"
    );
}

/// The difference between skipping and completing, stated as an assertion.
///
/// They look identical from the head's point of view — both advance it — which
/// is exactly why this is worth pinning. A skip must leave no record saying the
/// work was done: no clone, nothing in Completed, nothing in the history a
/// person would later read as "I did that".
#[tokio::test]
async fn a_skipped_occurrence_is_not_a_completed_one() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let (id, first) = daily_series(&ws, "Standup", "2099-03-02").await;

    ws.skip_occurrence(id.clone(), first[..10].to_string())
        .await
        .unwrap();

    let completed = ws
        .list_completed(CompletedScope::Inbox, 50, 0)
        .await
        .unwrap();
    assert_eq!(
        completed.total,
        0,
        "a skip writes no completed page: {:?}",
        completed.pages.iter().map(|p| &p.title).collect::<Vec<_>>()
    );
}

/// Undo, and the reason a skip needs no confirmation.
#[tokio::test]
async fn unskipping_brings_the_occurrence_back() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let (id, first) = daily_series(&ws, "Standup", "2099-03-02").await;
    let date = first[..10].to_string();

    ws.skip_occurrence(id.clone(), date.clone()).await.unwrap();
    assert_ne!(
        ws.get_page(id.clone()).await.unwrap().scheduled_start,
        Some(first.clone()),
        "precondition: it moved on"
    );

    ws.unskip_occurrence(id.clone(), date).await.unwrap();

    assert_eq!(
        ws.get_page(id).await.unwrap().scheduled_start,
        Some(first),
        "the head returns to the restored occurrence"
    );
}

/// Both halves are safe to retry.
///
/// A tap that gets no response is a tap the user makes again. Skipping an
/// already-skipped date must not advance the head a second time — that would
/// silently eat tomorrow's occurrence as well — and un-skipping a date that was
/// never skipped must do nothing at all.
#[tokio::test]
async fn skipping_and_unskipping_are_both_repeatable() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let (id, first) = daily_series(&ws, "Standup", "2099-03-02").await;
    let date = first[..10].to_string();

    ws.skip_occurrence(id.clone(), date.clone()).await.unwrap();
    let once = ws.get_page(id.clone()).await.unwrap().scheduled_start;
    ws.skip_occurrence(id.clone(), date.clone()).await.unwrap();
    assert_eq!(
        ws.get_page(id.clone()).await.unwrap().scheduled_start,
        once,
        "a second skip of the same date must not eat another occurrence"
    );

    ws.unskip_occurrence(id.clone(), date.clone())
        .await
        .unwrap();
    let back = ws.get_page(id.clone()).await.unwrap().scheduled_start;
    ws.unskip_occurrence(id.clone(), date).await.unwrap();
    assert_eq!(
        ws.get_page(id).await.unwrap().scheduled_start,
        back,
        "and un-skipping twice is the same as once"
    );
}

/// A date the series never produced is not an error.
///
/// The set is keyed by date and expansion only ever asks about dates the rule
/// yields, so a stray entry is inert. Worth pinning because the alternative —
/// validating against the rule on the way in — would make a skip fail for a
/// client whose calendar is one refresh behind, which is every client.
#[tokio::test]
async fn skipping_a_date_outside_the_series_changes_nothing() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let (id, first) = daily_series(&ws, "Weekly review", "2099-03-02").await;
    // Weekly from a Monday, so the Tuesday is a date the rule never yields.
    ws.set_page_repeat(
        id.clone(),
        Repeat {
            freq: RepeatFreq::Weekly,
            interval: 1,
            weekdays: vec![0],
        },
    )
    .await
    .unwrap();
    let before = ws.get_page(id.clone()).await.unwrap().scheduled_start;

    ws.skip_occurrence(id.clone(), "2099-03-03".to_string())
        .await
        .unwrap();

    assert_eq!(
        ws.get_page(id).await.unwrap().scheduled_start,
        before,
        "the head is unmoved by a skip the rule cannot match: {first}"
    );
}

/// Completing the occurrence you tapped, not the one you owe.
///
/// The backlog case, and the reason `Occurrence` exists. A series left alone
/// for a week has its head sitting on the oldest occurrence still open, while
/// the block the user actually tapped in the calendar is days ahead of it.
/// Completing "the next one due" there finishes the wrong day and leaves the
/// tapped block still sitting on screen, undone.
#[tokio::test]
async fn completing_a_particular_occurrence_leaves_the_backlog_alone() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let (id, first) = daily_series(&ws, "Standup", "2099-03-02").await;

    let result = ws
        .complete_recurring_occurrence(
            id.clone(),
            Some(Occurrence {
                original_date: "2099-03-04".to_string(),
                scheduled_start: "2099-03-04T09:00:00".to_string(),
                scheduled_end: None,
            }),
        )
        .await
        .unwrap();

    assert_eq!(
        ws.get_page(id).await.unwrap().scheduled_start,
        Some(first),
        "the two occurrences still owed stay owed"
    );
    let clone = ws.get_page(result.clone_id).await.unwrap();
    assert_eq!(clone.status, "done");
    assert_eq!(
        clone.scheduled_start.as_deref(),
        Some("2099-03-04T09:00:00"),
        "and the finished page is dated the day that was finished"
    );
}

/// The regression this call could not survive before.
///
/// `pikos-db` refuses an occurrence date supplied without the occurrence's own
/// start — it has to write that start onto the clone. The FFI used to hard-code
/// both extra fields to `None`, so *any* caller naming an occurrence was
/// rejected at runtime with a message about synced series, and the only reachable
/// behaviour was "complete whatever is next". Passing the three fields as one
/// record is what makes the broken call unrepresentable.
#[tokio::test]
async fn naming_an_occurrence_does_not_need_a_second_argument() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let (id, first) = daily_series(&ws, "Standup", "2099-03-02").await;

    ws.complete_recurring_occurrence(
        id.clone(),
        Some(Occurrence {
            original_date: first[..10].to_string(),
            scheduled_start: first.clone(),
            scheduled_end: None,
        }),
    )
    .await
    .expect("naming the occurrence you are looking at must be enough");

    assert_ne!(
        ws.get_page(id).await.unwrap().scheduled_start,
        Some(first),
        "and it is the occurrence that was named which got completed"
    );
}

/// Skipping one occurrence out of the middle, with work still owed behind it.
#[tokio::test]
async fn an_occurrence_can_be_skipped_from_behind_a_backlog() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let (id, first) = daily_series(&ws, "Standup", "2099-03-02").await;

    ws.skip_occurrence(id.clone(), "2099-03-04".to_string())
        .await
        .unwrap();

    assert_eq!(
        ws.get_page(id.clone()).await.unwrap().scheduled_start,
        Some(first),
        "the head stays on the oldest occurrence still open"
    );

    // Clear the two in front of it and the skipped day is the one the series
    // steps over, rather than the one it lands on.
    for day in ["2099-03-02", "2099-03-03"] {
        ws.skip_occurrence(id.clone(), day.to_string())
            .await
            .unwrap();
    }
    assert_eq!(
        ws.get_page(id).await.unwrap().scheduled_start.as_deref(),
        Some("2099-03-05T09:00:00"),
        "the skipped day is passed over, not landed on"
    );
}

/// The block that looks like a one-off and is not.
///
/// A repeating page's own row is drawn as a real block — no `original_date`,
/// `is_virtual` false — and it is the occurrence most often on screen, because
/// the head sits on the next one due. A calendar that decides "is this an
/// occurrence?" by asking whether the block is virtual therefore gets the
/// common case exactly backwards, and offers the series-wide delete for the one
/// thing the user meant to drop from this week.
#[tokio::test]
async fn a_series_head_draws_as_a_real_block_that_still_knows_it_repeats() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let one_off = ws.create_page(new_page("Dentist")).await.unwrap();
    ws.set_page_schedule(one_off.id.clone(), "2026-03-24T11:00:00".to_string(), None)
        .await
        .unwrap();

    let series = ws.create_page(new_page("Standup")).await.unwrap();
    ws.set_recurrence(
        series.id.clone(),
        "FREQ=WEEKLY;BYDAY=MO".to_string(),
        "2026-03-23T09:00:00".to_string(),
        None,
        "UTC".to_string(),
    )
    .await
    .unwrap();

    let entries = ws
        .calendar_range("2026-03-23".to_string(), "2026-03-29".to_string())
        .await
        .unwrap();

    let head = entries
        .iter()
        .find(|e| e.page_id == series.id && !e.is_virtual)
        .expect("the head's own occurrence is drawn from its row");
    assert!(
        head.is_recurring,
        "and it has to say so, since nothing else about it does"
    );

    let dentist = entries
        .iter()
        .find(|e| e.page_id == one_off.id)
        .expect("the one-off is drawn too");
    assert!(
        !dentist.is_recurring,
        "while a page that does not repeat must not be offered occurrence actions"
    );
}

/// Where an occurrence came from, which decides whether it can be finished on
/// its own.
///
/// The desktop draws a checkbox on an occurrence of an imported calendar and
/// withholds it from one of a native series — a birthday is resolved on the day
/// it names, while a task series funnels to whichever occurrence is next due.
/// The phone can only apply that rule if the block says which kind it is, and
/// the answer is sync *origin*: a detached series is unlocked and still an
/// imported calendar.
#[tokio::test]
async fn a_drawn_occurrence_says_whether_its_series_came_from_a_calendar() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();

    let native = ws.create_page(new_page("Standup")).await.unwrap();
    let imported = ws.create_page(new_page("Book club")).await.unwrap();
    let detached = ws.create_page(new_page("Five-a-side")).await.unwrap();
    for id in [&native.id, &imported.id, &detached.id] {
        ws.set_recurrence(
            id.clone(),
            "FREQ=WEEKLY;BYDAY=MO".to_string(),
            "2026-03-02T09:00:00".to_string(),
            None,
            "UTC".to_string(),
        )
        .await
        .unwrap();
    }
    link_to_a_calendar(&tmp.path, &imported.id).await;
    link_to_a_calendar(&tmp.path, &detached.id).await;
    detach_from_its_calendar(&tmp.path, &detached.id).await;

    let entries = ws
        .calendar_range("2026-03-23".to_string(), "2026-03-29".to_string())
        .await
        .unwrap();

    let of = |page_id: &str| {
        entries
            .iter()
            .find(|e| e.page_id == page_id)
            .unwrap_or_else(|| panic!("both series project onto this week"))
    };
    assert!(
        of(&imported.id).is_synced_origin,
        "an occurrence of an imported series is completable on its own"
    );
    assert!(
        of(&detached.id).is_synced_origin,
        "and so is one of a series that was imported and then unlinked — this is \
         the case that separates origin from whether the schedule is locked"
    );
    assert!(
        !of(&native.id).is_synced_origin,
        "an occurrence of a native series is not — it funnels to the head"
    );
}

/// Unlink a page from its calendar, leaving the link row behind.
///
/// Which is the whole point of a detached series: the page remembers where it
/// came from, and nothing upstream governs it any more.
async fn detach_from_its_calendar(path: &str, page_id: &str) {
    let pool = pikos_db::open_pool(path).await.unwrap();
    sqlx::query("UPDATE page_sync SET sync_state = 'detached' WHERE page_id = ?")
        .bind(page_id)
        .execute(&pool)
        .await
        .unwrap();
}

/// Moving one occurrence out of a native series.
///
/// The third verb, and the only one that changes the series rather than a set
/// membership. A native occurrence has no upstream to reclaim its date, so it
/// leaves: it becomes an ordinary page at the new time, and the date it came
/// from joins the rule's exclusions so nothing is drawn twice.
#[tokio::test]
async fn moving_one_occurrence_detaches_it_and_leaves_the_series_alone() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let series = ws.create_page(new_page("Standup")).await.unwrap();
    ws.set_recurrence(
        series.id.clone(),
        "FREQ=WEEKLY;BYDAY=MO".to_string(),
        "2026-03-02T09:00:00".to_string(),
        None,
        "UTC".to_string(),
    )
    .await
    .unwrap();

    let before = ws
        .calendar_range("2026-03-23".to_string(), "2026-03-29".to_string())
        .await
        .unwrap();
    let monday = before
        .iter()
        .find(|e| e.original_date.as_deref() == Some("2026-03-23"))
        .expect("the series projects onto the visible Monday");
    let rule_id = monday
        .rule_id
        .clone()
        .expect("a projected block names the rule that made it");

    ws.move_occurrence(
        rule_id,
        "2026-03-23".to_string(),
        "2026-03-25T14:00:00".to_string(),
        Some("2026-03-25T15:30:00".to_string()),
        "UTC".to_string(),
    )
    .await
    .unwrap();

    let after = ws
        .calendar_range("2026-03-23".to_string(), "2026-03-29".to_string())
        .await
        .unwrap();
    assert!(
        !after
            .iter()
            .any(|e| e.original_date.as_deref() == Some("2026-03-23")),
        "the Monday it came from stops being drawn — otherwise it is there twice"
    );
    let moved = after
        .iter()
        .find(|e| e.scheduled_start == "2026-03-25T14:00:00")
        .expect("and it is drawn where it went");
    assert_ne!(
        moved.page_id, series.id,
        "a native move makes an independent page, not a block of the series"
    );
    assert_eq!(
        moved.scheduled_end.as_deref(),
        Some("2026-03-25T15:30:00"),
        "for as long as it was asked to run — a dropped end draws a block of the \
         default height, which reads as the calendar guessing"
    );
    assert!(
        !moved.is_recurring,
        "which no longer repeats — later edits to the rule do not reach it"
    );
    assert_eq!(moved.title, "Standup", "it keeps what it was");
}

/// A calendar's times are the calendar's.
///
/// `reschedule_virtual_occurrence_impl` refuses an active mirror before it opens
/// a transaction, and the iOS menu leaves the entry out rather than offering it
/// and explaining the refusal — which is only possible because `CalendarEntry`
/// carries the lock.
#[tokio::test]
async fn an_occurrence_of_a_live_mirror_cannot_be_moved() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let series = ws.create_page(new_page("Book club")).await.unwrap();
    ws.set_recurrence(
        series.id.clone(),
        "FREQ=WEEKLY;BYDAY=MO".to_string(),
        "2026-03-02T19:00:00".to_string(),
        None,
        "UTC".to_string(),
    )
    .await
    .unwrap();
    link_to_a_calendar(&tmp.path, &series.id).await;

    let entries = ws
        .calendar_range("2026-03-23".to_string(), "2026-03-29".to_string())
        .await
        .unwrap();
    let monday = entries
        .iter()
        .find(|e| e.original_date.as_deref() == Some("2026-03-23"))
        .expect("a mirrored series is still drawn");
    assert!(
        monday.schedule_locked,
        "and it says so, which is what lets the menu withhold the move"
    );

    let refused = ws
        .move_occurrence(
            monday.rule_id.clone().unwrap(),
            "2026-03-23".to_string(),
            "2026-03-25T14:00:00".to_string(),
            None,
            "UTC".to_string(),
        )
        .await;
    assert!(refused.is_err(), "and the workspace refuses it regardless");

    let after = ws
        .calendar_range("2026-03-23".to_string(), "2026-03-29".to_string())
        .await
        .unwrap();
    assert!(
        after
            .iter()
            .any(|e| e.original_date.as_deref() == Some("2026-03-23")),
        "with nothing half-written: the occurrence is still on its own Monday"
    );
}

/// Only a projection carries a rule. A real block has a row to move instead.
#[tokio::test]
async fn a_real_block_names_no_rule_to_move_it_by() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let series = ws.create_page(new_page("Standup")).await.unwrap();
    ws.set_recurrence(
        series.id.clone(),
        "FREQ=WEEKLY;BYDAY=MO".to_string(),
        "2026-03-23T09:00:00".to_string(),
        None,
        "UTC".to_string(),
    )
    .await
    .unwrap();

    let entries = ws
        .calendar_range("2026-03-23".to_string(), "2026-04-05".to_string())
        .await
        .unwrap();
    let head = entries
        .iter()
        .find(|e| !e.is_virtual)
        .expect("the head's own occurrence is drawn from its row");
    assert!(head.rule_id.is_none());
    let projected = entries
        .iter()
        .find(|e| e.is_virtual)
        .expect("and the weeks after it are projected");
    assert!(
        projected.rule_id.is_some(),
        "a projection has to name the rule, or it cannot be moved out of it"
    );
}

// ─── Search operators ────────────────────────────────────────────────────────
//
// The grammar itself — which tokens are operators, and what each one means — is
// `pikos-core`'s, graded there against the TypeScript it replaces. What these
// cover is the half that only exists here: turning a parsed query into a
// storage filter, intersecting it with full-text search, and the several ways
// that can quietly answer a different question than the one asked.

/// Seeds one page with everything an operator can narrow on.
async fn tagged_page(
    ws: &Workspace,
    title: &str,
    folder_id: Option<String>,
    tags: &[&str],
    priority: i64,
    scheduled_start: Option<&str>,
) -> String {
    let page = ws
        .create_page(NewPage {
            title: title.to_string(),
            folder_id: folder_id.clone(),
            content: None,
            tags: Some(tags.iter().map(|t| t.to_string()).collect()),
            scheduled_start: scheduled_start.map(str::to_string),
            scheduled_end: None,
        })
        .await
        .unwrap();
    if priority != 0 {
        ws.update_page(
            page.id.clone(),
            PageEdit {
                priority: Some(priority),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }
    page.id
}

#[tokio::test]
async fn a_tag_operator_narrows_to_that_tag() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let wanted = tagged_page(&ws, "Quarterly report", None, &["work"], 0, None).await;
    tagged_page(&ws, "Quarterly recipe", None, &["home"], 0, None).await;

    let hits = ws
        .search("tag:work quarterly".to_string(), 10)
        .await
        .unwrap();
    let ids: Vec<&str> = hits.iter().map(|h| h.page_id.as_str()).collect();
    assert_eq!(
        ids,
        [wanted.as_str()],
        "both pages match the words; only one matches the tag"
    );
}

/// Two tags mean both, not either.
#[tokio::test]
async fn tags_are_matched_conjunctively() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let both = tagged_page(&ws, "Release plan", None, &["work", "urgent"], 0, None).await;
    tagged_page(&ws, "Release notes", None, &["work"], 0, None).await;

    let hits = ws
        .search("tag:work tag:urgent release".to_string(), 10)
        .await
        .unwrap();
    let ids: Vec<&str> = hits.iter().map(|h| h.page_id.as_str()).collect();
    assert_eq!(ids, [both.as_str()]);
}

/// A folder named by part of its name, which is how anybody types one.
#[tokio::test]
async fn a_folder_operator_matches_a_folder_by_a_prefix_of_its_name() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let folder = ws.create_folder("Work".to_string(), None).await.unwrap();
    let inside = tagged_page(&ws, "Standup notes", Some(folder.id.clone()), &[], 0, None).await;
    tagged_page(&ws, "Standup shoes", None, &[], 0, None).await;

    let hits = ws
        .search("folder:wor standup".to_string(), 10)
        .await
        .unwrap();
    let ids: Vec<&str> = hits.iter().map(|h| h.page_id.as_str()).collect();
    assert_eq!(ids, [inside.as_str()]);
}

/// `folder:inbox` is not a folder, and has to be spelled out.
#[tokio::test]
async fn the_inbox_is_the_pages_with_no_folder_at_all() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let folder = ws.create_folder("Work".to_string(), None).await.unwrap();
    let loose = tagged_page(&ws, "Standup notes", None, &[], 0, None).await;
    tagged_page(&ws, "Standup agenda", Some(folder.id), &[], 0, None).await;

    let hits = ws
        .search("folder:inbox standup".to_string(), 10)
        .await
        .unwrap();
    let ids: Vec<&str> = hits.iter().map(|h| h.page_id.as_str()).collect();
    assert_eq!(ids, [loose.as_str()]);
}

/// A folder name nothing matches narrows to nothing.
///
/// The failure worth guarding: dropping an unresolvable filter returns the
/// *unfiltered* set, which looks like a working search and answers a question
/// nobody asked.
#[tokio::test]
async fn a_folder_that_does_not_exist_matches_nothing_rather_than_everything() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    tagged_page(&ws, "Standup notes", None, &[], 0, None).await;

    let hits = ws
        .search("folder:nowhere standup".to_string(), 10)
        .await
        .unwrap();
    assert!(hits.is_empty(), "got {} hits", hits.len());
}

/// Finished work stays out of the way unless it is what was asked for.
#[tokio::test]
async fn done_pages_are_withheld_until_the_query_asks_for_them() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let finished = tagged_page(&ws, "Ship the release", None, &["work"], 0, None).await;
    let open = tagged_page(&ws, "Plan the release", None, &["work"], 0, None).await;
    ws.set_page_status(finished.clone(), true).await.unwrap();

    let default = ws.search("tag:work release".to_string(), 10).await.unwrap();
    assert_eq!(
        default.iter().map(|h| &h.page_id).collect::<Vec<_>>(),
        vec![&open],
        "a tag search is about outstanding work"
    );

    let asked = ws
        .search("tag:work is:done release".to_string(), 10)
        .await
        .unwrap();
    assert_eq!(
        asked.iter().map(|h| &h.page_id).collect::<Vec<_>>(),
        vec![&finished],
        "and `is:done` is how you ask for the rest"
    );
}

#[tokio::test]
async fn a_priority_operator_narrows_to_that_priority() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let urgent = tagged_page(&ws, "Fix the outage", None, &[], 1, None).await;
    tagged_page(&ws, "Fix the typo", None, &[], 4, None).await;

    let hits = ws
        .search("priority:urgent fix".to_string(), 10)
        .await
        .unwrap();
    let ids: Vec<&str> = hits.iter().map(|h| h.page_id.as_str()).collect();
    assert_eq!(ids, [urgent.as_str()]);
}

/// A date window, and the two things it has to exclude: what falls outside it,
/// and what has no date at all.
#[tokio::test]
async fn a_due_window_excludes_both_the_far_future_and_the_undated() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let today = pikos_db::today_local();
    let inside = tagged_page(&ws, "Report draft", None, &[], 0, Some(&today)).await;
    tagged_page(&ws, "Report final", None, &[], 0, Some("2099-01-01")).await;
    tagged_page(&ws, "Report someday", None, &[], 0, None).await;

    let hits = ws.search("due:today report".to_string(), 10).await.unwrap();
    let ids: Vec<&str> = hits.iter().map(|h| h.page_id.as_str()).collect();
    assert_eq!(ids, [inside.as_str()]);
}

/// `is:scheduled` means "has a date", whatever the date is.
///
/// The only operator whose whole effect is the `has_schedule` flag — every
/// other one that sets it also sets a date bound, and in SQLite a date bound
/// drops undated rows on the NULL comparison by itself. So without a case here
/// the flag can be removed entirely and nothing notices.
#[tokio::test]
async fn is_scheduled_keeps_only_the_pages_that_have_a_date() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let dated = tagged_page(&ws, "Report draft", None, &[], 0, Some("2099-01-01")).await;
    tagged_page(&ws, "Report someday", None, &[], 0, None).await;

    let hits = ws
        .search("is:scheduled report".to_string(), 10)
        .await
        .unwrap();
    let ids: Vec<&str> = hits.iter().map(|h| h.page_id.as_str()).collect();
    assert_eq!(ids, [dated.as_str()]);
}

/// A query that is only operators still returns the pages they describe.
///
/// The path with no words left for full-text search to rank. Getting it wrong
/// gives an empty result for a query that plainly describes something, which
/// reads as "there is nothing tagged work".
#[tokio::test]
async fn a_query_of_nothing_but_operators_still_answers() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let wanted = tagged_page(&ws, "Anything at all", None, &["work"], 0, None).await;
    tagged_page(&ws, "Something else", None, &["home"], 0, None).await;

    let hits = ws.search("tag:work".to_string(), 10).await.unwrap();
    let ids: Vec<&str> = hits.iter().map(|h| h.page_id.as_str()).collect();
    assert_eq!(ids, [wanted.as_str()]);
}

/// One leftover letter is matched on the title rather than thrown away.
///
/// FTS5 needs at least two characters to prefix-match on, so a single one
/// cannot go to the index. Dropping it instead would silently widen the query:
/// "tag:work a" would return everything tagged work, which is a different
/// question and looks like a working search.
#[tokio::test]
async fn a_single_leftover_character_still_narrows() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let matching = tagged_page(&ws, "Zebra", None, &["work"], 0, None).await;
    tagged_page(&ws, "Quilt", None, &["work"], 0, None).await;

    let hits = ws.search("tag:work z".to_string(), 10).await.unwrap();
    let ids: Vec<&str> = hits.iter().map(|h| h.page_id.as_str()).collect();
    assert_eq!(ids, [matching.as_str()]);
}

/// A value the grammar rejects leaves the whole token as text.
///
/// `priority:9` is the sharp case: the keyword is real and the value is not.
/// Accepting it — clamping 9 to something, or shrugging and applying no
/// priority — sends the query down the structured path with an empty filter,
/// which matches *everything*. Leaving it as text sends it to full-text search,
/// which looks for the words "priority" and "9" and finds neither. The two
/// answers could not be further apart, and only one of them is honest.
#[tokio::test]
async fn a_rejected_operator_value_leaves_the_token_as_text() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    tagged_page(&ws, "Fix the outage", None, &[], 1, None).await;
    tagged_page(&ws, "Write the notes", None, &[], 0, None).await;

    let hits = ws.search("priority:9".to_string(), 10).await.unwrap();
    assert!(
        hits.is_empty(),
        "9 is not a priority, so this is a search for two words that appear nowhere: got {:?}",
        hits.iter().map(|h| &h.title).collect::<Vec<_>>()
    );

    // The same shape with a value the grammar *does* know narrows instead of
    // matching nothing — which is what makes the assertion above about the
    // value, and not about the path being broken.
    let hits = ws.search("priority:urgent".to_string(), 10).await.unwrap();
    assert_eq!(
        hits.iter().map(|h| h.title.as_str()).collect::<Vec<_>>(),
        ["Fix the outage"]
    );
}

/// A keyword the grammar does not have is a word.
#[tokio::test]
async fn an_unknown_operator_is_searched_for_rather_than_obeyed() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    tagged_page(&ws, "Fix the outage", None, &[], 1, None).await;
    let page = ws
        .create_page(new_page("Aspect ratio notes"))
        .await
        .unwrap();
    ws.update_page(
        page.id.clone(),
        PageEdit {
            content: Some(r#"{"type":"doc"}"#.to_string()),
            content_text: Some("the ratio is 1.5 across".to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    // FTS5 splits on the punctuation, so this searches for "ratio", "1" and
    // "5" — all of which that page has, and the other page has none of. A port
    // that swallowed `ratio:` as an operator would take the structured path
    // with an empty filter and hand back both.
    let hits = ws.search("ratio:1.5".to_string(), 10).await.unwrap();
    assert_eq!(
        hits.iter().map(|h| h.page_id.as_str()).collect::<Vec<_>>(),
        [page.id.as_str()],
        "an unrecognised token stays in the query as text"
    );
}

// ─── Clearing the overdue backlog ────────────────────────────────────────────
//
// The date arithmetic is `pikos-core`'s and graded there. What these cover is
// this layer's half: which pages the button is allowed to act on, that the
// writes actually landed, and that the undo puts back exactly what moved.

/// Dates a page in the past, which `create_page` will not do on its own.
async fn overdue_page(ws: &Workspace, title: &str, start: &str, end: Option<&str>) -> String {
    let page = ws.create_page(new_page(title)).await.unwrap();
    ws.set_page_schedule(page.id.clone(), start.to_string(), end.map(str::to_string))
        .await
        .unwrap();
    page.id
}

/// Yesterday, and the day before, as the workspace's own local clock sees them.
fn days_ago(days: i64) -> String {
    let (today, _) = pikos_db::now_local_parts();
    let parsed = pikos_core::dates::parse_local_iso(&today).expect("today parses");
    pikos_core::dates::format_date_only(&(parsed - chrono::Duration::days(days)))
}

#[tokio::test]
async fn the_bulk_move_lands_every_overdue_page_on_today_and_keeps_its_shape() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let today = pikos_db::today_local();

    let all_day = overdue_page(&ws, "Tax return", &days_ago(5), None).await;
    let timed = overdue_page(
        &ws,
        "Standup",
        &format!("{}T08:00:00", days_ago(3)),
        Some(&format!("{}T09:00:00", days_ago(3))),
    )
    .await;

    let result = ws.move_overdue_to_today().await.unwrap();
    assert_eq!(result.moved.len(), 2, "{}", result.label);

    let moved_all_day = ws.get_page(all_day).await.unwrap();
    assert_eq!(
        moved_all_day.scheduled_start.as_deref(),
        Some(today.as_str()),
        "an all-day page lands on today as an all-day page, not at midnight"
    );

    let moved_timed = ws.get_page(timed).await.unwrap();
    assert_eq!(
        moved_timed.scheduled_start.as_deref(),
        Some(format!("{today}T08:00:00").as_str()),
        "and a timed one keeps its hour"
    );
    assert_eq!(
        moved_timed.scheduled_end.as_deref(),
        Some(format!("{today}T09:00:00").as_str()),
        "along with its length — an end left behind makes a one-hour meeting three days long"
    );
}

/// What the button must not touch, and must say it did not touch.
#[tokio::test]
async fn a_recurring_series_and_a_calendars_page_are_left_where_they_are() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();

    let plain = overdue_page(&ws, "Tax return", &days_ago(5), None).await;

    let series = ws.create_page(new_page("Standup")).await.unwrap();
    ws.set_recurrence(
        series.id.clone(),
        "FREQ=DAILY".to_string(),
        format!("{}T09:00:00", days_ago(4)),
        None,
        "UTC".to_string(),
    )
    .await
    .unwrap();

    let mirrored = overdue_page(&ws, "Book club", &format!("{}T19:00:00", days_ago(2)), None).await;
    link_to_a_calendar(&tmp.path, &mirrored).await;

    let before_series = ws
        .get_page(series.id.clone())
        .await
        .unwrap()
        .scheduled_start;
    let before_mirror = ws.get_page(mirrored.clone()).await.unwrap().scheduled_start;

    let result = ws.move_overdue_to_today().await.unwrap();

    assert_eq!(
        result.moved.iter().map(|m| &m.page_id).collect::<Vec<_>>(),
        vec![&plain],
        "only the ordinary page moves"
    );
    assert_eq!(result.recurring_kept, 1);
    assert_eq!(result.synced_kept, 1);
    assert_eq!(
        result.label, "Moved 1 · 1 recurring, 1 synced left",
        "and the sentence names both, or the user thinks it moved everything"
    );
    assert_eq!(
        ws.get_page(series.id).await.unwrap().scheduled_start,
        before_series,
        "dragging a series anchor forward erases the gap rather than resolving it"
    );
    assert_eq!(
        ws.get_page(mirrored).await.unwrap().scheduled_start,
        before_mirror,
        "and a calendar's times are not ours"
    );
}

/// Nothing overdue is a sentence, not an empty result the caller has to
/// interpret.
#[tokio::test]
async fn a_clear_backlog_reports_that_there_was_nothing_to_do() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    overdue_page(&ws, "Next week", "2099-01-01", None).await;

    let result = ws.move_overdue_to_today().await.unwrap();
    assert!(result.moved.is_empty());
    assert_eq!(result.label, "Nothing to move");
}

/// A series that is not late is not "left behind".
///
/// The subtle one. Both reasons a page is kept are *counted* and shown, so the
/// set handed to the planner has to be the overdue section and nothing else. A
/// caller that passes every scheduled page instead still moves the right pages
/// — the planner refuses a shift into the past — but reports "1 recurring left"
/// about a standup happening next Tuesday, which reads as a refusal to do
/// something nobody asked for.
#[tokio::test]
async fn a_series_dated_ahead_is_not_counted_as_left_behind() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();

    let series = ws.create_page(new_page("Standup")).await.unwrap();
    ws.set_recurrence(
        series.id.clone(),
        "FREQ=DAILY".to_string(),
        "2099-03-02T09:00:00".to_string(),
        None,
        "UTC".to_string(),
    )
    .await
    .unwrap();

    let mirrored = overdue_page(&ws, "Book club", "2099-04-01T19:00:00", None).await;
    link_to_a_calendar(&tmp.path, &mirrored).await;

    let result = ws.move_overdue_to_today().await.unwrap();
    assert_eq!(result.recurring_kept, 0);
    assert_eq!(result.synced_kept, 0);
    assert_eq!(
        result.label, "Nothing to move",
        "nothing was late, so nothing stayed behind"
    );
}

/// A finished page is not a backlog.
#[tokio::test]
async fn the_bulk_move_leaves_completed_pages_alone() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let done = overdue_page(&ws, "Already handled", &days_ago(5), None).await;
    let was = ws.get_page(done.clone()).await.unwrap().scheduled_start;
    ws.set_page_status(done.clone(), true).await.unwrap();

    let result = ws.move_overdue_to_today().await.unwrap();
    assert!(result.moved.is_empty(), "{}", result.label);
    assert_eq!(
        ws.get_page(done).await.unwrap().scheduled_start,
        was,
        "a page that is done is not late"
    );
}

/// The undo, and the reason the move asks for no confirmation.
#[tokio::test]
async fn undoing_the_bulk_move_puts_every_page_back_where_it_was() {
    let tmp = TempWorkspace::new();
    let ws = Workspace::open(tmp.path.clone()).await.unwrap();
    let start = format!("{}T08:00:00", days_ago(3));
    let end = format!("{}T09:30:00", days_ago(3));
    let page = overdue_page(&ws, "Standup", &start, Some(&end)).await;

    let result = ws.move_overdue_to_today().await.unwrap();
    assert_eq!(result.moved.len(), 1);
    assert_ne!(
        ws.get_page(page.clone())
            .await
            .unwrap()
            .scheduled_start
            .as_deref(),
        Some(start.as_str()),
        "precondition: it moved"
    );

    let restored = ws.undo_overdue_move(result.moved).await.unwrap();
    assert_eq!(restored, 1);

    let back = ws.get_page(page).await.unwrap();
    assert_eq!(back.scheduled_start.as_deref(), Some(start.as_str()));
    assert_eq!(
        back.scheduled_end.as_deref(),
        Some(end.as_str()),
        "the end comes back too, or undo silently shortens the meeting"
    );
}
