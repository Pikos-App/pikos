//! Moving pages within a list's manual order by naming the open pages they land between.
//!
//! The moved pages take order values strictly between their new neighbours', so nothing else is
//! rewritten. Values are spread [`ORDER_SPACING`] apart to leave room; when two neighbours have run
//! out of room, the folder is renumbered once, done pages included, which keeps every page's
//! place. A neighbour that isn't where the caller saw it any more is a conflict: the caller's
//! window is stale and refetches.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::{AppError, AppResult};
use crate::now_iso;

/// The gap left between neighbouring order values: twenty halvings before a spot runs out.
pub const ORDER_SPACING: i64 = 1 << 20;

/// Where moved pages land: directly after one open page and directly before another. `after`
/// None is the top of the list, `before` None the bottom.
#[derive(Debug, Clone, Default, Deserialize, ts_rs::TS)]
#[ts(export, optional_fields = nullable)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    pub after: Option<String>,
    pub before: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct MoveOutcome {
    /// Each moved page's new order value, in the order they were given.
    #[ts(type = "Array<[string, number]>")]
    pub orders: Vec<(String, i64)>,
    /// The folder was renumbered, so every order value in it changed.
    pub renumbered: bool,
}

#[derive(sqlx::FromRow)]
struct Placed {
    id: String,
    folder_id: Option<String>,
    sort_order: i64,
    created_at: String,
}

fn conflict(why: &str) -> AppError {
    AppError::Conflict(format!("the list changed: {why}"))
}

async fn placed(
    tx: &mut sqlx::SqliteConnection,
    id: &str,
    open_only: bool,
) -> AppResult<Option<Placed>> {
    let row = sqlx::query_as::<_, Placed>(
        "SELECT id, folder_id, sort_order, created_at FROM pages
         WHERE id = ? AND deleted_at IS NULL AND (? = 0 OR status <> 'done')",
    )
    .bind(id)
    .bind(open_only)
    .fetch_optional(tx)
    .await?;
    Ok(row)
}

/// Open pages in `folder`, other than the moved ones, strictly between two places in manual
/// order; either end may be open.
async fn open_between(
    tx: &mut sqlx::SqliteConnection,
    folder: Option<&str>,
    moved: &[String],
    after: Option<&Placed>,
    before: Option<&Placed>,
) -> AppResult<i64> {
    let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
        "SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL AND status <> 'done'",
    );
    match folder {
        Some(folder) => {
            builder.push(" AND folder_id = ");
            builder.push_bind(folder.to_string());
        }
        None => {
            builder.push(" AND folder_id IS NULL");
        }
    }
    if let Some(after) = after {
        builder.push(" AND (sort_order, created_at, id) > (");
        builder.push_bind(after.sort_order);
        builder.push(", ");
        builder.push_bind(after.created_at.clone());
        builder.push(", ");
        builder.push_bind(after.id.clone());
        builder.push(")");
    }
    if let Some(before) = before {
        builder.push(" AND (sort_order, created_at, id) < (");
        builder.push_bind(before.sort_order);
        builder.push(", ");
        builder.push_bind(before.created_at.clone());
        builder.push(", ");
        builder.push_bind(before.id.clone());
        builder.push(")");
    }
    if !moved.is_empty() {
        builder.push(" AND id NOT IN (");
        let mut ids = builder.separated(", ");
        for id in moved {
            ids.push_bind(id.clone());
        }
        ids.push_unseparated(")");
    }
    Ok(builder.build_query_scalar().fetch_one(tx).await?)
}

/// Give every page in `folder`, done ones included, a value [`ORDER_SPACING`] apart, keeping
/// their order.
async fn renumber(tx: &mut sqlx::SqliteConnection, folder: Option<&str>) -> AppResult<()> {
    sqlx::query(
        "UPDATE pages SET sort_order = ranked.place * ?
         FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY sort_order, created_at, id) AS place
               FROM pages WHERE deleted_at IS NULL AND folder_id IS ?) AS ranked
         WHERE pages.id = ranked.id",
    )
    .bind(ORDER_SPACING)
    .bind(folder)
    .execute(tx)
    .await?;
    Ok(())
}

