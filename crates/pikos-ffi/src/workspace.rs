//! The database, as Swift sees it.
//!
//! A thin async wrapper over `pikos-db`, which is the single writer behind the
//! desktop app and the CLI already. Nothing here reimplements storage logic —
//! that would be a second writer, and a second writer is how two clients end up
//! disagreeing about what a page is.
//!
//! ## Where the file lives is the caller's business
//!
//! [`Workspace::open`] takes a path. On iOS it will be inside the App Group
//! container so widget extensions can read the same database, but that
//! container's identifier is a provisioning concern, not a data-layer one, and
//! putting it here would bake a build setting into a Rust crate.
//!
//! ## One writer
//!
//! The plan's rule is one writer in the app process, extensions read-only, WAL
//! mode. [`ReadOnlyWorkspace`] exists so that rule is enforced by the type a
//! widget can get hold of, rather than by everyone remembering it. WAL comes
//! from `pikos_db::open_pool`, which the desktop app has used since the
//! beginning.

use std::sync::Arc;

use pikos_core::calendar::occurrences::{
    virtual_occurrences_in_range, OverrideRow, SeriesPage, SeriesRule,
};
use pikos_core::dates::{next_day, parse_local_iso};
use pikos_core::nlp::quick_add::ParseResult as QuickAddParse;

use crate::{CalendarEntry, RecurringCompletion};
use pikos_db::{
    AppError, NewPage as DbNewPage, PageFilter as DbPageFilter, PageUpdate as DbPageUpdate,
};

// ─── Errors ──────────────────────────────────────────────────────────────────

/// What can go wrong, in terms Swift can act on.
///
/// Deliberately coarse. Swift's realistic responses are "tell the user",
/// "retry" and "this is a bug", and a fine-grained enum here would invite
/// `switch` statements that add nothing. The message carries the detail for
/// logs and bug reports.
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum WorkspaceError {
    /// The workspace could not be opened — a bad path, a corrupt file, or a
    /// migration that failed. Not retryable without changing something.
    #[error("could not open the workspace: {message}")]
    Open { message: String },

    /// The requested row does not exist. Distinct from a failure because it is
    /// routine: a widget can hold a page id that has since been deleted.
    #[error("{entity} {id} was not found")]
    NotFound { entity: String, id: String },

    /// Everything else the data layer reported.
    #[error("{message}")]
    Database { message: String },

    /// A write was attempted through a read-only handle. A programming error
    /// rather than a runtime condition — see the note on `ReadOnlyWorkspace`.
    #[error("this workspace is read-only")]
    ReadOnly,

    /// An argument could not be used — a reference time that is not a
    /// wall-clock datetime, say. Distinct from `Database` because nothing is
    /// wrong with the workspace: the call was malformed and retrying it
    /// unchanged will fail the same way.
    #[error("{message}")]
    InvalidInput { message: String },

    /// The workspace understood the request and declined it — filing a page
    /// into a folder a calendar owns, say.
    ///
    /// Distinct from `Database` because nothing failed. Collapsing the two
    /// showed the user "could not read or write" over a message that already
    /// explained itself, which reads as a fault in the app rather than a rule
    /// it is enforcing.
    #[error("{message}")]
    Refused { message: String },

    /// The network was the problem — a server that did not answer, a name that
    /// did not resolve, a phone with no signal.
    ///
    /// Distinct because it is the one failure here that is worth retrying
    /// unchanged, and the only one where "try again" is honest advice. Folded
    /// into `Database` it would tell somebody on a train that their workspace
    /// is broken.
    #[error("{message}")]
    Network { message: String },
}

impl From<AppError> for WorkspaceError {
    fn from(error: AppError) -> Self {
        match error {
            // The data layer's conflicts carry a sentence written for a user —
            // "Pages cannot be moved into an external calendar folder" — so it
            // is passed through rather than wrapped in a failure message.
            AppError::Conflict(message) => WorkspaceError::Refused { message },
            // Sync is the only caller that can produce one of these, and it is
            // the difference between "your calendar server is unreachable" and
            // "your notes are damaged".
            AppError::Network(message) => WorkspaceError::Network { message },
            other => WorkspaceError::Database {
                message: other.to_string(),
            },
        }
    }
}

// ─── Records ─────────────────────────────────────────────────────────────────

/// A page without its content, for list and calendar screens.
///
/// Content is excluded on purpose: a list of several hundred pages would
/// otherwise carry every document across the FFI boundary to render titles.
#[derive(Debug, uniffi::Record)]
pub struct PageSummary {
    pub id: String,
    pub folder_id: Option<String>,
    pub title: String,
    pub subtitle: Option<String>,
    pub status: String,
    pub priority: i64,
    pub tags: Vec<String>,
    pub sort_order: i64,
    /// Local wall-clock ISO string. See the note on dates in `lib.rs`.
    pub scheduled_start: Option<String>,
    pub scheduled_end: Option<String>,
    pub completed_at: Option<String>,
    pub parent_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// Whether this page repeats.
    ///
    /// Carried because the UI cannot complete a page correctly without knowing:
    /// setting `status` on a recurring head ends the series instead of
    /// completing one occurrence of it. Cheaper than the alternative of asking
    /// per row, and the one flag that changes what a checkbox means.
    pub is_recurring: bool,
    /// True while a calendar owns this page's schedule.
    ///
    /// Carried for the same reason as `is_recurring`: it changes what the UI may
    /// offer, not just what it draws. A locked page's title and dates belong to
    /// the calendar, so rename, move and clear-date are refused at the data
    /// layer — and a menu entry whose only outcome is an error message should
    /// not be shown at all. Derived per row by the summary query, not stored.
    pub schedule_locked: bool,
}

impl From<pikos_db::PageSummary> for PageSummary {
    fn from(p: pikos_db::PageSummary) -> Self {
        PageSummary {
            id: p.id,
            folder_id: p.folder_id,
            title: p.title,
            subtitle: p.subtitle,
            status: p.status,
            priority: p.priority,
            tags: p.tags,
            sort_order: p.sort_order,
            scheduled_start: p.scheduled_start,
            scheduled_end: p.scheduled_end,
            completed_at: p.completed_at,
            parent_id: p.parent_id,
            created_at: p.created_at,
            updated_at: p.updated_at,
            is_recurring: p.is_recurring,
            schedule_locked: p.schedule_locked,
        }
    }
}

/// A page with its document.
#[derive(Debug, uniffi::Record)]
pub struct Page {
    pub id: String,
    pub folder_id: Option<String>,
    pub title: String,
    pub subtitle: Option<String>,
    /// The Tiptap document, as JSON text. Swift never parses it — it hands it
    /// to the editor webview and stores whatever comes back.
    pub content: String,
    pub status: String,
    pub priority: i64,
    pub tags: Vec<String>,
    pub scheduled_start: Option<String>,
    pub scheduled_end: Option<String>,
    pub completed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// Which editor schema wrote `content`. A client finding a version above
    /// its own must not save over the document — see pikos-db migration 013.
    pub content_schema_version: i64,
}

impl From<pikos_db::Page> for Page {
    fn from(p: pikos_db::Page) -> Self {
        Page {
            id: p.id,
            folder_id: p.folder_id,
            title: p.title,
            subtitle: p.subtitle,
            content: p.content,
            status: p.status,
            priority: p.priority,
            tags: p.tags,
            scheduled_start: p.scheduled_start,
            scheduled_end: p.scheduled_end,
            completed_at: p.completed_at,
            created_at: p.created_at,
            updated_at: p.updated_at,
            content_schema_version: p.content_schema_version,
        }
    }
}

/// A page in the trash, as the recovery list shows it.
#[derive(Debug, uniffi::Record)]
pub struct TrashedPage {
    pub id: String,
    pub title: String,
    /// The folder it would return to. `None` for the Inbox, and also when its
    /// folder was trashed alongside it — there is no surviving name to show,
    /// and restoring the page alone would not bring the folder back.
    pub folder_name: Option<String>,
    /// When it was trashed, UTC. Drives both the "deleted N days ago" label and
    /// the auto-purge clock.
    pub deleted_at: String,
    /// True while the page still exists in a calendar upstream. Such a row
    /// carries the tombstone that suppresses the upstream event, so the trash
    /// cannot destroy it — deleting it outright would hand the next sync pass a
    /// page to resurrect. Restoring one gives it back to its calendar.
    pub is_synced: bool,
}

#[derive(Debug, uniffi::Record)]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub sort_order: i64,
    /// True for a folder that mirrors a synced calendar.
    ///
    /// Pikos manages it, and the data layer enforces that: it cannot be deleted
    /// and nothing can be filed into it. Carried across so the UI can leave it
    /// out of a folder picker rather than offering a choice that will be
    /// refused.
    pub is_external_calendar: bool,
}

/// Which folder a listing is scoped to.
///
/// The data layer models this as an optional JSON value where absent means
/// "any" and null means "inbox" — a tri-state that does not survive an FFI
/// boundary, and reads as a trap even in Rust. Three named cases instead.
#[derive(Debug, uniffi::Enum)]
pub enum FolderScope {
    /// Every folder, and the inbox.
    Any,
    /// Only pages with no folder.
    Inbox,
    /// One specific folder.
    Folder { id: String },
}

/// Which finished pages a "Completed" section should show.
///
/// One case per view rather than a generic filter, because the views do not ask
/// the same question and a caller assembling the filter itself would have to
/// know that. A date view's Completed means *completed today* across every
/// folder — the things that left its sections since this morning; a folder's
/// means everything ever finished in it. Passing "today" for a folder view
/// would hide last week's work; passing a folder for Today would hide the rest
/// of what was ticked off today.
#[derive(Debug, uniffi::Enum)]
pub enum CompletedScope {
    /// Completed today, in any folder — what Today and Upcoming mean by it.
    Today,
    /// Everything ever completed with no folder.
    Inbox,
    /// Everything ever completed in one folder.
    Folder { id: String },
}

