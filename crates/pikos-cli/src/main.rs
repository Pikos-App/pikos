//! Pikos CLI — headless access to the local workspace, over the shared
//! `pikos-db` writer. DB work is pure Rust; the parser and recurrence math are
//! bridged to the TS core via a one-shot `node` subprocess (parse / next-occurrence),
//! so NLP+recurrence stay single-sourced in TS and the writer in pikos-db.

use std::path::{Path, PathBuf};
use std::process::Command as Proc;

use clap::{Parser, Subcommand};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::SqlitePool;

use pikos_db::{
    complete_recurring_page_impl, create_page_impl, create_recurrence_rule_impl, delete_page_impl,
    get_page, get_recurrence_rule_impl, list_folders_impl, list_page_schedules_impl,
    list_pages_impl, list_pages_today_impl, now_iso, open_pool, search_pages_impl,
    update_page_impl, update_page_schedule_impl, AppError, CompleteRecurringInput, NewPage,
    NewPageSchedule, NewRecurrenceRule, Page, PageFilter, PageSummary, PageUpdate, SearchResponse,
};

const BUNDLE_IDENTIFIER: &str = "app.pikos.desktop";
const DB_FILENAME: &str = "default.sqlite";

// ─── CLI definition ───────────────────────────────────────────────────────────

#[derive(Parser)]
#[command(name = "pikos", version, about = "Headless access to your local Pikos workspace.")]
struct Cli {
    #[arg(long, global = true, help = "Output machine-readable JSON")]
    json: bool,
    #[arg(long, global = true, help = "Override the workspace database path")]
    db: Option<String>,
    #[arg(long, global = true, help = "Skip confirmation prompts")]
    yes: bool,
    #[command(subcommand)]
    command: CliCommand,
}

#[derive(Subcommand)]
enum CliCommand {
    /// Full-text search across pages (FTS5, bm25-ranked)
    Search {
        query: Vec<String>,
        #[arg(long)]
        include_completed: bool,
        #[arg(long)]
        limit: Option<usize>,
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
        #[arg(long)]
        modified: bool,
        #[arg(long)]
        limit: Option<usize>,
    },
    /// Pages due or scheduled on or before today (open only)
    Today,
    /// Create a page from natural-language text (same parser as Quick Add)
    Add { text: Vec<String> },
    /// Update a page's core fields
    Update {
        id: String,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        content: Option<String>,
        #[arg(long)]
        status: Option<String>,
        #[arg(long)]
        due: Option<String>,
        #[arg(long)]
        priority: Option<i64>,
    },
    /// Mark a page done (clones + advances recurring pages)
    Done { id: String },
    /// Set a page's status: done | not_started
    Status { id: String, state: String },
    /// Permanently delete a page (through core's delete path)
    Rm { id: String },
}

// ─── Errors / exit codes ────────────────────────────────────────────────────

#[derive(Debug)]
struct CliError {
    kind: &'static str,
    message: String,
    code: i32,
}

impl CliError {
    fn new(kind: &'static str, message: impl Into<String>, code: i32) -> Self {
        CliError { kind, message: message.into(), code }
    }
    fn usage(m: impl Into<String>) -> Self {
        Self::new("Usage", m, 2)
    }
    fn not_found(m: impl Into<String>) -> Self {
        Self::new("NotFound", m, 3)
    }
    fn workspace(m: impl Into<String>) -> Self {
        Self::new("Workspace", m, 5)
    }
    fn missing_node(m: impl Into<String>) -> Self {
        Self::new("MissingNode", m, 7)
    }
    fn internal(m: impl Into<String>) -> Self {
        Self::new("Internal", m, 1)
    }
}

