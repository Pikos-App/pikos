//! Which columns of which tables sync, and how each row is named as a record: the one source for
//! the capture triggers and the codec.
//!
//! Every column of a synced table is classified here, and a test reads the schema and fails on any
//! column that isn't, so a migration can't start or stop syncing a column by accident.

use pikos_replica::Entity;

/// Values that move under one clock. Usually one column; columns that must never split, like a
/// page's status and when it was completed, are one field, and so is a whole row whose entity
/// merges by row.
pub struct Field {
    pub name: &'static str,
    pub columns: &'static [&'static str],
}

/// Which changes to an entity's rows are captured.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lifecycle {
    /// Created, changed and deleted.
    Row,
    /// Created once and never changed or deleted, like a tag, named by its value.
    CreateOnly,
    /// Created and changed, and gone when its owner is, like a page's body.
    Part,
}

/// The row a delete cascades from. A delete captured while it's already gone is the cascade, which
/// every device performs itself when the parent's tombstone arrives.
pub struct Parent {
    pub table: &'static str,
    pub column: &'static str,
}

pub struct EntityMap {
    pub entity: Entity,
    pub table: &'static str,
    pub lifecycle: Lifecycle,
    /// SQL for the record's key over the row, written `{row}`. A key that names a domain value
    /// instead of a row id is for rows two devices create independently under a uniqueness rule.
    pub key: &'static str,
    /// Which of the table's rows are this entity, when two entities share a table.
    pub covers: Option<&'static str>,
    /// In slot order. Append only: a slot's position is stored in every row's clocks, so a field
    /// added after sync ships comes with a migration that pads them.
    pub fields: &'static [Field],
    pub scope: Scope,
    pub parent: Option<Parent>,
}

/// Which rows sync. The calendar layer stays on each device: a page linked to a calendar, unless
/// the link is detached, along with everything that hangs off it, the done copies made by ticking
/// one of its occurrences, and the folders made for calendars. Scope is read when records are built,
/// not when changes are captured, because the reconciler inserts a page before its calendar link.
#[derive(Clone, Copy, Debug)]
pub enum Scope {
    All,
    /// While the page this column names is in scope. NULL names no page and is in scope.
    Page(&'static str),
    /// A folder a person made, not one made for a calendar.
    OwnFolder,
}

impl Scope {
    /// SQL true when the row, written `{row}`, is in scope.
    pub fn sql(self) -> String {
        match self {
            Scope::All => "1".to_owned(),
            Scope::OwnFolder => "{row}.is_external_calendar = 0".to_owned(),
            Scope::Page(column) => {
                let page = format!("{{row}}.{column}");
                format!(
                    "({page} IS NULL OR (\
                     NOT EXISTS (SELECT 1 FROM page_sync WHERE page_sync.page_id = {page} \
                     AND page_sync.sync_state <> 'detached') \
                     AND NOT EXISTS (SELECT 1 FROM completed_set JOIN page_sync \
                     ON page_sync.page_id = completed_set.page_id \
                     AND page_sync.sync_state <> 'detached' \
                     WHERE completed_set.clone_id = {page})))"
                )
            }
        }
    }
}

/// A synced table's columns that aren't in any entity's fields.
pub struct TableMap {
    pub table: &'static str,
    /// Row ids and key columns.
    pub identity: &'static [&'static str],
    /// Rebuilt on apply from synced values, never sent. `updated_at` is here because apply sets it
    /// to the newest winning clock's wall time; stamping now would float every remote change to the
    /// top of the recent lists.
    pub derived: &'static [&'static str],
    /// This device's own, never sent.
    pub local: &'static [&'static str],
}

/// Foreign keys that set a column NULL when their row is purged. That write isn't captured: every
/// device makes it itself when the purge's tombstone arrives.
pub const PURGE_NULLED: &[(&str, &str, &str)] = &[
    ("pages", "folder_id", "folders"),
    ("pages", "parent_id", "pages"),
    ("focus_sessions", "page_id", "pages"),
];

