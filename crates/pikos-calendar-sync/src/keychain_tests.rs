use super::*;
use crate::test_support::memory_keychain as keychain;

/// The real OS store, not the in-memory stand-in.
///
/// Ignored by default: it writes to the machine's own keychain, which on macOS means a prompt and
/// on a headless Linux session means nothing is listening. `scripts/linux-keyring-check.sh` runs it
/// where a Secret Service exists, which is the only place the Linux backend is exercised at all —
/// every other test here injects a map, and a missing backend still passes all of them.
#[test]
#[ignore = "writes to the machine's keychain; see scripts/linux-keyring-check.sh"]
fn the_system_keychain_round_trips() {
    let account = format!("pikos-test-{}", std::process::id());
    let kc = Keychain::system();

    kc.store(&account, "app-password").expect("store");
    assert_eq!(kc.load(&account).expect("load"), "app-password");
    kc.delete(&account).expect("delete");
    assert!(matches!(kc.load(&account), Err(KeychainError::NotFound)));
}

/// Every platform Pikos builds for names a keyring backend.
///
/// With no feature named, keyring compiles in an in-memory mock that accepts every write and
/// shares nothing between `Entry` instances, so Connect appears to work and every later launch
/// reads `NotFound`. That is what shipped, and it passed every other test in this file.
///
/// A manifest check rather than a round trip because the round trip needs a Secret Service to talk
/// to, which the suite that would catch the omission has not got. The round trip lives in
/// `scripts/linux-keyring-check.sh`; this is the half that runs on the commit that drops the line.
#[test]
fn every_platform_names_a_keyring_backend() {
    let manifest = include_str!("../Cargo.toml");
    let mut checked = 0;

    for (platform, section) in [
        (
            "macos",
            "[target.'cfg(target_os = \"macos\")'.dependencies]",
        ),
        (
            "linux",
            "[target.'cfg(target_os = \"linux\")'.dependencies]",
        ),
    ] {
        let body = manifest
            .split(section)
            .nth(1)
            .unwrap_or_else(|| panic!("{section} is gone from Cargo.toml"));
        let line = body
            .lines()
            .find(|l| l.trim_start().starts_with("keyring"))
            .unwrap_or_else(|| panic!("{platform} names no keyring dependency"));
        assert!(
            line.contains("features"),
            "{platform} names keyring with no backend feature, so it gets the in-memory mock: {line}"
        );
        checked += 1;
    }

    assert_eq!(checked, 2, "a target block stopped being checked");
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
    assert!(matches!(
        map_err(keyring::Error::NoEntry),
        KeychainError::NotFound
    ));
    assert!(matches!(
        map_err(keyring::Error::BadEncoding(vec![0xff])),
        KeychainError::Backend(_)
    ));
}
