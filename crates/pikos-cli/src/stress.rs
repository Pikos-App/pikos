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

use pikos_db::{create_page_impl, get_page, open_pool, update_page_impl, PageUpdate};
use serde_json::json;

use crate::error::{classify, CliError};
use crate::ops::{list_pages, search, ListQuery};
use crate::workspace::resolve_db_path;
use crate::write::base_page;

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

pub async fn seed(
    db: &Option<String>,
    pages: usize,
    large_pages: usize,
    large_words: usize,
    json: bool,
) -> Result<(), CliError> {
    let path = require_scratch_db(db)?;
    let pool = open_pool(&path).await.map_err(classify)?;

    let mut rng = Rng(0x5EED_1234_ABCD_0001);
    let started = Instant::now();

    for i in 0..pages {
        let title = format!("{} {}", sentence(&mut rng, 4), i);
        let body = sentence(&mut rng, 40);
        let mut page = base_page(None, title);
        page.content = body.clone();
        page.content_text = Some(body);
        create_page_impl(&pool, page).await.map_err(classify)?;

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
        page.content = body.clone();
        page.content_text = Some(body);
        create_page_impl(&pool, page).await.map_err(classify)?;
    }

    for i in 0..large_pages {
        let title = format!("large document {i}");
        let body = sentence(&mut rng, large_words);
        let mut page = base_page(None, title);
        page.content = body.clone();
        page.content_text = Some(body);
        create_page_impl(&pool, page).await.map_err(classify)?;
    }

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
    millis: f64,
}

async fn time_it<F, Fut, T>(name: &'static str, f: F) -> Result<Timing, CliError>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<T, CliError>>,
{
    // Once to warm the page cache, then the measured run, so the number is steady-state rather
    // than whatever the filesystem happened to be doing.
    let _ = f().await?;
    let start = Instant::now();
    f().await?;
    Ok(Timing {
        name,
        millis: start.elapsed().as_secs_f64() * 1000.0,
    })
}

pub async fn bench(db: &Option<String>, json: bool) -> Result<(), CliError> {
    let path = require_scratch_db(db)?;

    let open_start = Instant::now();
    let pool = open_pool(&path).await.map_err(classify)?;
    let open_ms = open_start.elapsed().as_secs_f64() * 1000.0;

    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pages")
        .fetch_one(&pool)
        .await
        .map_err(|e| classify(e.into()))?;

    // A page to read and update, taken from the seeded set rather than created, so the reads are
    // against a row that has been sitting in the table rather than one still warm in the cache.
    let sample_id: String = sqlx::query_scalar("SELECT id FROM pages LIMIT 1")
        .fetch_one(&pool)
        .await
        .map_err(|e| classify(e.into()))?;

    let mut timings = vec![Timing {
        name: "open workspace",
        millis: open_ms,
    }];

    timings.push(
        time_it("create page", || async {
            let mut page = base_page(None, "benchmark page".to_string());
            page.content = "benchmark body".to_string();
            create_page_impl(&pool, page).await.map_err(classify)
        })
        .await?,
    );
    timings.push(
        time_it("read page", || async {
            get_page(&pool, &sample_id).await.map_err(classify)
        })
        .await?,
    );
    timings.push(
        time_it("update page", || async {
            update_page_impl(
                &pool,
                sample_id.clone(),
                PageUpdate {
                    title: Some("renamed".to_string()),
                    ..Default::default()
                },
            )
            .await
            .map_err(classify)
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
            time_it(name, || async {
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
            time_it(name, || async {
                update_page_impl(
                    &pool,
                    id.clone(),
                    PageUpdate {
                        content: Some(sentence(&mut Rng(7), 80)),
                        ..Default::default()
                    },
                )
                .await
                .map_err(classify)
            })
            .await?,
        );
    }

    timings.push(
        time_it("list 50 pages", || async {
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
        time_it("search one word", || async {
            search(&pool, "quarterly", false, Some(50)).await
        })
        .await?,
    );
    timings.push(
        time_it("search two words", || async {
            search(&pool, "budget review", false, Some(50)).await
        })
        .await?,
    );

    if json {
        crate::render::print_json(&json!({
            "pages": total,
            "timings": timings.iter().map(|t| json!({"op": t.name, "ms": t.millis})).collect::<Vec<_>>(),
        }));
    } else {
        println!("{total} pages in {path}\n");
        for t in &timings {
            println!("  {:<22} {:>8.2} ms", t.name, t.millis);
        }
    }
    Ok(())
}
