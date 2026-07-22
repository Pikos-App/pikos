//! CalDAV-specific failures, kept richer than the shared `AppError` so the
//! discovery/sync logic can branch (auth vs transport vs malformed server),
//! then flattened onto `AppError` at the `CalendarProvider` trait boundary.

use pikos_db::error::AppError;

#[derive(Debug, thiserror::Error)]
pub enum CaldavError {
    /// 401/403 — wrong username or app password. User-actionable at connect time;
    /// "reconnect needed" once an account already exists.
    #[error("CalDAV authentication failed — check the username and app password")]
    Unauthorized,

    /// Transport-level failure (DNS, TLS, connection, timeout, read).
    #[error("CalDAV network error: {0}")]
    Network(String),

    /// Reached the server but it answered a PROPFIND with an unexpected status.
    #[error("unexpected CalDAV status {0}")]
    UnexpectedStatus(u16),

    /// The URL is reachable but the discovery chain didn't yield a principal /
    /// calendar-home — almost always a wrong server URL or a non-CalDAV endpoint.
    #[error("CalDAV discovery failed: {0}")]
    NotCaldav(String),

    /// Malformed XML, or a redirect with no `Location`.
    #[error("malformed CalDAV response: {0}")]
    Protocol(String),
}

impl From<CaldavError> for AppError {
    fn from(e: CaldavError) -> Self {
        match e {
            // Both surface as user-actionable input problems at connect time.
            CaldavError::Unauthorized | CaldavError::NotCaldav(_) => {
                AppError::Invalid(e.to_string())
            }
            CaldavError::Network(_) | CaldavError::UnexpectedStatus(_) => {
                AppError::Network(e.to_string())
            }
            CaldavError::Protocol(_) => AppError::Internal(e.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mapped(e: CaldavError) -> AppError {
        e.into()
    }

    // The boundary mapping decides how a CalDAV failure reads downstream: Invalid =
    // user-actionable (bad creds/URL), Network = transient (calm stale indicator),
    // Internal = a bug/contract break. A mis-map would, e.g., show a 500 as
    // "reconnect needed" or a wrong password as a transient blip.
    #[test]
    fn auth_and_not_caldav_are_user_actionable_invalid() {
        assert!(matches!(
            mapped(CaldavError::Unauthorized),
            AppError::Invalid(_)
        ));
        assert!(matches!(
            mapped(CaldavError::NotCaldav("x".into())),
            AppError::Invalid(_)
        ));
    }

    #[test]
    fn network_and_unexpected_status_are_network() {
        assert!(matches!(
            mapped(CaldavError::Network("x".into())),
            AppError::Network(_)
        ));
        assert!(matches!(
            mapped(CaldavError::UnexpectedStatus(500)),
            AppError::Network(_)
        ));
    }

    #[test]
    fn protocol_is_internal() {
        assert!(matches!(
            mapped(CaldavError::Protocol("x".into())),
            AppError::Internal(_)
        ));
    }
}
