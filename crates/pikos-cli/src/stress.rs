//! Seed a throwaway workspace and time the operations that decide whether Pikos feels instant.
//!
//! The point is a number anybody can reproduce on their own hardware, so this seeds through the
//! same writer the app uses rather than inserting rows directly. Raw SQL would be far quicker and
//! would measure a workspace the app could never have produced: FTS rows, tag denormalisation and
//! schedule bookkeeping all come from the writer, and a benchmark over data that skipped them is
//! measuring the wrong thing. Seeding is therefore slow on purpose.
//!
//! Every entry point here refuses to touch the real workspace. Seeding a quarter of a million
//! pages into somebody's actual notes is the worst thing this binary could do, so `--db` is
//! required and a path matching the default workspace is rejected.

use std::path::Path;
use std::time::Instant;

use pikos_db::moves::{move_pages, Placement};
use pikos_db::reads::{
    count_views, get_page_if_newer, get_pages, list_range, list_recent_pages, list_series_heads,
    list_tags,
};
use pikos_db::views::DateBounds;
use pikos_db::views::{list_completed, list_view, list_view_ids, ViewKey, ViewScope, ViewSort};
use pikos_db::{
    build_tiptap_doc, create_folder_impl, create_page_impl, create_recurrence_rule_impl, get_page,
    list_pages_impl, open_pool, open_pool_checkpointing, update_page_impl, CheckpointHooks,
    Checkpoints, NewFolder, NewPage, NewRecurrenceRule, PageFilter, PageUpdate, SearchScan,
    DEFAULT_SEARCH_SCAN,
};
use serde_json::json;

use crate::error::{classify, CliError};
use crate::ops::{list_pages, search, ListQuery};
use crate::workspace::resolve_db_path;
use crate::write::{base_page, local_tz, schedule_once};

/// Words the generated bodies are drawn from. Deliberately ordinary English rather than lorem:
/// FTS5 tokenises real words the way it will in use, and a corpus of one repeated token would
/// make search look faster than it is.
const WORDS: &[&str] = &[
    "meeting",
    "notes",
    "review",
    "draft",
    "follow",
    "up",
    "budget",
    "roadmap",
    "hiring",
    "release",
    "customer",
    "feedback",
    "design",
    "kitchen",
    "holiday",
    "invoice",
    "renewal",
    "quarterly",
    "standup",
    "retro",
    "migration",
    "rollout",
    "deadline",
    "proposal",
    "contract",
    "onboarding",
    "handover",
    "estimate",
    "sprint",
    "incident",
];

/// Body sizes the bench reads and writes against, in words. Roughly: a note, a long document, and
/// something past anything a person would type by hand — the last exists to find where the editor
/// and the FTS index stop being free rather than to represent a real page.
const SIZE_BUCKETS: &[(&str, usize)] = &[("small", 40), ("large", 20_000), ("huge", 200_000)];
const SIZE_MARKER: &str = "sizebench";

/// A word outside [`WORDS`], put into the same number of pages whatever the corpus size. Every
/// word in [`WORDS`] lands in most pages, so searching one ranks most of the workspace and grows
/// with it; a real search term matches a handful, and this is the line that shows whether search
/// stays flat when it does.
const RARE_WORD: &str = "zephyr";
const RARE_PAGES: usize = 50;

/// A small deterministic generator, so two runs on the same inputs produce the same workspace and
/// two people comparing numbers are comparing the same shape of data. Not cryptographic and not
/// trying to be.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*; enough spread for picking words and lengths.
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

/// A body as the editor saves one, with its plain text for search beside it.
fn set_body(page: &mut NewPage, text: String) {
    page.content = build_tiptap_doc(&text);
    page.content_text = Some(text);
}

fn sentence(rng: &mut Rng, words: usize) -> String {
    let mut s = String::with_capacity(words * 8);
    for i in 0..words {
        if i > 0 {
            s.push(' ');
        }
        s.push_str(WORDS[rng.below(WORDS.len())]);
    }
    s
}

