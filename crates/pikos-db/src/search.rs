use serde::Serialize;

use crate::error::AppResult;

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields = nullable)]
pub struct SearchResponse {
    pub results: Vec<SearchResult>,
    /// Number of completed pages matching the query (always counted, even when excluded).
    #[ts(type = "number")]
    pub completed_count: i64,
    /// The query matched more pages than the search scanned, so `completed_count` counts only the
    /// scanned ones and the real number may be higher.
    pub completed_count_capped: bool,
}

/// How many of a query's matches search scores before ranking them.
///
/// Ranking has to score every match, and nothing in the full-text index keeps matches in score
/// order, so an exact top twenty for a word in most pages costs time in proportion to the
/// workspace. Scanning a fixed number of the newest matches keeps it flat. A query with no more
/// matches than the scan ranks exactly as before; past it, see [`search_pages_scan`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchScan {
    /// Score at most this many of the newest matches, and as many of the newest title matches.
    Newest(usize),
    /// Score every match. Exact, and linear in the number of matches.
    All,
}

/// The scan the app searches with.
pub const DEFAULT_SEARCH_SCAN: SearchScan = SearchScan::Newest(2_000);

/// bm25() weights, in `pages_fts` column order: title, subtitle, content_text, tags,
/// mirror_search_text.
const BM25: &str = "bm25(pages_fts, 10.0, 5.0, 1.0, 3.0, 3.0)";
/// [`SearchRow`]'s columns. The capped query aliases its ranked rows as `pages` to reuse them.
const SEARCH_COLUMNS: &str = "pages.id, pages.title, pages.subtitle, pages.content_text,
     pages.status, pages.scheduled_start, pages.priority, pages.tags, pages.mirror_search_text";
const RESULT_LIMIT: i64 = 20;

#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields = nullable)]
pub struct SearchResult {
    pub id: String,
    pub title: String,
    pub excerpt: String,
    #[ts(type = "'title' | 'content' | 'subtitle' | 'both'")]
    pub match_source: String,
    #[ts(type = "'not_started' | 'done'")]
    pub status: String,
    pub subtitle: Option<String>,
    pub scheduled_date: Option<String>,
    #[ts(type = "0 | 1 | 2 | 3 | 4")]
    pub priority: i32,
    pub tags: Vec<String>,
    /// First ~80 characters of the body, shown when there's no other metadata to show.
    pub content_preview: String,
}

#[derive(Debug, sqlx::FromRow)]
struct SearchRow {
    id: String,
    title: String,
    subtitle: Option<String>,
    content_text: Option<String>,
    status: String,
    scheduled_start: Option<String>,
    priority: i32,
    tags: Option<String>,
    mirror_search_text: Option<String>,
}

fn char_to_byte(s: &str, char_idx: usize) -> usize {
    s.char_indices()
        .nth(char_idx)
        .map(|(b, _)| b)
        .unwrap_or(s.len())
}

/// Build an excerpt centered on the first occurrence of any search token.
/// Strips the title and subtitle from the beginning of content_text so the
/// excerpt only shows body content.
fn build_excerpt(
    content_text: Option<&str>,
    title: &str,
    subtitle: Option<&str>,
    tokens: &[String],
) -> String {
    excerpt_around(
        &join_blocks(strip_title_subtitle(content_text, title, subtitle)),
        tokens,
    )
}

/// One block per line, rejoined so two of them do not read as one sentence.
///
/// `content_text` keeps the document's line breaks, and every reader renders the excerpt as HTML,
/// where a newline folds into a space: a hit at the end of "Measure the alcove" came out as
/// "the alcove Order the desktop top". Blank lines are dropped, or an empty paragraph leaves a
/// separator with nothing on either side of it.
fn join_blocks(body: &str) -> String {
    body.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" \u{00B7} ")
}

/// A mirror's calendar-owned metadata as the excerpt, for a hit that lands only
/// there — the room or an attendee. Fills the same `excerpt` rather than adding a
/// metadata arm to `match_source`, so the row's existing quote-and-highlight path
/// renders it unchanged; an empty excerpt leaves the row showing the page's date,
/// which names nothing the query asked for.
///
/// The stored blob is newline-joined (`mirror_search_text`, reconciler.rs) and the
/// row is one truncated line, so the parts are rejoined for display.
fn build_mirror_excerpt(mirror_search_text: Option<&str>, tokens: &[String]) -> String {
    let Some(text) = mirror_search_text else {
        return String::new();
    };
    excerpt_around(&join_blocks(text), tokens)
}

/// Char index of the first whitespace at or after `target`.
fn whitespace_at_or_after(body: &str, target: usize) -> Option<usize> {
    let target_byte = char_to_byte(body, target);
    body[target_byte..]
        .find(char::is_whitespace)
        .map(|b| body[..target_byte + b].chars().count())
}

