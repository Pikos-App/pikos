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
    Db(#[from] sqlx::Error),

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

    #[error("internal: {0}")]
    Internal(String),
}

impl AppError {
    /// Stable, content-free kind tag for frontend branching. Lives next to
    /// the variant list so adding a variant produces a compile error here
    /// before reaching the wire format.
    fn kind(&self) -> &'static str {
        match self {
            AppError::Db(_) => "Db",
            AppError::NotFound(_) => "NotFound",
            AppError::Conflict(_) => "Conflict",
            AppError::Io(_) => "Io",
            AppError::Serde(_) => "Serde",
            AppError::Invalid(_) => "Invalid",
            AppError::Internal(_) => "Internal",
        }
    }
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
