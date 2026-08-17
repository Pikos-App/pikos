use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::now_iso;

// ─── DB row ───────────────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct FolderRow {
    id: String,
    name: String,
    parent_id: Option<String>,
    sort_order: i64,
    color: Option<String>,
    icon: Option<String>,
    is_external_calendar: i64,
    created_at: String,
    updated_at: String,
}

// ─── Output type ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields = nullable)]
pub struct Folder {
    pub id: String,
    pub name: String,
    #[ts(optional = false)]
    pub parent_id: Option<String>,
    #[ts(type = "number")]
    pub sort_order: i64,
    pub color: Option<String>,
    pub icon: Option<String>,
    /// True for a folder that mirrors a synced calendar. Pikos manages it: it can't be
    /// renamed, moved or deleted, and nothing can be filed into it.
    pub is_external_calendar: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl From<FolderRow> for Folder {
    fn from(row: FolderRow) -> Self {
        Folder {
            id: row.id,
            name: row.name,
            parent_id: row.parent_id,
            sort_order: row.sort_order,
            color: row.color,
            icon: row.icon,
            is_external_calendar: row.is_external_calendar != 0,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

// ─── Input types ──────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields = nullable)]
pub struct NewFolder {
    pub name: String,
    pub parent_id: Option<String>,
    pub color: Option<String>,
    pub icon: Option<String>,
}

#[derive(Debug, Deserialize, Default, ts_rs::TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export, optional_fields = nullable)]
pub struct FolderUpdate {
    pub name: Option<String>,
    #[ts(type = "string | null", optional)]
    pub parent_id: Option<serde_json::Value>,
    #[ts(type = "string | null", optional)]
    pub color: Option<serde_json::Value>,
    #[ts(type = "string | null", optional)]
    pub icon: Option<serde_json::Value>,
    #[ts(type = "number", optional)]
    pub sort_order: Option<i64>,
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async fn fetch_folder(pool: &sqlx::SqlitePool, id: &str) -> AppResult<Folder> {
    sqlx::query_as::<_, FolderRow>("SELECT * FROM folders WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Folder not found: {id}")))
        .map(Folder::from)
}

// ─── Commands ─────────────────────────────────────────────────────────────────

pub async fn get_folder_impl(pool: &sqlx::SqlitePool, id: &str) -> AppResult<Option<Folder>> {
    let row = sqlx::query_as::<_, FolderRow>("SELECT * FROM folders WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(Folder::from))
}

pub async fn create_folder_impl(pool: &sqlx::SqlitePool, data: NewFolder) -> AppResult<Folder> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    let sort_order: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(sort_order) + 1, 0) FROM folders")
            .fetch_one(pool)
            .await
            .unwrap_or(0);

    sqlx::query(
        "INSERT INTO folders (id, name, parent_id, sort_order, color, icon, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&data.name)
    .bind(&data.parent_id)
    .bind(sort_order)
    .bind(&data.color)
    .bind(&data.icon)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;

    fetch_folder(pool, &id).await
}

async fn folder_is_external(pool: &sqlx::SqlitePool, id: &str) -> AppResult<bool> {
    Ok(sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM folders WHERE id = ? AND is_external_calendar = 1)",
    )
    .bind(id)
    .fetch_one(pool)
    .await?)
}

const EXTERNAL_FOLDER_LOCKED_MSG: &str =
    "External calendar folders are system-managed — use the Calendar Sync settings to disconnect.";

pub async fn update_folder_impl(
    pool: &sqlx::SqlitePool,
    id: String,
    updates: FolderUpdate,
) -> AppResult<Folder> {
    // Placement lock: an external-calendar folder can't be reparented, and nothing
    // can be nested under one. Name/color stay editable. The reconciler sets the
    // system flag directly via SQL, bypassing this command.
    if let Some(serde_json::Value::String(new_parent)) = &updates.parent_id {
        if folder_is_external(pool, new_parent).await? {
            return Err(AppError::Conflict(EXTERNAL_FOLDER_LOCKED_MSG.to_string()));
        }
    }
    if updates.parent_id.is_some() && folder_is_external(pool, &id).await? {
        return Err(AppError::Conflict(EXTERNAL_FOLDER_LOCKED_MSG.to_string()));
    }

    // A sidebar recolour is a user pick like the panel's, so it has to reach the
    // column that owns it (see `sync_calendar.color_user_set`).
    let recolor = match &updates.color {
        Some(serde_json::Value::String(c)) => Some(c.clone()),
        _ => None,
    };

    let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new("UPDATE folders SET ");
    let mut fields = builder.separated(", ");
    let mut has_updates = false;

    if let Some(v) = updates.name {
        fields.push("name = ");
        fields.push_bind_unseparated(v);
        has_updates = true;
    }
    if let Some(v) = updates.sort_order {
        fields.push("sort_order = ");
        fields.push_bind_unseparated(v);
        has_updates = true;
    }

    macro_rules! push_nullable_str {
        ($field:expr, $col:literal) => {
            if let Some(val) = $field {
                fields.push(concat!($col, " = "));
                match val {
                    serde_json::Value::Null => fields.push_bind_unseparated(None::<String>),
                    serde_json::Value::String(s) => fields.push_bind_unseparated(s),
                    _ => fields.push_bind_unseparated(None::<String>),
                };
                has_updates = true;
            }
        };
    }

    push_nullable_str!(updates.parent_id, "parent_id");
    push_nullable_str!(updates.color, "color");
    push_nullable_str!(updates.icon, "icon");

    if !has_updates {
        return fetch_folder(pool, &id).await;
    }

    fields.push("updated_at = ");
    fields.push_bind_unseparated(now_iso());
    drop(fields);

    builder.push(" WHERE id = ");
    builder.push_bind(&id);

    builder.build().execute(pool).await?;

    if let Some(color) = recolor {
        crate::tx::retry_on_busy(|| async {
            sqlx::query(
                "UPDATE sync_calendar SET color = ?, color_user_set = 1, updated_at = ?
                 WHERE folder_id = ?",
            )
            .bind(&color)
            .bind(now_iso())
            .bind(&id)
            .execute(pool)
            .await?;
            Ok(())
        })
        .await?;
    }

    fetch_folder(pool, &id).await
}

pub async fn delete_folder_impl(pool: &sqlx::SqlitePool, id: String) -> AppResult<()> {
    if folder_is_external(pool, &id).await? {
        return Err(AppError::Conflict(EXTERNAL_FOLDER_LOCKED_MSG.to_string()));
    }
    // Transaction wraps the soft-delete-pages + drop-folder pair. The ON
    // DELETE SET NULL constraint would otherwise orphan pages into the
    // inbox if the second statement runs without the first.
    crate::tx::retry_on_busy(|| async {
        let now = now_iso();
        let mut tx = pool.begin().await?;

        sqlx::query(
            "UPDATE pages SET deleted_at = ?, updated_at = ? WHERE folder_id = ? AND deleted_at IS NULL",
        )
        .bind(&now)
        .bind(&now)
        .bind(&id)
        .execute(&mut *tx)
        .await?;

        sqlx::query("DELETE FROM folders WHERE id = ?")
            .bind(&id)
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;
        Ok(())
    })
    .await
}

pub async fn soft_delete_folder_impl(pool: &sqlx::SqlitePool, id: String) -> AppResult<()> {
    if folder_is_external(pool, &id).await? {
        return Err(AppError::Conflict(EXTERNAL_FOLDER_LOCKED_MSG.to_string()));
    }
    // Atomic with the cascading page soft-delete so the folder can't
    // disappear from the sidebar while its pages remain visible (or vice
    // versa) if the second statement fails.
    crate::tx::retry_on_busy(|| async {
        let now = now_iso();
        let mut tx = pool.begin().await?;

        sqlx::query(
            "UPDATE folders SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(&now)
        .bind(&now)
        .bind(&id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "UPDATE pages SET deleted_at = ?, updated_at = ? WHERE folder_id = ? AND deleted_at IS NULL",
        )
        .bind(&now)
        .bind(&now)
        .bind(&id)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(())
    })
    .await
}

pub async fn restore_folder_impl(pool: &sqlx::SqlitePool, id: String) -> AppResult<()> {
    crate::tx::retry_on_busy(|| async {
        let now = now_iso();
        let mut tx = pool.begin().await?;

        // Read the folder's trash timestamp before clearing it: the cascade in
        // soft_delete_folder_impl stamps the folder and its pages with the same
        // `now`, so we can revive only the pages this folder deletion trashed.
        // Restoring every `deleted_at IS NOT NULL` page in the folder would also
        // revive a page the user had trashed individually *before* the folder
        // (its earlier timestamp is preserved by the cascade).
        let folder_deleted_at: Option<String> =
            sqlx::query_scalar("SELECT deleted_at FROM folders WHERE id = ?")
                .bind(&id)
                .fetch_optional(&mut *tx)
                .await?
                .flatten();

        sqlx::query("UPDATE folders SET deleted_at = NULL, updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(&id)
            .execute(&mut *tx)
            .await?;

        if let Some(folder_deleted_at) = folder_deleted_at {
            sqlx::query("UPDATE pages SET deleted_at = NULL, updated_at = ? WHERE folder_id = ? AND deleted_at = ?")
                .bind(&now)
                .bind(&id)
                .bind(&folder_deleted_at)
                .execute(&mut *tx)
                .await?;
        }

        tx.commit().await?;
        Ok(())
    })
    .await
}

pub async fn list_folders_impl(pool: &sqlx::SqlitePool) -> AppResult<Vec<Folder>> {
    let rows = sqlx::query_as::<_, FolderRow>(
        "SELECT * FROM folders WHERE deleted_at IS NULL ORDER BY sort_order ASC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(Folder::from).collect())
}

/// Resolve a parsed `folderQuery` to one of `folders`, in three tiers of
/// precedence: exact case-insensitive, then prefix, then substring. `None` when
/// nothing matches — the caller decides what a miss means.
///
/// Twin of the TS core's `fuzzyMatchFolder`, which the desktop's Quick Add runs
/// over the same queries out of the same parser. Both answer to
/// `tests/fixtures/folder-matching.json`; a tier that exists on one side only
/// files the same string into different folders depending on which binary the
/// user typed it into.
pub fn fuzzy_match_folder<'a>(query: &str, folders: &'a [Folder]) -> Option<&'a Folder> {
    if query.is_empty() {
        return None;
    }
    let q = query.to_lowercase();
    folders
        .iter()
        .find(|f| f.name.to_lowercase() == q)
        .or_else(|| {
            folders
                .iter()
                .find(|f| f.name.to_lowercase().starts_with(&q))
        })
        .or_else(|| folders.iter().find(|f| f.name.to_lowercase().contains(&q)))
}

pub async fn reorder_folders_impl(
    pool: &sqlx::SqlitePool,
    ordered_ids: &[String],
) -> AppResult<()> {
    crate::tx::retry_on_busy(|| async {
        let mut tx = pool.begin().await?;
        let now = now_iso();
        for (i, id) in ordered_ids.iter().enumerate() {
            sqlx::query("UPDATE folders SET sort_order = ?, updated_at = ? WHERE id = ?")
                .bind(i as i64)
                .bind(&now)
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    })
    .await
}

#[cfg(test)]
#[path = "folders_tests.rs"]
mod folders_tests;
