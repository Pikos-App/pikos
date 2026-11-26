//! The folder palette.
//!
//! The TypeScript in `packages/core/src/constants/colors.ts` is the design source of truth;
//! this exists so the palette reaches Swift over the FFI instead of being typed out a third
//! time in a file no test compares.
//!
//! One palette for folders and for the folders a calendar mirrors into, so a synced calendar
//! never clashes with a colour the user picked. Provider hex is not inherited: Google's Banana
//! `#fbe983` is near-white on a dark sidebar. The saturated eight are what a person picks; the
//! pastel eight are where a synced calendar maps, so it reads as ambient next to chosen colours.
//!
//! `pikos-calendar-sync::palette` keeps its own copy of the pastel half, since that crate does
//! not depend on this one. If the palette moves, both move.

/// One entry. `label` is shown to a person; `value` is what is stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaletteColor {
    pub label: &'static str,
    pub value: &'static str,
}

const fn color(label: &'static str, value: &'static str) -> PaletteColor {
    PaletteColor { label, value }
}

/// Saturated row first, pastel row second, the order the pickers draw.
pub const PALETTE_COLORS: [PaletteColor; 16] = [
    color("Red", "#D9577A"),
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
/// Per provider so two accounts do not both arrive as the same colour; always pastel.
pub fn default_color_for_provider(provider: &str) -> &'static str {
    match provider {
        "caldav" => "#A6C8E8", // Sky
        "google" => "#A8CDB4", // Sage
        _ => "#A6C8E8",
    }
}
