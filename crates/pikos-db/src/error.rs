//! Typed errors for the Tauri backend.
//!
//! Replaces the stringly-typed `Result<T, String>` pattern that used to be
//! peppered with `.map_err(|e| e.to_string())`. With this enum, command
//! bodies can use `?` directly for any error that has a `From` impl, and
//! the frontend receives a structured `{ kind, message }` shape instead of
//! an opaque string.
//!
//! Tauri requires command error types to be `Serialize`. We hand-roll the
//! impl rather than `#[derive(Serialize)]` so the wire format is stable
//! regardless of variant payload type — frontends discriminate on `kind`,
//! not on enum tag.
//!
//! NOTE: `Display` output from foreign systems (sqlx in particular) can
//! echo SQL fragments and parameter values, which may include user input.
//! When *logging*, use a stable classifier (see `notifications::scheduler::
//! classify_sqlx`). When *returning* the error to the frontend it's
//! acceptable to surface the message — it's the same information the user
//! would see in a dev-tools console — but the kind tag is what code should
//! branch on.

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

    #[error("invalid: {0}")]
    Invalid(String),

    #[error("network: {0}")]
    Network(String),

    /// The workspace file itself is damaged: SQLite refused it, or an integrity
    /// check found it inconsistent. Separate from `Db` because the answer is
    /// different — no retry helps, and the app has a backups directory to point
    /// the user at. Nothing else can offer that if this arrives as a generic
    /// storage failure. Any query can produce it, not only the open, which is why
    /// the sorting happens in `From<sqlx::Error>`.
    #[error("corrupt: {0}")]
    Corrupt(String),

    #[error("internal: {0}")]
    Internal(String),
}

impl AppError {
    /// Stable, content-free kind tag for frontend branching. Lives next to
    /// the variant list so adding a variant produces a compile error here
    /// before reaching the wire format.
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
            AppError::Internal(_) => "Internal",
        }
    }
}

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        if says_the_file_is_damaged(&err) {
            AppError::Corrupt(err.to_string())
        } else {
            AppError::Db(err)
        }
    }
}

/// SQLITE_IOERR_SHORT_READ: the file is shorter than SQLite's own record of it, so it changed
/// underneath SQLite. It arrived a second before the first CORRUPT on the one damaged workspace
/// seen in use. The rest of IOERR, and FULL (13), stay `Db`: a full disk or a failed write is
/// the machine rather than the file, and a restore offered over it would throw away good work.
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
