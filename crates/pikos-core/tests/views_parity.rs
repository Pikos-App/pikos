//! Today and Upcoming, graded against the TypeScript they replace.
//!
//! `tests/corpus/views.json` is the output of `pageFilters.ts` and
//! `upcoming.ts` over one fixture set at each of the suite's seven reference
//! times — regenerate with `pnpm --filter @pikos/core gen:parity`. Each case
//! records three things: which view every page belongs to, the last day the
//! Upcoming window reaches, and the sections each view is actually built from.
//!
//! Grading the *sections* rather than only the predicates is the point. The
//! predicates are three string comparisons and would pass a port that had the
//! ordering entirely wrong; what a reader sees is the order, and two of its
//! rules are easy to get plausibly wrong. An all-day item dated today sorts at
//! the current moment rather than at midnight, so "sometime today" lands
//! between what has passed and what has not instead of at the top of the list.
//! And the sort is stable, so two pages sharing a moment keep the order the
//! user arranged them in rather than swapping on every redraw.
//!
//! The generator freezes the clock to capture any of this: the TypeScript reads
//! `new Date()` in three places and takes no reference parameter, which is also
//! why the Rust takes `today` and `now` as arguments instead of reading the
//! clock itself.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use chrono::NaiveDateTime;
use pikos_core::dates::parse_local_iso;
use pikos_core::views::{
    belongs_to_today, belongs_to_upcoming, group_today, group_upcoming, upcoming_window_end,
};
use serde::Deserialize;

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CorpusPage {
    id: String,
    #[serde(default)]
    scheduled_start: Option<String>,
    status: String,
}

