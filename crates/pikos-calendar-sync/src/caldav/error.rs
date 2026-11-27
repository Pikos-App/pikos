//! CalDAV-specific failures, kept richer than the shared `AppError` so the
//! discovery/sync logic can branch (auth vs transport vs malformed server),
//! then flattened onto `AppError` at the `CalendarProvider` trait boundary.

use pikos_db::error::AppError;

#[derive(Debug, thiserror::Error)]
pub enum CaldavError {
    /// 401: wrong username or app password. User-actionable at connect time;
    /// "reconnect needed" once an account already exists.
    #[error("The server refused the sign-in. Check the username and app password.")]
    Unauthorized,

    /// 403: the sign-in was accepted but the request was refused, so a new password is not
    /// the first thing to try. Flattened like `Unauthorized`, since only the person can act.
    #[error(
        "The server accepted the sign-in but refused access. Check that the app password is allowed to use calendars, and that this account can still read the calendar."
    )]
    Forbidden,

    /// No answer at all. The text is [`crate::http::failure`]'s class and cause chain.
    #[error("CalDAV network error: {0}")]
    Network(String),

    /// An answer sync doesn't handle. `op` names the request rather than its URL, which
    /// can hold the account's email address.
    #[error("{}", status_message(op, *status))]
    UnexpectedStatus { op: &'static str, status: u16 },

    /// The URL is reachable but the discovery chain didn't yield a principal /
    /// calendar-home — almost always a wrong server URL or a non-CalDAV endpoint.
    #[error("CalDAV discovery failed: {0}")]
    NotCaldav(String),

    #[error("malformed CalDAV response: {0}")]
    Protocol(String),
}

fn status_message(op: &str, status: u16) -> String {
    if is_gone(status) {
        format!("The server no longer has this calendar (CalDAV {op} answered HTTP {status}).")
    } else {
        format!("CalDAV {op} answered HTTP {status}")
    }
}

fn is_gone(status: u16) -> bool {
    matches!(status, 404 | 410)
}

/// Statuses that say "not now" rather than "never": a timeout, throttling, and a gateway or
/// server that is down or overloaded. A plain 500 is left out, because a CalDAV server that fails
/// a REPORT tends to fail the same REPORT on every poll, and reading it as offline would hide it.
fn is_transient(status: u16) -> bool {
    matches!(status, 408 | 429 | 502 | 503 | 504)
}

impl From<CaldavError> for AppError {
    fn from(e: CaldavError) -> Self {
        match e {
            // All surface as user-actionable input problems at connect time.
            CaldavError::Unauthorized | CaldavError::Forbidden | CaldavError::NotCaldav(_) => {
                AppError::Invalid(e.to_string())
            }
            CaldavError::Network(_) => AppError::Network(e.to_string()),
            // The engine reads Network as offline and keeps retrying quietly, so only a status
            // that will clear by itself goes there. The rest is an error the pass reports.
            CaldavError::UnexpectedStatus { status, .. } if is_transient(status) => {
                AppError::Network(e.to_string())
            }
            CaldavError::UnexpectedStatus { status, .. } if is_gone(status) => {
                AppError::NotFound(e.to_string())
            }
            CaldavError::UnexpectedStatus { .. } | CaldavError::Protocol(_) => {
                AppError::Internal(e.to_string())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mapped(e: CaldavError) -> AppError {
        e.into()
    }

    // A mis-map would show a 500 as "reconnect needed" or a wrong password as a
    // transient blip that clears on its own.
    #[test]
    fn auth_and_not_caldav_are_user_actionable_invalid() {
        assert!(matches!(
            mapped(CaldavError::Unauthorized),
            AppError::Invalid(_)
        ));
        assert!(matches!(
            mapped(CaldavError::Forbidden),
            AppError::Invalid(_)
        ));
        assert!(matches!(
            mapped(CaldavError::NotCaldav("x".into())),
            AppError::Invalid(_)
        ));
    }

    #[test]
    fn a_refused_password_reads_without_an_em_dash() {
        for e in [CaldavError::Unauthorized, CaldavError::Forbidden] {
            let message = e.to_string();
            assert!(!message.contains('—'), "{message}");
        }
    }

    #[test]
    fn network_and_a_transient_status_are_network() {
        assert!(matches!(
            mapped(CaldavError::Network("x".into())),
            AppError::Network(_)
        ));
        for status in [408, 429, 502, 503, 504] {
            assert!(
                matches!(
                    mapped(CaldavError::UnexpectedStatus {
                        op: "REPORT",
                        status
                    }),
                    AppError::Network(_)
                ),
                "{status}"
            );
        }
    }

    #[test]
    fn a_status_names_its_request() {
        let message = CaldavError::UnexpectedStatus {
            op: "calendar-query REPORT",
            status: 500,
        }
        .to_string();
        assert_eq!(message, "CalDAV calendar-query REPORT answered HTTP 500");
    }

    #[test]
    fn protocol_is_internal() {
        assert!(matches!(
            mapped(CaldavError::Protocol("x".into())),
            AppError::Internal(_)
        ));
    }
}