// ─── External calendars ──────────────────────────────────────────────────────
//
// What reaches the phone, and what deliberately does not.
//
// CalDAV account management and a manual sync are plain async functions over
// the pool and the OS keychain, so they port unchanged. Two things do not, and
// both are structural rather than unfinished:
//
//   - **Google.** The grant waits on a loopback TCP listener inside the app
//     process. Leaving for the browser starts iOS suspending that process, so
//     the wait outlives the app. It needs `ASWebAuthenticationSession`; the
//     PKCE half is transport-agnostic and ports as-is when somebody builds it.
//   - **Background polling.** `run_sync_loop` is an in-process timer, which
//     iOS suspends within seconds of backgrounding. Every sync here is one the
//     user asked for, by hand, with the app open.
//
// So this surface is honest about being manual. `docs/ios/06-platform-audit.md`
// has the detail.

/// One connected calendar account.
#[derive(Debug, uniffi::Record)]
pub struct SyncAccount {
    pub id: String,
    /// `caldav` or `google`. Google accounts can appear here — the desktop may
    /// have connected one against the same workspace — but cannot be created
    /// or repaired from the phone.
    pub provider: String,
    /// What the user calls it: an email, or server·username for CalDAV.
    pub display_name: String,
    pub auth_kind: String,
    pub created_at: String,
    /// Set when a poll hit a rejected credential. The account is then skipped
    /// entirely until somebody fixes it, so a screen that does not surface this
    /// shows an account that looks connected and silently syncs nothing.
    pub reconnect_needed: bool,
}

/// One calendar inside an account.
#[derive(Debug, uniffi::Record)]
pub struct SyncCalendar {
    pub id: String,
    pub account_id: String,
    pub display_name: String,
    /// Hex, as the server gave it. `None` when the server said nothing.
    pub color: Option<String>,
    pub enabled: bool,
    pub last_synced_at: Option<String>,
    /// The folder this calendar's events mirror into, once it has one.
    pub folder_id: Option<String>,
    /// How many pages this calendar left behind when it was switched off —
    /// ones the user had edited, so they were kept rather than deleted.
    /// Switching it back on reclaims them and the calendar's values win, which
    /// is worth confirming first. Zero means there is nothing to ask about.
    pub detached_pages: i64,
}

/// An account and its calendars — the shape the settings screen reads.
#[derive(Debug, uniffi::Record)]
pub struct SyncAccountWithCalendars {
    pub account: SyncAccount,
    pub calendars: Vec<SyncCalendar>,
}

/// How one calendar's sync went.
#[derive(Debug, uniffi::Record)]
pub struct CalendarSyncResult {
    pub calendar_id: String,
    /// `synced`, `offline`, or `reconnectNeeded`.
    ///
    /// A string rather than an enum because it is the data layer's own
    /// vocabulary and the desktop already branches on these exact spellings;
    /// two enums that must agree across a language boundary is the drift this
    /// avoids.
    pub status: String,
    /// True when the calendar was re-read from scratch rather than from its
    /// cursor.
    pub full_resync: bool,
}

impl From<pikos_db::SyncAccount> for SyncAccount {
    fn from(a: pikos_db::SyncAccount) -> Self {
        SyncAccount {
            id: a.id,
            provider: a.provider,
            display_name: a.display_name,
            auth_kind: a.auth_kind,
            created_at: a.created_at,
            reconnect_needed: a.reconnect_needed,
        }
    }
}

impl From<pikos_db::SyncCalendar> for SyncCalendar {
    fn from(c: pikos_db::SyncCalendar) -> Self {
        SyncCalendar {
            id: c.id,
            account_id: c.account_id,
            display_name: c.display_name,
            color: c.color,
            enabled: c.enabled,
            last_synced_at: c.last_synced_at,
            folder_id: c.folder_id,
            detached_pages: c.detached_pages,
        }
    }
}

