//! Search operators — `tag:`, `folder:`, `is:`, `priority:`, `due:` — lifted out
//! of a query, leaving the free text behind.
//!
//! Ported from `@pikos/core`'s `nlp/searchQuery.ts` and graded against a corpus
//! generated from it (`tests/search_parity.rs`). Not part of [`crate::nlp`]
//! despite living beside it there: that module is the chrono-node port, and
//! this grammar is five keywords and a colon.
//!
//! The rule that shapes everything below is that **an operator the grammar does
//! not know stays in the text**. `ratio:1.5` is a search for "ratio:1.5", not a
//! search with a broken filter; `priority:9` is a search for "priority:9",
//! because 9 is not a priority. A parser that swallowed either would answer a
//! question nobody asked and give no sign it had.
//!
//! Building the storage filter from this is the caller's job. It needs to
//! resolve `folder:` against real folders, and that lives a layer down.

use chrono::{Duration, NaiveDateTime};
use fancy_regex::{Captures, Regex};
use std::sync::OnceLock;

use crate::dates::format_date_only;

/// What `is:done` / `is:open` narrowed to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SearchStatus {
    Done,
    NotStarted,
}

impl SearchStatus {
    /// The value as `pages.status` stores it, which is also what the corpus
    /// records.
    pub fn as_str(self) -> &'static str {
        match self {
            SearchStatus::Done => "done",
            SearchStatus::NotStarted => "not_started",
        }
    }
}

/// A query split into the operators it carried and the text around them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ParsedSearchQuery {
    /// Free text left after every recognised operator was lifted out.
    pub text: String,
    /// Every `tag:` value, in the order typed — matched conjunctively.
    pub tags: Vec<String>,
    /// Raw `folder:` value; the caller resolves it against real folders.
    pub folder: Option<String>,
    pub status: Option<SearchStatus>,
    /// From `is:scheduled`.
    pub scheduled: bool,
    /// 0 (none) … 4 (low). The quick-add parser's scale.
    pub priority: Option<i64>,
    /// Inclusive lower bound, `YYYY-MM-DD`.
    pub due_from: Option<String>,
    /// Inclusive upper bound, `YYYY-MM-DDT23:59:59` — the CLI's `parse_due`
    /// shape, so a timed page late on the last day is still inside the window.
    pub due_to: Option<String>,
    /// At least one operator was recognised and stripped. What tells a caller
    /// to take the structured path rather than plain full-text search.
    pub has_operators: bool,
}

/// `(^|\s)` anchors each operator to a word start, so `path/to:file` and an
/// `is:x` inside a longer token stay text. A value is either a quoted string
/// (spaces allowed) or a run of non-space characters.
fn operator_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?i)(^|\s)(tag|folder|is|priority|due):(?:"([^"]*)"|(\S+))"#)
            .expect("the operator pattern is a literal")
    })
}

/// Priority words and digits share the quick-add parser's scale: 1 = urgent …
/// 4 = low, 0 = none.
fn priority_value(word: &str) -> Option<i64> {
    match word {
        "0" | "none" => Some(0),
        "1" | "urgent" => Some(1),
        "2" | "high" => Some(2),
        "3" | "medium" => Some(3),
        "4" | "low" => Some(4),
        _ => None,
    }
}

/// True only for a real calendar date — `2026-02-31` matches the shape but is
/// not one.
fn is_real_date(iso: &str) -> bool {
    chrono::NaiveDate::parse_from_str(iso, "%Y-%m-%d").is_ok() && iso.len() == 10
}

fn day_offset(reference: NaiveDateTime, days: i64) -> String {
    format_date_only(&(reference + Duration::days(days)))
}

/// One `due:` endpoint → the day span it names, or `None` when it names
/// nothing.
fn resolve_due_endpoint(token: &str, reference: NaiveDateTime) -> Option<(String, String)> {
    let lower = token.to_lowercase();
    if is_real_date(&lower) {
        return Some((lower.clone(), lower));
    }
    let today = format_date_only(&reference);
    match lower.as_str() {
        "month" => Some((today, day_offset(reference, 29))),
        "today" => Some((today.clone(), today)),
        "tomorrow" => {
            let day = day_offset(reference, 1);
            Some((day.clone(), day))
        }
        "week" => Some((today, day_offset(reference, 6))),
        "yesterday" => {
            let day = day_offset(reference, -1);
            Some((day.clone(), day))
        }
        _ => None,
    }
}