/// Map a pikos-db AppError to a scrubbed CliError. Foreign (sqlx) messages are
/// never surfaced — only a stable kind + generic text; NotFound/Conflict/Invalid
/// carry our own safe messages.
fn classify(err: AppError) -> CliError {
    // open_pool's migrator returns VersionMissing when the DB has applied a
    // migration this build doesn't know — i.e. the workspace is newer than the
    // CLI. Surface that as a clear, actionable error rather than a generic Db one.
    if let AppError::Db(sqlx::Error::Migrate(ref m)) = err {
        if matches!(**m, sqlx::migrate::MigrateError::VersionMissing(_)) {
            return CliError::new(
                "SchemaTooNew",
                "This workspace's database is newer than this Pikos CLI supports. Upgrade the CLI to match the desktop app.",
                6,
            );
        }
    }
    match err {
        AppError::NotFound(m) => CliError::not_found(m),
        AppError::Conflict(m) => CliError::new("Conflict", m, 4),
        AppError::Invalid(m) => CliError::usage(m),
        AppError::Db(_) => CliError::new("Db", "a database error occurred", 1),
        AppError::Io(_) => CliError::internal("an I/O error occurred"),
        AppError::Serde(_) => CliError::internal("a serialization error occurred"),
        AppError::Internal(m) => CliError::internal(m),
    }
}

// ─── DB path ──────────────────────────────────────────────────────────────────

fn platform_data_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    if cfg!(target_os = "windows") {
        std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(&home).join("AppData").join("Roaming"))
    } else if cfg!(target_os = "macos") {
        PathBuf::from(&home).join("Library").join("Application Support")
    } else {
        std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(&home).join(".local").join("share"))
    }
}

fn resolve_db_path(override_opt: &Option<String>) -> String {
    if let Some(p) = override_opt {
        return p.clone();
    }
    platform_data_dir()
        .join(BUNDLE_IDENTIFIER)
        .join(DB_FILENAME)
        .to_string_lossy()
        .into_owned()
}

// ─── Bridge (parser + recurrence) ───────────────────────────────────────────

fn bridge_js() -> Result<PathBuf, CliError> {
    if let Ok(p) = std::env::var("PIKOS_BRIDGE_JS") {
        return Ok(PathBuf::from(p));
    }
    // Candidates relative to the executable, then a dev fallback relative to cwd.
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("bridge.mjs"));
            candidates.push(dir.join("../bridge/bridge.mjs"));
        }
    }
    candidates.push(PathBuf::from("packages/pikos-bridge/dist/bridge.mjs"));
    candidates
        .into_iter()
        .find(|p| p.exists())
        .ok_or_else(|| {
            CliError::internal(
                "parser bridge (bridge.mjs) not found; set PIKOS_BRIDGE_JS to its path",
            )
        })
}

fn run_bridge(cmd: &str, payload: &str) -> Result<Value, CliError> {
    let js = bridge_js()?;
    let out = Proc::new("node")
        .arg(&js)
        .arg(cmd)
        .arg(payload)
        .output()
        .map_err(|e| {
            // ENOENT means `node` isn't on PATH. Only `add` and recurring `done`
            // hit this path — DB-only commands (list/today/search/read/status/rm)
            // work without Node, so steer the user toward those + an install hint.
            if e.kind() == std::io::ErrorKind::NotFound {
                CliError::missing_node(
                    "this command needs Node.js (the NLP parser runs in a one-shot \
                     node subprocess). Install from https://nodejs.org or `brew install node`. \
                     DB-only commands (list, today, search, read, status, rm, done on \
                     non-recurring pages) work without Node.",
                )
            } else {
                CliError::internal(format!("failed to run node for the parser bridge: {e}"))
            }
        })?;
    let v: Value = serde_json::from_slice(&out.stdout)
        .map_err(|_| CliError::internal("parser bridge returned invalid output"))?;
    if v.get("ok").and_then(Value::as_bool) != Some(true) {
        let msg = v
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("parser bridge error")
            .to_string();
        return Err(CliError::usage(msg));
    }
    Ok(v)
}