impl From<pikos_db::AccountWithCalendars> for SyncAccountWithCalendars {
    fn from(a: pikos_db::AccountWithCalendars) -> Self {
        SyncAccountWithCalendars {
            account: a.account.into(),
            calendars: a.calendars.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<pikos_calendar_sync::CalendarSyncResult> for CalendarSyncResult {
    fn from(r: pikos_calendar_sync::CalendarSyncResult) -> Self {
        CalendarSyncResult {
            calendar_id: r.calendar_id,
            status: r.status,
            full_resync: r.full_resync,
        }
    }
}

// ─── Repeats ─────────────────────────────────────────────────────────────────

/// How often a page repeats.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum RepeatFreq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

/// A repeat in the shape an editor can offer: a frequency, how many of them
/// between runs, and — for a weekly repeat — which days.
///
/// Deliberately narrower than an RRULE. This is the set of rules a picker can
/// round-trip without losing anything; a rule carrying `BYSETPOS`, `BYWEEKNO`
/// or an ordinal weekday cannot be described here, and [`PageRepeat::Fixed`] is
/// what says so instead of quietly flattening it.
#[derive(Debug, Clone, uniffi::Record)]
pub struct Repeat {
    pub freq: RepeatFreq,
    /// 1 is every day/week/month/year, 2 is every other, and so on.
    pub interval: u32,
    /// Weekdays for a weekly repeat: 0 is Monday through 6 is Sunday, matching
    /// what the rule layer stores. Empty for every other frequency, and for a
    /// weekly repeat that names no day — which means "the day it started on".
    ///
    /// `u32` rather than the `u8` the rule layer uses, because UniFFI maps a
    /// `Vec<u8>` to Swift's `Data`. These are weekday numbers, not bytes, and a
    /// caller should not have to build a byte buffer to say "Tuesday".
    pub weekdays: Vec<u32>,
}

/// What a page's repeat is, and whether this editor may change it.
#[derive(Debug, uniffi::Enum)]
pub enum PageRepeat {
    /// The page does not repeat.
    Never,
    /// It repeats, and the rule fits [`Repeat`] exactly.
    Editable { repeat: Repeat, label: String },
    /// It repeats in a way the picker cannot represent.
    ///
    /// Shown, never edited. Offering an editor here is not a cosmetic bug: the
    /// user nudges the interval, the rule is rebuilt through a shape that
    /// cannot hold the terms it had, and the rule that was theirs is gone with
    /// nothing logged. `rrule_edit_would_degrade` is the guard, and a rule a
    /// calendar owns lands here too — that one is upstream's to change.
    Fixed { label: String },
}

/// Today's list, already split into the two sections it is drawn as.
///
/// Split here rather than in the shell because the rule is not a rendering
/// choice: an all-day item stays in "today" until midnight while a timed one
/// slips the moment it passes, and a shell reimplementing that is a second
/// definition of overdue that drifts from this one.
#[derive(Debug, uniffi::Record)]
pub struct TodaySections {
    /// Already slipped, soonest first. Drawn above, because it is the part
    /// worth acting on.
    pub overdue: Vec<PageSummary>,
    /// Due today and not yet passed.
    pub today: Vec<PageSummary>,
}

/// One day of the Upcoming view.
#[derive(Debug, uniffi::Record)]
pub struct UpcomingDay {
    /// `YYYY-MM-DD`. Deliberately not a label: "Today" / "Tomorrow" / "Thu, 27
    /// Aug" is locale work, and the platform does it better than a second
    /// implementation here would.
    pub date: String,
    pub pages: Vec<PageSummary>,
}

/// One page of finished pages, plus how many there are in total.
///
/// `total` is the count matching the scope, not the length of `pages` — it is
/// what lets a "Show more" control know whether there is any more to show
/// without fetching a page to find out.
#[derive(Debug, uniffi::Record)]
pub struct CompletedPages {
    pub pages: Vec<PageSummary>,
    pub total: u32,
}

/// Narrows a page listing. Every field is optional; an all-default filter lists
/// everything not deleted.
#[derive(Debug, Default, uniffi::Record)]
pub struct PageQuery {
    #[uniffi(default = None)]
    pub folder: Option<FolderScope>,
    /// `"not_started"` or `"done"`.
    #[uniffi(default = None)]
    pub status: Option<String>,
    #[uniffi(default = None)]
    pub tags: Option<Vec<String>>,
    /// Substring match on the title. For full-text search across page bodies,
    /// use [`Workspace::search`] instead — this does not touch the FTS index.
    #[uniffi(default = None)]
    pub title_contains: Option<String>,
    /// Inclusive lower bound on `scheduled_start`.
    #[uniffi(default = None)]
    pub scheduled_after: Option<String>,
    /// Inclusive upper bound on `scheduled_start`.
    #[uniffi(default = None)]
    pub scheduled_before: Option<String>,
    /// When true, only pages that have a schedule at all.
    #[uniffi(default = None)]
    pub has_schedule: Option<bool>,
    /// When true, leave out finished pages.
    ///
    /// What a page list means by "the pages in this folder": desktop's every
    /// view filters on `isOpen`, and the finished ones appear in their own
    /// section fed by [`Workspace::list_completed`], ordered by when they were
    /// completed rather than by where the user filed them.
    #[uniffi(default = None)]
    pub open_only: Option<bool>,
}

impl From<PageQuery> for DbPageFilter {
    fn from(q: PageQuery) -> Self {
        DbPageFilter {
            // Back to the tri-state the data layer expects: absent for any,
            // JSON null for the inbox, a string for a specific folder.
            folder_id: match q.folder {
                None | Some(FolderScope::Any) => None,
                Some(FolderScope::Inbox) => Some(serde_json::Value::Null),
                Some(FolderScope::Folder { id }) => Some(serde_json::Value::String(id)),
            },
            status: q.status,
            priority: None,
            tags: q.tags,
            query: q.title_contains,
            scheduled_after: q.scheduled_after,
            scheduled_before: q.scheduled_before,
            has_schedule: q.has_schedule,
            open_only: q.open_only,
        }
    }
}

/// Fields to set when creating a page. Anything omitted takes the column
/// default; `content_schema_version` is stamped by the writer and is not
/// settable, so a client cannot claim a document shape it did not produce.
#[derive(Debug, uniffi::Record)]
pub struct NewPage {
    pub title: String,
    #[uniffi(default = None)]
    pub folder_id: Option<String>,
    /// Tiptap JSON. Defaults to an empty document.
    #[uniffi(default = None)]
    pub content: Option<String>,
    #[uniffi(default = None)]
    pub tags: Option<Vec<String>>,
    #[uniffi(default = None)]
    pub scheduled_start: Option<String>,
    #[uniffi(default = None)]
    pub scheduled_end: Option<String>,
}

/// Where a page should be filed. Distinct from [`FolderScope`], which narrows a
/// listing; this one assigns.
#[derive(Debug, uniffi::Enum)]
pub enum FolderAssignment {
    /// Remove the page from any folder, leaving it in the inbox.
    Inbox,
    Folder {
        id: String,
    },
}

/// A partial update. `None` means "leave alone", which is why this cannot use
/// the same type as [`NewPage`] — there, `None` means "use the default".
#[derive(Debug, Default, uniffi::Record)]
pub struct PageEdit {
    #[uniffi(default = None)]
    pub title: Option<String>,
    /// Tiptap JSON. Setting this re-stamps `content_schema_version`.
    #[uniffi(default = None)]
    pub content: Option<String>,
    /// Plain text for the search index. Supply it alongside `content` — the
    /// editor extracts it already, and re-deriving it here would parse the
    /// document a second time.
    #[uniffi(default = None)]
    pub content_text: Option<String>,
    #[uniffi(default = None)]
    pub status: Option<String>,
    #[uniffi(default = None)]
    pub priority: Option<i64>,
    #[uniffi(default = None)]
    pub tags: Option<Vec<String>>,
    /// Absent leaves the page where it is; see [`FolderAssignment`].
    #[uniffi(default = None)]
    pub folder: Option<FolderAssignment>,
}

#[derive(Debug, uniffi::Record)]
pub struct SearchHit {
    pub page_id: String,
    pub title: String,
    /// The matching text with surrounding context.
    pub excerpt: String,
    /// Which column matched — `"title"`, `"body"`, and so on. Lets the UI say
    /// why a result is a result.
    pub match_source: String,
}

/// One page from one parsed line. `schedule` is false for the head of a
/// recurring series, whose date the rule writes instead.
async fn create_quick_add_page(
    workspace: &Workspace,
    input: pikos_core::nlp::quick_add::ParsedInput,
    folder_id: Option<String>,
    schedule: bool,
) -> Result<Page, WorkspaceError> {
    let priority = quick_add_priority(&input.priority);
    let page = workspace
        .create_page(NewPage {
            title: input.title,
            folder_id,
            content: None,
            tags: Some(input.tags),
            scheduled_start: if schedule {
                input.scheduled_start
            } else {
                None
            },
            scheduled_end: if schedule { input.scheduled_end } else { None },
        })
        .await?;

    // Priority is not a `NewPage` field, so it takes a second write. Only
    // when the line actually said something about it — "unchanged" on a
    // brand-new page means the default, which is already what it has.
    let Some(priority) = priority else {
        return Ok(page);
    };
    let updated = pikos_db::update_page_impl(
        &workspace.pool,
        page.id.clone(),
        DbPageUpdate {
            priority: Some(priority),
            ..Default::default()
        },
    )
    .await?;
    Ok(updated.into())
}

/// The stored priority for what a quick-add line said, or `None` when it said
/// nothing. `0` is "no priority", and is what a new page already has, so
/// "cleared" and "unmentioned" differ only for an *existing* page — a
/// distinction this call never has to make, but one the parser preserves so the
/// edit path can.
fn quick_add_priority(
    priority: &Option<Option<pikos_core::nlp::quick_add::Priority>>,
) -> Option<i64> {
    use pikos_core::nlp::quick_add::Priority as P;
    let named = priority.as_ref()?;
    Some(match named {
        Some(P::Urgent) => 1,
        Some(P::High) => 2,
        Some(P::Medium) => 3,
        Some(P::Low) => 4,
        // `!0` — an explicit clear, which on a new page is already the default.
        None => 0,
    })
}

// ─── Workspace ───────────────────────────────────────────────────────────────

/// A read-write handle on a Pikos workspace.
///
/// Exactly one of these should exist per process. SQLite in WAL mode tolerates
/// concurrent readers alongside a single writer, and the app process is that
/// writer; extensions get a [`ReadOnlyWorkspace`].
#[derive(Debug, uniffi::Object)]
pub struct Workspace {
    pool: sqlx::SqlitePool,
}

#[uniffi::export(async_runtime = "tokio")]
impl Workspace {
    /// Open (or create) the workspace at `path`, applying any pending
    /// migrations.
    ///
    /// Migrations run here, which is why this is the app's job and not a
    /// widget's: a widget waking to refresh a timeline must never be the
    /// process that migrates the database.
    #[uniffi::constructor]
    pub async fn open(path: String) -> Result<Arc<Self>, WorkspaceError> {
        let pool = pikos_db::open_pool(&path)
            .await
            .map_err(|e| WorkspaceError::Open {
                message: e.to_string(),
            })?;
        Ok(Arc::new(Workspace { pool }))
    }

    /// The editor schema this build writes. A page whose
    /// `content_schema_version` exceeds this must not be saved over.
    pub fn content_schema_version(&self) -> i64 {
        pikos_db::CONTENT_SCHEMA_VERSION
    }

    pub async fn list_pages(&self, query: PageQuery) -> Result<Vec<PageSummary>, WorkspaceError> {
        let pages = pikos_db::list_pages_impl(&self.pool, Some(query.into())).await?;
        Ok(pages.into_iter().map(Into::into).collect())
    }

    /// Pages scheduled for today, plus anything overdue.
    pub async fn list_today(&self) -> Result<Vec<PageSummary>, WorkspaceError> {
        let pages = pikos_db::list_pages_today_impl(&self.pool).await?;
        Ok(pages.into_iter().map(Into::into).collect())
    }

    /// Today, split into overdue and due-today.
    ///
    /// The same rows [`Workspace::list_today`] returns, grouped and ordered.
    /// Both exist because they answer different questions: a widget wants a
    /// flat list of what is due, and the app wants the sections.
    pub async fn list_today_sections(&self) -> Result<TodaySections, WorkspaceError> {
        let pages: Vec<PageSummary> = pikos_db::list_pages_today_impl(&self.pool)
            .await?
            .into_iter()
            .map(Into::into)
            .collect();
        let (today, now) = pikos_db::now_local_parts();
        let groups = pikos_core::views::group_today(pages, &today, &now, |page| {
            page.scheduled_start.as_deref()
        });
        Ok(TodaySections {
            overdue: groups.overdue,
            today: groups.today,
        })
    }

    /// The week ahead, grouped by day.
    ///
    /// The window is today through today+6 and it deliberately overlaps Today:
    /// a view of what is coming that starts tomorrow leaves the reader
    /// wondering where today went. What it does *not* carry is the overdue
    /// backlog — that is Today's job, and an Upcoming list that repeated it
    /// would be the same list twice.
    ///
    /// Only days holding something get an entry. An empty day is a header that
    /// says nothing the next populated one does not.
    pub async fn list_upcoming(&self) -> Result<Vec<UpcomingDay>, WorkspaceError> {
        let (today, now) = pikos_db::now_local_parts();
        let Some(end) = pikos_core::views::upcoming_window_end(&today) else {
            return Err(WorkspaceError::InvalidInput {
                message: format!("today is not a date: {today}"),
            });
        };
        let pages: Vec<PageSummary> = pikos_db::list_pages_impl(
            &self.pool,
            Some(pikos_db::PageFilter {
                scheduled_after: Some(today.clone()),
                // The window's last day plus a time at the end of it. The
                // column holds `YYYY-MM-DD` for an all-day row and
                // `YYYY-MM-DDTHH:MM:SS` for a timed one, and the comparison is
                // lexicographic — so a bare date as the upper bound would
                // admit the last day's all-day rows and silently drop every
                // timed row on it, `"2026-09-19T14:00:00" > "2026-09-19"`.
                scheduled_before: Some(format!("{end}T23:59:59")),
                open_only: Some(true),
                ..Default::default()
            }),
        )
        .await?
        .into_iter()
        .map(Into::into)
        .collect();

        Ok(
            pikos_core::views::group_upcoming(pages, &today, &now, |page| {
                page.scheduled_start.as_deref()
            })
            .into_iter()
            .map(|day| UpcomingDay {
                date: day.date,
                pages: day.pages,
            })
            .collect(),
        )
    }

    /// Finished pages for one view, newest first.
    ///
    /// Paginated because a folder accumulates completed pages without limit and
    /// a list that loads all of them is a list that gets slower every week. The
    /// open pages above it have no such bound in practice and are not paginated;
    /// this is the one that grows forever.
    ///
    /// Separate from `list_pages` rather than a status filter on it because the
    /// ordering differs and matters: finished pages read newest-first, by when
    /// they were completed, where open ones follow the order the user arranged
    /// them in.
    pub async fn list_completed(
        &self,
        scope: CompletedScope,
        limit: u32,
        offset: u32,
    ) -> Result<CompletedPages, WorkspaceError> {
        let (folder_id, completed_since) = match scope {
            // `today_local()` rather than a date from the caller: this is the
            // same function `list_today` uses to decide what is due, so the two
            // halves of the screen cannot disagree about which day it is.
            CompletedScope::Today => (None, Some(pikos_db::today_local())),
            CompletedScope::Inbox => (Some(serde_json::Value::Null), None),
            CompletedScope::Folder { id } => (Some(serde_json::Value::String(id)), None),
        };
        let response = pikos_db::list_completed_pages_impl(
            &self.pool,
            pikos_db::CompletedPagesFilter {
                folder_id,
                completed_since,
                limit: i64::from(limit),
                offset: i64::from(offset),
            },
        )
        .await?;
        Ok(CompletedPages {
            pages: response.pages.into_iter().map(Into::into).collect(),
            // The count comes from SQLite as a signed COUNT(*); it cannot be
            // negative, and saturating rather than casting means a number too
            // large to represent shows as "very many" instead of wrapping to
            // near zero and claiming there is nothing more to load.
            total: u32::try_from(response.total).unwrap_or(u32::MAX),
        })
    }

    pub async fn get_page(&self, id: String) -> Result<Page, WorkspaceError> {
        // Distinguished from a genuine failure: a widget or a deep link can
        // easily hold an id that has since been deleted, and that is not an
        // error worth surfacing as one.
        match pikos_db::get_page(&self.pool, &id).await? {
            Some(page) => Ok(page.into()),
            None => Err(WorkspaceError::NotFound {
                entity: "page".into(),
                id,
            }),
        }
    }

    /// Create a page.
    ///
    /// A `scheduled_start` becomes a real schedule row, not just a value on the
    /// page. `pages.scheduled_start` is a *denormalised* copy of the page's
    /// earliest `page_schedules` row, recomputed from that table whenever a
    /// schedule changes — so a date written straight onto the page looks right
    /// until the first reschedule, then silently vanishes. Writing the row is
    /// what makes the date real.
    pub async fn create_page(&self, page: NewPage) -> Result<Page, WorkspaceError> {
        let scheduled_start = page.scheduled_start;
        let scheduled_end = page.scheduled_end;
        let created = pikos_db::create_page_impl(
            &self.pool,
            DbNewPage {
                folder_id: page.folder_id,
                title: page.title,
                subtitle: None,
                content: page.content.unwrap_or_else(|| EMPTY_DOCUMENT.to_string()),
                content_text: None,
                status: "not_started".to_string(),
                priority: 0,
                tags: page.tags.unwrap_or_default(),
                scheduled_start: None,
                scheduled_end: None,
                completed_at: None,
                links: Vec::new(),
                parent_id: None,
                last_opened_at: None,
                created_at: None,
                updated_at: None,
            },
        )
        .await?;

        let Some(start) = scheduled_start else {
            return Ok(created.into());
        };
        self.schedule_page(created.id.clone(), start, scheduled_end)
            .await?;
        self.get_page(created.id).await
    }

    /// Give a page a date, or another one.
    ///
    /// Pages can carry several schedules; the earliest still ahead is the one
    /// the page shows. Adding a date does not replace the ones already there.
    pub async fn schedule_page(
        &self,
        page_id: String,
        scheduled_start: String,
        scheduled_end: Option<String>,
    ) -> Result<(), WorkspaceError> {
        pikos_db::create_page_schedule_impl(
            &self.pool,
            pikos_db::NewPageSchedule {
                page_id,
                scheduled_start,
                scheduled_end,
                timezone: None,
                rule_id: None,
                original_date: None,
            },
        )
        .await?;
        Ok(())
    }

    /// Make a page recurring.
    ///
    /// `scheduled_start` is snapped onto the first date the rule actually
    /// permits, so a M/W/F rule anchored to a Sunday starts on the Monday
    /// rather than showing a first run on a day the series excludes. Snapping
    /// is idempotent, so an already-valid anchor is left alone.
    ///
    /// The page's own date is then set from the snapped anchor. A recurring
    /// page owns that field directly — the occurrences after the first are
    /// expanded at display time and have no rows to derive it from.
    pub async fn set_recurrence(
        &self,
        page_id: String,
        rrule: String,
        scheduled_start: String,
        scheduled_end: Option<String>,
        timezone: String,
    ) -> Result<(), WorkspaceError> {
        let anchor = pikos_recurrence::snap_anchor_to_rule(&rrule, &scheduled_start);

        pikos_db::create_recurrence_rule_impl(
            &self.pool,
            pikos_db::NewRecurrenceRule {
                page_id: page_id.clone(),
                rrule,
                rrule_exdates: Vec::new(),
                scheduled_start: anchor.clone(),
                scheduled_end: scheduled_end.clone(),
                timezone,
            },
        )
        .await?;

        pikos_db::update_page_impl(
            &self.pool,
            page_id,
            DbPageUpdate {
                scheduled_start: Some(serde_json::Value::String(anchor)),
                scheduled_end: Some(match scheduled_end {
                    Some(end) => serde_json::Value::String(end),
                    None => serde_json::Value::Null,
                }),
                ..Default::default()
            },
        )
        .await?;
        Ok(())
    }

    /// Tick or untick a page, whatever kind it is.
    ///
    /// The single safe entry point for a checkbox, and the reason it exists is
    /// that the unsafe one is indistinguishable at the call site. Setting
    /// `status` on a recurring head ends the series; completing an occurrence
    /// of it clones the head and advances it. A caller that has to know which
    /// kind of page it holds before it can tick a box will eventually hold one
    /// it has not checked — and the failure is silent and destroys data.
    ///
    /// The first version of this lived in Swift and read `is_recurring` from
    /// the cached page list, defaulting to false when the page was not in it.
    /// That is safe for the list screen and a trap for everything else: a
    /// widget action or an App Intent completing a page it never listed would
    /// take the corrupting path. Deciding here removes the trap rather than
    /// documenting it.
    pub async fn set_page_status(&self, page_id: String, done: bool) -> Result<(), WorkspaceError> {
        let page = pikos_db::get_page(&self.pool, &page_id)
            .await?
            .ok_or_else(|| WorkspaceError::NotFound {
                entity: "page".into(),
                id: page_id.clone(),
            })?;

        if page.is_recurring {
            if done {
                self.complete_recurring_occurrence(page_id, None).await?;
                return Ok(());
            }
            // A series with nothing completed has no occurrence to reopen; the
            // head itself is what is ticked, so it flips like any other page.
            if self
                .uncomplete_latest_recurring_occurrence(page_id.clone())
                .await?
            {
                return Ok(());
            }
        }

        let status = if done { "done" } else { "not_started" };
        // `completed_at` is stamped here, not left to the column, because
        // nothing else on this path sets it: `update_page_impl` writes it only
        // when a caller supplies it. A page ticked without one is done with no
        // record of when, which reads as an ordering quirk and is worse than
        // that — the Completed section for a date view selects on
        // `date(completed_at)`, so such a page is finished and invisible in
        // every view that would show it, on this device and on the desktop
        // reading the same file.
        //
        // Local wall clock rather than the UTC `now_iso()` used for
        // `created_at`/`updated_at`, matching the convention `pikos-db` states
        // above `complete_recurring_page_once`: the Completed view compares the
        // first ten characters against the local day, and a UTC stamp hides a
        // just-ticked page whenever UTC's date is not the local one.
        let completed_at = if done {
            serde_json::Value::String(pikos_db::now_local_iso())
        } else {
            serde_json::Value::Null
        };
        pikos_db::update_page_impl(
            &self.pool,
            page_id,
            pikos_db::PageUpdate {
                status: Some(status.to_string()),
                completed_at: Some(completed_at),
                ..Default::default()
            },
        )
        .await?;
        Ok(())
    }

    /// Complete one occurrence of a recurring page.
    ///
    /// Not the same operation as setting `status` to done, and the difference is
    /// destructive rather than cosmetic. A recurring page is stored as a head
    /// row plus a rule; completing an occurrence clones the head at that date,
    /// marks the clone done, and *advances the head* to the next open
    /// occurrence. Flipping the head's own status instead marks the whole
    /// series finished — `pikos-db` says so directly above
    /// `set_pages_status_impl`: "a plain status flip would corrupt the series".
    ///
    /// `occurrence_date` is required only for a page a calendar owns, whose own
    /// date stays pinned to where the series began. For a page created in Pikos,
    /// omit it and the next-due date is used.
    pub async fn complete_recurring_occurrence(
        &self,
        page_id: String,
        occurrence_date: Option<String>,
    ) -> Result<RecurringCompletion, WorkspaceError> {
        let result = pikos_db::complete_recurring_page_impl(
            &self.pool,
            pikos_db::CompleteRecurringInput {
                page_id,
                occurrence_date,
                scheduled_start: None,
                scheduled_end: None,
                expected_occurrence_date: None,
            },
        )
        .await?;
        Ok(RecurringCompletion {
            clone_id: result.clone.id,
            head_status: result.head.status,
            head_scheduled_start: result.head.scheduled_start,
        })
    }

    /// Undo the most recent completed occurrence of a series.
    ///
    /// Returns false when there is nothing to undo — no rule, no completions,
    /// or a schedule a calendar owns — which is the caller's signal to fall back
    /// to a plain status flip. Deciding *which* occurrence here rather than in
    /// the UI keeps the whole `completedOccurrences` map off the wire, and keeps
    /// the choice somewhere it can be tested.
    pub async fn uncomplete_latest_recurring_occurrence(
        &self,
        page_id: String,
    ) -> Result<bool, WorkspaceError> {
        let Some(page) = pikos_db::get_page(&self.pool, &page_id).await? else {
            return Ok(false);
        };
        // `schedule_locked` is the one that does work here: a calendar owns that
        // page's schedule, so walking its head back is not ours to do. The
        // `is_recurring` half is belt-and-braces — a page with no rule has no
        // completions map either, so the check below would refuse it anyway.
        if !page.is_recurring || page.schedule_locked {
            return Ok(false);
        }
        let Some(completed) = page.completed_occurrences else {
            return Ok(false);
        };
        // The newest by date. Dates are zero-padded ISO, so the lexical maximum
        // is the calendar maximum.
        let Some(newest) = completed.keys().max().cloned() else {
            return Ok(false);
        };
        self.uncomplete_recurring_occurrence(page_id, newest)
            .await?;
        Ok(true)
    }

    /// Undo one completed occurrence, and let the head recompute.
    ///
    /// The mirror of the above: it drops the completion record and re-derives
    /// the head, which walks back to the re-opened occurrence.
    pub async fn uncomplete_recurring_occurrence(
        &self,
        page_id: String,
        occurrence_date: String,
    ) -> Result<(), WorkspaceError> {
        pikos_db::uncomplete_recurring_occurrence_impl(
            &self.pool,
            pikos_db::UncompleteRecurringInput {
                page_id,
                occurrence_date,
            },
        )
        .await?;
        Ok(())
    }

    pub async fn update_page(&self, id: String, edit: PageEdit) -> Result<Page, WorkspaceError> {
        let updated = pikos_db::update_page_impl(
            &self.pool,
            id,
            DbPageUpdate {
                title: edit.title,
                content: edit.content,
                content_text: edit.content_text,
                status: edit.status,
                priority: edit.priority,
                tags: edit.tags,
                folder_id: match edit.folder {
                    None => None,
                    Some(FolderAssignment::Inbox) => Some(serde_json::Value::Null),
                    Some(FolderAssignment::Folder { id }) => Some(serde_json::Value::String(id)),
                },
                ..Default::default()
            },
        )
        .await?;
        Ok(updated.into())
    }

    /// Create everything one quick-add line asks for.
    ///
    /// "standup every weekday at 9am #work" is one user action, and this is the
    /// one call that performs it: parse the line, create the page or pages,
    /// give them their dates, and attach a recurrence rule when there is one.
    /// Doing it here rather than in Swift keeps the ordering — a rule's anchor
    /// has to be snapped before it is written — in the same place as the rules
    /// that require it.
    ///
    /// `reference` is "now" as a wall-clock ISO string, so the same line parses
    /// the same way in the app, a widget, and a test. `timezone` is the IANA
    /// name stored on a recurrence rule.
    ///
    /// Returns the created pages: one for a single or recurring line, several
    /// for one that named specific days ("run m/w/f").
    ///
    /// **Not atomic.** A page and its recurrence rule are two writes, and
    /// SQLite is not holding a transaction across them. If the rule fails the
    /// page is trashed again rather than left behind as a silent one-off, but a
    /// multi-page line that fails partway leaves the pages it already made —
    /// they are real pages the user asked for, and deleting them would be the
    /// more surprising outcome.
    pub async fn create_from_quick_add(
        &self,
        input: String,
        reference: String,
        folder_id: Option<String>,
        timezone: String,
    ) -> Result<Vec<Page>, WorkspaceError> {
        let now = pikos_core::dates::parse_local_iso(&reference).ok_or_else(|| {
            WorkspaceError::InvalidInput {
                message: format!("reference is not a wall-clock datetime: {reference}"),
            }
        })?;

        match pikos_core::nlp::quick_add::parse_input(&input, now) {
            QuickAddParse::Single { input } => {
                let page = create_quick_add_page(self, input, folder_id, true).await?;
                Ok(vec![page])
            }
            QuickAddParse::Finite { inputs } => {
                let mut pages = Vec::with_capacity(inputs.len());
                for input in inputs {
                    pages.push(create_quick_add_page(self, input, folder_id.clone(), true).await?);
                }
                Ok(pages)
            }
            QuickAddParse::Recurring { input, rrule } => {
                // The rule owns the page's date, so the page is created without
                // one: a non-rule schedule row would linger at the original
                // anchor and fight the rule for the head.
                let anchor = input
                    .scheduled_start
                    .clone()
                    .unwrap_or_else(|| pikos_core::dates::format_date_only(&now));
                let scheduled_end = input.scheduled_end.clone();
                let page = create_quick_add_page(self, input, folder_id, false).await?;

                if let Err(error) = self
                    .set_recurrence(page.id.clone(), rrule, anchor, scheduled_end, timezone)
                    .await
                {
                    // A page with no rule is not what was asked for, and it
                    // would look like an ordinary one-off. Take it back.
                    let _ = self.trash_page(page.id.clone()).await;
                    return Err(error);
                }
                Ok(vec![self.get_page(page.id).await?])
            }
        }
    }

    // ─── Repeats ─────────────────────────────────────────────────────────

    /// What a page repeats as, and whether this editor may change it.
    pub async fn page_repeat(&self, page_id: String) -> Result<PageRepeat, WorkspaceError> {
        let Some(rule) = pikos_db::get_recurrence_rule_impl(&self.pool, &page_id).await? else {
            return Ok(PageRepeat::Never);
        };
        // A label for anything, including the rules the picker cannot hold: a
        // reader who is not allowed to change a repeat should still be told
        // what it is.
        let label =
            pikos_recurrence::rrule_to_label(&rule.rrule).unwrap_or_else(|| "Repeats".to_string());

        // Two separate reasons to lock, and both have to be checked. The guard
        // covers what the picker cannot express; the sync lock covers what is
        // not ours to express at all. `schedule_locked` is derived by the
        // summary query, so reading it costs the page fetch and nothing more.
        let locked = pikos_db::get_page(&self.pool, &page_id)
            .await?
            .is_some_and(|page| page.schedule_locked);
        if locked || pikos_recurrence::rrule_edit_would_degrade(&rule.rrule) {
            return Ok(PageRepeat::Fixed { label });
        }

        match pikos_recurrence::parse_rrule(&rule.rrule).and_then(repeat_from) {
            Some(repeat) => Ok(PageRepeat::Editable { repeat, label }),
            None => Ok(PageRepeat::Fixed { label }),
        }
    }

    /// Make a page repeat, or change how it already does.
    ///
    /// Creates the rule when there is none and rewrites it when there is, so a
    /// caller does not have to know which — and so the two cannot drift apart,
    /// which is what a second rule row on one page would be.
    ///
    /// The page needs a date first. A repeat is a pattern *from* somewhere, and
    /// the anchor is what every occurrence is derived from; inventing one here
    /// would put the series on a day the user never chose.
    ///
    /// Refused when the existing rule is one this picker cannot represent, and
    /// when a calendar owns it. `page_repeat` reports both as `Fixed` and
    /// applies the identical test, so a UI that asks first never reaches
    /// either — but a stale list row can, which is why they are checked here
    /// rather than trusted to the caller.
    pub async fn set_page_repeat(
        &self,
        page_id: String,
        // Named `pattern` rather than `repeat`: `repeat` is a Swift keyword, and
        // a generated argument label that has to be back-quoted at every call
        // site is a papercut for nothing.
        pattern: Repeat,
    ) -> Result<(), WorkspaceError> {
        let page = pikos_db::get_page(&self.pool, &page_id)
            .await?
            .ok_or_else(|| WorkspaceError::NotFound {
                entity: "page".into(),
                id: page_id.clone(),
            })?;
        let Some(anchor) = page.scheduled_start.clone() else {
            return Err(WorkspaceError::Refused {
                message: "Give the page a date first — a repeat needs somewhere to start."
                    .to_string(),
            });
        };
        if pattern.interval == 0 {
            return Err(WorkspaceError::InvalidInput {
                message: "a repeat has to happen at least every 1".to_string(),
            });
        }
        if pattern.weekdays.iter().any(|day| *day > 6) {
            return Err(WorkspaceError::InvalidInput {
                message: "weekdays are 0 (Monday) through 6 (Sunday)".to_string(),
            });
        }

        let rrule = pikos_recurrence::build_rrule(&pikos_recurrence::RecurrenceOptions {
            freq: Some(match pattern.freq {
                RepeatFreq::Daily => pikos_recurrence::Freq::Daily,
                RepeatFreq::Weekly => pikos_recurrence::Freq::Weekly,
                RepeatFreq::Monthly => pikos_recurrence::Freq::Monthly,
                RepeatFreq::Yearly => pikos_recurrence::Freq::Yearly,
            }),
            interval: pattern.interval,
            byweekday: match pattern.freq {
                // Weekdays mean nothing on a monthly or yearly repeat, and the
                // engine rejects a rule that carries them there. Dropped rather
                // than passed through, so switching a weekly repeat to monthly
                // does not produce a rule that fails to enumerate.
                RepeatFreq::Weekly if !pattern.weekdays.is_empty() => {
                    Some(pattern.weekdays.iter().map(|d| *d as u8).collect())
                }
                _ => None,
            },
            ..Default::default()
        });

        match pikos_db::get_recurrence_rule_impl(&self.pool, &page_id).await? {
            Some(existing) => {
                // The same envelope the read applies, not the wider one.
                // `rrule_edit_would_degrade` alone would let "the last
                // Friday of the month" through here — it round-trips
                // fine — and this write would save it back as "every
                // month on a Friday". The read and the write have to
                // refuse the same set, or the UI calls a rule uneditable
                // while the workspace edits it for anyone who asks
                // directly.
                let representable = pikos_recurrence::parse_rrule(&existing.rrule)
                    .and_then(repeat_from)
                    .is_some();
                if !representable {
                    return Err(WorkspaceError::Refused {
                        message: "This repeat is more detailed than Pikos can edit here. Change it on the desktop."
                            .to_string(),
                    });
                }
                // The anchor moves with the rule: a weekly repeat switched to
                // Wednesdays has to sit on a Wednesday, or the derivation drags
                // the head back on the next recompute.
                let (start, end) = pikos_recurrence::snap_schedule_to_rule(
                    &rrule,
                    &anchor,
                    page.scheduled_end.as_deref(),
                );
                pikos_db::update_recurrence_rule_impl(
                    &self.pool,
                    existing.id,
                    pikos_db::RecurrenceRuleUpdate {
                        rrule: Some(rrule),
                        scheduled_start: Some(start),
                        scheduled_end: Some(match end {
                            Some(value) => serde_json::Value::String(value),
                            None => serde_json::Value::Null,
                        }),
                        ..Default::default()
                    },
                )
                .await?;
            }
            None => {
                self.set_recurrence(
                    page_id,
                    rrule,
                    anchor,
                    page.scheduled_end.clone(),
                    pikos_db::device_zone().to_string(),
                )
                .await?;
            }
        }
        Ok(())
    }

    /// Stop a page repeating, leaving the page itself where it is.
    ///
    /// Not a delete: the head survives as an ordinary one-off on the date it
    /// was last sitting on, which is what somebody switching "Repeat" to
    /// "Never" means. Refused on a calendar's rule, which is upstream's.
    pub async fn remove_page_repeat(&self, page_id: String) -> Result<(), WorkspaceError> {
        let Some(rule) = pikos_db::get_recurrence_rule_impl(&self.pool, &page_id).await? else {
            return Ok(());
        };
        pikos_db::delete_recurrence_rule_impl(&self.pool, &rule.id).await?;
        Ok(())
    }

    /// Give a page a date, replacing whatever one-off date it already had.
    ///
    /// The everyday "move this to Thursday". Distinct from
    /// [`Workspace::schedule_page`], which *adds* a date — a page can carry
    /// several, and the earliest still ahead is the one it shows. Adding when
    /// the user meant moving leaves the old date behind to resurface once the
    /// new one passes, which reads as the app forgetting the edit.
    ///
    /// Shapes must match: both all-day (`YYYY-MM-DD`) or both timed
    /// (`YYYY-MM-DDTHH:MM:SS`). Mixing them is how a multi-day all-day event
    /// ends up with a time on one end only, and the storage format has no way
    /// to represent that.
    ///
    /// **Refused on a repeating page.** A recurring head's date belongs to its
    /// rule: moving it has to realign the rule's anchor and snap the drop onto
    /// a day the rule can yield, or the next recompute silently reverts it.
    /// That logic is `resolveAnchorMove` in `@pikos/core` and is not ported
    /// yet, so this refuses rather than corrupting a series — the same line the
    /// CLI draws (`update --due`, matrix §5).
    ///
    /// Refused on a page a calendar owns, by the data layer: its schedule is
    /// upstream's.
    pub async fn set_page_schedule(
        &self,
        page_id: String,
        scheduled_start: String,
        scheduled_end: Option<String>,
    ) -> Result<Page, WorkspaceError> {
        let page = pikos_db::get_page(&self.pool, &page_id)
            .await?
            .ok_or_else(|| WorkspaceError::NotFound {
                entity: "page".into(),
                id: page_id.clone(),
            })?;
        if page.is_recurring {
            return Err(WorkspaceError::Refused {
                message: "A repeating page's date comes from its rule. Change the repeat instead."
                    .to_string(),
            });
        }

        let start = pikos_core::dates::parse_local_iso(&scheduled_start).ok_or_else(|| {
            WorkspaceError::InvalidInput {
                message: format!("not a wall-clock date or datetime: {scheduled_start}"),
            }
        })?;
        let all_day = pikos_core::dates::is_all_day_iso(&scheduled_start);

        if let Some(ref end) = scheduled_end {
            let parsed = pikos_core::dates::parse_local_iso(end).ok_or_else(|| {
                WorkspaceError::InvalidInput {
                    message: format!("not a wall-clock date or datetime: {end}"),
                }
            })?;
            if pikos_core::dates::is_all_day_iso(end) != all_day {
                return Err(WorkspaceError::InvalidInput {
                    message: "the start and end must both be all-day or both carry a time"
                        .to_string(),
                });
            }
            if parsed < start {
                return Err(WorkspaceError::InvalidInput {
                    message: "the end cannot be before the start".to_string(),
                });
            }
        }

        // Clear first, then write. Not one transaction — each of these is its
        // own, as they are on the desktop — but the order is the safe one: a
        // failure between them leaves the page with no date, which the user can
        // see and redo, rather than with two.
        self.clear_page_schedule(page_id.clone()).await?;
        self.schedule_page(page_id.clone(), scheduled_start, scheduled_end)
            .await?;
        self.get_page(page_id).await
    }

    /// Take a page's date away, leaving any recurrence it has intact.
    ///
    /// A page can carry several schedule rows and they are not all the same
    /// kind. The one-off ones are what "clear the date" means; a row with a
    /// `rule_id` is a *materialised occurrence* of a series — a single instance
    /// somebody dragged to another slot — and deleting those would silently
    /// undo those moves, or, on a head, strip the series of the anchor it is
    /// expanded from. So only the rule-less rows go, which is the same line
    /// desktop's `clearSchedule` draws.
    ///
    /// Each row goes through `delete_page_schedule_impl` rather than one bulk
    /// `DELETE`, because that function is where the two things a bare delete
    /// would skip live: the refusal on a calendar-owned row, and the denorm
    /// refresh that stops `pages.scheduled_start` pointing at a row that is no
    /// longer there.
    ///
    /// Returns how many rows were removed, so a caller can tell "cleared" from
    /// "there was nothing to clear" without listing them itself.
    ///
    /// **Not atomic.** Each row is its own transaction. A failure partway
    /// leaves the earlier deletions in place, which is the same shape as the
    /// desktop path and the benign direction to fail in: a page with fewer
    /// dates than it had, never one whose denorm disagrees with its rows.
    pub async fn clear_page_schedule(&self, page_id: String) -> Result<u32, WorkspaceError> {
        let schedules = pikos_db::list_page_schedules_impl(&self.pool, &page_id).await?;
        let mut cleared = 0;
        for schedule in schedules.into_iter().filter(|s| s.rule_id.is_none()) {
            pikos_db::delete_page_schedule_impl(&self.pool, schedule.id).await?;
            cleared += 1;
        }
        Ok(cleared)
    }

    /// Move a page to the trash. Recoverable — see `restore_page`.
    pub async fn trash_page(&self, id: String) -> Result<(), WorkspaceError> {
        pikos_db::soft_delete_page_impl(&self.pool, &id).await?;
        Ok(())
    }

    /// What is in the trash, newest first.
    ///
    /// Exists because the phone had no way back. Swipe-to-delete was wired and
    /// nothing listed or restored, which made a mis-swipe unrecoverable on the
    /// one device most likely to produce one.
    pub async fn list_trashed_pages(&self) -> Result<Vec<TrashedPage>, WorkspaceError> {
        let rows = pikos_db::list_trashed_pages_impl(&self.pool).await?;
        Ok(rows
            .into_iter()
            .map(|t| TrashedPage {
                id: t.id,
                title: t.title,
                folder_name: t.folder_name,
                deleted_at: t.deleted_at,
                is_synced: t.is_synced,
            })
            .collect())
    }

    /// How long the trash keeps a page before purging it.
    ///
    /// Surfaced so the UI can say "deleted pages are removed after 30 days"
    /// with the number the data layer actually uses, rather than a second copy
    /// that drifts.
    pub fn trash_retention_days(&self) -> i64 {
        pikos_db::TRASH_RETENTION_DAYS
    }

    pub async fn restore_page(&self, id: String) -> Result<(), WorkspaceError> {
        pikos_db::restore_page_impl(&self.pool, &id).await?;
        Ok(())
    }

    // ─── External calendars ──────────────────────────────────────────────
    //
    // Manual by construction. See the note above `SyncAccount` for what iOS
    // structurally cannot do here and why.

    /// Every connected account with its calendars, dormant ones included.
    ///
    /// Dormant accounts are listed rather than filtered because a disconnect is
    /// reversible: the row survives so a later reconnect re-links detached
    /// pages by their iCal UID instead of duplicating every event. Hiding them
    /// would make reconnecting look like connecting, which is the outcome that
    /// duplicates a calendar.
    pub async fn sync_status(&self) -> Result<Vec<SyncAccountWithCalendars>, WorkspaceError> {
        let accounts = pikos_db::get_sync_status_impl(&self.pool).await?;
        Ok(accounts.into_iter().map(Into::into).collect())
    }

    /// Connect a CalDAV server, or repair the connection to one already known.
    ///
    /// The password goes to the OS keychain and never to the database.
    /// Discovery runs first, so a wrong URL or password fails before anything
    /// is stored — which is also why this is slow enough to need a spinner.
    ///
    /// An account already known by provider and display name is *reused* rather
    /// than duplicated, whether it is dormant or active. That is what makes
    /// reconnecting safe: a second row would re-sync every event a second time
    /// and leave the first row's mirrors orphaned.
    pub async fn connect_caldav(
        &self,
        base_url: String,
        username: String,
        password: String,
        display_name: String,
    ) -> Result<SyncAccountWithCalendars, WorkspaceError> {
        let account = pikos_calendar_sync::connect_caldav(
            &self.pool,
            pikos_calendar_sync::Keychain::system(),
            base_url,
            username,
            password,
            display_name,
        )
        .await?;
        Ok(account.into())
    }

    /// Swap the password on a CalDAV account whose credential stopped working.
    ///
    /// Takes the password alone: the base URL and username are already in the
    /// keychain blob, and re-collecting them would let a typo create a *second*
    /// account instead of repairing this one. Nothing is written until the new
    /// password proves itself against the server.
    pub async fn reconnect_caldav(
        &self,
        account_id: String,
        password: String,
    ) -> Result<SyncAccountWithCalendars, WorkspaceError> {
        let account = pikos_calendar_sync::reconnect_caldav(
            &self.pool,
            pikos_calendar_sync::Keychain::system(),
            &account_id,
            password,
        )
        .await?;
        Ok(account.into())
    }

    /// Disconnect an account: release its credential and stop syncing it.
    ///
    /// Dormancy, not deletion. The row and its calendars stay so a later
    /// reconnect re-links the pages this account mirrored rather than creating
    /// a second copy of every one of them.
    pub async fn disconnect_sync_account(&self, account_id: String) -> Result<(), WorkspaceError> {
        pikos_calendar_sync::disconnect_account(
            &self.pool,
            pikos_calendar_sync::Keychain::system(),
            &account_id,
        )
        .await?;
        Ok(())
    }

    /// Turn one calendar's mirroring on or off.
    ///
    /// Switching off is not free and the UI should say so: pages the user
    /// edited are kept and detached, and un-actioned mirrors are deleted.
    /// `SyncCalendar::detached_pages` counts what a re-enable would reclaim —
    /// and a reclaim lets the calendar's values win over the local edits, which
    /// is why it is worth confirming rather than doing quietly.
    pub async fn set_calendar_enabled(
        &self,
        sync_calendar_id: String,
        enabled: bool,
    ) -> Result<SyncCalendar, WorkspaceError> {
        let calendar =
            pikos_db::toggle_sync_calendar_impl(&self.pool, &sync_calendar_id, enabled, None)
                .await?;
        Ok(calendar.into())
    }

    /// Sync one account now, from where each calendar left off.
    ///
    /// The ordinary "pull down to refresh" of calendar sync. Nothing calls this
    /// on a timer on iOS — see the note above `SyncAccount`.
    pub async fn sync_account_now(
        &self,
        account_id: String,
    ) -> Result<Vec<CalendarSyncResult>, WorkspaceError> {
        let results = pikos_calendar_sync::resync_account_auto(
            &self.pool,
            pikos_calendar_sync::Keychain::system(),
            &account_id,
        )
        .await?;
        Ok(results.into_iter().map(Into::into).collect())
    }

    /// Re-read an account's calendars in full, discarding every cursor.
    ///
    /// The repair path for a mirror that has drifted — an upstream change a
    /// cursor advanced past, or a deletion made while nothing was polling.
    /// Deliberately not a teardown: unchanged events are recognised by their
    /// etag, so this leaves pages, folders and timestamps alone. Slower than a
    /// plain sync and worth offering separately rather than instead.
    pub async fn resync_account_fully(
        &self,
        account_id: String,
    ) -> Result<Vec<CalendarSyncResult>, WorkspaceError> {
        let results = pikos_calendar_sync::refresh_account_auto(
            &self.pool,
            pikos_calendar_sync::Keychain::system(),
            &account_id,
        )
        .await?;
        Ok(results.into_iter().map(Into::into).collect())
    }

    /// Full-text search across titles and page bodies.
    pub async fn search(
        &self,
        query: String,
        limit: u32,
    ) -> Result<Vec<SearchHit>, WorkspaceError> {
        let response = pikos_db::search_pages_impl(&self.pool, query, Some(false)).await?;
        // The data layer has no limit parameter — it returns its own capped set
        // — so the cap is applied here rather than pushed down. Worth knowing if
        // a caller passes a large limit expecting more results: it will not get
        // them, and the fix belongs in search_pages_impl.
        Ok(response
            .results
            .into_iter()
            .take(limit as usize)
            .map(|r| SearchHit {
                page_id: r.id,
                title: r.title,
                excerpt: r.excerpt,
                match_source: r.match_source,
            })
            .collect())
    }

    pub async fn create_folder(
        &self,
        name: String,
        color: Option<String>,
    ) -> Result<Folder, WorkspaceError> {
        let folder = pikos_db::create_folder_impl(
            &self.pool,
            pikos_db::NewFolder {
                name,
                parent_id: None,
                color,
                icon: None,
            },
        )
        .await?;
        Ok(Folder {
            id: folder.id,
            name: folder.name,
            color: folder.color,
            sort_order: folder.sort_order,
            is_external_calendar: folder.is_external_calendar,
        })
    }

    /// Rename a folder.
    ///
    /// A calendar-owned folder is deliberately not refused here: the data layer
    /// allows its name and colour to be edited and only locks its *placement*,
    /// so refusing would be this layer inventing a rule the desktop does not
    /// have.
    pub async fn rename_folder(&self, id: String, name: String) -> Result<Folder, WorkspaceError> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(WorkspaceError::InvalidInput {
                message: "a folder needs a name".to_string(),
            });
        }
        let folder = pikos_db::update_folder_impl(
            &self.pool,
            id,
            pikos_db::FolderUpdate {
                name: Some(trimmed.to_string()),
                ..Default::default()
            },
        )
        .await?;
        Ok(Folder {
            id: folder.id,
            name: folder.name,
            color: folder.color,
            sort_order: folder.sort_order,
            is_external_calendar: folder.is_external_calendar,
        })
    }

    /// Move a folder to the trash, taking its pages with it.
    ///
    /// Soft, and cascading: the folder and every page filed in it are marked
    /// deleted in one transaction, so the sidebar cannot lose the folder while
    /// its pages stay visible. Recoverable through `restore_folder`, which is
    /// why the UI can offer this without a second confirmation beyond naming
    /// what goes with it.
    ///
    /// Refused for a folder a calendar owns — that one is not the user's to
    /// delete, and the message says so.
    pub async fn trash_folder(&self, id: String) -> Result<(), WorkspaceError> {
        pikos_db::soft_delete_folder_impl(&self.pool, id).await?;
        Ok(())
    }

    /// Bring a trashed folder and its pages back.
    pub async fn restore_folder(&self, id: String) -> Result<(), WorkspaceError> {
        pikos_db::restore_folder_impl(&self.pool, id).await?;
        Ok(())
    }

    pub async fn list_folders(&self) -> Result<Vec<Folder>, WorkspaceError> {
        let folders = pikos_db::list_folders_impl(&self.pool).await?;
        Ok(folders
            .into_iter()
            .map(|f| Folder {
                id: f.id,
                name: f.name,
                color: f.color,
                sort_order: f.sort_order,
                is_external_calendar: f.is_external_calendar,
            })
            .collect())
    }

    /// Everything to draw for a visible range, in one call.
    ///
    /// `start` and `end` are `YYYY-MM-DD`; `end` is inclusive, being the last
    /// day shown. One day for a phone, seven for a week grid — the same call
    /// either way.
    ///
    /// Three sources go in and one list comes out:
    ///
    /// 1. Pages whose schedule *overlaps* the range, not merely starts in it,
    ///    so a multi-day event that began earlier still appears.
    /// 2. Every recurrence rule, and the head page of each — the head is
    ///    usually outside the range, since the point of a series is that it
    ///    was anchored once and runs on. Omitting these was the mistake worth
    ///    guarding against: expansion needs the head, and without it a weekly
    ///    standup silently shows nothing at all.
    /// 3. Materialised override rows in the range, whose dates are folded into
    ///    each rule's exclusions so an overridden occurrence is drawn once,
    ///    from its row, rather than twice.
    pub async fn calendar_range(
        &self,
        start: String,
        end: String,
    ) -> Result<Vec<CalendarEntry>, WorkspaceError> {
        calendar_range_impl(&self.pool, &start, &end).await
    }

    /// A read-only handle onto the same workspace, for passing to code that
    /// must not write.
    pub fn read_only(&self) -> Arc<ReadOnlyWorkspace> {
        Arc::new(ReadOnlyWorkspace {
            pool: self.pool.clone(),
        })
    }
}

/// The empty Tiptap document, matching what the editor produces for a new page.
const EMPTY_DOCUMENT: &str = r#"{"type":"doc","content":[{"type":"paragraph"}]}"#;

/// A read-only handle, for widget and intent extensions.
///
/// The restriction is structural rather than advisory: this type simply has no
/// write methods, so an extension holding one cannot write however carelessly
/// it is used. That matters because SQLite in WAL mode permits exactly one
/// writer, and a widget refresh racing the app for it would block the app —
/// the visible symptom being a keystroke that does not appear.
#[derive(Debug, uniffi::Object)]
pub struct ReadOnlyWorkspace {
    pool: sqlx::SqlitePool,
}

#[uniffi::export(async_runtime = "tokio")]
impl ReadOnlyWorkspace {
    /// Open an existing workspace read-only.
    ///
    /// Fails if the file does not exist rather than creating one, and never
    /// migrates: a widget must not be the process that changes the schema, and
    /// a widget that silently creates an empty database looks to the user like
    /// their notes have vanished.
    #[uniffi::constructor]
    pub async fn open_existing(path: String) -> Result<Arc<Self>, WorkspaceError> {
        if !std::path::Path::new(&path).exists() {
            return Err(WorkspaceError::Open {
                message: format!("no workspace at {path}"),
            });
        }
        let pool = pikos_db::open_pool(&path)
            .await
            .map_err(|e| WorkspaceError::Open {
                message: e.to_string(),
            })?;
        Ok(Arc::new(ReadOnlyWorkspace { pool }))
    }