/// The real workspace is off limits, whatever the flags say.
fn require_scratch_db(db: &Option<String>) -> Result<String, CliError> {
    let Some(path) = db.clone() else {
        return Err(CliError::workspace(
            "pikos stress needs an explicit --db path. It writes hundreds of thousands of pages \
             and must never be pointed at a workspace you care about. Try --db /tmp/pikos-stress.db"
                .to_string(),
        ));
    };
    if Path::new(&path) == Path::new(&resolve_db_path(&None)) {
        return Err(CliError::workspace(
            "--db is your real workspace. Refusing: pikos stress writes throwaway data and \
             cannot be undone. Point it somewhere else."
                .to_string(),
        ));
    }
    Ok(path)
}

/// What the seeded pages look like.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum Shape {
    /// Every page an undated inbox page: the database figures, and comparable across releases.
    Plain,
    /// Folders, dates a year either side of `today`, priorities, tags, done pages, weekly series,
    /// multi-week all-day spans, and titles that test collation and ties, so a large workspace
    /// exercises every view, sort mode and calendar layout.
    Mixed,
}

const FOLDER_COUNT: usize = 20;
const TAGS: &[&str] = &["work", "home", "errands", "reading", "health"];
const EMOJI: &[&str] = &["📌 ", "🔥 ", "✅ "];
/// Titles whose order differs between naive byte order and the app's collation: accents, case,
/// and numbers that sort by value.
const TRICKY_TITLES: &[&str] = &[
    "Élan", "élan", "Elan", "ZEBRA", "zebra", "apple", "Äpfel", "item 2", "Item 10",
];

/// One page's shape under [`Shape::Mixed`]: it edits `page` and returns the schedule to write
/// (start, optional end) and whether the page repeats weekly.
fn shape_page(
    rng: &mut Rng,
    i: usize,
    today: chrono::NaiveDate,
    page: &mut NewPage,
    folder_ids: &[String],
) -> (Option<(String, Option<String>)>, bool) {
    if rng.below(10) < 7 {
        page.folder_id = Some(folder_ids[rng.below(folder_ids.len())].clone());
    }
    if i.is_multiple_of(7) {
        page.title = format!("Item {}", rng.below(1_000));
    }
    if i.is_multiple_of(11) {
        page.title = format!("{}{}", EMOJI[rng.below(EMOJI.len())], page.title);
    }
    if i.is_multiple_of(13) {
        page.title = TRICKY_TITLES[rng.below(TRICKY_TITLES.len())].to_string();
    }
    if i.is_multiple_of(17) {
        page.title = "Same title".to_string();
    }
    page.priority = if rng.below(2) == 0 {
        0
    } else {
        1 + rng.below(4) as i64
    };
    if rng.below(10) < 3 {
        let count = 1 + rng.below(2);
        page.tags = (0..count)
            .map(|_| TAGS[rng.below(TAGS.len())].to_string())
            .collect();
        page.tags.dedup();
    }
    if rng.below(10) < 2 {
        let done_on = today - chrono::Duration::days(rng.below(60) as i64);
        page.status = "done".to_string();
        page.completed_at = Some(format!("{}T10:00:00.000Z", done_on.format("%Y-%m-%d")));
    }
    if rng.below(10) >= 4 {
        return (None, false);
    }
    let day = today + chrono::Duration::days(rng.below(731) as i64 - 365);
    let date = day.format("%Y-%m-%d").to_string();
    let at = |hour: usize, minute: usize| format!("{date}T{hour:02}:{minute:02}:00");
    let (start, end) = match rng.below(20) {
        0..=4 => (date.clone(), None),
        5..=16 => {
            let hour = 8 + rng.below(10);
            let minute = 30 * rng.below(2);
            (at(hour, minute), Some(at(hour + 1, minute)))
        }
        17 => {
            let last = day + chrono::Duration::days(7 + rng.below(15) as i64);
            (date.clone(), Some(last.format("%Y-%m-%d").to_string()))
        }
        _ => (at(8 + rng.below(10), 0), None),
    };
    let weekly = start.contains('T') && rng.below(40) == 0;
    (Some((start, end)), weekly)
}