/// A `due:` value: one endpoint, or an `a..b` range where either side may be
/// omitted for an open-ended bound.
///
/// `None` when any endpoint that *was* named fails to resolve, so the whole
/// token falls back to free text rather than silently applying half a window.
fn resolve_due(value: &str, reference: NaiveDateTime) -> Option<(Option<String>, Option<String>)> {
    if value.contains("..") {
        let parts: Vec<&str> = value.split("..").collect();
        if parts.len() != 2 {
            return None;
        }
        let (raw_from, raw_to) = (parts[0], parts[1]);
        let from = if raw_from.is_empty() {
            None
        } else {
            resolve_due_endpoint(raw_from, reference)
        };
        let to = if raw_to.is_empty() {
            None
        } else {
            resolve_due_endpoint(raw_to, reference)
        };
        if (!raw_from.is_empty() && from.is_none()) || (!raw_to.is_empty() && to.is_none()) {
            return None;
        }
        if from.is_none() && to.is_none() {
            return None;
        }
        return Some((from.map(|(f, _)| f), to.map(|(_, t)| t)));
    }
    resolve_due_endpoint(value, reference).map(|(from, to)| (Some(from), Some(to)))
}

/// Split a query into its operators plus the free text around them.
///
/// `reference` is what `due:today` is read against — injectable so the whole
/// thing is testable, and so the corpus can pin it.
pub fn parse_search_query(raw: &str, reference: NaiveDateTime) -> ParsedSearchQuery {
    let mut parsed = ParsedSearchQuery::default();

    // Hand-rolled rather than `Regex::replace_all`, because the replacement
    // both writes to `parsed` and decides — per match — whether to strip the
    // token at all. Matching JavaScript's global replace exactly: non-
    // overlapping, left to right, resuming at the end of the previous match.
    let mut stripped = String::with_capacity(raw.len());
    let mut cursor = 0usize;
    for captures in operator_re().captures_iter(raw) {
        let Ok(captures) = captures else { break };
        let whole = captures.get(0).expect("group 0 always matches");
        if whole.start() < cursor {
            continue;
        }
        stripped.push_str(&raw[cursor..whole.start()]);
        cursor = whole.end();

        let lead = group(&captures, 1);
        let key = group(&captures, 2).to_lowercase();
        // A quoted empty value (`tag:""`) names nothing and is left alone.
        let value = captures
            .get(3)
            .or_else(|| captures.get(4))
            .map(|m| m.as_str().trim())
            .unwrap_or_default();
        if value.is_empty() {
            stripped.push_str(whole.as_str());
            continue;
        }

        let recognised = apply(&mut parsed, &key, value, reference);
        if recognised {
            parsed.has_operators = true;
            // Keep the boundary character, so the words either side of a
            // stripped operator do not run together. Defensive rather than
            // load-bearing, and the corpus says so: mutating this line away
            // changes no case, because the whitespace run *after* an operator
            // is never part of its match and the final normalisation collapses
            // what is left. It stays because the reference has it, and because
            // the property it protects is one a future change to the pattern
            // could quietly take away.
            stripped.push_str(lead);
        } else {
            stripped.push_str(whole.as_str());
        }
    }
    stripped.push_str(&raw[cursor..]);

    parsed.text = stripped.split_whitespace().collect::<Vec<_>>().join(" ");
    parsed
}

/// One recognised operator applied. `false` leaves the token in the text.
fn apply(parsed: &mut ParsedSearchQuery, key: &str, value: &str, reference: NaiveDateTime) -> bool {
    match key {
        "due" => match resolve_due(value, reference) {
            Some((from, to)) => {
                parsed.due_from = from;
                parsed.due_to = to.map(|day| format!("{day}T23:59:59"));
                true
            }
            None => false,
        },
        // Last wins, mirroring the quick-add parser's `~folder`.
        "folder" => {
            parsed.folder = Some(value.to_string());
            true
        }
        "is" => match value.to_lowercase().as_str() {
            "done" => {
                parsed.status = Some(SearchStatus::Done);
                true
            }
            "open" => {
                parsed.status = Some(SearchStatus::NotStarted);
                true
            }
            "scheduled" => {
                parsed.scheduled = true;
                true
            }
            _ => false,
        },
        "priority" => match priority_value(&value.to_lowercase()) {
            Some(priority) => {
                parsed.priority = Some(priority);
                true
            }
            None => false,
        },
        "tag" => {
            parsed.tags.push(value.to_string());
            true
        }
        _ => false,
    }
}

fn group<'t>(captures: &Captures<'t, str>, index: usize) -> &'t str {
    captures.get(index).map_or("", |m| m.as_str())
}
