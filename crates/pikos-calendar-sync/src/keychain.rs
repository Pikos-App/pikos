//! OS keychain wrapper for sync credentials — never SQLite or the Tauri store.
//!
//! One opaque secret per `sync_account` id; a provider needing several secrets
//! (Google's tokens) serializes them into that one blob. `NotFound` is the
//! "reconnect needed" signal — an absent/revoked credential means stop polling
//! and re-auth; a `Backend` error is transient and retried, not a logout.

use keyring::Entry;

const SERVICE: &str = "app.pikos.desktop.sync";

#[derive(Debug, thiserror::Error)]
pub enum KeychainError {
    #[error("no credential stored for this account")]
    NotFound,
    #[error("keychain backend error: {0}")]
    Backend(String),
}

impl KeychainError {
    /// Absent credential → "reconnect needed"; not a transient backend failure.
    pub fn is_reconnect_needed(&self) -> bool {
        matches!(self, KeychainError::NotFound)
    }
}

/// Secret backend. Production = OS keychain; tests inject an in-memory map
/// (keyring's mock backend can't round-trip — state isn't shared across `Entry`s).
pub(crate) trait CredentialStore: Send + Sync {
    fn set(&self, key: &str, secret: &str) -> Result<(), KeychainError>;
    fn get(&self, key: &str) -> Result<String, KeychainError>;
    fn delete(&self, key: &str) -> Result<(), KeychainError>;
}

struct KeyringStore;

impl CredentialStore for KeyringStore {
    fn set(&self, key: &str, secret: &str) -> Result<(), KeychainError> {
        entry(key)?.set_password(secret).map_err(map_err)
    }

    fn get(&self, key: &str) -> Result<String, KeychainError> {
        entry(key)?.get_password().map_err(map_err)
    }

    fn delete(&self, key: &str) -> Result<(), KeychainError> {
        // Idempotent — deleting an absent entry is success (disconnect-twice safe).
        match entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(map_err(e)),
        }
    }
}

fn entry(key: &str) -> Result<Entry, KeychainError> {
    Entry::new(SERVICE, key).map_err(map_err)
}

fn map_err(e: keyring::Error) -> KeychainError {
    match e {
        keyring::Error::NoEntry => KeychainError::NotFound,
        other => KeychainError::Backend(other.to_string()),
    }
}

/// Per-account credential store over the OS keychain.
pub struct Keychain {
    store: Box<dyn CredentialStore>,
}

impl Keychain {
    /// The real OS keychain. Use everywhere outside tests.
    pub fn system() -> Self {
        Self { store: Box::new(KeyringStore) }
    }

    #[cfg(test)]
    pub(crate) fn with_store(store: Box<dyn CredentialStore>) -> Self {
        Self { store }
    }

    pub fn store(&self, account_id: &str, secret: &str) -> Result<(), KeychainError> {
        self.store.set(account_id, secret)
    }

    /// `NotFound` ⇒ reconnect needed.
    pub fn load(&self, account_id: &str) -> Result<String, KeychainError> {
        self.store.get(account_id)
    }

    /// Idempotent — absent entry is Ok.
    pub fn delete(&self, account_id: &str) -> Result<(), KeychainError> {
        self.store.delete(account_id)
    }
}

impl Default for Keychain {
    fn default() -> Self {
        Self::system()
    }
}

#[cfg(test)]
#[path = "keychain_tests.rs"]
mod keychain_tests;
