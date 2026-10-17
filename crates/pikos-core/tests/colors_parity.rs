//! The folder palette, graded against the design source of truth.
//!
//! `tests/corpus/colors.json` is `packages/core/src/constants/colors.ts`
//! written where a Rust test can read it — regenerate with
//! `pnpm --filter @pikos/core gen:parity`.
//!
//! Not a behaviour capture: a palette is a constant, and a constant copied by
//! hand into a second language is a constant that drifts. What this catches is
//! a colour added on one side and not the other, a hex typed a digit out, and —
//! the one worth naming — the *order* changing. The rows are not arbitrary:
//! the saturated eight are what a person picks for their own folders and the
//! pastel eight are where a synced calendar is mapped, so a shuffle that keeps
//! every value would still put an imported calendar in a colour that shouts.

use std::fs;
use std::path::PathBuf;

use pikos_core::colors::{default_color_for_provider, PALETTE_COLORS};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Entry {
    label: String,
    value: String,
}

#[derive(Debug, Deserialize)]
struct ProviderDefault {
    provider: String,
    color: String,
}

#[derive(Debug, Deserialize)]
struct Corpus {
    palette: Vec<Entry>,
    defaults: Vec<ProviderDefault>,
}

fn corpus() -> Corpus {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/corpus/colors.json");
    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&raw).expect("colors.json parses")
}

#[test]
fn the_palette_matches_the_reference_entry_for_entry_and_in_order() {
    let corpus = corpus();
    let ours: Vec<(&str, &str)> = PALETTE_COLORS.iter().map(|c| (c.label, c.value)).collect();
    let theirs: Vec<(&str, &str)> = corpus
        .palette
        .iter()
        .map(|c| (c.label.as_str(), c.value.as_str()))
        .collect();
    assert_eq!(ours, theirs);
}

#[test]
fn every_provider_default_is_a_colour_the_palette_actually_has() {
    let corpus = corpus();
    for entry in &corpus.defaults {
        assert_eq!(
            default_color_for_provider(&entry.provider),
            entry.color,
            "provider {}",
            entry.provider
        );
        // The fallback arm included: an unrecognised provider must land on a
        // real palette entry, or a calendar from one arrives with a colour no
        // picker can show and no picker can change.
        assert!(
            PALETTE_COLORS.iter().any(|c| c.value == entry.color),
            "{} maps to {}, which is not in the palette",
            entry.provider,
            entry.color
        );
    }
}

/// The two rows have to stay eight and eight.
///
/// `pikos-calendar-sync::palette::SYNCED_PALETTE` spells the pastel eight out
/// again as its own constant — it is what a provider's colour is mapped into,
/// and that crate does not depend on this one. Nothing makes the two agree, so
/// this pins the boundary: a colour added to the pastel row here that is not
/// added there is a colour the picker offers and re-discovery can never assign,
/// and this test is the only place that reads as a contradiction.
#[test]
fn the_palette_is_two_rows_of_eight() {
    assert_eq!(PALETTE_COLORS.len(), 16);
    let pastels = [
        "Rose", "Peach", "Sand", "Sage", "Mint", "Sky", "Lavender", "Blush",
    ];
    let tail: Vec<&str> = PALETTE_COLORS[8..].iter().map(|c| c.label).collect();
    assert_eq!(tail, pastels, "the pastel row is the second eight");
}
