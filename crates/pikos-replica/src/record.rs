//! Record names: how a synced row is addressed in a transport's store.
//!
//! A CloudKit record id is a name within a zone, and the record type is not part
//! of it, so every name carries its entity as a prefix. Without one, a page and
//! its body, both keyed by the page id, would be the same record.

use std::fmt;
use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Entity {
    Page,
    Body,
    Folder,
    Tag,
    PageTag,
    Rule,
    Schedule,
    Override,
    Completed,
    Skipped,
    Reminder,
    FocusSession,
    Asset,
}

/// Every entity once, for exhaustive checks; a new variant missing here fails
/// `every_prefix_is_distinct`.
pub const ALL_ENTITIES: [Entity; 13] = [
    Entity::Page,
    Entity::Body,
    Entity::Folder,
    Entity::Tag,
    Entity::PageTag,
    Entity::Rule,
    Entity::Schedule,
    Entity::Override,
    Entity::Completed,
    Entity::Skipped,
    Entity::Reminder,
    Entity::FocusSession,
    Entity::Asset,
];

/// Prefixes are part of every stored record name, so they never change once
/// sync has shipped.
impl Entity {
    pub const fn prefix(self) -> &'static str {
        match self {
            Entity::Page => "page",
            Entity::Body => "body",
            Entity::Folder => "folder",
            Entity::Tag => "tag",
            Entity::PageTag => "pagetag",
            Entity::Rule => "rule",
            Entity::Schedule => "sched",
            Entity::Override => "override",
            Entity::Completed => "done",
            Entity::Skipped => "skip",
            Entity::Reminder => "remind",
            Entity::FocusSession => "focus",
            Entity::Asset => "asset",
        }
    }

    fn from_prefix(prefix: &str) -> Option<Entity> {
        ALL_ENTITIES.into_iter().find(|e| e.prefix() == prefix)
    }
}

const TOMBSTONE_PREFIX: &str = "tomb";

/// `<entity>:<key>` for a live record, `tomb:<entity>:<key>` for the tombstone
/// that records its deletion with a clock, which a store's own delete lacks.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RecordName {
    pub entity: Entity,
    pub key: String,
    pub tombstone: bool,
}

impl RecordName {
    pub fn live(entity: Entity, key: impl Into<String>) -> RecordName {
        RecordName {
            entity,
            key: key.into(),
            tombstone: false,
        }
    }

    pub fn tombstone_of(&self) -> RecordName {
        RecordName {
            tombstone: true,
            ..self.clone()
        }
    }
}

impl fmt::Display for RecordName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.tombstone {
            write!(f, "{TOMBSTONE_PREFIX}:")?;
        }
        write!(f, "{}:{}", self.entity.prefix(), self.key)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseRecordNameError(String);

impl fmt::Display for ParseRecordNameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "not a record name: {:?}", self.0)
    }
}

impl std::error::Error for ParseRecordNameError {}

impl FromStr for RecordName {
    type Err = ParseRecordNameError;

    fn from_str(s: &str) -> Result<RecordName, ParseRecordNameError> {
        let err = || ParseRecordNameError(s.to_owned());
        let (tombstone, rest) = match s.strip_prefix(TOMBSTONE_PREFIX) {
            Some(rest) => (true, rest.strip_prefix(':').ok_or_else(err)?),
            None => (false, s),
        };
        let (prefix, key) = rest.split_once(':').ok_or_else(err)?;
        let entity = Entity::from_prefix(prefix).ok_or_else(err)?;
        if key.is_empty() {
            return Err(err());
        }
        Ok(RecordName {
            entity,
            key: key.to_owned(),
            tombstone,
        })
    }
}

#[cfg(test)]
#[path = "record_tests.rs"]
mod tests;
