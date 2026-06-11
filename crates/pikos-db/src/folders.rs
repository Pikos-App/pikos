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
    created_at: String,
    updated_at: String,
}

// ─── Output type ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: i64,
    pub color: Option<String>,
    pub icon: Option<String>,
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
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

// ─── Input types ──────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewFolder {
    pub name: String,
    pub parent_id: Option<String>,
    pub color: Option<String>,
    pub icon: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FolderUpdate {
    pub name: Option<String>,
    pub parent_id: Option<serde_json::Value>,
    pub color: Option<serde_json::Value>,
    pub icon: Option<serde_json::Value>,
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

pub async fn update_folder_impl(
    pool: &sqlx::SqlitePool,
    id: String,
    updates: FolderUpdate,
) -> AppResult<Folder> {
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

    fetch_folder(pool, &id).await
}

pub async fn delete_folder_impl(pool: &sqlx::SqlitePool, id: String) -> AppResult<()> {
    let now = now_iso();

    // Transaction wraps the soft-delete-pages + drop-folder pair. The ON
    // DELETE SET NULL constraint would otherwise orphan pages into the
    // inbox if the second statement runs without the first.
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
}

pub async fn soft_delete_folder_impl(pool: &sqlx::SqlitePool, id: String) -> AppResult<()> {
    let now = now_iso();

    // Atomic with the cascading page soft-delete so the folder can't
    // disappear from the sidebar while its pages remain visible (or vice
    // versa) if the second statement fails.
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
}

pub async fn restore_folder_impl(pool: &sqlx::SqlitePool, id: String) -> AppResult<()> {
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
}

pub async fn list_folders_impl(pool: &sqlx::SqlitePool) -> AppResult<Vec<Folder>> {
    let rows = sqlx::query_as::<_, FolderRow>(
        "SELECT * FROM folders WHERE deleted_at IS NULL ORDER BY sort_order ASC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(Folder::from).collect())
}

pub async fn reorder_folders_impl(
    pool: &sqlx::SqlitePool,
    ordered_ids: &[String],
) -> AppResult<()> {
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
}

#[cfg(test)]
#[path = "folders_tests.rs"]
mod folders_tests;