    pub async fn list_pages(&self, query: PageQuery) -> Result<Vec<PageSummary>, WorkspaceError> {
        let pages = pikos_db::list_pages_impl(&self.pool, Some(query.into())).await?;
        Ok(pages.into_iter().map(Into::into).collect())
    }

    pub async fn list_today(&self) -> Result<Vec<PageSummary>, WorkspaceError> {
        let pages = pikos_db::list_pages_today_impl(&self.pool).await?;
        Ok(pages.into_iter().map(Into::into).collect())
    }

    pub async fn get_page(&self, id: String) -> Result<Page, WorkspaceError> {
        match pikos_db::get_page(&self.pool, &id).await? {
            Some(page) => Ok(page.into()),
            None => Err(WorkspaceError::NotFound {
                entity: "page".into(),
                id,
            }),
        }
    }

    /// The calendar's range query, read-only — see [`Workspace::calendar_range`].
    ///
    /// Present here because a calendar is exactly the kind of thing an
    /// extension shows, and a widget reaching for it must not be able to open
    /// a writable handle to get it.
    pub async fn calendar_range(
        &self,
        start: String,
        end: String,
    ) -> Result<Vec<CalendarEntry>, WorkspaceError> {
        calendar_range_impl(&self.pool, &start, &end).await
    }