#[derive(Deserialize, Default)]
struct ParsedInput {
    #[serde(default)]
    title: String,
    #[serde(rename = "scheduledStart")]
    scheduled_start: Option<String>,
    #[serde(rename = "scheduledEnd")]
    scheduled_end: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(rename = "folderQuery")]
    folder_query: Option<String>,
    priority: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ParseResult {
    Single { input: ParsedInput },
    Finite { inputs: Vec<ParsedInput> },
    Recurring { input: ParsedInput, rrule: String },
}

// ─── Rendering ──────────────────────────────────────────────────────────────

fn priority_label(p: i64) -> &'static str {
    match p {
        1 => "Urgent",
        2 => "High",
        3 => "Medium",
        4 => "Low",
        _ => "None",
    }
}

fn status_box(status: &str) -> &'static str {
    if status == "done" {
        "[x]"
    } else {
        "[ ]"
    }
}

fn render_summary(p: &PageSummary) -> String {
    let title = if p.title.is_empty() { "(untitled)" } else { &p.title };
    let mut meta: Vec<String> = Vec::new();
    if let Some(d) = &p.scheduled_start {
        meta.push(format!("due:{d}"));
    }
    if p.priority != 0 {
        meta.push(format!("p:{}", priority_label(p.priority)));
    }
    if !p.tags.is_empty() {
        meta.push(p.tags.iter().map(|t| format!("#{t}")).collect::<Vec<_>>().join(" "));
    }
    let tail = if meta.is_empty() { String::new() } else { format!("   {}", meta.join("  ")) };
    format!("{} {title}{tail}   id:{}", status_box(&p.status), p.id)
}

fn render_summary_list(pages: &[PageSummary], empty: &str) -> String {
    if pages.is_empty() {
        return empty.to_string();
    }
    pages.iter().map(render_summary).collect::<Vec<_>>().join("\n")
}

fn render_page(page: &Page) -> String {
    let title = if page.title.is_empty() { "(untitled)" } else { &page.title };
    let mut lines = vec![title.to_string()];
    let mut meta = vec![
        format!("status:{}", page.status),
        format!("priority:{}", priority_label(page.priority)),
    ];
    if let Some(d) = &page.scheduled_start {
        meta.push(format!("due:{d}"));
    }
    if !page.tags.is_empty() {
        meta.push(page.tags.iter().map(|t| format!("#{t}")).collect::<Vec<_>>().join(" "));
    }
    lines.push(meta.join("  "));
    lines.push(format!("id:{}", page.id));
    lines.push(format!("created:{}  updated:{}", page.created_at, page.updated_at));
    if let Some(body) = page.content_text.as_deref() {
        let body = body.trim();
        if !body.is_empty() {
            lines.push(String::new());
            lines.push(body.to_string());
        }
    }
    lines.join("\n")
}

fn render_search(resp: &SearchResponse) -> String {
    if resp.results.is_empty() {
        let note = if resp.completed_count > 0 {
            format!(" ({} completed hidden — use --include-completed)", resp.completed_count)
        } else {
            String::new()
        };
        return format!("No matches.{note}");
    }
    let mut lines: Vec<String> = resp
        .results
        .iter()
        .map(|r| {
            let title = if r.title.is_empty() { "(untitled)" } else { &r.title };
            let snippet = if r.excerpt.is_empty() { &r.content_preview } else { &r.excerpt };
            let head = format!("{} {title}  ({})   id:{}", status_box(&r.status), r.match_source, r.id);
            if snippet.is_empty() {
                head
            } else {
                format!("{head}\n    {snippet}")
            }
        })
        .collect();
    if resp.completed_count > 0 {
        lines.push(format!(
            "\n{} completed hidden — use --include-completed to show.",
            resp.completed_count
        ));
    }
    lines.join("\n")
}

fn print_json<T: serde::Serialize>(value: &T) {
    println!("{}", serde_json::to_string_pretty(value).expect("serialize output"));
}

// ─── Write helpers (mirror the app's persistence path) ────────────────────────

fn local_tz() -> String {
    iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".to_string())
}