const PAGE_PARENT: Option<Parent> = Some(Parent {
    table: "pages",
    column: "page_id",
});

pub const ENTITIES: &[EntityMap] = &[
    EntityMap {
        entity: Entity::Page,
        table: "pages",
        lifecycle: Lifecycle::Row,
        key: "{row}.id",
        covers: None,
        fields: &[
            Field {
                name: "title",
                columns: &["title"],
            },
            Field {
                name: "subtitle",
                columns: &["subtitle"],
            },
            Field {
                name: "folder_id",
                columns: &["folder_id"],
            },
            Field {
                name: "parent_id",
                columns: &["parent_id"],
            },
            Field {
                name: "priority",
                columns: &["priority"],
            },
            Field {
                name: "sort_order",
                columns: &["sort_order"],
            },
            Field {
                name: "links",
                columns: &["links"],
            },
            Field {
                name: "deleted_at",
                columns: &["deleted_at"],
            },
            Field {
                name: "created_at",
                columns: &["created_at"],
            },
            Field {
                name: "status",
                columns: &["status", "completed_at"],
            },
        ],
        scope: Scope::Page("id"),
        parent: None,
    },
    EntityMap {
        entity: Entity::Body,
        table: "pages",
        lifecycle: Lifecycle::Part,
        key: "{row}.id",
        covers: None,
        fields: &[Field {
            name: "content",
            columns: &["content", "content_schema_version"],
        }],
        scope: Scope::Page("id"),
        parent: None,
    },
    EntityMap {
        entity: Entity::Folder,
        table: "folders",
        lifecycle: Lifecycle::Row,
        key: "{row}.id",
        covers: None,
        fields: &[
            Field {
                name: "name",
                columns: &["name"],
            },
            Field {
                name: "color",
                columns: &["color"],
            },
            Field {
                name: "icon",
                columns: &["icon"],
            },
            Field {
                name: "sort_order",
                columns: &["sort_order"],
            },
            Field {
                name: "deleted_at",
                columns: &["deleted_at"],
            },
            Field {
                name: "created_at",
                columns: &["created_at"],
            },
        ],
        scope: Scope::OwnFolder,
        parent: None,
    },
    EntityMap {
        entity: Entity::Tag,
        table: "tags",
        lifecycle: Lifecycle::CreateOnly,
        key: "{row}.name",
        covers: None,
        fields: &[Field {
            name: "created_at",
            columns: &["created_at"],
        }],
        scope: Scope::All,
        parent: None,
    },
    EntityMap {
        entity: Entity::PageTag,
        table: "page_tags",
        lifecycle: Lifecycle::Row,
        key: "{row}.page_id || '/' || (SELECT name FROM tags WHERE id = {row}.tag_id)",
        covers: None,
        fields: &[],
        scope: Scope::Page("page_id"),
        parent: PAGE_PARENT,
    },
    EntityMap {
        entity: Entity::Rule,
        table: "page_recurrence_rules",
        lifecycle: Lifecycle::Row,
        key: "{row}.page_id",
        covers: None,
        fields: &[Field {
            name: "rule",
            columns: &[
                "rrule",
                "rrule_exdates",
                "scheduled_start",
                "scheduled_end",
                "timezone",
                "created_at",
            ],
        }],
        scope: Scope::Page("page_id"),
        parent: PAGE_PARENT,
    },
    EntityMap {
        entity: Entity::Schedule,
        table: "page_schedules",
        lifecycle: Lifecycle::Row,
        key: "{row}.id",
        covers: Some("{row}.rule_id IS NULL"),
        fields: &[Field {
            name: "block",
            columns: &[
                "page_id",
                "scheduled_start",
                "scheduled_end",
                "timezone",
                "status",
                "created_at",
            ],
        }],
        scope: Scope::Page("page_id"),
        parent: PAGE_PARENT,
    },
    EntityMap {
        entity: Entity::Override,
        table: "page_schedules",
        lifecycle: Lifecycle::Row,
        key: "{row}.page_id || '/' || {row}.original_date",
        covers: Some("{row}.rule_id IS NOT NULL"),
        fields: &[Field {
            name: "override",
            columns: &[
                "scheduled_start",
                "scheduled_end",
                "timezone",
                "status",
                "created_at",
            ],
        }],
        scope: Scope::Page("page_id"),
        parent: Some(Parent {
            table: "page_recurrence_rules",
            column: "rule_id",
        }),
    },
    EntityMap {
        entity: Entity::Completed,
        table: "completed_set",
        lifecycle: Lifecycle::Row,
        key: "{row}.page_id || '/' || {row}.occurrence_date",
        covers: None,
        fields: &[Field {
            name: "clone_id",
            columns: &["clone_id"],
        }],
        scope: Scope::Page("page_id"),
        parent: PAGE_PARENT,
    },
    EntityMap {
        entity: Entity::Skipped,
        table: "skip_set",
        lifecycle: Lifecycle::Row,
        key: "{row}.page_id || '/' || {row}.occurrence_date",
        covers: None,
        fields: &[],
        scope: Scope::Page("page_id"),
        parent: PAGE_PARENT,
    },
    EntityMap {
        entity: Entity::Reminder,
        table: "page_reminders",
        lifecycle: Lifecycle::Row,
        key: "{row}.id",
        covers: None,
        fields: &[Field {
            name: "reminder",
            columns: &["page_id", "minutes_before", "created_at"],
        }],
        scope: Scope::Page("page_id"),
        parent: PAGE_PARENT,
    },
    EntityMap {
        entity: Entity::FocusSession,
        table: "focus_sessions",
        lifecycle: Lifecycle::Row,
        key: "{row}.id",
        covers: None,
        fields: &[Field {
            name: "session",
            columns: &["page_id", "started_at", "ended_at", "duration_s"],
        }],
        scope: Scope::Page("page_id"),
        parent: None,
    },
];

