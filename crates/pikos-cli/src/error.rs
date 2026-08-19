//! The CLI's error kinds and their exit codes.
//!
//! Every failure the binary can report is one of these, and each carries a
//! stable `kind` string plus the process exit code a caller can branch on.
//! Foreign error text (sqlx, io, serde) never reaches the user.

use pikos_db::AppError;

#[derive(Debug)]
pub struct CliError {
    pub kind: &'static str,
    pub message: String,
    pub code: i32,
}

impl CliError {
    pub fn new(kind: &'static str, message: impl Into<String>, code: i32) -> Self {
        CliError {
            kind,
            message: message.into(),
            code,
        }
    }
    pub fn usage(m: impl Into<String>) -> Self {
        Self::new("Usage", m, 2)
    }
    pub fn not_found(m: impl Into<String>) -> Self {
        Self::new("NotFound", m, 3)
    }
    pub fn conflict(m: impl Into<String>) -> Self {
        Self::new("Conflict", m, 4)
    }
    pub fn workspace(m: impl Into<String>) -> Self {
        Self::new("Workspace", m, 5)
    }
    pub fn missing_node(m: impl Into<String>) -> Self {
        Self::new("MissingNode", m, 7)
    }
    pub fn migration_required(m: impl Into<String>) -> Self {
        Self::new("MigrationRequired", m, 8)
    }
    pub fn internal(m: impl Into<String>) -> Self {
        Self::new("Internal", m, 1)
    }
}

/// Map a pikos-db AppError to a scrubbed CliError. Foreign (sqlx) messages are
/// never surfaced — only a stable kind + generic text; NotFound/Conflict/Invalid
/// carry our own safe messages.
pub fn classify(err: AppError) -> CliError {
    // open_pool's migrator returns VersionMissing when the DB has applied a
    // migration this build doesn't know — i.e. the workspace is newer than the
    // CLI. Surface that as a clear, actionable error rather than a generic Db one.
    if let AppError::Db(sqlx::Error::Migrate(ref m)) = err {
        if matches!(**m, sqlx::migrate::MigrateError::VersionMissing(_)) {
            return CliError::new(
                "SchemaTooNew",
                "This workspace's database is newer than this Pikos CLI supports. Upgrade the CLI to match the desktop app.",
                6,
            );
        }
    }
    match err {
        AppError::NotFound(m) => CliError::not_found(m),
        AppError::Conflict(m) => CliError::conflict(m),
        AppError::Invalid(m) => CliError::usage(m),
        AppError::Db(_) => CliError::new("Db", "a database error occurred", 1),
        AppError::Io(_) => CliError::internal("an I/O error occurred"),
        AppError::Serde(_) => CliError::internal("a serialization error occurred"),
        AppError::Network(m) => CliError::new("Network", m, 1),
        AppError::Internal(m) => CliError::internal(m),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_maps_kinds_and_scrubs_db() {
        assert_eq!(classify(AppError::NotFound("x".into())).code, 3);
        assert_eq!(classify(AppError::NotFound("x".into())).kind, "NotFound");
        assert_eq!(classify(AppError::Conflict("x".into())).code, 4);
        assert_eq!(classify(AppError::Invalid("x".into())).kind, "Usage");
        // Foreign DB error text is scrubbed to a stable kind + generic message.
        let db = classify(AppError::Db(sqlx::Error::RowNotFound));
        assert_eq!(db.kind, "Db");
        assert_eq!(db.message, "a database error occurred");
    }

    #[test]
    fn schema_too_new_maps_to_exit_6() {
        let err = AppError::Db(sqlx::Error::Migrate(Box::new(
            sqlx::migrate::MigrateError::VersionMissing(99),
        )));
        let cli = classify(err);
        assert_eq!(cli.kind, "SchemaTooNew");
        assert_eq!(cli.code, 6);
    }
}