/// Char index of the last whitespace before `target`.
fn whitespace_before(body: &str, target: usize) -> Option<usize> {
    let target_byte = char_to_byte(body, target);
    body[..target_byte]
        .rfind(char::is_whitespace)
        .map(|b| body[..b].chars().count())
}

/// Window `body` around the first occurrence of any token, snapped to word
/// boundaries and elided at both cut edges. Empty when no token is present.
/// All indexing is char-based to avoid panics on multi-byte UTF-8.
///
/// Each edge snaps *outward*, to the edge of whatever word it lands in, so the
/// window can only ever grow to a whole word. Snapping inward instead reads as an
/// excerpt that starts mid-word — "r delivery" — which looks like corrupted data
/// rather than like the sentence it came from, and on a body with a long unbroken
/// run (a pasted URL) it has no boundary to move to at all. Growing outward also
/// keeps the match inside the window by construction, where an inward snap on a
/// body with one space could close the window past it and lose the match.
/// `max_chars` is therefore a target, not a bound.
fn excerpt_around(body: &str, tokens: &[String]) -> String {
    if body.is_empty() {
        return String::new();
    }

    let body_lower = body.to_lowercase();
    let match_char_pos = tokens
        .iter()
        .filter_map(|t| {
            let t_lower = t.to_lowercase();
            body_lower.find(&t_lower).map(|byte_pos| {
                // Convert byte offset in lowercased string to char offset
                body_lower[..byte_pos].chars().count()
            })
        })
        .min();

    let max_chars: usize = 120;
    let body_char_count = body.chars().count();

    match match_char_pos {
        Some(pos) => {
            let half = max_chars / 2;
            let start_char = if pos > half {
                whitespace_before(body, pos - half)
                    .map(|w| w + 1)
                    .unwrap_or(0)
            } else {
                0
            };
            let end_char = if pos + half < body_char_count {
                whitespace_at_or_after(body, pos + half).unwrap_or(body_char_count)
            } else {
                body_char_count
            };

            let start_byte = char_to_byte(body, start_char);
            let end_byte = char_to_byte(body, end_char);
            let slice = body[start_byte..end_byte].trim();
            let prefix = if start_char > 0 { "\u{2026}" } else { "" };
            let suffix = if end_char < body_char_count {
                "\u{2026}"
            } else {
                ""
            };
            format!("{prefix}{slice}{suffix}")
        }
        None => String::new(),
    }
}

/// Extract first ~80 chars of body content as a preview, breaking at word boundary.
/// All indexing is char-based to avoid panics on multi-byte UTF-8.
fn build_content_preview(
    content_text: Option<&str>,
    title: &str,
    subtitle: Option<&str>,
) -> String {
    let body = strip_title_subtitle(content_text, title, subtitle);
    if body.is_empty() {
        return String::new();
    }

    let first_line = body.split('\n').next().unwrap_or(body).trim();
    let char_count = first_line.chars().count();
    if char_count <= 80 {
        first_line.to_string()
    } else {
        let truncate_byte = char_to_byte(first_line, 80);
        let truncated = &first_line[..truncate_byte];
        let end = truncated
            .rfind(char::is_whitespace)
            .unwrap_or(truncate_byte);
        format!("{}\u{2026}", first_line[..end].trim())
    }
}

/// Strip title and subtitle from the beginning of content_text, returning
/// just the body portion.
fn strip_title_subtitle<'a>(
    content_text: Option<&'a str>,
    title: &str,
    subtitle: Option<&str>,
) -> &'a str {
    let raw = match content_text {
        Some(t) if !t.is_empty() => t,
        _ => return "",
    };

    let mut body = raw;
    let trimmed = body.trim_start();
    if let Some(rest) = strip_prefix_ci(trimmed, title) {
        body = rest.trim_start_matches('\n').trim_start();
    }
    if let Some(sub) = subtitle {
        let trimmed = body.trim_start();
        if let Some(rest) = strip_prefix_ci(trimmed, sub) {
            body = rest.trim_start_matches('\n').trim_start();
        }
    }
    body
}

/// Case-insensitive prefix strip. Returns the remainder if `text` starts with `prefix`.
/// Uses char-based comparison to handle multi-byte UTF-8 safely.
fn strip_prefix_ci<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let prefix_chars: usize = prefix.chars().count();
    let text_prefix: String = text.chars().take(prefix_chars).collect();
    if text_prefix.len() >= prefix.len() && text_prefix.eq_ignore_ascii_case(prefix) {
        // Advance past the matched prefix using the byte length of the chars we consumed
        let byte_len: usize = text
            .char_indices()
            .nth(prefix_chars)
            .map(|(b, _)| b)
            .unwrap_or(text.len());
        Some(&text[byte_len..])
    } else {
        None
    }
}

