use super::*;
use std::collections::HashSet;

const PAGE_ID: &str = "0b9c6f2e-4d1a-4f3e-9a51-7c2d8e6b1f40";

#[test]
fn a_page_and_its_body_have_different_names() {
    assert_ne!(
        RecordName::live(Entity::Page, PAGE_ID).to_string(),
        RecordName::live(Entity::Body, PAGE_ID).to_string()
    );
}

#[test]
fn every_prefix_is_distinct() {
    let prefixes: HashSet<_> = ALL_ENTITIES.iter().map(|e| e.prefix()).collect();
    assert_eq!(prefixes.len(), ALL_ENTITIES.len());
    assert!(!prefixes.contains(TOMBSTONE_PREFIX));
}

#[test]
fn names_round_trip_for_every_entity_live_and_tombstoned() {
    for entity in ALL_ENTITIES {
        let live = RecordName::live(entity, PAGE_ID);
        for name in [live.clone(), live.tombstone_of()] {
            assert_eq!(name.to_string().parse::<RecordName>(), Ok(name));
        }
    }
}

#[test]
fn a_tombstone_reads_as_tomb_then_the_live_name() {
    let name = RecordName::live(Entity::Folder, "f1").tombstone_of();
    assert_eq!(name.to_string(), "tomb:folder:f1");
}

#[test]
fn a_key_may_itself_contain_colons() {
    let name = RecordName::live(Entity::Override, "p1:2026-10-16");
    assert_eq!(name.to_string().parse::<RecordName>(), Ok(name));
}

#[test]
fn malformed_names_are_refused() {
    for bad in [
        "",
        "page",
        "page:",
        "nope:p1",
        "tomb:",
        "tomb:page",
        "tombpage:p1",
        ":p1",
    ] {
        assert!(bad.parse::<RecordName>().is_err(), "{bad:?} parsed");
    }
}

#[test]
fn a_plain_record_name_is_stored_as_it_is() {
    let name = RecordName::live(Entity::Override, "p1/2026-10-17T09:00:00");

    assert_eq!(name.store_name(), "override:p1/2026-10-17T09:00:00");
}

#[test]
fn a_name_with_characters_cloudkit_refuses_is_escaped() {
    let name = RecordName::live(Entity::PageTag, "p1/café ☕");

    let stored = name.store_name();

    assert_eq!(stored, "pagetag:p1/caf%C3%A9%20%E2%98%95");
    assert!(stored.is_ascii());
}

#[test]
fn a_name_too_long_is_cut_and_kept_unique() {
    let long =
        |tail: &str| RecordName::live(Entity::PageTag, format!("p1/{}{tail}", "x".repeat(400)));

    let a = long("a").store_name();
    let b = long("b").store_name();

    assert_eq!(a.len(), 255);
    assert_ne!(a, b);
    assert_eq!(a, long("a").store_name());
}
