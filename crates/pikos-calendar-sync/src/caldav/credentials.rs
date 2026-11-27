//! CalDAV connection credentials — the single opaque keychain blob per
//! `sync_account` (the parallel of Google serializing its tokens into one blob).
//! Never persisted to SQLite; `sync_account` holds only the row id that keys it.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaldavCredentials {
    pub base_url: String,
    pub username: String,
    pub password: String,
}

impl CaldavCredentials {
    pub fn to_blob(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }

    pub fn from_blob(blob: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(blob)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_round_trips() {
        let creds = CaldavCredentials {
            base_url: "https://caldav.fastmail.com/".into(),
            username: "me@example.com".into(),
            password: "app-specific-pw".into(),
        };
        let restored = CaldavCredentials::from_blob(&creds.to_blob().unwrap()).unwrap();
        assert_eq!(creds, restored);
    }

    #[test]
    fn an_unreadable_caldav_credential_is_a_reconnect_that_quotes_none_of_it() {
        let keychain = crate::test_support::memory_keychain();
        keychain
            .store(
                "acc",
                r#"{"base_url":"https://x/","username":"me","password":"hunter2-secr"#,
            )
            .unwrap();

        let err = crate::caldav::stored_credentials(&keychain, "acc").unwrap_err();

        assert!(
            matches!(err, pikos_db::error::AppError::Invalid(_)),
            "got {err:?}"
        );
        assert!(!err.to_string().contains("hunter2"), "{err}");
    }
}
