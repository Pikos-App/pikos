//! Google-specific failures, kept richer than the shared `AppError` so the auth
//! logic can branch (revoked grant vs transport vs misbuilt client), then
//! flattened onto `AppError` at the crate boundary — the same split CalDAV uses.

use pikos_db::error::AppError;

#[derive(Debug, thiserror::Error)]
pub enum GoogleError {
    /// The build carries no OAuth client. Google sync is simply unavailable —
    /// CalDAV accounts are unaffected.
    #[error("Google Calendar sync isn't available in this build")]
    NotConfigured,

    /// The refresh token no longer works — the user revoked access in their
    /// Google account, or the grant expired. Only re-authorizing fixes it.
    #[error("Google access was revoked — reconnect the account")]
    Revoked,

    /// The user closed the browser, denied consent, or never finished.
    #[error("Google authorization was cancelled")]
    Cancelled,

    /// Google's granular consent screen lets a user approve part of the request;
    /// approving less than sync needs yields tokens that can't read the calendar.
    #[error("Google Calendar access wasn't fully granted — reconnect and allow both permissions")]
    ScopesWithheld,

    /// Transport-level failure (DNS, TLS, connection, timeout, read).
    #[error("Google network error: {0}")]
    Network(String),

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
            | GoogleError::ScopesWithheld
            | GoogleError::NotConfigured => AppError::Invalid(e.to_string()),
            GoogleError::Network(_) => AppError::Network(e.to_string()),
            GoogleError::Protocol(_) => AppError::Internal(e.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mapped(e: GoogleError) -> AppError {
        e.into()
    }

    // The boundary mapping decides how a Google failure reads downstream, and the
    // engine keys off it: Invalid → ReconnectNeeded (stop, ask the user), Network →
    // Offline (stale dot, cursor untouched, retry). Mapping a revoked grant as
    // Network would poll a dead account forever with no prompt to reconnect.
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
    }

    #[test]
    fn network_is_network() {
        assert!(matches!(
            mapped(GoogleError::Network("x".into())),
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