pub async fn seed(
    db: &Option<String>,
    pages: usize,
    large_pages: usize,
    large_words: usize,
    shape: Shape,
    today: chrono::NaiveDate,
    json: bool,
) -> Result<(), CliError> {
    let path = require_scratch_db(db)?;
    let pool = open_pool(&path).await.map_err(classify)?;

    let mut rng = Rng(0x5EED_1234_ABCD_0001);
    let started = Instant::now();

    let mut folder_ids = Vec::new();
    if shape == Shape::Mixed {
        for n in 1..=FOLDER_COUNT {
            let folder = create_folder_impl(
                &pool,
                NewFolder {
                    name: format!("Folder {n:02}"),
                    parent_id: None,
                    color: None,
                    icon: None,
                },
            )
            .await
            .map_err(classify)?;
            folder_ids.push(folder.id);
        }
    }

    let rare_every = (pages / RARE_PAGES).max(1);
    for i in 0..pages {
        let title = format!("{} {}", sentence(&mut rng, 4), i);
        let mut body = sentence(&mut rng, 40);
        if i % rare_every == 0 {
            body = format!("{body} {RARE_WORD}");
        }
        let mut page = base_page(None, title);
        set_body(&mut page, body);
        let (schedule, weekly) = match shape {
            Shape::Plain => (None, false),
            Shape::Mixed => shape_page(&mut rng, i, today, &mut page, &folder_ids),
        };
        let created = create_page_impl(&pool, page).await.map_err(classify)?;
        if let Some((start, end)) = schedule {
            schedule_once(&pool, &created.id, &start, end.as_deref())
                .await
                .map_err(classify)?;
            if weekly {
                create_recurrence_rule_impl(
                    &pool,
                    NewRecurrenceRule {
                        page_id: created.id.clone(),
                        rrule: "FREQ=WEEKLY".to_string(),
                        rrule_exdates: Vec::new(),
                        scheduled_start: start,
                        scheduled_end: end,
                        timezone: local_tz(),
                    },
                )
                .await
                .map_err(classify)?;
            }
        }

        // Seeding a quarter of a million pages is minutes of work, and a silent process that
        // long reads as a hang.
        if !json && i > 0 && i % 5_000 == 0 {
            eprintln!(
                "  {i} / {pages} pages, {:.0}s elapsed",
                started.elapsed().as_secs_f64()
            );
        }
    }

    // Three marked pages the bench can find by title, so read and write can be timed against a
    // known body size. Listing never touches these bodies — SUMMARY_COLUMNS carries no content —
    // so page size only shows up on open, save, and the FTS index a write has to maintain.
    for (label, words) in SIZE_BUCKETS {
        let mut page = base_page(None, format!("{SIZE_MARKER} {label}"));
        let body = sentence(&mut rng, *words);
        set_body(&mut page, body);
        create_page_impl(&pool, page).await.map_err(classify)?;
    }

    for i in 0..large_pages {
        let title = format!("large document {i}");
        let body = sentence(&mut rng, large_words);
        let mut page = base_page(None, title);
        set_body(&mut page, body);
        create_page_impl(&pool, page).await.map_err(classify)?;
    }

    // Closing the last connection checkpoints the write-ahead log into the file and removes it, so
    // the seeded file is complete on its own and can be copied as a template.
    pool.close().await;
    let elapsed = started.elapsed();
    if json {
        crate::render::print_json(&json!({
            "seeded": pages, "large_pages": large_pages, "large_words": large_words,
            "seconds": elapsed.as_secs_f64(), "db": path,
        }));
    } else {
        println!(
            "Seeded {pages} pages and {large_pages} large pages ({large_words} words each) into {path} in {:.1}s",
            elapsed.as_secs_f64()
        );
        println!("Now run: pikos stress bench --db {path}");
    }
    Ok(())
}

/// One timed operation, reported with the corpus size beside it because a duration without a size
/// is the adjective this whole exercise exists to replace.
struct Timing {
    name: &'static str,
    /// Every measured run, in milliseconds, sorted.
    samples: Vec<f64>,
}

impl Timing {
    fn percentile(&self, p: f64) -> f64 {
        let rank = (p * (self.samples.len() - 1) as f64).round() as usize;
        self.samples[rank]
    }
}

/// How long one operation may spend on its measured runs before it stops early. Hundreds of runs of
/// a sub-millisecond read cost nothing, while the same count of a seconds-long whole-table load
/// would take most of an hour; the runs each operation actually got are in the output.
const RUN_BUDGET: std::time::Duration = std::time::Duration::from_secs(10);
const MIN_RUNS: usize = 5;

