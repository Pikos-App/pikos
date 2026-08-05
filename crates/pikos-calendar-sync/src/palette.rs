//! Provider calendar colour → Pikos palette.
//!
//! Providers hand back their own hex (Google's saturated calendar set, a CalDAV
//! server's `calendar-color`). Inheriting it fights our palette and dark mode —
//! Google's Banana `#fbe983` is near-white on a dark sidebar and reads as no dot
//! at all — so a synced calendar is recoloured into the palette's pastel row,
//! which is where synced calendars belong anyway: ambient next to the vivid
//! colours a user picks for their own folders.
//!
//! The palette is defined in `apps/desktop/src/shared/constants/colors.ts` (the
//! design SSOT). This mirrors its pastel half; keep the two in step.

use std::sync::LazyLock;

/// The pastel half of `PALETTE_COLORS`, the only entries a synced calendar maps
/// into.
const SYNCED_PALETTE: [(&str, &str); 8] = [
    ("Rose", "#E8A6A1"),
    ("Peach", "#E8C3A0"),
    ("Sand", "#DCCB97"),
    ("Sage", "#A8CDB4"),
    ("Mint", "#A6DBCF"),
    ("Sky", "#A6C8E8"),
    ("Lavender", "#C3B8E8"),
    ("Blush", "#E8B6CE"),
];

static PALETTE_HUES: LazyLock<Vec<(&'static str, f32)>> = LazyLock::new(|| {
    SYNCED_PALETTE
        .iter()
        .filter_map(|(_, hex)| Some((*hex, hue(parse_hex(hex)?)?)))
        .collect()
});

/// The palette entry nearest `hex` by hue, or `None` when there is no hue to
/// match — an unparseable value, or a grey like Google's Graphite. The caller
/// falls back to its per-provider default there.
///
/// Hue alone is the metric: every candidate already shares one pastel lightness
/// and chroma, so the provider's saturation and brightness carry no signal worth
/// matching — only *which* colour the user picked in their calendar app. RGB
/// distance collapses instead of separating, because a saturated input is far
/// from every pastel and lands on whichever is nearest in brightness: it maps
/// Google's Tomato and Tangerine both onto Rose, where hue splits them.
pub fn nearest_palette_color(hex: &str) -> Option<&'static str> {
    let h = hue(parse_hex(hex)?)?;
    PALETTE_HUES
        .iter()
        .min_by(|a, b| arc(h, a.1).total_cmp(&arc(h, b.1)))
        .map(|(entry, _)| *entry)
}

/// Shortest angular distance between two hues, degrees.
fn arc(a: f32, b: f32) -> f32 {
    let d = (a - b).abs();
    d.min(360.0 - d)
}

fn parse_hex(hex: &str) -> Option<(f32, f32, f32)> {
    let s = hex.strip_prefix('#')?;
    if s.len() != 6 {
        return None;
    }
    let channel = |i: usize| u8::from_str_radix(s.get(i..i + 2)?, 16).ok();
    Some((
        channel(0)? as f32 / 255.0,
        channel(2)? as f32 / 255.0,
        channel(4)? as f32 / 255.0,
    ))
}

/// HSL hue in degrees. `None` when the colour is achromatic (grey/black/white)
/// and hue is undefined.
fn hue((r, g, b): (f32, f32, f32)) -> Option<f32> {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let d = max - min;
    if d <= f32::EPSILON {
        return None;
    }
    let h = if max == r {
        60.0 * (((g - b) / d) % 6.0)
    } else if max == g {
        60.0 * ((b - r) / d + 2.0)
    } else {
        60.0 * ((r - g) / d + 4.0)
    };
    Some(if h < 0.0 { h + 360.0 } else { h })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nearest(hex: &str) -> Option<&'static str> {
        nearest_palette_color(hex)
    }

    #[test]
    fn google_calendar_colours_map_to_distinct_pastels() {
        // The four calendars on the dev account, in the order the sidebar lists
        // them. Distinctness is the point: a mapping that collapsed these onto one
        // entry would be worse than the provider hex it replaces.
        assert_eq!(nearest("#f83a22"), Some("#E8A6A1")); // Tomato    → Rose
        assert_eq!(nearest("#ff7537"), Some("#E8C3A0")); // Tangerine → Peach
        assert_eq!(nearest("#fbe983"), Some("#DCCB97")); // Banana    → Sand
        assert_eq!(nearest("#f691b2"), Some("#E8B6CE")); // Flamingo  → Blush
    }

    #[test]
    fn google_event_palette_lands_on_its_hue_family() {
        assert_eq!(nearest("#0b8043"), Some("#A8CDB4")); // Basil     → Sage
        assert_eq!(nearest("#039be5"), Some("#A6C8E8")); // Peacock   → Sky
        assert_eq!(nearest("#8e24aa"), Some("#C3B8E8")); // Grape     → Lavender
        assert_eq!(nearest("#7986cb"), Some("#A6C8E8")); // Lavender  → Sky
        assert_eq!(nearest("#33b679"), Some("#A8CDB4")); // Sage      → Sage
    }

    #[test]
    fn achromatic_and_malformed_values_have_no_match() {
        assert_eq!(nearest("#616161"), None); // Graphite — grey, no hue
        assert_eq!(nearest("#000000"), None);
        assert_eq!(nearest("#ffffff"), None);
        assert_eq!(nearest("not-a-colour"), None);
        assert_eq!(nearest("#abc"), None); // shorthand is not a form any provider sends
        assert_eq!(nearest(""), None);
    }

    #[test]
    fn a_palette_entry_maps_to_itself() {
        for (_, hex) in SYNCED_PALETTE {
            assert_eq!(nearest(hex), Some(hex), "{hex} should be its own match");
        }
    }

    #[test]
    fn hue_wraps_the_short_way_around_the_circle() {
        // Red sits either side of 0°, so a naive |a-b| would send a 359° input the
        // long way round to Sage rather than to Rose at ~4°.
        assert_eq!(arc(359.0, 4.0), 5.0);
        assert_eq!(nearest("#ff0033"), Some("#E8A6A1"));
    }
}
