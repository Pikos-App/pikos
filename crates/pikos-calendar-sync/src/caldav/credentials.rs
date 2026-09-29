//! CalDAV connection credentials — the single opaque keychain blob per
//! `sync_account` (the parallel of Google serializing its tokens into one blob).
//! Never persisted to SQLite; `sync_account` holds only the row id that keys it.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaldavCredentials {
    /// The base server URL the user entered; autodiscovery starts here.
    pub base_url: String,
    pub username: String,
    pub password: String,
}

impl CaldavCredentials {
    /// Serialize for the keychain. The blob is opaque to the store.
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
}
