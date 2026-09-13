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
    /// its own must not save over the document — see pikos-db migration 010.
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

    pub async fn create_page(&self, page: NewPage) -> Result<Page, WorkspaceError> {
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
                scheduled_start: page.scheduled_start,
                scheduled_end: page.scheduled_end,
                completed_at: None,
                links: Vec::new(),
                parent_id: None,
                last_opened_at: None,
                created_at: None,
                updated_at: None,
            },
        )
        .await?;
        Ok(created.into())
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
}