fn base_page(folder_id: Option<String>, title: String) -> NewPage {
    NewPage {
        folder_id,
        title,
        subtitle: None,
        content: String::new(),
        content_text: Some(String::new()),
        status: "not_started".to_string(),
        priority: 0,
        tags: Vec::new(),
        scheduled_start: None,
        scheduled_end: None,
        completed_at: None,
        links: Vec::new(),
        parent_id: None,
        last_opened_at: None,
        created_at: None,
        updated_at: None,
    }
}

fn priority_num(word: &Option<String>) -> i64 {
    match word.as_deref() {
        Some("urgent") => 1,
        Some("high") => 2,
        Some("medium") => 3,
        Some("low") => 4,
        _ => 0,
    }
}

async fn apply_patch(pool: &SqlitePool, id: &str, priority: i64, tags: &[String]) -> Result<(), AppError> {
    let mut patch = PageUpdate::default();
    let mut touched = false;
    if priority != 0 {
        patch.priority = Some(priority);
        touched = true;
    }
    if !tags.is_empty() {
        patch.tags = Some(tags.to_vec());
        touched = true;
    }
    if touched {
        update_page_impl(pool, id.to_string(), patch).await?;
    }
    Ok(())
}

async fn resolve_folder(pool: &SqlitePool, folder_query: &Option<String>) -> Result<Option<String>, AppError> {
    let q = match folder_query {
        Some(q) if !q.is_empty() => q,
        _ => return Ok(None),
    };
    if q.eq_ignore_ascii_case("inbox") {
        return Ok(None);
    }
    let folders = list_folders_impl(pool).await?;
    Ok(folders
        .into_iter()
        .find(|f| f.name.eq_ignore_ascii_case(q))
        .map(|f| f.id))
}

async fn schedule_once(
    pool: &SqlitePool,
    page_id: &str,
    start: &str,
    end: Option<&str>,
) -> Result<(), AppError> {
    let schedules = list_page_schedules_impl(pool, page_id).await?;
    if let Some(existing) = schedules.iter().find(|s| s.rule_id.is_none()) {
        let upd = pikos_db::PageScheduleUpdate {
            scheduled_start: Some(start.to_string()),
            scheduled_end: Some(end.map(|e| Value::String(e.to_string())).unwrap_or(Value::Null)),
            ..Default::default()
        };
        update_page_schedule_impl(pool, existing.id.clone(), upd).await?;
    } else {
        pikos_db::create_page_schedule_impl(
            pool,
            NewPageSchedule {
                page_id: page_id.to_string(),
                scheduled_start: start.to_string(),
                scheduled_end: end.map(str::to_string),
                timezone: Some(local_tz()),
                rule_id: None,
                original_date: None,
            },
        )
        .await?;
    }
    Ok(())
}

fn text_to_tiptap(text: &str) -> (String, String) {
    let content: Vec<Value> = text
        .split('\n')
        .map(|line| {
            if line.is_empty() {
                json!({ "type": "paragraph" })
            } else {
                json!({ "type": "paragraph", "content": [{ "type": "text", "text": line }] })
            }
        })
        .collect();
    let doc = json!({ "type": "doc", "content": content });
    (doc.to_string(), text.to_string())
}

// ─── Command handlers ─────────────────────────────────────────────────────────

async fn require_page(pool: &SqlitePool, id: &str) -> Result<Page, CliError> {
    get_page(pool, id)
        .await
        .map_err(classify)?
        .ok_or_else(|| CliError::not_found(format!("No page with id: {id}")))
}

fn parse_due(due: &str) -> Result<(String, String), CliError> {
    let is_date = |s: &str| s.len() == 10 && s.as_bytes()[4] == b'-' && s.as_bytes()[7] == b'-';
    let end_of = |d: &str| format!("{d}T23:59:59");
    if let Some((a, b)) = due.split_once("..") {
        if !is_date(a) || !is_date(b) {
            return Err(CliError::usage(format!("--due range must be YYYY-MM-DD..YYYY-MM-DD (got \"{due}\")")));
        }
        return Ok((a.to_string(), end_of(b)));
    }
    if !is_date(due) {
        return Err(CliError::usage(format!("--due must be YYYY-MM-DD or YYYY-MM-DD..YYYY-MM-DD (got \"{due}\")")));
    }
    Ok((due.to_string(), end_of(due)))
}

