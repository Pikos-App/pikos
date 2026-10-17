//! `pikos sync`: checking that two devices' copies of a workspace agree.

use std::path::Path;

use pikos_db::replica::compare::{differences, Difference, Side};
use pikos_db::replica::state::synced_rows;
use serde::Serialize;
use serde_json::json;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

use crate::error::{classify, CliError};
use crate::render::print_json;

/// Opened read-only and never migrated, so it can read a running app's workspace, or a copy taken
/// off another device, without changing either.
async fn open_read_only(path: &str) -> Result<SqlitePool, CliError> {
    if !Path::new(path).exists() {
        return Err(CliError::workspace(format!("No workspace at \"{path}\".")));
    }

    let options = SqliteConnectOptions::new().filename(path).read_only(true);
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|e| classify(e.into()))
}

/// What a copy's own sync says about itself, which explains a difference still in flight.
#[derive(Serialize)]
struct CopyState {
    path: String,
    zone: String,
    started: bool,
    pending: i64,
    held: i64,
    last_fetch_at: Option<String>,
}

async fn state_of(path: &str, pool: &SqlitePool) -> Result<CopyState, CliError> {
    let meta = pikos_db::replica::meta(pool).await.map_err(classify)?;
    let summary = pikos_db::replica::summary(pool).await.map_err(classify)?;
    Ok(CopyState {
        path: path.to_owned(),
        zone: pikos_replica::zone::zone_name(&meta.workspace_id),
        started: summary.started,
        pending: summary.pending,
        held: summary.held,
        last_fetch_at: summary.last_fetch_at,
    })
}

/// Prints where two copies disagree on what sync carries, and fails with `Diverged` when they do,
/// so a script can tell converged from not by the exit code alone.
pub async fn diff(first: &str, second: &str, limit: usize, json: bool) -> Result<(), CliError> {
    let first_pool = open_read_only(first).await?;
    let second_pool = open_read_only(second).await?;
    let copies = [
        state_of(first, &first_pool).await?,
        state_of(second, &second_pool).await?,
    ];
    let found = differences(
        synced_rows(&first_pool).await.map_err(classify)?,
        synced_rows(&second_pool).await.map_err(classify)?,
    );

    if json {
        print_json(&json!({ "copies": copies, "differences": found }));
    } else {
        println!("{}", render(&copies, &found, limit));
    }

    if found.is_empty() {
        return Ok(());
    }
    Err(CliError::new(
        "Diverged",
        format!("{} difference(s)", found.len()),
        10,
    ))
}

fn render(copies: &[CopyState; 2], found: &[Difference], limit: usize) -> String {
    let mut lines: Vec<String> = ["first ", "second"]
        .iter()
        .zip(copies)
        .map(|(label, c)| {
            let sync = if c.started {
                format!(
                    "{} to send · {} held · last fetch {}",
                    c.pending,
                    c.held,
                    c.last_fetch_at.as_deref().unwrap_or("never")
                )
            } else {
                "sync never started".to_owned()
            };
            format!("{label}  {}  {sync}  {}", c.zone, c.path)
        })
        .collect();

    if copies[0].zone != copies[1].zone {
        lines.push(
            "They sync in different iCloud zones, so neither sees the other's changes.".into(),
        );
    }
    let in_flight = copies.iter().any(|c| c.pending > 0 || c.held > 0);
    if in_flight && !found.is_empty() {
        lines.push("Records still waiting to send or apply may account for some of these.".into());
    }

    if found.is_empty() {
        lines.push("No differences.".into());
        return lines.join("\n");
    }

    lines.push(format!("{} difference(s):", found.len()));
    lines.extend(found.iter().take(limit).map(|d| match d {
        Difference::OnlyIn { record, side } => {
            let side = match side {
                Side::First => "first",
                Side::Second => "second",
            };
            format!("  {record}  only on the {side}")
        }
        Difference::Field {
            record,
            field,
            first,
            second,
        } => format!(
            "  {record}  {field}: {}  vs  {}",
            first.join(", "),
            second.join(", ")
        ),
    }));
    if found.len() > limit {
        lines.push(format!("  … and {} more", found.len() - limit));
    }

    lines.join("\n")
}