/// Move `ids`, in that order, to `place` in their folder's manual order. They must all be open,
/// in one folder (or all in the Inbox), and the neighbours open pages of that folder, adjacent
/// once the moved pages are left out.
pub async fn move_pages(
    pool: &SqlitePool,
    ids: &[String],
    place: &Placement,
) -> AppResult<MoveOutcome> {
    if ids.is_empty() {
        return Err(AppError::Invalid("nothing to move".into()));
    }
    if [&place.after, &place.before]
        .into_iter()
        .flatten()
        .any(|n| ids.contains(n))
    {
        return Err(AppError::Invalid("a page can't land next to itself".into()));
    }
    crate::tx::retry_on_busy(|| async {
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

        let mut folder: Option<Option<String>> = None;
        for id in ids {
            let page = placed(&mut tx, id, true)
                .await?
                .ok_or_else(|| conflict(&format!("{id} isn't an open page")))?;
            match &folder {
                None => folder = Some(page.folder_id),
                Some(f) if *f != page.folder_id => {
                    return Err(AppError::Invalid("moved pages must share a folder".into()))
                }
                Some(_) => {}
            }
        }
        let folder = folder.flatten();

        let neighbour = |id: &Option<String>| id.clone();
        let mut ends = Vec::new();
        for id in [neighbour(&place.after), neighbour(&place.before)] {
            ends.push(match id {
                None => None,
                Some(id) => {
                    let page = placed(&mut tx, &id, true)
                        .await?
                        .ok_or_else(|| conflict(&format!("{id} isn't an open page")))?;
                    if page.folder_id != folder {
                        return Err(conflict(&format!("{id} is in another folder")));
                    }
                    Some(page)
                }
            });
        }
        let (mut after, mut before) = (ends.remove(0), ends.remove(0));
        if open_between(
            &mut tx,
            folder.as_deref(),
            ids,
            after.as_ref(),
            before.as_ref(),
        )
        .await?
            > 0
        {
            return Err(conflict("its neighbours aren't next to each other"));
        }

        let k = ids.len() as i64;
        let bounds = |after: &Option<Placed>, before: &Option<Placed>| match (after, before) {
            (Some(a), Some(b)) => (a.sort_order, b.sort_order),
            (Some(a), None) => (a.sort_order, a.sort_order + (k + 1) * ORDER_SPACING),
            (None, Some(b)) => (b.sort_order - (k + 1) * ORDER_SPACING, b.sort_order),
            (None, None) => (0, (k + 1) * ORDER_SPACING),
        };
        let (mut low, mut high) = bounds(&after, &before);
        let renumbered = high - low - 1 < k;
        if renumbered {
            renumber(&mut tx, folder.as_deref()).await?;
            if let Some(a) = &after {
                after = placed(&mut tx, &a.id, false).await?;
            }
            if let Some(b) = &before {
                before = placed(&mut tx, &b.id, false).await?;
            }
            (low, high) = bounds(&after, &before);
        }

        let now = now_iso();
        let mut orders = Vec::with_capacity(ids.len());
        for (i, id) in ids.iter().enumerate() {
            let step = (high - low) as i128 * (i as i128 + 1) / (k as i128 + 1);
            let value = low + step as i64;
            sqlx::query("UPDATE pages SET sort_order = ?, updated_at = ? WHERE id = ?")
                .bind(value)
                .bind(&now)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            orders.push((id.clone(), value));
        }
        tx.commit().await?;
        Ok(MoveOutcome { orders, renumbered })
    })
    .await
}

#[cfg(test)]
#[path = "moves_tests.rs"]
mod moves_tests;