    /// The folder list, for pickers outside the app.
    ///
    /// A read like any other here. It exists so a Shortcuts folder parameter
    /// does not have to open a writable handle to populate itself — the one
    /// case where a *query*, rather than an intent run, needed the database.
    pub async fn list_folders(&self) -> Result<Vec<Folder>, WorkspaceError> {
        let folders = pikos_db::list_folders_impl(&self.pool).await?;
        Ok(folders
            .into_iter()
            .map(|f| Folder {
                id: f.id,
                name: f.name,
                color: f.color,
                sort_order: f.sort_order,
                is_external_calendar: f.is_external_calendar,
            })
            .collect())
    }
}

// ─── Calendar ────────────────────────────────────────────────────────────────

/// Shared by both handles. A free function rather than a trait: it needs the
/// pool and nothing else, and two one-line forwarding methods are cheaper to
/// read than a trait with two implementors.
async fn calendar_range_impl(
    pool: &sqlx::SqlitePool,
    start: &str,
    end: &str,
) -> Result<Vec<CalendarEntry>, WorkspaceError> {
    let drawn = pikos_db::list_pages_overlapping_impl(pool, start, end).await?;
    let rules = pikos_db::list_recurrence_rules_impl(pool).await?;

    // Everything the range query returned is drawn. Rule heads gathered below
    // are *inputs to the expansion*, not blocks — a weekly standup anchored in
    // March must project onto June without also drawing itself there in March.
    let mut heads: Vec<pikos_db::PageSummary> = Vec::new();
    for rule in &rules {
        let known = drawn
            .iter()
            .chain(heads.iter())
            .any(|p| p.id == rule.page_id);
        if known {
            continue;
        }
        // Sequential `get_page` rather than one `WHERE id IN (…)`: rule counts
        // are in the tens, and a variadic IN builder is more code than it saves.
        if let Some(page) = pikos_db::get_page(pool, &rule.page_id).await? {
            heads.push(page_summary_of(page));
        }
    }

    // Gathered by rule, never by date range. An override moved out of the
    // visible week still has to suppress the slot it came from, and a range
    // query keyed on where it moved *to* misses it — leaving a ghost behind.
    let rule_ids: Vec<String> = rules.iter().map(|r| r.id.clone()).collect();
    let overrides = pikos_db::list_page_schedules_for_rules_impl(pool, &rule_ids).await?;

    let series_pages: Vec<SeriesPage> = drawn
        .iter()
        .chain(heads.iter())
        .map(|p| SeriesPage {
            id: p.id.clone(),
            scheduled_start: p.scheduled_start.clone(),
            completed_dates: p
                .completed_occurrences
                .as_ref()
                .map(|m| m.keys().cloned().collect())
                .unwrap_or_default(),
            skipped_dates: p.skipped_occurrences.clone().unwrap_or_default(),
            synced_since: p.synced_since.clone(),
        })
        .collect();

    let series_rules: Vec<SeriesRule> = rules
        .into_iter()
        .map(|rule| SeriesRule {
            id: rule.id,
            page_id: rule.page_id,
            rrule: rule.rrule,
            exdates: rule.rrule_exdates,
            scheduled_start: rule.scheduled_start,
            scheduled_end: rule.scheduled_end,
        })
        .collect();

    let override_rows: Vec<OverrideRow> = overrides
        .into_iter()
        .filter_map(|row| {
            Some(OverrideRow {
                rule_id: row.rule_id?,
                original_date: row.original_date?,
            })
        })
        .collect();

    // The expansion window runs to the day *after* the last visible one, since
    // the engine takes a half-open interval and `end` here is the last day
    // shown. Without the extra day, the final column of a week would never show
    // a recurring occurrence.
    let (Some(_), Some(to)) = (parse_local_iso(start), parse_local_iso(end).map(next_day)) else {
        return Err(WorkspaceError::InvalidInput {
            message: format!("calendar range needs two YYYY-MM-DD dates, got {start} and {end}"),
        });
    };
    let to = pikos_core::dates::format_local_iso(&to);

    let virtuals =
        virtual_occurrences_in_range(&series_pages, &series_rules, &override_rows, start, &to);

    let mut entries: Vec<CalendarEntry> = drawn
        .iter()
        .filter_map(|page| {
            let scheduled_start = page.scheduled_start.clone()?;
            Some(entry_of(
                page,
                page.id.clone(),
                scheduled_start,
                page.scheduled_end.clone(),
                None,
            ))
        })
        .collect();

    for occurrence in virtuals {
        let Some(page) = drawn
            .iter()
            .chain(heads.iter())
            .find(|p| p.id == occurrence.page_id)
        else {
            continue;
        };
        let key = format!("{}@{}", occurrence.page_id, occurrence.original_date);
        entries.push(entry_of(
            page,
            key,
            occurrence.scheduled_start,
            occurrence.scheduled_end,
            Some(occurrence.original_date),
        ));
    }

    Ok(entries)
}

/// One entry, from a page plus whichever schedule this occurrence has.
/// A parsed rule as a [`Repeat`], or `None` when the picker cannot hold it.
///
/// A second, narrower envelope than `rrule_edit_would_degrade`, and the two
/// answer different questions. That guard asks whether a *full* editor could
/// round-trip the rule; this asks whether *this* picker can — frequency,
/// interval, and weekdays for a weekly repeat, and nothing else.
///
/// The distinction is not academic, and a test caught it being missed.
/// `FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1` — "the last Friday of the month" —
/// round-trips perfectly, so the guard passes it; a picker with nowhere to put
/// `BYSETPOS` would then have offered it for editing and saved back "every
/// month on a Friday". Every term below is one this shape would silently drop.
fn repeat_from(options: pikos_recurrence::RecurrenceOptions) -> Option<Repeat> {
    let freq = match options.freq? {
        pikos_recurrence::Freq::Daily => RepeatFreq::Daily,
        pikos_recurrence::Freq::Weekly => RepeatFreq::Weekly,
        pikos_recurrence::Freq::Monthly => RepeatFreq::Monthly,
        pikos_recurrence::Freq::Yearly => RepeatFreq::Yearly,
    };

    // "The first Monday", "the last Friday", "the 15th", "every March", a
    // non-default week start, and the two ways a rule can stop. A picker with
    // no control for any of them must not claim to be editing the rule.
    let unrepresentable = options.bysetpos.is_some_and(|v| !v.is_empty())
        || options.bymonthday.is_some_and(|v| !v.is_empty())
        || options.bymonth.is_some_and(|v| !v.is_empty())
        || options
            .byweekday_ordinals
            .is_some_and(|v| v.iter().any(Option::is_some))
        || options.wkst.is_some()
        || options.count.is_some()
        || options.until.is_some();
    if unrepresentable {
        return None;
    }

    let weekdays = options.byweekday.unwrap_or_default();
    // Weekdays on anything but a weekly rule say something this shape cannot,
    // and would be dropped on the way back out.
    if !weekdays.is_empty() && freq != RepeatFreq::Weekly {
        return None;
    }

    Some(Repeat {
        freq,
        interval: options.interval.max(1),
        weekdays: weekdays.into_iter().map(u32::from).collect(),
    })
}

fn entry_of(
    page: &pikos_db::PageSummary,
    key: String,
    scheduled_start: String,
    scheduled_end: Option<String>,
    original_date: Option<String>,
) -> CalendarEntry {
    CalendarEntry {
        page_id: page.id.clone(),
        key,
        title: page.title.clone(),
        status: page.status.clone(),
        priority: page.priority,
        folder_id: page.folder_id.clone(),
        tags: page.tags.clone(),
        created_at: page.created_at.clone(),
        scheduled_start,
        scheduled_end,
        is_virtual: original_date.is_some(),
        original_date,
    }
}

/// Narrow a full page row to the summary shape the range query returns, so
/// everything downstream sees one kind of thing.
fn page_summary_of(page: pikos_db::Page) -> pikos_db::PageSummary {
    pikos_db::PageSummary {
        id: page.id,
        folder_id: page.folder_id,
        title: page.title,
        subtitle: page.subtitle,
        status: page.status,
        priority: page.priority,
        tags: page.tags,
        sort_order: page.sort_order,
        scheduled_start: page.scheduled_start,
        scheduled_end: page.scheduled_end,
        completed_at: page.completed_at,
        links: page.links,
        parent_id: page.parent_id,
        last_opened_at: page.last_opened_at,
        created_at: page.created_at,
        updated_at: page.updated_at,
        schedule_locked: page.schedule_locked,
        sync_state: page.sync_state,
        timezone: page.timezone,
        completed_occurrences: page.completed_occurrences,
        skipped_occurrences: page.skipped_occurrences,
        mirror_location: page.mirror_location,
        mirror_attendees: page.mirror_attendees,
        pending_description: page.pending_description,
        synced_since: page.synced_since,
        is_recurring: page.is_recurring,
    }
}
