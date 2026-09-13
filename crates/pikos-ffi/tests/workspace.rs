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