pub const TABLES: &[TableMap] = &[
    TableMap {
        table: "pages",
        identity: &["id"],
        derived: &[
            "content_text",
            "tags",
            "scheduled_start",
            "scheduled_end",
            "row_seq",
            "title_key",
            "order_start",
            "span_days",
            "is_absolute",
            "abs_start_utc",
            "mirror_search_text",
            "updated_at",
        ],
        local: &["last_opened_at"],
    },
    TableMap {
        table: "folders",
        identity: &["id"],
        derived: &["updated_at"],
        // Folders don't nest, so `parent_id` is always NULL. A calendar's folder is local, as the
        // whole calendar layer is.
        local: &["parent_id", "is_external_calendar"],
    },
    TableMap {
        table: "tags",
        identity: &["id", "name"],
        derived: &[],
        local: &[],
    },
    TableMap {
        table: "page_tags",
        identity: &["page_id", "tag_id"],
        derived: &[],
        local: &[],
    },
    TableMap {
        table: "page_recurrence_rules",
        identity: &["id", "page_id"],
        derived: &[],
        local: &[],
    },
    TableMap {
        table: "page_schedules",
        // An override's rule id is this device's; apply maps it from the page's rule.
        identity: &["id", "rule_id", "original_date"],
        derived: &[],
        local: &[],
    },
    TableMap {
        table: "completed_set",
        identity: &["page_id", "occurrence_date"],
        derived: &[],
        local: &[],
    },
    TableMap {
        table: "skip_set",
        identity: &["page_id", "occurrence_date"],
        derived: &[],
        local: &[],
    },
    TableMap {
        table: "page_reminders",
        identity: &["id"],
        derived: &[],
        local: &[],
    },
    TableMap {
        table: "focus_sessions",
        identity: &["id"],
        derived: &[],
        local: &[],
    },
];

pub fn entity(entity: Entity) -> Option<&'static EntityMap> {
    ENTITIES.iter().find(|e| e.entity == entity)
}

#[cfg(test)]
#[path = "manifest_tests.rs"]
mod tests;
