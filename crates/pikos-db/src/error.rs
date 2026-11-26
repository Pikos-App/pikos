//! Typed errors for the backend. The frontend receives a structured `{ kind, message }`.
//!
//! `Serialize` is hand-rolled rather than derived so the wire format is stable whatever the
//! variant payload: frontends discriminate on `kind`, not the enum tag.
//!
//! `Display` output from foreign systems (sqlx in particular) can echo SQL fragments and
//! parameter values, which may include user input. When logging, use a stable classifier
//! (see `notifications::scheduler::classify_sqlx`). Returning the message to the frontend is
//! acceptable; the kind tag is what code branches on.

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

#[cfg(test)]
#[path = "error_tests.rs"]
mod error_tests;