async fn cmd_add(pool: &SqlitePool, text: &str) -> Result<Vec<Page>, CliError> {
    let parsed = run_bridge("parse", text)?;
    let result: ParseResult = serde_json::from_value(parsed["result"].clone())
        .map_err(|_| CliError::internal("could not interpret parser output"))?;

    let mut created: Vec<Page> = Vec::new();
    match result {
        ParseResult::Recurring { input, rrule } => {
            let folder = resolve_folder(pool, &input.folder_query).await.map_err(classify)?;
            let page = create_page_impl(pool, base_page(folder, input.title.clone())).await.map_err(classify)?;
            apply_patch(pool, &page.id, priority_num(&input.priority), &input.tags).await.map_err(classify)?;
            let rule_start = input.scheduled_start.clone().unwrap_or_else(local_today);
            create_recurrence_rule_impl(
                pool,
                NewRecurrenceRule {
                    page_id: page.id.clone(),
                    rrule,
                    rrule_exdates: Vec::new(),
                    scheduled_start: rule_start.clone(),
                    scheduled_end: input.scheduled_end.clone(),
                    timezone: local_tz(),
                },
            )
            .await
            .map_err(classify)?;
            let denorm = PageUpdate {
                scheduled_start: Some(Value::String(rule_start)),
                scheduled_end: input.scheduled_end.as_ref().map(|e| Value::String(e.clone())),
                ..Default::default()
            };
            update_page_impl(pool, page.id.clone(), denorm).await.map_err(classify)?;
            created.push(require_page(pool, &page.id).await?);
        }
        ParseResult::Finite { inputs } => {
            for inp in inputs {
                let folder = resolve_folder(pool, &inp.folder_query).await.map_err(classify)?;
                let page = create_page_impl(pool, base_page(folder, inp.title.clone())).await.map_err(classify)?;
                apply_patch(pool, &page.id, priority_num(&inp.priority), &inp.tags).await.map_err(classify)?;
                if let Some(start) = &inp.scheduled_start {
                    schedule_once(pool, &page.id, start, inp.scheduled_end.as_deref()).await.map_err(classify)?;
                }
                created.push(require_page(pool, &page.id).await?);
            }
        }
        ParseResult::Single { input } => {
            let folder = resolve_folder(pool, &input.folder_query).await.map_err(classify)?;
            let page = create_page_impl(pool, base_page(folder, input.title.clone())).await.map_err(classify)?;
            apply_patch(pool, &page.id, priority_num(&input.priority), &input.tags).await.map_err(classify)?;
            if let Some(start) = &input.scheduled_start {
                schedule_once(pool, &page.id, start, input.scheduled_end.as_deref()).await.map_err(classify)?;
            }
            created.push(require_page(pool, &page.id).await?);
        }
    }
    Ok(created)
}

fn local_today() -> String {
    // YYYY-MM-DD in UTC is good enough for a rule anchor fallback.
    now_iso()[..10].to_string()
}