/// Split a query into runs of alphanumeric chars, every other character a separator.
///
/// This is FTS5's default `unicode61` tokenizer, reproduced — the index is the
/// authority, not this function, so a query for "multi-color" finds the same rows as
/// "multi color". It also keeps FTS5 from reading `-` as a NOT operator or column
/// qualifier (`multi-color` → "no such column: color") and `'` as a phrase delimiter
/// (`don't` → syntax error). The highlighter mirrors it through `ftsTokens`; both
/// answer to `tests/fixtures/search-tokenization.json`.
pub fn fts_tokens(query: &str) -> Vec<String> {
    query
        .split_whitespace()
        .flat_map(|word| {
            word.split(|c: char| !c.is_alphanumeric())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
        })
        .collect()
}

/// Unified search: queries all FTS5 columns with bm25() weighting so title
/// matches rank above content matches. Supports prefix matching on the last
/// token (e.g. "morn" → "morning"). Returns up to 20 results with plain text
/// excerpts (no HTML markup — frontend handles highlighting).
pub async fn search_pages_impl(
    pool: &sqlx::SqlitePool,
    query: String,
    include_completed: Option<bool>,
) -> AppResult<SearchResponse> {
    search_pages_scan(pool, query, include_completed, DEFAULT_SEARCH_SCAN).await
}

