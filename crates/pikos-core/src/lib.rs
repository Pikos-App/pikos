//! Portable Pikos domain logic, shared by the desktop app, the CLI, and
//! (via UniFFI) the iOS app.
//!
//! This crate is the Rust destination for logic that currently lives in
//! `packages/core` (TypeScript). Everything here is graded against a golden
//! corpus generated from the TypeScript reference — see
//! `packages/core/scripts/gen-parity-corpus.ts` and `tests/parity.rs`. The TS
//! path is the reference implementation until a module reaches parity; only
//! then may it be deleted.
//!
//! Deliberately dependency-free of `pikos-db`: this is pure logic with no I/O,
//! which is what makes it testable against a fixture corpus and cheap to bind
//! from Swift.

pub mod calendar;
pub mod colors;
pub mod dates;
pub mod deep_link;
pub mod nlp;
pub mod overdue;
pub mod page;
pub mod schedule;
pub mod search;
pub mod text;
pub mod views;

pub use calendar::LayoutPage;
pub use colors::{default_color_for_provider, PaletteColor, PALETTE_COLORS};
pub use dates::{
    format_date_only, format_local_iso, is_all_day_iso, is_timed_iso, parse_local_iso,
};
pub use deep_link::{parse_deep_link, DeepLink, SmartView};
pub use nlp::{
    parse as parse_dates, parse_first as parse_first_date, DateMatch, Granularity, MatchedDate,
};
pub use overdue::{
    move_overdue_to_today_label, plan_move_overdue_to_today, OverdueMove, OverdueMovePlan,
    OverdueRow,
};
pub use page::{is_done, is_open, PageStatus};
pub use schedule::{compute_schedule_transition, normalize_end_input, ScheduleTransition};
pub use search::{parse_search_query, ParsedSearchQuery, SearchStatus};
pub use text::{extract_text, extract_text_value};