/// The operations `bench --only` asked for; every one when empty.
static ONLY: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();

async fn time_it<F, Fut, T>(runs: u32, name: &'static str, f: F) -> Result<Timing, CliError>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<T, CliError>>,
{
    let only = ONLY.get().map(Vec::as_slice).unwrap_or_default();
    if !only.is_empty() && !only.iter().any(|o| name.contains(o.as_str())) {
        return Ok(Timing {
            name,
            samples: vec![],
        });
    }
    // Once to warm the page cache, then the measured runs, so the number is steady-state rather
    // than whatever the filesystem happened to be doing.
    let _ = f().await?;
    let mut samples = Vec::with_capacity(runs as usize);
    let began = Instant::now();
    for _ in 0..runs {
        let start = Instant::now();
        f().await?;
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
        if samples.len() >= MIN_RUNS && began.elapsed() > RUN_BUDGET {
            break;
        }
    }
    samples.sort_by(f64::total_cmp);
    Ok(Timing { name, samples })
}

pub async fn bench(
    db: &Option<String>,
    runs: u32,
    only: &[String],
    json: bool,
) -> Result<(), CliError> {
    let path = require_scratch_db(db)?;
    let _ = ONLY.set(only.to_vec());

    let open_start = Instant::now();
    // Checkpointing the way the app does, so the bench times the database the app actually runs.
    let pool = open_pool_checkpointing(&path, Checkpoints::Background(CheckpointHooks::NONE))
        .await
        .map_err(classify)?;
    let open_ms = open_start.elapsed().as_secs_f64() * 1000.0;

    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pages")
        .fetch_one(&pool)
        .await
        .map_err(|e| classify(e.into()))?;

    // Every read and update goes to a different page, picked across the whole table with a fixed
    // seed. Reading one page over and over times a cache hit, not a workspace of this size.
    let max_rowid: i64 = sqlx::query_scalar("SELECT MAX(rowid) FROM pages")
        .fetch_one(&pool)
        .await
        .map_err(|e| classify(e.into()))?;
    let mut rng = Rng(0x5EED_0000_0000_BEEF);
    let mut page_ids = Vec::new();
    while page_ids.len() < 2 * (runs as usize + 1) {
        let rowid = 1 + rng.below(max_rowid as usize) as i64;
        let id: Option<String> =
            sqlx::query_scalar("SELECT id FROM pages WHERE rowid = ? AND deleted_at IS NULL")
                .bind(rowid)
                .fetch_optional(&pool)
                .await
                .map_err(|e| classify(e.into()))?;
        page_ids.extend(id);
    }
    let picked = std::cell::Cell::new(0);
    let next_page = || {
        let i = picked.get();
        picked.set(i + 1);
        page_ids[i].clone()
    };
    let pool_ref = &pool;

    // Opening happens once per process, so it has one sample whatever `runs` says.
    let mut timings = vec![Timing {
        name: "open workspace",
        samples: vec![open_ms],
    }];

    timings.push(
        time_it(runs, "create page", || async {
            let mut page = base_page(None, "benchmark page".to_string());
            set_body(&mut page, "benchmark body".to_string());
            create_page_impl(&pool, page).await.map_err(classify)
        })
        .await?,
    );
    timings.push(
        time_it(runs, "read page", || {
            let id = next_page();
            async move { get_page(pool_ref, &id).await.map_err(classify) }
        })
        .await?,
    );
    timings.push(
        time_it(runs, "update page", || {
            let id = next_page();
            async move {
                update_page_impl(
                    pool_ref,
                    id,
                    PageUpdate {
                        title: Some("renamed".to_string()),
                        ..Default::default()
                    },
                )
                .await
                .map_err(classify)
            }
        })
        .await?,
    );
    for (label, _) in SIZE_BUCKETS {
        let title = format!("{SIZE_MARKER} {label}");
        let id: Option<String> =
            sqlx::query_scalar("SELECT id FROM pages WHERE title = ?1 LIMIT 1")
                .bind(&title)
                .fetch_optional(&pool)
                .await
                .map_err(|e| classify(e.into()))?;
        let Some(id) = id else { continue };

        let name: &'static str = match *label {
            "small" => "read small page",
            "large" => "read large page",
            _ => "read huge page",
        };
        timings.push(
            time_it(runs, name, || async {
                get_page(&pool, &id).await.map_err(classify)
            })
            .await?,
        );

        let name: &'static str = match *label {
            "small" => "save small page",
            "large" => "save large page",
            _ => "save huge page",
        };
        timings.push(
            time_it(runs, name, || async {
                let text = sentence(&mut Rng(7), 80);
                update_page_impl(
                    &pool,
                    id.clone(),
                    PageUpdate {
                        content: Some(build_tiptap_doc(&text)),
                        content_text: Some(text),
                        ..Default::default()
                    },
                )
                .await
                .map_err(classify)
            })
            .await?,
        );
    }

    let zone = pikos_db::device_zone().name().to_string();
    let inbox = |sort| ViewKey {
        scope: ViewScope::Inbox,
        sort,
        zone: zone.clone(),
        dates: None,
    };
    for (name, sort) in [
        ("view 50, manual order", ViewSort::Manual),
        ("view 50, by date", ViewSort::Date),
        ("view 50, by title", ViewSort::Title),
        ("view 50, by priority", ViewSort::Priority),
    ] {
        let key = inbox(sort);
        timings.push(
            time_it(runs, name, || async {
                list_view(&pool, &key, None, 50).await.map_err(classify)
            })
            .await?,
        );
    }
    let key = inbox(ViewSort::Date);
    let deep = list_view(&pool, &key, None, 2_000)
        .await
        .map_err(classify)?
        .next;
    timings.push(
        time_it(runs, "view 50, 2,000 rows down", || async {
            list_view(&pool, &key, deep.as_ref(), 50)
                .await
                .map_err(classify)
        })
        .await?,
    );
    timings.push(
        time_it(runs, "view 50 done", || async {
            list_completed(&pool, Some(&ViewScope::Inbox), None, None, 50)
                .await
                .map_err(classify)
        })
        .await?,
    );
    let top: Vec<String> = list_view(&pool, &inbox(ViewSort::Manual), None, 2)
        .await
        .map_err(classify)?
        .rows
        .into_iter()
        .map(|p| p.id)
        .collect();
    if let [first, second] = top.as_slice() {
        let turn = std::cell::Cell::new(0usize);
        timings.push(
            time_it(runs, "view move a page", || {
                let (moved, onto) = if turn.get().is_multiple_of(2) {
                    (second.clone(), first.clone())
                } else {
                    (first.clone(), second.clone())
                };
                turn.set(turn.get() + 1);
                let pool = &pool;
                async move {
                    let place = Placement {
                        after: None,
                        before: Some(onto),
                    };
                    move_pages(pool, &[moved], &place).await.map_err(classify)
                }
            })
            .await?,
        );
    }
    let today = chrono::Local::now().date_naive();
    timings.push(
        time_it(runs, "read sidebar counts", || async {
            count_views(&pool, &zone, today).await.map_err(classify)
        })
        .await?,
    );
    let week_start = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let week_end = (chrono::Utc::now() + chrono::Duration::days(7))
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string();
    timings.push(
        time_it(runs, "read a calendar week", || async {
            list_range(&pool, Some(&week_start), &week_end, &zone, false)
                .await
                .map_err(classify)
        })
        .await?,
    );
    let tomorrow = (chrono::Utc::now() + chrono::Duration::days(1))
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string();
    timings.push(
        time_it(runs, "read Today's whole range", || async {
            list_range(&pool, None, &tomorrow, &zone, true)
                .await
                .map_err(classify)
        })
        .await?,
    );
    for (name, from, until) in [
        ("read Overdue's first 50", None, today),
        (
            "read Today's first 50",
            Some(today),
            today + chrono::Days::new(1),
        ),
    ] {
        let key = ViewKey {
            scope: ViewScope::Everywhere,
            sort: ViewSort::Date,
            zone: zone.clone(),
            dates: Some(DateBounds { from, until }),
        };
        timings.push(
            time_it(runs, name, || async {
                list_view(&pool, &key, None, 50).await.map_err(classify)
            })
            .await?,
        );
    }
    timings.push(
        time_it(runs, "read series heads", || async {
            list_series_heads(&pool, true).await.map_err(classify)
        })
        .await?,
    );
    // What the app reads at launch besides the list on screen.
    timings.push(
        time_it(runs, "launch: recompute recurring schedules", || async {
            pikos_db::recompute_recurring_schedules_impl(&pool).await.map_err(classify)
        })
        .await?,
    );
    timings.push(
        time_it(runs, "launch: read recurrence rules", || async {
            pikos_db::list_recurrence_rules_impl(&pool).await.map_err(classify)
        })
        .await?,
    );
    timings.push(
        time_it(runs, "launch: read folders", || async {
            pikos_db::list_folders_impl(&pool).await.map_err(classify)
        })
        .await?,
    );
    timings.push(
        time_it(runs, "read 10 recents", || async {
            list_recent_pages(&pool, None, 10).await.map_err(classify)
        })
        .await?,
    );
    timings.push(
        time_it(runs, "read tags", || async {
            list_tags(&pool).await.map_err(classify)
        })
        .await?,
    );
    let some: Vec<String> = page_ids.iter().take(50).cloned().collect();
    timings.push(
        time_it(runs, "read 50 pages by id", || async {
            get_pages(&pool, &some).await.map_err(classify)
        })
        .await?,
    );
    timings.push(
        time_it(runs, "read a page if newer", || async {
            get_page_if_newer(&pool, &some[0], Some(i64::MAX))
                .await
                .map_err(classify)
        })
        .await?,
    );
    timings.push(
        time_it(runs, "view ids, all of Inbox", || async {
            list_view_ids(&pool, &inbox(ViewSort::Manual), None, None)
                .await
                .map_err(classify)
        })
        .await?,
    );

    timings.push(
        time_it(runs, "list 50 pages", || async {
            list_pages(
                &pool,
                ListQuery {
                    limit: Some(50),
                    ..Default::default()
                },
            )
            .await
        })
        .await?,
    );
    timings.push(
        time_it(runs, "load open pages (app)", || async {
            list_pages_impl(
                &pool,
                Some(PageFilter {
                    status: Some("not_started".into()),
                    ..Default::default()
                }),
            )
            .await
            .map_err(classify)
        })
        .await?,
    );
    timings.push(
        time_it(runs, "search one word", || async {
            search(&pool, "quarterly", false, Some(50), DEFAULT_SEARCH_SCAN).await
        })
        .await?,
    );
    timings.push(
        time_it(runs, "search one word, exact", || async {
            search(&pool, "quarterly", false, Some(50), SearchScan::All).await
        })
        .await?,
    );
    timings.push(
        time_it(runs, "search a rare word", || async {
            search(&pool, RARE_WORD, false, Some(50), DEFAULT_SEARCH_SCAN).await
        })
        .await?,
    );
    timings.push(
        time_it(runs, "search two words", || async {
            search(&pool, "budget review", false, Some(50), DEFAULT_SEARCH_SCAN).await
        })
        .await?,
    );

    timings.retain(|t| !t.samples.is_empty());
    if json {
        crate::render::print_json(&json!({
            "pages": total,
            "runs": runs,
            "timings": timings.iter().map(|t| json!({
                "op": t.name,
                "ms": t.percentile(0.5),
                "p95_ms": t.percentile(0.95),
                "p99_ms": t.percentile(0.99),
                "min_ms": t.samples[0],
                "max_ms": t.samples[t.samples.len() - 1],
                "runs": t.samples.len(),
            })).collect::<Vec<_>>(),
        }));
    } else {
        println!("{total} pages in {path}, median of {runs} run(s)\n");
        if runs > 1 {
            println!("  {:<24} {:>8} {:>8}", "", "median", "p95");
        }
        for t in &timings {
            if runs > 1 {
                println!(
                    "  {:<24} {:>8.2} {:>8.2}",
                    t.name,
                    t.percentile(0.5),
                    t.percentile(0.95)
                );
            } else {
                println!("  {:<24} {:>8.2}", t.name, t.percentile(0.5));
            }
        }
    }
    Ok(())
}
