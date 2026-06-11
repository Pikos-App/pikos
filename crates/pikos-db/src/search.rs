use serde::Serialize;

use crate::error::AppResult;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub results: Vec<SearchResult>,
    /// Number of completed pages matching the query (always counted, even when excluded).
    pub completed_count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub id: String,
    pub title: String,
    pub excerpt: String,
    pub match_source: String,
    pub status: String,
    pub subtitle: Option<String>,
    pub scheduled_date: Option<String>,
    pub priority: i32,
    pub tags: Vec<String>,
    /// First ~80 chars of body content — used as fallback line 2 when no metadata exists
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
/// All indexing is char-based to avoid panics on multi-byte UTF-8.
fn build_excerpt(
    content_text: Option<&str>,
    title: &str,
    subtitle: Option<&str>,
    tokens: &[String],
) -> String {
    let body = strip_title_subtitle(content_text, title, subtitle);
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
            // Determine start/end in char indices, then snap to word boundaries
            let start_char = if pos > half {
                let target = pos - half;
                let target_byte = char_to_byte(body, target);
                body[target_byte..]
                    .find(char::is_whitespace)
                    .map(|b| body[..target_byte + b].chars().count() + 1)
                    .unwrap_or(target)
            } else {
                0
            };
            let end_char = if pos + half < body_char_count {
                let target = pos + half;
                let target_byte = char_to_byte(body, target);
                body[..target_byte]
                    .rfind(char::is_whitespace)
                    .map(|b| body[..b].chars().count())
                    .unwrap_or(target)
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
        None => {
            // No token found in body — match was in title/subtitle/tags only.
            String::new()
        }
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

/// Unified search: queries all FTS5 columns with bm25() weighting so title
/// matches rank above content matches. Supports prefix matching on the last
/// token (e.g. "morn" → "morning"). Returns up to 20 results with plain text
/// excerpts (no HTML markup — frontend handles highlighting).
pub async fn search_pages_impl(
    pool: &sqlx::SqlitePool,
    query: String,
    include_completed: Option<bool>,
) -> AppResult<SearchResponse> {
    let include_completed = include_completed.unwrap_or(false);
    let q = query.trim();
    if q.is_empty() {
        return Ok(SearchResponse {
            results: vec![],
            completed_count: 0,
        });
    }

    // Sanitize and build FTS5 prefix query.
    // Split each whitespace-separated word into runs of alphanumeric chars;
    // any other character (hyphen, apostrophe, paren, etc.) is treated as a
    // token separator. This matches what FTS5's default unicode61 tokenizer
    // does when indexing, so a query for "multi-color" finds the same docs as
    // "multi color". Critically, it also prevents FTS5 from interpreting `-`
    // as a NOT operator / column qualifier (e.g. `multi-color` → "no such
    // column: color") or `'` as a phrase delimiter (`don't` → syntax error).
    // The last token gets a trailing `*` for prefix matching.
    let tokens: Vec<String> = q
        .split_whitespace()
        .flat_map(|word| {
            word.split(|c: char| !c.is_alphanumeric())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
        })
        .collect();

    if tokens.is_empty() {
        return Ok(SearchResponse {
            results: vec![],
            completed_count: 0,
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

    // bm25() weights: title=10, subtitle=5, content_text=1, tags=3
    // Fetch raw content_text — excerpt is built in Rust for accurate windowing
    // deleted_at IS NULL is unconditional — trashed pages never appear in search.
    // When include_completed is false, completed pages are excluded entirely.
    // When true, they sort last and secondary sort is updated_at DESC (works for
    // both notes and tasks).
    let sql = if include_completed {
        "SELECT pages.id, pages.title, pages.subtitle, pages.content_text,
                pages.status, pages.scheduled_start, pages.priority, pages.tags
         FROM pages_fts
         JOIN pages ON pages.rowid = pages_fts.rowid
         WHERE pages_fts MATCH ?1
           AND pages.deleted_at IS NULL
         ORDER BY bm25(pages_fts, 10.0, 5.0, 1.0, 3.0),
                  CASE WHEN pages.status = 'done' THEN 1 ELSE 0 END,
                  pages.updated_at DESC
         LIMIT 20"
    } else {
        "SELECT pages.id, pages.title, pages.subtitle, pages.content_text,
                pages.status, pages.scheduled_start, pages.priority, pages.tags
         FROM pages_fts
         JOIN pages ON pages.rowid = pages_fts.rowid
         WHERE pages_fts MATCH ?1
           AND pages.deleted_at IS NULL
           AND pages.status != 'done'
         ORDER BY bm25(pages_fts, 10.0, 5.0, 1.0, 3.0),
                  pages.updated_at DESC
         LIMIT 20"
    };

    // Count completed matches (always, regardless of include_completed flag).
    // Uses the same FTS index — fast single-pass count.
    let completed_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pages_fts
         JOIN pages ON pages.rowid = pages_fts.rowid
         WHERE pages_fts MATCH ?1
           AND pages.deleted_at IS NULL
           AND pages.status = 'done'",
    )
    .bind(&fts_query)
    .fetch_one(pool)
    .await?;

    let rows = sqlx::query_as::<_, SearchRow>(sql)
        .bind(&fts_query)
        .fetch_all(pool)
        .await?;

    let results = rows
        .into_iter()
        .map(|row| {
            let excerpt = build_excerpt(
                row.content_text.as_deref(),
                &row.title,
                row.subtitle.as_deref(),
                &tokens,
            );

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
    })
}

#[cfg(test)]
#[path = "search_tests.rs"]
mod search_tests;