async fn mark_done(pool: &SqlitePool, id: &str) -> Result<Page, CliError> {
    let page = require_page(pool, id).await?;
    if page.status == "done" {
        return Ok(page);
    }
    let rule = get_recurrence_rule_impl(pool, id).await.map_err(classify)?;
    let Some(rule) = rule else {
        let upd = PageUpdate {
            status: Some("done".to_string()),
            completed_at: Some(Value::String(now_iso())),
            ..Default::default()
        };
        return update_page_impl(pool, id.to_string(), upd).await.map_err(classify);
    };

    // "advance" policy via the bridge's recurrence math.
    let head_date = page.scheduled_start.clone().unwrap_or_else(now_iso);
    let completed_date = page.scheduled_start.as_ref().map(|s| s[..10.min(s.len())].to_string());
    let mut exdates = rule.rrule_exdates.clone();
    if let Some(d) = &completed_date {
        exdates.push(d.clone());
    }
    let req = json!({
        "rrule": rule.rrule,
        "scheduledStart": rule.scheduled_start,
        "afterDate": head_date,
        "exdates": exdates,
        "scheduledEnd": rule.scheduled_end,
    });
    let resp = run_bridge("next-occurrence", &req.to_string())?;
    let next_start = resp["next"].get("scheduledStart").and_then(Value::as_str).map(str::to_string);
    let next_end = resp["nextEnd"].as_str().map(str::to_string);

    complete_recurring_page_impl(
        pool,
        CompleteRecurringInput {
            page_id: id.to_string(),
            next_scheduled_start: next_start,
            next_scheduled_end: next_end,
            // Folded into the completion tx; the backend MERGES the date into
            // the current exdates, so a concurrent desktop write survives.
            rule_id: Some(rule.id.clone()),
            add_exdates: completed_date.map(|d| vec![d]),
        },
    )
    .await
    .map_err(classify)?;

    require_page(pool, id).await
}

async fn confirm(question: &str) -> bool {
    eprint!("{question} [y/N] ");
    use std::io::Write;
    let _ = std::io::stderr().flush();
    let mut line = String::new();
    if std::io::stdin().read_line(&mut line).is_err() {
        return false;
    }
    matches!(line.trim().to_lowercase().as_str(), "y" | "yes")
}

// ─── main ──────────────────────────────────────────────────────────────────

