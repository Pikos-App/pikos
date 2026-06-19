use super::*;
use std::collections::HashMap;
use std::sync::Mutex;

/// In-memory stand-in for the OS keychain — exercises the wrapper without the real backend.
#[derive(Default)]
struct MemoryStore {
    map: Mutex<HashMap<String, String>>,
}

impl CredentialStore for MemoryStore {
    fn set(&self, key: &str, secret: &str) -> Result<(), KeychainError> {
        self.map.lock().unwrap().insert(key.to_string(), secret.to_string());
        Ok(())
    }

    fn get(&self, key: &str) -> Result<String, KeychainError> {
        self.map
            .lock()
            .unwrap()
            .get(key)
            .cloned()
            .ok_or(KeychainError::NotFound)
    }

    fn delete(&self, key: &str) -> Result<(), KeychainError> {
        self.map.lock().unwrap().remove(key);
        Ok(())
    }
}

fn keychain() -> Keychain {
    Keychain::with_store(Box::new(MemoryStore::default()))
}

#[test]
fn store_then_load_round_trips() {
    let kc = keychain();
    kc.store("acct-1", "app-password").unwrap();
    assert_eq!(kc.load("acct-1").unwrap(), "app-password");
}

#[test]
fn store_overwrites_existing_secret() {
    let kc = keychain();
    kc.store("acct-1", "old").unwrap();
    kc.store("acct-1", "new").unwrap();
    assert_eq!(kc.load("acct-1").unwrap(), "new");
}

#[test]
fn load_missing_is_reconnect_needed() {
    let kc = keychain();
    let err = kc.load("never-stored").unwrap_err();
    assert!(matches!(err, KeychainError::NotFound));
    assert!(err.is_reconnect_needed());
}

#[test]
fn delete_removes_the_secret() {
    let kc = keychain();
    kc.store("acct-1", "secret").unwrap();
    kc.delete("acct-1").unwrap();
    assert!(matches!(kc.load("acct-1"), Err(KeychainError::NotFound)));
}

#[test]
fn delete_missing_is_idempotent() {
    let kc = keychain();
    kc.delete("acct-1").unwrap();
    kc.delete("acct-1").unwrap();
}

#[test]
fn secrets_are_keyed_per_account() {
    let kc = keychain();
    kc.store("acct-1", "secret-1").unwrap();
    kc.store("acct-2", "secret-2").unwrap();
    assert_eq!(kc.load("acct-1").unwrap(), "secret-1");
    assert_eq!(kc.load("acct-2").unwrap(), "secret-2");
    kc.delete("acct-1").unwrap(); // leaves acct-2 intact

    assert!(matches!(kc.load("acct-1"), Err(KeychainError::NotFound)));
    assert_eq!(kc.load("acct-2").unwrap(), "secret-2");
}

#[test]
fn backend_error_is_not_reconnect_needed() {
    assert!(!KeychainError::Backend("locked".into()).is_reconnect_needed());
}

#[test]
fn keyring_no_entry_maps_to_not_found() {
    // The reconnect-needed primitive hinges on this mapping from the real backend.
    assert!(matches!(map_err(keyring::Error::NoEntry), KeychainError::NotFound));
    assert!(matches!(
        map_err(keyring::Error::BadEncoding(vec![0xff])),
        KeychainError::Backend(_)
    ));
}
