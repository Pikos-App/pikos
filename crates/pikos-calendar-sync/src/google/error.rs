//! Google-specific failures, kept richer than the shared `AppError` so the auth
//! logic can branch (revoked grant vs transport vs misbuilt client), then
//! flattened onto `AppError` at the crate boundary — the same split CalDAV uses.

use pikos_db::error::AppError;

#[derive(Debug, thiserror::Error)]
pub enum GoogleError {
    /// The build carries no OAuth client. Google sync is unavailable —
    /// CalDAV accounts are unaffected.
    #[error("Google Calendar sync isn't available in this build")]
    NotConfigured,

    /// The refresh token no longer works — the user revoked access in their
    /// Google account, or the grant expired. Only re-authorizing fixes it.
    #[error("Google access was revoked. Connect the account again.")]
    Revoked,

    /// The user denied consent in the browser.
    #[error("Google authorization was cancelled")]
    Cancelled,

    /// Nothing came back from the browser before the listener gave up.
    #[error("Google sign-in took too long, so Pikos stopped waiting. Connect again to retry.")]
    TimedOut,

    /// Google's granular consent screen lets a user approve part of the request;
    /// approving less than sync needs yields tokens that can't read the calendar.
    #[error("Pikos needs both Google Calendar permissions to sync. Connect again and allow both.")]
    ScopesWithheld,

    /// No `primary` entry in `calendarList`. Its id is the account's *identity* —
    /// a reconnect is matched on it — not just a label, so falling back to a
    /// constant would let a second primary-less account claim the first's row and
    /// overwrite its keychain blob: a silent cross-account merge.
    #[error(
        "Google didn't send this account's main calendar, so Pikos can't tell it apart from another. Nothing was connected."
    )]
    NoPrimaryCalendar,

    #[error("Google network error: {0}")]
    Network(String),

    /// The keychain refused a write. Not Network: it is this machine, not the connection.
    #[error("{0}")]
    Keychain(String),

    /// The stored blob no longer deserializes. Carries nothing of serde's message, which
    /// can quote the blob.
    #[error("Pikos can't read this Google account's saved sign-in. Connect the account again.")]
    CredentialsUnreadable,

    /// The event is gone upstream (`404`). Terminal for a targeted fetch: the
    /// engine drops the occurrence delta that asked for it instead of retrying
    /// against a master that will never come back.
    #[error("Google event not found")]
    NotFound,

    /// Listing a calendar's events answered `404`: the calendar was deleted, or this
    /// account can no longer see it.
    #[error("Google no longer has this calendar, or this account can't see it any more.")]
    CalendarGone,

    /// Quota or per-user rate limit. Transient by definition — the cursor is kept
    /// and the next scheduled poll retries.
    #[error("Google is limiting requests for now. Pikos will try again shortly.")]
    RateLimited,

    /// Reached Google but it answered with a status sync doesn't handle. `op` names
    /// the API method rather than the path, which holds the calendar id, an email address.
    #[error("Google {op} answered HTTP {status}")]
    UnexpectedStatus { op: &'static str, status: u16 },

    /// Reached Google but couldn't make sense of the exchange — a malformed
    /// token response, a rejected client_id, or a redirect that didn't carry
    /// the state we issued.
    #[error("Google authorization failed: {0}")]
    Protocol(String),
}

impl From<GoogleError> for AppError {
    fn from(e: GoogleError) -> Self {
        match e {
            // All user-actionable: reconnect, retry the grant, grant the rest, or
            // wait for a build that ships the client.
            GoogleError::Revoked
            | GoogleError::Cancelled
            | GoogleError::TimedOut
            | GoogleError::ScopesWithheld
            | GoogleError::NoPrimaryCalendar
            | GoogleError::CredentialsUnreadable
            | GoogleError::NotConfigured => AppError::Invalid(e.to_string()),
            GoogleError::NotFound | GoogleError::CalendarGone => AppError::NotFound(e.to_string()),
            // Transient: maps to `Offline` — cursor kept, retried later, no reconnect prompt.
            // Google documents its 5xx answers as retryable, so they land here too.
            GoogleError::Network(_) | GoogleError::RateLimited => AppError::Network(e.to_string()),
            GoogleError::UnexpectedStatus { status, .. } if status == 408 || status >= 500 => {
                AppError::Network(e.to_string())
            }
            // Any other status repeats on every poll, so it is reported rather than read as offline.
            GoogleError::UnexpectedStatus { .. }
            | GoogleError::Keychain(_)
            | GoogleError::Protocol(_) => AppError::Internal(e.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mapped(e: GoogleError) -> AppError {
        e.into()
    }

    // Mapping a revoked grant as Network would poll a dead account forever with
    // no prompt to reconnect.
    #[test]
    fn revoked_is_user_actionable_invalid() {
        assert!(matches!(mapped(GoogleError::Revoked), AppError::Invalid(_)));
        assert!(matches!(
            mapped(GoogleError::Cancelled),
            AppError::Invalid(_)
        ));
        assert!(matches!(
            mapped(GoogleError::ScopesWithheld),
            AppError::Invalid(_)
        ));
        assert!(matches!(
            mapped(GoogleError::NotConfigured),
            AppError::Invalid(_)
        ));
        assert!(matches!(
            mapped(GoogleError::NoPrimaryCalendar),
            AppError::Invalid(_)
        ));
        assert!(matches!(
            mapped(GoogleError::TimedOut),
            AppError::Invalid(_)
        ));
    }

    #[test]
    fn messages_a_person_reads_use_no_em_dash() {
        for e in [
            GoogleError::Revoked,
            GoogleError::ScopesWithheld,
            GoogleError::NoPrimaryCalendar,
            GoogleError::RateLimited,
            GoogleError::TimedOut,
            GoogleError::CredentialsUnreadable,
            GoogleError::CalendarGone,
        ] {
            assert!(!e.to_string().contains('—'), "{e}");
        }
    }

    #[test]
    fn network_is_network() {
        assert!(matches!(
            mapped(GoogleError::Network("x".into())),
            AppError::Network(_)
        ));
    }

    #[test]
    fn a_status_names_its_method_and_not_its_path() {
        let e = GoogleError::UnexpectedStatus {
            op: "events.list",
            status: 400,
        };
        assert_eq!(e.to_string(), "Google events.list answered HTTP 400");
    }

    // Invalid would set reconnect_needed and prompt re-auth over a quota blip
    // that clears itself — a rate limit must read as transient, not a bad credential.
    #[test]
    fn rate_limited_is_transient_not_a_reconnect_prompt() {
        assert!(matches!(
            mapped(GoogleError::RateLimited),
            AppError::Network(_)
        ));
    }

    #[test]
    fn protocol_is_internal() {
        assert!(matches!(
            mapped(GoogleError::Protocol("x".into())),
            AppError::Internal(_)
        ));
    }
}
