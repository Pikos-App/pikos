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

use crate::CalendarEntry;
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
}

impl From<AppError> for WorkspaceError {
    fn from(error: AppError) -> Self {
        WorkspaceError::Database {
            message: error.to_string(),
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

#[derive(Debug, uniffi::Record)]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub sort_order: i64,
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

    /// Move a page to the trash. Recoverable — see `restore_page`.
    pub async fn trash_page(&self, id: String) -> Result<(), WorkspaceError> {
        pikos_db::soft_delete_page_impl(&self.pool, &id).await?;
        Ok(())
    }

    pub async fn restore_page(&self, id: String) -> Result<(), WorkspaceError> {
        pikos_db::restore_page_impl(&self.pool, &id).await?;
        Ok(())
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
        })
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
        let known = drawn.iter().chain(heads.iter()).any(|p| p.id == rule.page_id);
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
            Some(entry_of(page, page.id.clone(), scheduled_start, page.scheduled_end.clone(), None))
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
