//! The folder palette.
//!
//! Mirror of `packages/core/src/constants/colors.ts`, graded against it by
//! `tests/colors_parity.rs`. The TypeScript is the design source of truth; this
//! exists so the palette reaches Swift over the FFI instead of being typed out a
//! third time in a file no test compares to anything.
//!
//! One palette for folders *and* for the folders a calendar mirrors into, so a
//! synced calendar can never clash with a colour the user picked themselves.
//! Provider hex is deliberately not inherited — Google's Banana `#fbe983` is
//! near-white on a dark sidebar and reads as no dot at all.
//!
//! The two rows are not decoration. The saturated eight are what a person picks
//! for their own folders; the pastel eight are where a synced calendar is
//! mapped, so an imported calendar reads as ambient next to work somebody chose
//! to colour.
//!
//! `pikos-calendar-sync::palette` carries its own copy of the pastel half for
//! the provider-colour mapping. It is a third copy and known to be one: that
//! crate does not depend on this one, and adding the dependency to share eight
//! string pairs would be the larger change. If the palette moves, both move.

/// One entry. `label` is shown to a person; `value` is what is stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaletteColor {
    pub label: &'static str,
    pub value: &'static str,
}

const fn color(label: &'static str, value: &'static str) -> PaletteColor {
    PaletteColor { label, value }
}

/// Saturated row first, pastel row second — the order the pickers draw.
pub const PALETTE_COLORS: [PaletteColor; 16] = [
    color("Red", "#E5534B"),
    color("Orange", "#E09B4A"),
    color("Yellow", "#C4A143"),
    color("Green", "#57A872"),
    color("Teal", "#3DBDA7"),
    color("Blue", "#539BF5"),
    color("Purple", "#9B8AE8"),
    color("Pink", "#DB6C9E"),
    color("Rose", "#E8A6A1"),
    color("Peach", "#E8C3A0"),
    color("Sand", "#DCCB97"),
    color("Sage", "#A8CDB4"),
    color("Mint", "#A6DBCF"),
    color("Sky", "#A6C8E8"),
    color("Lavender", "#C3B8E8"),
    color("Blush", "#E8B6CE"),
];

/// What a calendar's folder is coloured on first enable, before anybody picks.
///
/// Per provider so two accounts do not both arrive as the same colour, and a
/// pastel either way — see the module note on which row means what.
pub fn default_color_for_provider(provider: &str) -> &'static str {
    match provider {
        "caldav" => "#A6C8E8", // Sky
        "google" => "#A8CDB4", // Sage
        _ => "#A6C8E8",
    }
}
