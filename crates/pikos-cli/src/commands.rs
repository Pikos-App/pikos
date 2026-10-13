//! Dispatch: one arm per subcommand, each turning parsed flags into an [`ops`]
//! call and then rendering the result for `--json` or a human.

use pikos_db::{hard_delete_page_impl, hard_delete_would_resurrect, list_pages_today_impl};
use serde_json::json;

use crate::cli::{
    Cli, CliCommand, FolderCommand, OccurrenceCommand, ReminderCommand, StressCommand,
};
use crate::error::{classify, CliError};
use crate::occurrences;
use crate::ops::{
    add_reminder, cmd_add, confirm, create_folder, list_folders, list_pages, list_reminders,
    list_tags, list_trash, mark_done, parse_only, read_page, remove_reminder, rename_folder,
    require_folder, require_page, restore, restore_folder, search, set_status, trash, trash_folder,
    update_page, ListQuery, PageEdit,
};
use crate::render::{
    print_json, render_entry_list, render_folders, render_page, render_read, render_reminders,
    render_search, render_summary, render_summary_list, render_tags, render_trash,
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
    // Owns its own workspace lifecycle too: it opens a scratch file by path and must never go
    // through open_workspace, which resolves to the real one when --db is absent.
    if let CliCommand::Stress { action } = &cli.command {
        return match action {
            StressCommand::Seed {
                pages,
                large_pages,
                large_words,
                shape,
                today,
            } => {
                let today = today.unwrap_or_else(|| chrono::Local::now().date_naive());
                crate::stress::seed(
                    &cli.db,
                    *pages,
                    *large_pages,
                    *large_words,
                    *shape,
                    today,
                    json,
                )
                .await
            }
            StressCommand::Bench { runs, only } => {
                crate::stress::bench(&cli.db, *runs, only, json).await
            }
        };
    }
    let pool = open_workspace(&cli.db, cli.migrate).await?;

    match cli.command {
        CliCommand::Search {
            query,
            any,
            include_completed,
            limit,
            after,
        } => {
            let resp = search(
                &pool,
                &query.join(" "),
                any,
                include_completed,
                limit,
                after,
            )
            .await?;
            if json {
                print_json(&resp);
            } else {
                if resp.any_word && !any {
                    println!("No page holds every word; showing pages with any of them.\n");
                }
                println!("{}", render_search(&resp.page));
            }
        }
        CliCommand::Read { id } => {
            let read = read_page(&pool, &id).await?;
            if json {
                print_json(&read);
            } else {
                println!("{}", render_read(&read));
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
            created,
            completed,
            repeating,
            has_reminders,
            modified,
            oldest_first,
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
                    created,
                    completed,
                    repeating,
                    has_reminders,
                    tags: tag,
                    modified,
                    oldest_first,
                    limit,
                },
            )
            .await?;
            if json {
                print_json(&pages);
            } else {
                println!("{}", render_entry_list(&pages, "No pages match."));
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
            folder,
            add_tags,
            remove_tags,
            subtitle,
            unschedule,
            no_end,
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
                    folder,
                    add_tags,
                    remove_tags,
                    subtitle,
                    unschedule,
                    no_end,
                },
            )
            .await?;
            if json {
                print_json(&page);
            } else {
                println!("{}", render_page(&page));
            }
        }
        CliCommand::Done { id, date } => {
            let page = mark_done(&pool, &id, date.as_deref()).await?;
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
        CliCommand::Trash => {
            let trashed = list_trash(&pool).await?;
            if json {
                print_json(&trashed);
            } else {
                println!("{}", render_trash(&trashed));
            }
        }
        CliCommand::Tags => {
            let tags = list_tags(&pool).await?;
            if json {
                print_json(&tags);
            } else {
                println!("{}", render_tags(&tags));
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
            FolderCommand::Rename { folder, name } => {
                let renamed = rename_folder(&pool, &folder, &name.join(" ")).await?;
                if json {
                    print_json(&renamed);
                } else {
                    println!("Renamed {} to {}", renamed.id, renamed.name);
                }
            }
            FolderCommand::Delete { folder } => {
                let target = require_folder(&pool, &folder).await?;
                if !cli.yes {
                    if json {
                        return Err(CliError::usage(
                            "refusing to delete without --yes in --json mode",
                        ));
                    }
                    let question = format!(
                        "Move the folder \"{}\" and every page in it to the trash?",
                        target.name
                    );
                    if !confirm(&question).await {
                        eprintln!("Aborted.");
                        return Ok(());
                    }
                }
                let trashed = trash_folder(&pool, &target.id).await?;
                if json {
                    print_json(&json!({ "id": trashed.id, "trashed": true }));
                } else {
                    println!(
                        "Moved {} and its pages to the trash; `pikos folders restore {}` brings them back",
                        trashed.name, trashed.id
                    );
                }
            }
            FolderCommand::Restore { id } => {
                let folder = restore_folder(&pool, &id).await?;
                if json {
                    print_json(&folder);
                } else {
                    println!("Restored {}: {}", folder.id, folder.name);
                }
            }
        },
        CliCommand::Occurrence { command } => match command {
            OccurrenceCommand::Skip { id, date } => {
                let page = occurrences::skip(&pool, &id, &date).await?;
                if json {
                    print_json(&page);
                } else {
                    println!("Skipped {date}\n{}", render_page(&page));
                }
            }
            OccurrenceCommand::Unskip { id, date } => {
                let page = occurrences::unskip(&pool, &id, &date).await?;
                if json {
                    print_json(&page);
                } else {
                    println!("Brought {date} back\n{}", render_page(&page));
                }
            }
            OccurrenceCommand::Move {
                id,
                date,
                due,
                all_day,
                end,
            } => {
                let moved = occurrences::move_occurrence(
                    &pool,
                    &id,
                    &date,
                    due.as_deref(),
                    all_day.as_deref(),
                    end.as_deref(),
                )
                .await?;
                if json {
                    print_json(&moved);
                } else if let Some(clone) = &moved.clone {
                    println!("Moved {date} to its own page\n{}", render_summary(clone));
                } else {
                    println!("Moved {date}");
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
        CliCommand::Mcp | CliCommand::Stress { .. } => {
            unreachable!("handled above, before the workspace was opened")
        }
    }
    Ok(())
}
