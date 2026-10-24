//! The lookups that turn a body's links into Markdown and back, for the writers that speak
//! Markdown: the CLI, MCP and the export.

use std::collections::HashMap;

use pikos_core::page_links::{
    link_targets, refresh_link_titles, resolve_wikilinks, wikilink_titles,
};
use serde_json::Value;
use sqlx::{QueryBuilder, Sqlite, SqlitePool};

use crate::error::AppResult;

/// Write each link's target's current title into `doc`, so Markdown made from it names the page
/// as it is called now rather than as it was when linked.
pub async fn refresh_titles(pool: &SqlitePool, doc: &mut Value) -> AppResult<()> {
    let titles = target_titles(pool, doc).await?;

    refresh_link_titles(doc, &|id| titles.get(id).cloned());
    Ok(())
}

/// The current title of each page `doc` links to, by page id.
pub async fn target_titles(pool: &SqlitePool, doc: &Value) -> AppResult<HashMap<String, String>> {
    let ids = link_targets(doc);
    if ids.is_empty() {
        return Ok(HashMap::new());
    }

    let mut builder = QueryBuilder::<Sqlite>::new("SELECT id, title FROM pages WHERE id IN (");
    let mut list = builder.separated(", ");
    for id in &ids {
        list.push_bind(id.clone());
    }
    list.push_unseparated(")");

    Ok(builder
        .build_query_as::<(String, String)>()
        .fetch_all(pool)
        .await?
        .into_iter()
        .collect())
}

/// Turn each `[[title]]` in `doc` into a link to the page of that title.
///
/// A title several pages share goes to the one in `linked`, the pages the body linked to before
/// this write, which is what keeps a link through a read and write back. A title no page has, or
/// that several have and none of them was linked, stays as text rather than linking a guess.
pub async fn link_titles(pool: &SqlitePool, doc: &mut Value, linked: &[String]) -> AppResult<()> {
    let titles = wikilink_titles(doc);
    if titles.is_empty() {
        return Ok(());
    }

    let mut builder = QueryBuilder::<Sqlite>::new(
        "SELECT id, title FROM pages WHERE deleted_at IS NULL AND title COLLATE NOCASE IN (",
    );
    let mut list = builder.separated(", ");
    for title in &titles {
        list.push_bind(title.clone());
    }
    list.push_unseparated(")");
    let mut by_title: HashMap<String, Vec<String>> = HashMap::new();
    for (id, title) in builder
        .build_query_as::<(String, String)>()
        .fetch_all(pool)
        .await?
    {
        by_title.entry(title.to_lowercase()).or_default().push(id);
    }

    resolve_wikilinks(doc, &mut |title| {
        let ids = by_title.get(&title.to_lowercase())?;
        let previously_linked = ids.iter().find(|id| linked.contains(id));
        match (previously_linked, ids.as_slice()) {
            (Some(id), _) => Some(id.clone()),
            (None, [only]) => Some(only.clone()),
            _ => None,
        }
    });
    Ok(())
}

#[cfg(test)]
#[path = "page_links_tests.rs"]
mod tests;
