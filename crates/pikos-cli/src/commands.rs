//! Dispatch: one arm per subcommand, each turning parsed flags into an [`ops`]
//! call and then rendering the result for `--json` or a human.

use pikos_db::{
    get_recurrence_rule_impl, hard_delete_page_impl, hard_delete_would_resurrect,
    list_page_schedules_impl, list_pages_impl, list_pages_today_impl, now_local_iso,
    search_pages_impl, soft_delete_page_impl, update_page_impl, PageFilter, PageUpdate,
};
use serde_json::{json, Value};

use crate::cli::{Cli, CliCommand};
use crate::error::{classify, CliError};
use crate::ops::{cmd_add, confirm, mark_done, require_page};
use crate::render::{print_json, render_page, render_search, render_summary_list};
use crate::schedule::{parse_due, resolve_schedule_change};
use crate::workspace::open_workspace;
use crate::write::{schedule_once, text_to_tiptap};

pub async fn run(cli: Cli) -> Result<(), CliError> {
    let json = cli.json;
    let pool = open_workspace(&cli.db, cli.migrate).await?;

    match cli.command {
        CliCommand::Search {
            query,
            include_completed,
            limit,
        } => {
            let mut resp = search_pages_impl(&pool, query.join(" "), Some(include_completed))
                .await
                .map_err(classify)?;
            if let Some(n) = limit {
                resp.results.truncate(n);
            }
            if json {
                print_json(&resp);
            } else {
                println!("{}", render_search(&resp));
            }
        }
        CliCommand::Read { id } => {
            let page = require_page(&pool, &id).await?;
            if json {
                print_json(&page);
            } else {
                println!("{}", render_page(&page));
            }
        }
        CliCommand::List {
            status,
            due,
            tag,
            modified,
            limit,
        } => {
            let mut filter = PageFilter::default();
            if let Some(s) = &status {
                if s != "not_started" && s != "done" {
                    return Err(CliError::usage(format!(
                        "--status must be \"not_started\" or \"done\" (got \"{s}\")"
                    )));
                }
                filter.status = Some(s.clone());
            }
            if let Some(d) = &due {
                let (after, before) = parse_due(d)?;
                filter.scheduled_after = Some(after);
                filter.scheduled_before = Some(before);
            }
            if !tag.is_empty() {
                filter.tags = Some(tag);
            }
            let mut pages = list_pages_impl(&pool, Some(filter))
                .await
                .map_err(classify)?;
            if modified {
                pages.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            }
            if let Some(n) = limit {
                pages.truncate(n);
            }
            if json {
                print_json(&pages);
            } else {
                println!("{}", render_summary_list(&pages, "No pages match."));
            }
        }
        CliCommand::Today => {
            let pages = list_pages_today_impl(&pool).await.map_err(classify)?;
            if json {
                print_json(&pages);
            } else {
                println!(
                    "{}",
                    render_summary_list(&pages, "Nothing scheduled for today.")
                );
            }
        }
        CliCommand::Add { text } => {
            let created = cmd_add(&pool, &text.join(" ")).await?;
            if json {
                print_json(&json!({ "created": created }));
            } else {
                for p in &created {
                    println!(
                        "Created {}: {}",
                        p.id,
                        if p.title.is_empty() {
                            "(untitled)"
                        } else {
                            &p.title
                        }
                    );
                }
            }
        }
        CliCommand::Update {
            id,
            title,
            content,
            status,
            due,
            all_day,
            end,
            priority,
        } => {
            let page = require_page(&pool, &id).await?;
            // Every schedule rejection is settled before the first write, so a bad
            // flag can't leave --title and --priority half-applied.
            let touches_schedule = due.is_some() || all_day.is_some() || end.is_some();
            if touches_schedule {
                if page.schedule_locked {
                    return Err(CliError::conflict(
                        "This event comes from a connected calendar — reschedule it in the Pikos app.",
                    ));
                }
                // schedule_once writes the rule-less anchor row, which a recurring
                // page's denorm deliberately ignores — the write would land and
                // move nothing.
                if get_recurrence_rule_impl(&pool, &id)
                    .await
                    .map_err(classify)?
                    .is_some()
                {
                    return Err(CliError::conflict(
                        "This page repeats — move the series in the Pikos app.",
                    ));
                }
            }
            let existing = if touches_schedule {
                list_page_schedules_impl(&pool, &id)
                    .await
                    .map_err(classify)?
                    .into_iter()
                    .find(|s| s.rule_id.is_none())
            } else {
                None
            };
            let change = resolve_schedule_change(
                existing
                    .as_ref()
                    .map(|s| (s.scheduled_start.as_str(), s.scheduled_end.as_deref())),
                due.as_deref(),
                all_day.as_deref(),
                end.as_deref(),
            )?;
            let mut upd = PageUpdate::default();
            if let Some(t) = title {
                upd.title = Some(t);
            }
            if let Some(c) = content {
                let (doc, txt) = text_to_tiptap(&c);
                upd.content = Some(doc);
                upd.content_text = Some(txt);
            }
            if let Some(s) = &status {
                if s != "not_started" && s != "done" {
                    return Err(CliError::usage(format!(
                        "--status must be \"not_started\" or \"done\" (got \"{s}\")"
                    )));
                }
                upd.status = Some(s.clone());
                upd.completed_at = Some(if s == "done" {
                    Value::String(now_local_iso())
                } else {
                    Value::Null
                });
            }
            if let Some(p) = priority {
                if !(0..=4).contains(&p) {
                    return Err(CliError::usage(format!("--priority must be 0–4 (got {p})")));
                }
                upd.priority = Some(p);
            }
            update_page_impl(&pool, id.clone(), upd)
                .await
                .map_err(classify)?;
            if let Some(change) = &change {
                schedule_once(&pool, &id, &change.start, change.end.as_deref())
                    .await
                    .map_err(classify)?;
            }
            let page = require_page(&pool, &id).await?;
            if json {
                print_json(&page);
            } else {
                println!("{}", render_page(&page));
            }
        }
        CliCommand::Done { id } => {
            let page = mark_done(&pool, &id).await?;
            if json {
                print_json(&page);
            } else {
                println!("{}", render_page(&page));
            }
        }
        CliCommand::Status { id, state } => {
            let page = match state.as_str() {
                "done" => mark_done(&pool, &id).await?,
                "not_started" => {
                    require_page(&pool, &id).await?;
                    let upd = PageUpdate {
                        status: Some("not_started".to_string()),
                        completed_at: Some(Value::Null),
                        ..Default::default()
                    };
                    update_page_impl(&pool, id.clone(), upd)
                        .await
                        .map_err(classify)?
                }
                other => {
                    return Err(CliError::usage(format!(
                        "state must be \"done\" or \"not_started\" (got \"{other}\")"
                    )))
                }
            };
            if json {
                print_json(&page);
            } else {
                println!("{}", render_page(&page));
            }
        }
        CliCommand::Delete { id, hard } => {
            let page = require_page(&pool, &id).await?;
            if hard
                && hard_delete_would_resurrect(&pool, &id)
                    .await
                    .map_err(classify)?
            {
                return Err(CliError::conflict(
                    "This event comes from a connected calendar — delete it there, or disconnect the calendar first.",
                ));
            }
            if !cli.yes {
                if json {
                    return Err(CliError::usage(
                        "refusing to delete without --yes in --json mode",
                    ));
                }
                let title = if page.title.is_empty() {
                    "(untitled)".to_string()
                } else {
                    page.title.clone()
                };
                let question = if hard {
                    format!("Permanently delete \"{title}\" ({id})? This cannot be undone.")
                } else {
                    format!("Move \"{title}\" ({id}) to the trash?")
                };
                if !confirm(&question).await {
                    eprintln!("Aborted.");
                    return Ok(());
                }
            }
            if hard {
                hard_delete_page_impl(&pool, &id).await.map_err(classify)?;
            } else {
                soft_delete_page_impl(&pool, &id).await.map_err(classify)?;
            }
            if json {
                print_json(&json!({ "id": id, "deleted": true, "hard": hard }));
            } else if hard {
                println!("Deleted {id}");
            } else {
                println!("Moved {id} to the trash");
            }
        }
    }
    Ok(())
}
