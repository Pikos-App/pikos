//! Dispatch: one arm per subcommand, each turning parsed flags into an [`ops`]
//! call and then rendering the result for `--json` or a human.

use pikos_db::{hard_delete_page_impl, hard_delete_would_resurrect, list_pages_today_impl};
use serde_json::json;

use crate::cli::{Cli, CliCommand, FolderCommand, ReminderCommand};
use crate::error::{classify, CliError};
use crate::ops::{
    add_reminder, cmd_add, confirm, create_folder, list_folders, list_pages, list_reminders,
    mark_done, parse_only, remove_reminder, require_page, restore, search, set_status, trash,
    update_page, ListQuery, PageEdit,
};
use crate::render::{
    print_json, render_folders, render_page, render_reminders, render_search, render_summary_list,
};
use crate::workspace::open_workspace;

pub async fn run(cli: Cli) -> Result<(), CliError> {
    let json = cli.json;
    // The MCP server owns its own workspace lifecycle: it opens the file on the
    // first tool call, so a client can still complete `initialize` and then be told
    // in a frame it can read that the workspace is missing or behind.
    if matches!(cli.command, CliCommand::Mcp) {
        return crate::mcp::serve(cli.db, cli.migrate).await;
    }
    let pool = open_workspace(&cli.db, cli.migrate).await?;

    match cli.command {
        CliCommand::Search {
            query,
            include_completed,
            limit,
        } => {
            let resp = search(&pool, &query.join(" "), include_completed, limit).await?;
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
            folder,
            priority,
            query,
            has_schedule,
            modified,
            limit,
        } => {
            let pages = list_pages(
                &pool,
                ListQuery {
                    folder,
                    status,
                    priority,
                    query,
                    has_schedule,
                    due,
                    tags: tag,
                    modified,
                    limit,
                },
            )
            .await?;
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
        CliCommand::Add { text, dry_run } => {
            if dry_run {
                // Agent-preview mode: show the parse and touch nothing. Always
                // JSON — the parse tree has no plain-text rendering worth reading.
                print_json(&parse_only(&text.join(" "))?);
                return Ok(());
            }
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
            let page = update_page(
                &pool,
                &id,
                PageEdit {
                    title,
                    content,
                    status,
                    due,
                    all_day,
                    end,
                    priority,
                },
            )
            .await?;
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
            let page = set_status(&pool, &id, &state).await?;
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
                trash(&pool, &id).await?;
            }
            if json {
                print_json(&json!({ "id": id, "deleted": true, "hard": hard }));
            } else if hard {
                println!("Deleted {id}");
            } else {
                println!("Moved {id} to the trash");
            }
        }
        CliCommand::Restore { id } => {
            let page = restore(&pool, &id).await?;
            if json {
                print_json(&page);
            } else {
                println!("{}", render_page(&page));
            }
        }
        CliCommand::Folders { command } => match command {
            FolderCommand::List => {
                let folders = list_folders(&pool).await?;
                if json {
                    print_json(&folders);
                } else {
                    println!("{}", render_folders(&folders));
                }
            }
            FolderCommand::Create { name } => {
                let folder = create_folder(&pool, name.join(" ").trim()).await?;
                if json {
                    print_json(&folder);
                } else {
                    println!("Created {}: {}", folder.id, folder.name);
                }
            }
        },
        CliCommand::Reminders { command } => match command {
            ReminderCommand::List { page_id } => {
                let reminders = list_reminders(&pool, &page_id).await?;
                if json {
                    print_json(&reminders);
                } else {
                    println!("{}", render_reminders(&reminders));
                }
            }
            ReminderCommand::Add { page_id, minutes } => {
                let reminder = add_reminder(&pool, &page_id, minutes).await?;
                if json {
                    print_json(&reminder);
                } else {
                    println!("Added reminder {} at {} min", reminder.id, minutes);
                }
            }
            ReminderCommand::Rm { reminder_id } => {
                remove_reminder(&pool, &reminder_id).await?;
                if json {
                    print_json(&json!({ "id": reminder_id, "removed": true }));
                } else {
                    println!("Removed reminder {reminder_id}");
                }
            }
        },
        CliCommand::Mcp => unreachable!("served above, before the workspace was opened"),
    }
    Ok(())
}
