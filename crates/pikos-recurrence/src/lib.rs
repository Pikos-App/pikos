//! Pikos recurrence engine.
//!
//! Single source of truth for RRULE math across the product: the desktop
//! backend and CLI link this crate natively, and the JS apps (React desktop
//! frontend, tests, future mobile) consume the same code compiled to
//! WebAssembly via the `pikos-recurrence-wasm` crate / `@pikos/recurrence-wasm`
//! package.
//!
//! Conventions (shared with `packages/core`):
//! - All dates are naive local wall-clock ISO strings ('YYYY-MM-DD' for
//!   all-day, 'YYYY-MM-DDTHH:MM:SS' for timed). No timezones anywhere.
//! - RRULE strings are stored without the "RRULE:" prefix and without
//!   DTSTART — the anchor lives on the page row.
//! - Weekday indices follow rrule.js: 0 = Monday … 6 = Sunday.

mod engine;
mod generate;
mod iso;
mod label;
mod options;
mod rule;
#[cfg(feature = "tz")]
pub mod zoned;

pub use engine::{
    align_weekly_rule_to_anchor, compute_next_end, expand_range, list_occurrences,
    missed_occurrences_between, next_occurrence_after, snap_anchor_to_rule, ExpandedOccurrence,
};
pub use iso::{format_date, format_datetime, is_all_day, parse_naive};
pub use label::rrule_to_label;
pub use options::{build_rrule, parse_options, Freq, RecurrenceOptions, WEEKDAY_CODES};
pub use rule::{parse_rule, ByDay, ParsedRule, RuleFreq};

#[cfg(test)]
mod tests;
