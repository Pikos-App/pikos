//! Title sort keys, so the database can order pages by title the way the app does: the same
//! leading-emoji strip as `stripLeadingEmoji` in `packages/core/src/utils/sort.ts`, then a
//! numeric, tertiary-strength collation in the system's language, which is what the webview's
//! `Intl.Collator(undefined, { numeric: true })` uses. Keys compare as bytes.

use std::sync::OnceLock;

use icu_collator::options::CollatorOptions;
use icu_collator::preferences::{CollationCaseFirst, CollationNumericOrdering};
use icu_collator::{Collator, CollatorBorrowed, CollatorPreferences};
use icu_locale_core::Locale;
use icu_properties::props::ExtendedPictographic;
use icu_properties::CodePointSetData;

/// Changes whenever a key for the same title could change: the collator's data (bump with
/// `icu_collator` in Cargo.toml) or the strip rule. Stored keys made under another version, or
/// another language, are recomputed.
const KEY_RULES: &str = "icu_collator-2.3/strip-1";

/// Whitespace as a JavaScript regex's `\s` matches it, which isn't Unicode's White_Space: it adds
/// U+FEFF and leaves out U+0085.
fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `stripLeadingEmoji`: drop leading pictographs, whitespace, zero-width joiners and variation
/// selectors.
pub fn strip_leading_emoji(title: &str) -> &str {
    let pictographic = CodePointSetData::new::<ExtendedPictographic>();
    let start = title
        .char_indices()
        .find(|&(_, c)| {
            !(pictographic.contains(c)
                || is_js_whitespace(c)
                || matches!(c, '\u{200D}' | '\u{FE0F}' | '\u{FE0E}'))
        })
        .map_or(title.len(), |(i, _)| i);
    &title[start..]
}

/// The app's collator for `locale`. WebKit sorts lowercase first in every language, Danish
/// included, where the locale data says uppercase first; the keys follow WebKit.
pub fn collator_for(locale: &Locale) -> CollatorBorrowed<'static> {
    let app_prefs = |mut prefs: CollatorPreferences| {
        prefs.numeric_ordering = Some(CollationNumericOrdering::True);
        prefs.case_first = Some(CollationCaseFirst::False);
        prefs
    };
    Collator::try_new(app_prefs(locale.into()), CollatorOptions::default())
        .or_else(|_| Collator::try_new(app_prefs(Default::default()), CollatorOptions::default()))
        .expect("the root collation is compiled in")
}

pub fn key_with(collator: &CollatorBorrowed<'_>, title: &str) -> Vec<u8> {
    let mut key = Vec::new();
    let Ok(()) = collator.write_sort_key_to(strip_leading_emoji(title), &mut key);
    key
}

/// The language the app's collator uses: the system's first preferred one.
pub fn system_locale() -> &'static Locale {
    static LOCALE: OnceLock<Locale> = OnceLock::new();
    LOCALE.get_or_init(|| {
        sys_locale::get_locale()
            .and_then(|tag| Locale::try_from_str(&tag.replace('_', "-")).ok())
            .unwrap_or(Locale::UNKNOWN)
    })
}

/// This process's key for a title.
pub fn title_key(title: &str) -> Vec<u8> {
    static COLLATOR: OnceLock<CollatorBorrowed<'static>> = OnceLock::new();
    key_with(
        COLLATOR.get_or_init(|| collator_for(system_locale())),
        title,
    )
}

/// What a stored key was made with, to tell whether it's still this process's.
pub fn key_version() -> String {
    format!("{KEY_RULES}/{}", system_locale())
}

/// Pages re-keyed per transaction, so a re-key never holds the write lock long enough to stall a
/// save.
const REKEY_BATCH: i64 = 2_000;

/// Re-key every page when the stored keys were made with other rules or another language, in
/// batches, and record this process's version when done. A process that stops partway leaves the
/// version as it was, so the next one starts over.
pub async fn rekey_if_stale(pool: &sqlx::SqlitePool) -> crate::error::AppResult<()> {
    let version = key_version();
    let stored: Option<String> =
        sqlx::query_scalar("SELECT version FROM title_key_version WHERE id = 1")
            .fetch_one(pool)
            .await?;
    if stored.as_deref() == Some(version.as_str()) {
        return Ok(());
    }
    let mut after: i64 = 0;
    loop {
        let last: Option<i64> = sqlx::query_scalar(
            "UPDATE pages SET title_key = pikos_title_key(title)
             WHERE rowid IN (SELECT rowid FROM pages WHERE rowid > ? ORDER BY rowid LIMIT ?)
             RETURNING rowid",
        )
        .bind(after)
        .bind(REKEY_BATCH)
        .fetch_all(pool)
        .await?
        .into_iter()
        .max();
        match last {
            Some(rowid) => after = rowid,
            None => break,
        }
    }
    sqlx::query("UPDATE title_key_version SET version = ? WHERE id = 1")
        .bind(&version)
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
#[path = "title_key_tests.rs"]
mod title_key_tests;