async fn run(cli: Cli) -> Result<(), CliError> {
    let json = cli.json;
    let path = resolve_db_path(&cli.db);
    if !Path::new(&path).exists() {
        return Err(CliError::workspace(format!(
            "No Pikos workspace found at \"{path}\". Open the desktop app once to create it, or pass --db."
        )));
    }
    // open_pool runs the migrator, which fails closed (VersionMissing -> mapped
    // to SchemaTooNew in classify) when the workspace schema is newer than this
    // CLI — so a stale CLI can never write against an unknown schema.
    let pool = open_pool(&path).await.map_err(classify)?;

    match cli.command {
        CliCommand::Search { query, include_completed, limit } => {
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
        CliCommand::List { status, due, tag, modified, limit } => {
            let mut filter = PageFilter::default();
            if let Some(s) = &status {
                if s != "not_started" && s != "done" {
                    return Err(CliError::usage(format!("--status must be \"not_started\" or \"done\" (got \"{s}\")")));
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
            let mut pages = list_pages_impl(&pool, Some(filter)).await.map_err(classify)?;
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
                println!("{}", render_summary_list(&pages, "Nothing scheduled for today."));
            }
        }
        CliCommand::Add { text } => {
            let created = cmd_add(&pool, &text.join(" ")).await?;
            if json {
                print_json(&json!({ "created": created }));
            } else {
                for p in &created {
                    println!("Created {}: {}", p.id, if p.title.is_empty() { "(untitled)" } else { &p.title });
                }
            }
        }
        CliCommand::Update { id, title, content, status, due, priority } => {
            require_page(&pool, &id).await?;
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
                    return Err(CliError::usage(format!("--status must be \"not_started\" or \"done\" (got \"{s}\")")));
                }
                upd.status = Some(s.clone());
                upd.completed_at = Some(if s == "done" { Value::String(now_iso()) } else { Value::Null });
            }
            if let Some(p) = priority {
                if !(0..=4).contains(&p) {
                    return Err(CliError::usage(format!("--priority must be 0–4 (got {p})")));
                }
                upd.priority = Some(p);
            }
            update_page_impl(&pool, id.clone(), upd).await.map_err(classify)?;
            if let Some(d) = &due {
                schedule_once(&pool, &id, d, None).await.map_err(classify)?;
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
                    update_page_impl(&pool, id.clone(), upd).await.map_err(classify)?
                }
                other => {
                    return Err(CliError::usage(format!("state must be \"done\" or \"not_started\" (got \"{other}\")")))
                }
            };
            if json {
                print_json(&page);
            } else {
                println!("{}", render_page(&page));
            }
        }
        CliCommand::Rm { id } => {
            let page = require_page(&pool, &id).await?;
            if !cli.yes {
                if json {
                    return Err(CliError::usage("refusing to delete without --yes in --json mode"));
                }
                let title = if page.title.is_empty() { "(untitled)".to_string() } else { page.title.clone() };
                if !confirm(&format!("Delete \"{title}\" ({id})?")).await {
                    eprintln!("Aborted.");
                    return Ok(());
                }
            }
            delete_page_impl(&pool, &id).await.map_err(classify)?;
            if json {
                print_json(&json!({ "id": id, "deleted": true }));
            } else {
                println!("Deleted {id}");
            }
        }
    }
    Ok(())
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let json = cli.json;
    if let Err(e) = run(cli).await {
        if json {
            eprintln!("{}", json!({ "error": { "kind": e.kind, "message": e.message } }));
        } else {
            eprintln!("pikos: {} ({})", e.message, e.kind);
        }
        std::process::exit(e.code);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn priority_num_maps_words() {
        assert_eq!(priority_num(&Some("urgent".into())), 1);
        assert_eq!(priority_num(&Some("high".into())), 2);
        assert_eq!(priority_num(&Some("medium".into())), 3);
        assert_eq!(priority_num(&Some("low".into())), 4);
        assert_eq!(priority_num(&None), 0);
        assert_eq!(priority_num(&Some("nonsense".into())), 0);
    }

    #[test]
    fn parse_due_single_date() {
        let (after, before) = parse_due("2026-05-24").unwrap();
        assert_eq!(after, "2026-05-24");
        assert_eq!(before, "2026-05-24T23:59:59");
    }

    #[test]
    fn parse_due_range() {
        let (after, before) = parse_due("2026-05-01..2026-05-31").unwrap();
        assert_eq!(after, "2026-05-01");
        assert_eq!(before, "2026-05-31T23:59:59");
    }

    #[test]
    fn parse_due_rejects_garbage() {
        let err = parse_due("nope").unwrap_err();
        assert_eq!(err.kind, "Usage");
        assert_eq!(err.code, 2);
        let err2 = parse_due("2026-5-1").unwrap_err();
        assert_eq!(err2.kind, "Usage");
    }

    #[test]
    fn text_to_tiptap_wraps_lines_and_keeps_plaintext() {
        let (content, text) = text_to_tiptap("hello\nworld");
        assert_eq!(text, "hello\nworld");
        let doc: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(doc["type"], "doc");
        assert_eq!(doc["content"][0]["content"][0]["text"], "hello");
        assert_eq!(doc["content"][1]["content"][0]["text"], "world");
    }

    #[test]
    fn classify_maps_kinds_and_scrubs_db() {
        assert_eq!(classify(AppError::NotFound("x".into())).code, 3);
        assert_eq!(classify(AppError::NotFound("x".into())).kind, "NotFound");
        assert_eq!(classify(AppError::Conflict("x".into())).code, 4);
        assert_eq!(classify(AppError::Invalid("x".into())).kind, "Usage");
        // Foreign DB error text is scrubbed to a stable kind + generic message.
        let db = classify(AppError::Db(sqlx::Error::RowNotFound));
        assert_eq!(db.kind, "Db");
        assert_eq!(db.message, "a database error occurred");
    }

    #[test]
    fn schema_too_new_maps_to_exit_6() {
        let err = AppError::Db(sqlx::Error::Migrate(Box::new(
            sqlx::migrate::MigrateError::VersionMissing(99),
        )));
        let cli = classify(err);
        assert_eq!(cli.kind, "SchemaTooNew");
        assert_eq!(cli.code, 6);
    }

}
