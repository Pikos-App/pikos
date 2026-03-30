use serde::{Deserialize, Serialize};
use tauri::State;

use super::{now_iso, DbState};

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

async fn fetch_folder(pool: &sqlx::SqlitePool, id: &str) -> Result<Folder, String> {
    sqlx::query_as::<_, FolderRow>("SELECT * FROM folders WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Folder not found: {id}"))
        .map(Folder::from)
}

// ─── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_folder(state: State<'_, DbState>, id: String) -> Result<Option<Folder>, String> {
    let pool = state.get_pool().await?;
    let row = sqlx::query_as::<_, FolderRow>("SELECT * FROM folders WHERE id = ?")
        .bind(&id)
        .fetch_optional(&pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.map(Folder::from))
}

#[tauri::command]
pub async fn create_folder(state: State<'_, DbState>, data: NewFolder) -> Result<Folder, String> {
    let pool = state.get_pool().await?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    let sort_order: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(sort_order) + 1, 0) FROM folders")
            .fetch_one(&pool)
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
    .execute(&pool)
    .await
    .map_err(|e| e.to_string())?;

    fetch_folder(&pool, &id).await
}

#[tauri::command]
pub async fn update_folder(
    state: State<'_, DbState>,
    id: String,
    updates: FolderUpdate,
) -> Result<Folder, String> {
    let pool = state.get_pool().await?;

    let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new("UPDATE folders SET ");
    let mut sep = builder.separated(", ");
    let mut has_updates = false;

    if let Some(v) = updates.name {
        sep.push("name = ");
        sep.push_bind_unseparated(v);
        has_updates = true;
    }
    if let Some(v) = updates.sort_order {
        sep.push("sort_order = ");
        sep.push_bind_unseparated(v);
        has_updates = true;
    }

    macro_rules! push_nullable_str {
        ($field:expr, $col:literal) => {
            if let Some(val) = $field {
                sep.push(concat!($col, " = "));
                match val {
                    serde_json::Value::Null => sep.push_bind_unseparated(None::<String>),
                    serde_json::Value::String(s) => sep.push_bind_unseparated(s),
                    _ => sep.push_bind_unseparated(None::<String>),
                };
                has_updates = true;
            }
        };
    }

    push_nullable_str!(updates.parent_id, "parent_id");
    push_nullable_str!(updates.color, "color");
    push_nullable_str!(updates.icon, "icon");

    if !has_updates {
        return fetch_folder(&pool, &id).await;
    }

    sep.push("updated_at = ");
    sep.push_bind_unseparated(now_iso());
    drop(sep);

    builder.push(" WHERE id = ");
    builder.push_bind(&id);

    builder
        .build()
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

    fetch_folder(&pool, &id).await
}

#[tauri::command]
pub async fn delete_folder(state: State<'_, DbState>, id: String) -> Result<(), String> {
    let pool = state.get_pool().await?;
    let now = now_iso();

    // Soft-delete all pages in this folder before removing the folder itself.
    // The ON DELETE SET NULL constraint would otherwise orphan them into the inbox.
    sqlx::query("UPDATE pages SET deleted_at = ?, updated_at = ? WHERE folder_id = ? AND deleted_at IS NULL")
        .bind(&now)
        .bind(&now)
        .bind(&id)
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("DELETE FROM folders WHERE id = ?")
        .bind(&id)
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn list_folders(state: State<'_, DbState>) -> Result<Vec<Folder>, String> {
    let pool = state.get_pool().await?;
    let rows = sqlx::query_as::<_, FolderRow>("SELECT * FROM folders ORDER BY sort_order ASC")
        .fetch_all(&pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(Folder::from).collect())
}

#[tauri::command]
pub async fn reorder_folders(
    state: State<'_, DbState>,
    ordered_ids: Vec<String>,
) -> Result<(), String> {
    let pool = state.get_pool().await?;
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    let now = now_iso();
    for (i, id) in ordered_ids.iter().enumerate() {
        sqlx::query("UPDATE folders SET sort_order = ?, updated_at = ? WHERE id = ?")
            .bind(i as i64)
            .bind(&now)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    }
    tx.commit().await.map_err(|e| e.to_string())
}