#[derive(Debug, Deserialize)]
struct Membership {
    id: String,
    views: BTreeMap<String, bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TodayGroupsCase {
    ok: bool,
    #[serde(default)]
    overdue: Vec<String>,
    #[serde(default)]
    today: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct UpcomingDayCase {
    date: String,
    pages: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpcomingCase {
    ok: bool,
    #[serde(default)]
    days: Vec<UpcomingDayCase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Captured {
    ok: bool,
    #[serde(default)]
    value: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ViewCase {
    r#ref: String,
    today: String,
    window_end: Captured,
    membership: Vec<Membership>,
    today_groups: TodayGroupsCase,
    upcoming_days: UpcomingCase,
}

#[derive(Debug, Deserialize)]
struct ReferencePoint {
    id: String,
    iso: String,
}

#[derive(Debug, Deserialize)]
struct Meta {
    references: Vec<ReferencePoint>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Corpus {
    meta: Meta,
    pages: Vec<CorpusPage>,
    view_cases: Vec<ViewCase>,
}

fn load() -> Corpus {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/corpus/views.json");
    let raw = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "read {}: {e} — run `pnpm --filter @pikos/core gen:parity`",
            path.display()
        )
    });
    serde_json::from_str(&raw).expect("views.json parses")
}

/// The reference instant for a case, which is what the generator froze the
/// clock to.
fn now_for(corpus: &Corpus, case: &ViewCase) -> NaiveDateTime {
    let iso = &corpus
        .meta
        .references
        .iter()
        .find(|r| r.id == case.r#ref)
        .unwrap_or_else(|| panic!("no reference named {}", case.r#ref))
        .iso;
    parse_local_iso(iso).unwrap_or_else(|| panic!("reference {iso} parses"))
}

fn open_pages(corpus: &Corpus) -> Vec<CorpusPage> {
    corpus
        .pages
        .iter()
        .filter(|p| p.status != "done")
        .cloned()
        .collect()
}

fn start_of(page: &CorpusPage) -> Option<&str> {
    page.scheduled_start.as_deref()
}

#[test]
fn the_window_reaches_the_same_last_day() {
    let corpus = load();
    for case in &corpus.view_cases {
        assert!(case.window_end.ok, "the reference never throws here");
        assert_eq!(
            upcoming_window_end(&case.today),
            case.window_end.value,
            "window end at {}",
            case.r#ref
        );
    }
}

/// Membership for the two date views. The folder and inbox arms are the
/// TypeScript's alone — those are a SQL `WHERE` clause here, not a predicate —
/// so what is graded is `today` and `upcoming`.
#[test]
fn every_page_lands_in_the_same_date_views() {
    let corpus = load();
    let by_id: BTreeMap<&str, &CorpusPage> =
        corpus.pages.iter().map(|p| (p.id.as_str(), p)).collect();

    let mut checked = 0;
    for case in &corpus.view_cases {
        for entry in &case.membership {
            let page = by_id[entry.id.as_str()];
            assert_eq!(
                belongs_to_today(start_of(page), &case.today),
                entry.views["today"],
                "{} in Today at {}",
                entry.id,
                case.r#ref
            );
            assert_eq!(
                belongs_to_upcoming(start_of(page), &case.today),
                entry.views["upcoming"],
                "{} in Upcoming at {}",
                entry.id,
                case.r#ref
            );
            checked += 2;
        }
    }
    assert!(
        checked >= 100,
        "corpus looks truncated: {checked} assertions"
    );
}

/// Upcoming never shows anything that has already slipped.
///
/// Derived from the corpus as a property rather than read out of it. The upper
/// bound is arithmetic and obvious; the *lower* bound is the one carrying a
/// decision, and it is the half a port is likely to get wrong by reaching for
/// "everything from here on".
///
/// Note what this deliberately does **not** assert. A page dated today is in
/// both views at once, and the first draft of this test claimed it could not
/// be — the corpus disagreed, which is what a corpus is for. Today lists what
/// is due, Upcoming opens at today because a window starting tomorrow leaves a
/// reader wondering where today went. The overlap is one page answering two
/// different questions, not a page with two homes.
#[test]
fn upcoming_reaches_forward_only() {
    let corpus = load();
    let by_id: BTreeMap<&str, &CorpusPage> =
        corpus.pages.iter().map(|p| (p.id.as_str(), p)).collect();

    let mut overlapping = 0;
    for case in &corpus.view_cases {
        for entry in &case.membership {
            if !entry.views["upcoming"] {
                continue;
            }
            let page = by_id[entry.id.as_str()];
            let day = start_of(page).expect("an upcoming page has a schedule");
            assert!(
                &day[..case.today.len().min(day.len())] >= case.today.as_str(),
                "{} is before today at {}",
                entry.id,
                case.r#ref
            );
            if entry.views["today"] {
                overlapping += 1;
            }
        }
    }
    assert!(
        overlapping > 0,
        "the fixture should include a page dated today, which both views claim"
    );
}

#[test]
fn todays_sections_hold_the_same_pages_in_the_same_order() {
    let corpus = load();
    for case in &corpus.view_cases {
        assert!(case.today_groups.ok, "the reference never throws here");
        let now = now_for(&corpus, case);
        let listed: Vec<CorpusPage> = open_pages(&corpus)
            .into_iter()
            .filter(|p| belongs_to_today(start_of(p), &case.today))
            .collect();

        let groups = group_today(listed, &case.today, &now, start_of);
        let ids = |pages: &[CorpusPage]| pages.iter().map(|p| p.id.clone()).collect::<Vec<_>>();

        assert_eq!(
            ids(&groups.overdue),
            case.today_groups.overdue,
            "overdue at {}",
            case.r#ref
        );
        assert_eq!(
            ids(&groups.today),
            case.today_groups.today,
            "today at {}",
            case.r#ref
        );
    }
}

#[test]
fn upcoming_groups_the_same_days_holding_the_same_pages() {
    let corpus = load();
    for case in &corpus.view_cases {
        assert!(case.upcoming_days.ok, "the reference never throws here");
        let now = now_for(&corpus, case);
        let listed: Vec<CorpusPage> = open_pages(&corpus)
            .into_iter()
            .filter(|p| belongs_to_upcoming(start_of(p), &case.today))
            .collect();

        let days = group_upcoming(listed, &case.today, &now, start_of);
        let actual: Vec<(String, Vec<String>)> = days
            .into_iter()
            .map(|d| (d.date, d.pages.into_iter().map(|p| p.id).collect()))
            .collect();
        let expected: Vec<(String, Vec<String>)> = case
            .upcoming_days
            .days
            .iter()
            .map(|d| (d.date.clone(), d.pages.clone()))
            .collect();

        assert_eq!(actual, expected, "upcoming days at {}", case.r#ref);
    }
}

/// A corpus that never exercises the interesting cases would pass whatever the
/// port did. These are the three the ordering rules are about, asserted against
/// the fixture rather than assumed to be in it.
#[test]
fn the_corpus_reaches_the_cases_worth_grading() {
    let corpus = load();

    let sun_noon = corpus
        .view_cases
        .iter()
        .find(|c| c.r#ref == "sun_noon")
        .expect("the suite's primary reference is in the corpus");

    // An all-day item dated today, sorted against timed items on both sides of
    // the current moment — the rule that would look fine if it were wrong.
    let today_day = sun_noon
        .upcoming_days
        .days
        .iter()
        .find(|d| d.date == sun_noon.today)
        .expect("a day group for today");
    assert!(
        today_day.pages.len() >= 3,
        "today's group should hold items before and after the all-day one: {:?}",
        today_day.pages
    );

    // Two pages sharing a moment, which is what pins the sort's stability.
    let tie_day = sun_noon
        .upcoming_days
        .days
        .iter()
        .find(|d| d.pages.iter().any(|p| p == "v_tie_a"))
        .expect("the tied pair is in the window");
    let a = tie_day.pages.iter().position(|p| p == "v_tie_a");
    let b = tie_day.pages.iter().position(|p| p == "v_tie_b");
    assert!(
        a < b,
        "the tie keeps its arrival order: {:?}",
        tie_day.pages
    );

    // Both of Today's sections populated. A corpus where everything is overdue
    // grades only half the split.
    assert!(
        !sun_noon.today_groups.overdue.is_empty() && !sun_noon.today_groups.today.is_empty(),
        "both sections should be exercised"
    );

    // A finished page that would otherwise be in range, so "open only" is
    // actually tested rather than vacuously true.
    assert!(
        corpus.pages.iter().any(|p| p.status == "done"),
        "the fixture needs a completed page in range"
    );
}