/// [`search_pages_impl`] with the scan chosen by the caller.
///
/// Past the scan, two capped streams are scored: the newest matches, and the newest matches in
/// the title or subtitle. Their bm25 scores aren't comparable, because each query weighs its terms
/// by its own match count, so the title stream ranks first and the rest follow, each by its own
/// score. That is close to exact ranking anyway, since a title hit weighs ten times a body hit.
/// Rejected: scoring the capped candidates in one query by rowid, which makes FTS5 rebuild the
/// whole match list per candidate (35 s at 200,000 pages). When completed pages are excluded and
/// most scanned matches are done, fewer than twenty results come back though older open
/// matches exist.
pub async fn search_pages_scan(
    pool: &sqlx::SqlitePool,
    query: String,
    include_completed: Option<bool>,
    scan: SearchScan,
) -> AppResult<SearchResponse> {
    let include_completed = include_completed.unwrap_or(false);
    let q = query.trim();
    let tokens = fts_tokens(q);
    if tokens.is_empty() {
        return Ok(SearchResponse {
            results: vec![],
            completed_count: 0,
            completed_count_capped: false,
        });
    }

    let fts_query: String = tokens
        .iter()
        .enumerate()
        .map(|(i, t)| {
            if i == tokens.len() - 1 {
                format!("{t}*")
            } else {
                t.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ");

    let cap = match scan {
        SearchScan::Newest(n) if matches_more_than(pool, &fts_query, n).await? => {
            i64::try_from(n).ok()
        }
        _ => None,
    };

    // deleted_at IS NULL is unconditional — trashed pages never appear in search.
    // When include_completed is false, completed pages are excluded entirely.
    // When true, they sort last and secondary sort is updated_at DESC (works for
    // both notes and tasks).
    let status_filter = if include_completed {
        ""
    } else {
        "AND pages.status != 'done'"
    };
    let done_last = if include_completed {
        "CASE WHEN pages.status = 'done' THEN 1 ELSE 0 END,"
    } else {
        ""
    };

    let (rows, completed_count) = match cap {
        None => {
            let sql = format!(
                "SELECT {SEARCH_COLUMNS}
                 FROM pages_fts
                 JOIN pages ON pages.rowid = pages_fts.rowid
                 WHERE pages_fts MATCH ?1
                   AND pages.deleted_at IS NULL
                   {status_filter}
                 ORDER BY {BM25}, {done_last} pages.updated_at DESC
                 LIMIT {RESULT_LIMIT}"
            );
            let rows = sqlx::query_as::<_, SearchRow>(&sql) // sql-ok: fragments are compile-time constants
                .bind(&fts_query)
                .fetch_all(pool)
                .await?;
            let completed: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM pages_fts
                 JOIN pages ON pages.rowid = pages_fts.rowid
                 WHERE pages_fts MATCH ?1
                   AND pages.deleted_at IS NULL
                   AND pages.status = 'done'",
            )
            .bind(&fts_query)
            .fetch_one(pool)
            .await?;
            (rows, completed)
        }
        Some(n) => capped_search(pool, &fts_query, n, include_completed).await?,
    };

    let results = rows
        .into_iter()
        .map(|row| {
            let body_excerpt = build_excerpt(
                row.content_text.as_deref(),
                &row.title,
                row.subtitle.as_deref(),
                &tokens,
            );
            let excerpt = if body_excerpt.is_empty() {
                build_mirror_excerpt(row.mirror_search_text.as_deref(), &tokens)
            } else {
                body_excerpt
            };

            let title_lower = row.title.to_lowercase();
            let title_hit = tokens
                .iter()
                .any(|t| title_lower.contains(&t.to_lowercase()));
            let subtitle_hit = row
                .subtitle
                .as_deref()
                .map(|s| {
                    let s_lower = s.to_lowercase();
                    tokens.iter().any(|t| s_lower.contains(&t.to_lowercase()))
                })
                .unwrap_or(false);
            let content_hit = !excerpt.is_empty();
            let match_source = match (title_hit, subtitle_hit, content_hit) {
                (true, _, true) => "both",
                (true, _, false) => "title",
                (_, true, _) => "subtitle",
                _ => "content",
            }
            .to_string();

            let tags: Vec<String> = row
                .tags
                .as_deref()
                .and_then(|t| serde_json::from_str(t).ok())
                .unwrap_or_default();

            let content_preview = build_content_preview(
                row.content_text.as_deref(),
                &row.title,
                row.subtitle.as_deref(),
            );

            SearchResult {
                id: row.id,
                title: row.title,
                excerpt,
                match_source,
                status: row.status,
                subtitle: row.subtitle,
                scheduled_date: row.scheduled_start,
                priority: row.priority,
                tags,
                content_preview,
            }
        })
        .collect();

    Ok(SearchResponse {
        results,
        completed_count,
        completed_count_capped: cap.is_some(),
    })
}

/// Whether `fts_query` matches more than `n` pages, reading at most `n + 1` index entries and
/// scoring none.
async fn matches_more_than(pool: &sqlx::SqlitePool, fts_query: &str, n: usize) -> AppResult<bool> {
    let probe = i64::try_from(n).unwrap_or(i64::MAX - 1) + 1;
    let found: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM (SELECT 1 FROM pages_fts WHERE pages_fts MATCH ?1 LIMIT ?2)",
    )
    .bind(fts_query)
    .bind(probe)
    .fetch_one(pool)
    .await?;
    Ok(found >= probe)
}

/// A ranked match, with the completed count the query computes once beside every row.
#[derive(Debug, sqlx::FromRow)]
struct RankedRow {
    #[sqlx(flatten)]
    row: SearchRow,
    completed_count: i64,
}

/// The ranking [`search_pages_scan`] describes past the scan, as one statement so each capped
/// stream is built once. A prefix term makes FTS5 assemble the term's whole match list before it
/// can stream it newest-first, and that assembly is most of the cost at size. Completed pages
/// are excluded by sorting them after every open one and dropping them here, so the count still
/// arrives when no open page matched.
async fn capped_search(
    pool: &sqlx::SqlitePool,
    fts_query: &str,
    cap: i64,
    include_completed: bool,
) -> AppResult<(Vec<SearchRow>, i64)> {
    let (done_first, done_last) = if include_completed {
        ("", "CASE WHEN pages.status = 'done' THEN 1 ELSE 0 END,")
    } else {
        ("CASE WHEN pages.status = 'done' THEN 1 ELSE 0 END,", "")
    };
    let sql = format!(
        "WITH body AS MATERIALIZED (
             SELECT pages_fts.rowid AS r, {BM25} AS score FROM pages_fts
             WHERE pages_fts MATCH ?1 ORDER BY pages_fts.rowid DESC LIMIT ?3),
         titled AS MATERIALIZED (
             SELECT pages_fts.rowid AS r, {BM25} AS score FROM pages_fts
             WHERE pages_fts MATCH ?2 ORDER BY pages_fts.rowid DESC LIMIT ?3),
         candidates AS (
             SELECT r, 0 AS tier, score FROM titled
             UNION ALL
             SELECT r, 1 AS tier, score FROM body WHERE r NOT IN (SELECT r FROM titled)),
         live AS (
             SELECT candidates.tier, candidates.score, pages.*
             FROM candidates JOIN pages ON pages.rowid = candidates.r
             WHERE pages.deleted_at IS NULL)
         SELECT {SEARCH_COLUMNS},
                (SELECT COUNT(*) FROM live WHERE status = 'done') AS completed_count
         FROM live AS pages
         ORDER BY {done_first} pages.tier, pages.score, {done_last} pages.updated_at DESC
         LIMIT {RESULT_LIMIT}"
    );
    let ranked = sqlx::query_as::<_, RankedRow>(&sql) // sql-ok: fragments are compile-time constants
        .bind(fts_query)
        .bind(format!("{{title subtitle}}: ({fts_query})"))
        .bind(cap)
        .fetch_all(pool)
        .await?;
    let completed = ranked.first().map_or(0, |r| r.completed_count);
    let rows = ranked
        .into_iter()
        .map(|r| r.row)
        .filter(|row| include_completed || row.status != "done")
        .collect();
    Ok((rows, completed))
}

#[cfg(test)]
#[path = "search_tests.rs"]
mod search_tests;
