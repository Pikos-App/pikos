//! The clap surface: globals, subcommands and their flags.

use clap::{Parser, Subcommand};
use pikos_db::SearchCursor;

#[derive(Parser)]
#[command(
    name = "pikos",
    version,
    about = "Headless access to your local Pikos workspace."
)]
pub struct Cli {
    #[arg(long, global = true, help = "Output machine-readable JSON")]
    pub json: bool,
    #[arg(long, global = true, help = "Override the workspace database path")]
    pub db: Option<String>,
    #[arg(long, global = true, help = "Skip confirmation prompts")]
    pub yes: bool,
    #[arg(
        long,
        global = true,
        help = "Allow upgrading the workspace schema to match this CLI"
    )]
    pub migrate: bool,
    #[command(subcommand)]
    pub command: CliCommand,
}

#[derive(Subcommand)]
pub enum CliCommand {
    /// Full-text search across pages (FTS5, bm25-ranked)
    Search {
        query: Vec<String>,
        #[arg(
            long,
            help = "Match pages holding any of the words; used anyway when none holds them all"
        )]
        any: bool,
        #[arg(long)]
        include_completed: bool,
        #[arg(long, help = "Results per page (default 20)")]
        limit: Option<usize>,
        #[arg(
            long,
            value_parser = parse_cursor,
            help = "Continue from the cursor a previous page printed"
        )]
        after: Option<SearchCursor>,
    },
    /// Print a page's full content and metadata
    Read { id: String },
    /// List pages with filters
    List {
        #[arg(long)]
        status: Option<String>,
        #[arg(long)]
        due: Option<String>,
        #[arg(long)]
        tag: Vec<String>,
        #[arg(
            long,
            help = "Only pages in this folder, by name or id — \"inbox\" for unfiled"
        )]
        folder: Option<String>,
        #[arg(long, help = "Only pages at this priority: 0 none — 4 low")]
        priority: Option<i64>,
        #[arg(long, help = "Only pages whose title or body contains this text")]
        query: Option<String>,
        #[arg(long = "has-schedule", help = "Only pages that are scheduled at all")]
        has_schedule: bool,
        #[arg(long, help = "Created on YYYY-MM-DD, or in YYYY-MM-DD..YYYY-MM-DD")]
        created: Option<String>,
        #[arg(long, help = "Completed on YYYY-MM-DD, or in YYYY-MM-DD..YYYY-MM-DD")]
        completed: Option<String>,
        #[arg(long, help = "Only pages that repeat, with their rule")]
        repeating: bool,
        #[arg(
            long = "has-reminders",
            help = "Only pages with a reminder, with its lead time"
        )]
        has_reminders: bool,
        #[arg(long)]
        modified: bool,
        #[arg(
            long = "oldest-first",
            help = "Sort by when the page was created, oldest first"
        )]
        oldest_first: bool,
        #[arg(long)]
        limit: Option<usize>,
    },
    /// Pages due or scheduled on or before today (open only)
    Today,
    /// Create a page from natural-language text (same parser as Quick Add)
    Add {
        text: Vec<String>,
        #[arg(
            long = "dry-run",
            help = "Print what the parser made of the text and write nothing"
        )]
        dry_run: bool,
    },
    /// Update a page's core fields
    Update {
        id: String,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        content: Option<String>,
        #[arg(long)]
        status: Option<String>,
        #[arg(
            long,
            help = "Move the page: YYYY-MM-DDTHH:MM:SS, or YYYY-MM-DD if it isn't already timed"
        )]
        due: Option<String>,
        #[arg(
            long = "all-day",
            conflicts_with = "due",
            help = "Make the page all-day on YYYY-MM-DD — the only way to drop an existing time"
        )]
        all_day: Option<String>,
        #[arg(
            long,
            help = "Set when the page ends, in the page's own shape. Valid on its own"
        )]
        end: Option<String>,
        #[arg(long)]
        priority: Option<i64>,
        #[arg(
            long,
            help = "Move the page to this folder, by name or id — \"inbox\" for unfiled"
        )]
        folder: Option<String>,
        #[arg(long = "tag", help = "Add a tag; repeat for several")]
        add_tags: Vec<String>,
        #[arg(long = "untag", help = "Remove a tag; repeat for several")]
        remove_tags: Vec<String>,
        #[arg(long, help = "Set the line under the title; \"\" clears it")]
        subtitle: Option<String>,
        #[arg(
            long,
            conflicts_with_all = ["due", "all_day", "end", "no_end"],
            help = "Remove the page's date and time"
        )]
        unschedule: bool,
        #[arg(
            long = "no-end",
            conflicts_with = "end",
            help = "Drop the end, keeping the start"
        )]
        no_end: bool,
    },
    /// Mark a page done (clones + advances recurring pages)
    Done { id: String },
    /// Set a page's status: done | not_started
    Status { id: String, state: String },
    /// Move a page to the trash, where Pikos can restore it
    Delete {
        id: String,
        #[arg(
            long,
            help = "Destroy the page instead — irreversible, and refused on a page from a connected calendar"
        )]
        hard: bool,
    },
    /// Bring a trashed page back
    Restore { id: String },
    /// Inspect and create folders
    Folders {
        #[command(subcommand)]
        command: FolderCommand,
    },
    /// Per-page reminders, in minutes ahead of the scheduled start
    Reminders {
        #[command(subcommand)]
        command: ReminderCommand,
    },
    /// Speak the Model Context Protocol on stdio, for an agent to drive
    Mcp,
    /// Seed a throwaway workspace and time it. Never touches your real one.
    Stress {
        #[command(subcommand)]
        action: StressCommand,
    },
}

#[derive(Subcommand)]
pub enum FolderCommand {
    /// List folders with their page counts
    List,
    /// Create a folder at the top level
    Create { name: Vec<String> },
}

#[derive(Subcommand)]
pub enum ReminderCommand {
    /// List a page's reminders
    List { page_id: String },
    /// Add a reminder to a page
    Add {
        page_id: String,
        #[arg(
            long,
            help = "Minutes before the scheduled start; 0 fires at the start"
        )]
        minutes: i64,
    },
    /// Remove a reminder by its own id
    Rm { reminder_id: String },
}

#[derive(Subcommand)]
pub enum StressCommand {
    /// Fill a scratch workspace with generated pages
    Seed {
        #[arg(long, default_value_t = 100_000, help = "Ordinary pages to create")]
        pages: usize,
        #[arg(long, default_value_t = 20, help = "Very large pages to create")]
        large_pages: usize,
        #[arg(long, default_value_t = 50_000, help = "Words in each large page")]
        large_words: usize,
        #[arg(long, value_enum, default_value_t = crate::stress::Shape::Plain)]
        shape: crate::stress::Shape,
        #[arg(
            long,
            help = "The day mixed dates spread around, as YYYY-MM-DD (default: today)"
        )]
        today: Option<chrono::NaiveDate>,
    },
    /// Time the operations that decide whether Pikos feels instant
    Bench {
        #[arg(
            long,
            default_value_t = 1,
            value_parser = clap::value_parser!(u32).range(1..),
            help = "Times to measure each operation, reporting the median and the 95th percentile"
        )]
        runs: u32,
        #[arg(
            long,
            value_delimiter = ',',
            help = "Time only the operations whose names contain one of these, e.g. --only list,save"
        )]
        only: Vec<String>,
    },
}

fn parse_cursor(value: &str) -> Result<SearchCursor, String> {
    SearchCursor::parse(value).ok_or_else(|| {
        format!("expected a cursor a previous search printed, like 4120.20 (got \"{value}\")")
    })
}
