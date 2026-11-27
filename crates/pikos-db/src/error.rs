//! Typed errors for the backend. The frontend receives a structured `{ kind, message }`.
//!
//! `Serialize` is hand-rolled rather than derived so the wire format is stable whatever the
//! variant payload: frontends discriminate on `kind`, not the enum tag.
//!
//! `Display` output from foreign systems (sqlx in particular) can echo SQL fragments and
//! parameter values, which may include user input. When logging, use `AppError::log_summary`,
//! which says what failed without any of that text, and add the ids the call site knows.
//! Returning the message to the frontend is acceptable; the kind tag is what code branches on.

use serde::{ser::SerializeStruct, Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("db error: {0}")]
    Db(#[source] sqlx::Error),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("conflict: {0}")]
    Conflict(String),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),

    /// Something the person can act on, such as a refused password or a move that can't land,
    /// so the text is written for them and goes out without a kind prefix.
    #[error("{0}")]
    Invalid(String),

    #[error("network: {0}")]
    Network(String),

    /// The workspace file itself is damaged: SQLite refused it, or an integrity check found it
    /// inconsistent. Separate from `Db` because no retry helps and the app can point the user at
    /// the backups directory. Any query can produce it, not only the open, which is why the
    /// sorting happens in `From<sqlx::Error>`.
    #[error("corrupt: {0}")]
    Corrupt(String),

    /// A newer Pikos migrated the workspace past this build. The file is fine; updating opens it.
    #[error("too new: the workspace is at schema v{applied}, this build reads up to v{supported}")]
    TooNew { applied: i64, supported: i64 },

    #[error("internal: {0}")]
    Internal(String),
}

impl AppError {
    /// Stable, content-free kind tag for frontend branching. Next to the variant list, so a new
    /// variant is a compile error here before it reaches the wire.
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::Db(_) => "Db",
            AppError::NotFound(_) => "NotFound",
            AppError::Conflict(_) => "Conflict",
            AppError::Io(_) => "Io",
            AppError::Serde(_) => "Serde",
            AppError::Invalid(_) => "Invalid",
            AppError::Network(_) => "Network",
            AppError::Corrupt(_) => "Corrupt",
            AppError::TooNew { .. } => "TooNew",
            AppError::Internal(_) => "Internal",
        }
    }

    /// What failed, for a log line, with no text a foreign system or the person wrote: the kind,
    /// then the sqlx class and SQLite result code, the io error kind, or serde's category and
    /// position. A locked database (`Db/database code=5`) and a missing file (`Io/NotFound`) read
    /// differently, where `kind()` calls both a storage error.
    pub fn log_summary(&self) -> String {
        match self {
            AppError::Db(e) => format!("Db/{}", classify_sqlx(e)),
            AppError::Io(e) => format!("Io/{:?}", e.kind()),
            AppError::Serde(e) => {
                format!("Serde/{:?} at {}:{}", e.classify(), e.line(), e.column())
            }
            AppError::TooNew { applied, supported } => {
                format!("TooNew applied=v{applied} supported=v{supported}")
            }
            other => other.kind().to_string(),
        }
    }

    /// An io error that says what was being done and to which file, so "No such file or
    /// directory" becomes "copying the backup ~/…/backup.sqlite: No such file or directory". The
    /// io kind survives for `log_summary`, and the home folder is written `~`.
    pub fn io_at(doing: &str, path: &std::path::Path, err: std::io::Error) -> Self {
        let shown = scrub_home(&path.display().to_string());
        AppError::Io(std::io::Error::new(
            err.kind(),
            format!("{doing} {shown}: {err}"),
        ))
    }
}

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        if says_the_file_is_damaged(&err) {
            return AppError::Corrupt(err.to_string());
        }

        match migrated_past(&err) {
            Some((applied, supported)) => AppError::TooNew { applied, supported },
            None => AppError::Db(err),
        }
    }
}

/// The versions in a write refused because a newer Pikos migrated the workspace.
fn migrated_past(err: &sqlx::Error) -> Option<(i64, i64)> {
    let sqlx::Error::Database(db) = err else {
        return None;
    };

    let versions = db.message().strip_prefix(crate::pool::MIGRATED_PAST_MARK)?;
    let mut versions = versions.split_whitespace().map(str::parse::<i64>);
    match (versions.next(), versions.next()) {
        (Some(Ok(applied)), Some(Ok(supported))) => Some((applied, supported)),
        _ => None,
    }
}

/// SQLITE_IOERR_SHORT_READ: the file is shorter than SQLite's own record of it, so it changed
/// underneath SQLite. The rest of IOERR, and FULL (13), stay `Db`: a full disk or failed write is
/// the machine, not the file, and offering a restore would throw away good work.
const SQLITE_IOERR_SHORT_READ: i32 = 522;

/// CORRUPT (11) or NOTADB (26), in any extended form, or a short read. sqlx carries the
/// extended result code as a decimal string; the primary code is its low byte.
fn says_the_file_is_damaged(err: &sqlx::Error) -> bool {
    let sqlx::Error::Database(db) = err else {
        return false;
    };

    db.code()
        .and_then(|c| c.parse::<i32>().ok())
        .is_some_and(|code| matches!(code & 0xFF, 11 | 26) || code == SQLITE_IOERR_SHORT_READ)
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // { kind: "Db" | "NotFound" | ..., message: String }
        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("kind", self.kind())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

pub type AppResult<T> = std::result::Result<T, AppError>;

/// A sqlx error's class, plus the SQLite extended result code when there is one. Both are numbers
/// and fixed names, never the message, which can echo SQL and its parameters.
pub fn classify_sqlx(e: &sqlx::Error) -> String {
    use sqlx::Error::*;
    let class = match e {
        Configuration(_) => "configuration",
        Database(_) => "database",
        Io(_) => "io",
        Tls(_) => "tls",
        Protocol(_) => "protocol",
        RowNotFound => "row_not_found",
        TypeNotFound { .. } => "type_not_found",
        ColumnIndexOutOfBounds { .. } => "column_index_out_of_bounds",
        ColumnNotFound(_) => "column_not_found",
        ColumnDecode { .. } => "column_decode",
        Encode(_) => "encode",
        Decode(_) => "decode",
        AnyDriverError(_) => "any_driver",
        PoolTimedOut => "pool_timed_out",
        PoolClosed => "pool_closed",
        WorkerCrashed => "worker_crashed",
        Migrate(_) => "migrate",
        _ => "other",
    };

    let code = match e {
        Database(db) => db.code().map(|c| format!(" code={c}")),
        _ => None,
    };
    format!("{class}{}", code.unwrap_or_default())
}

fn scrub_home(shown: &str) -> String {
    match std::env::var("HOME") {
        Ok(home) if !home.is_empty() => shown.replacen(&home, "~", 1),
        _ => shown.to_string(),
    }
}

#[cfg(test)]
#[path = "error_tests.rs"]
mod error_tests;
