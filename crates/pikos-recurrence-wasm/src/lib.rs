//! WebAssembly bindings for the Pikos recurrence engine.
//!
//! Thin JSON-at-the-edges wrapper over `pikos-recurrence`: scalar arguments
//! pass as strings, list/struct values cross the boundary as JSON strings so
//! the binding surface stays tiny and version-stable. The TS wrapper in
//! `@pikos/core` owns (de)serialization and the typed public API.
//!
//! An out-of-envelope or unparseable rule yields the empty/undefined result —
//! the same shape as an exhausted series. The loud-rejection path
//! (`RecurrenceError`) is native-only: the backend derivations warn-skip, while
//! the frontend renders what the shared engine can enumerate.
//!
//! Exported names are camelCase to read naturally from JS.

use wasm_bindgen::prelude::*;

fn parse_exdates(exdates_json: &str) -> Vec<String> {
    serde_json::from_str(exdates_json).unwrap_or_default()
}

/// Occurrences of a rule within [rangeStart, rangeEnd) as a JSON array of
/// `{originalDate, scheduledStart, scheduledEnd}`.
#[wasm_bindgen(js_name = expandRange)]
pub fn expand_range(
    rrule: &str,
    scheduled_start: &str,
    scheduled_end: Option<String>,
    range_start: &str,
    range_end: &str,
    exdates_json: &str,
) -> String {
    pikos_recurrence::expand_range(
        rrule,
        scheduled_start,
        scheduled_end.as_deref(),
        range_start,
        range_end,
        &parse_exdates(exdates_json),
    )
    .ok()
    .and_then(|occurrences| serde_json::to_string(&occurrences).ok())
    .unwrap_or_else(|| "[]".to_string())
}

/// Next occurrence's scheduledStart strictly after the day of `after`, or
/// undefined when the rule is exhausted or invalid.
#[wasm_bindgen(js_name = nextOccurrenceAfter)]
pub fn next_occurrence_after(
    rrule: &str,
    scheduled_start: &str,
    after: &str,
    exdates_json: &str,
) -> Option<String> {
    pikos_recurrence::next_occurrence_after(
        rrule,
        scheduled_start,
        after,
        &parse_exdates(exdates_json),
    )
    .ok()
    .flatten()
    .map(|(start, _end)| start)
}

#[wasm_bindgen(js_name = snapAnchorToRule)]
pub fn snap_anchor_to_rule(rrule: &str, anchor: &str) -> String {
    pikos_recurrence::snap_anchor_to_rule(rrule, anchor)
}

/// JSON array of YYYY-MM-DD strings strictly between `after` and `before`.
#[wasm_bindgen(js_name = missedOccurrencesBetween)]
pub fn missed_occurrences_between(
    rrule: &str,
    scheduled_start: &str,
    after: &str,
    before: &str,
    exdates_json: &str,
) -> String {
    pikos_recurrence::missed_occurrences_between(
        rrule,
        scheduled_start,
        after,
        before,
        &parse_exdates(exdates_json),
    )
    .ok()
    .and_then(|missed| serde_json::to_string(&missed).ok())
    .unwrap_or_else(|| "[]".to_string())
}

#[wasm_bindgen(js_name = alignWeeklyRuleToAnchor)]
pub fn align_weekly_rule_to_anchor(rrule: &str, anchor_start: &str) -> String {
    pikos_recurrence::align_weekly_rule_to_anchor(rrule, anchor_start)
}

#[wasm_bindgen(js_name = computeNextEnd)]
pub fn compute_next_end(base_end: &str, next_start: &str) -> Option<String> {
    pikos_recurrence::compute_next_end(base_end, next_start)
}

/// Typed options as a JSON object (`{freq, interval, byweekday?,
/// byweekdayOrdinals?, bysetpos?, bymonthday?, bymonth?, wkst?, count?,
/// until?}`), or undefined when unparseable or the FREQ is unsupported.
#[wasm_bindgen(js_name = parseRruleOptions)]
pub fn parse_rrule_options(rrule: &str) -> Option<String> {
    pikos_recurrence::parse_rrule(rrule).and_then(|opts| serde_json::to_string(&opts).ok())
}

/// Builds an RRULE string from a JSON options object. Returns undefined when
/// the JSON doesn't deserialize into valid options.
#[wasm_bindgen(js_name = buildRrule)]
pub fn build_rrule(options_json: &str) -> Option<String> {
    let options: pikos_recurrence::RecurrenceOptions = serde_json::from_str(options_json).ok()?;
    Some(pikos_recurrence::build_rrule(&options))
}

/// Human-readable label ("every week on Monday"), or undefined when the rule
/// can't be reduced to the phrased subset (callers fall back to the raw
/// string).
#[wasm_bindgen(js_name = rruleToLabel)]
pub fn rrule_to_label(rrule: &str) -> Option<String> {
    pikos_recurrence::rrule_to_label(rrule)
}

/// Compact byline label ("Weekly", "Every 2 weeks × 10"). Falls back to the
/// raw RRULE string on parse failure, mirroring the native helper.
#[wasm_bindgen(js_name = rruleToShortLabel)]
pub fn rrule_to_short_label(rrule: &str) -> String {
    pikos_recurrence::rrule_to_short_label(rrule)
}

/// First `limit` occurrences anchored at `dtstart`, as a JSON array of local
/// ISO datetimes.
#[wasm_bindgen(js_name = listOccurrences)]
pub fn list_occurrences(rrule: &str, dtstart: &str, limit: u32) -> String {
    serde_json::to_string(&pikos_recurrence::list_occurrences(rrule, dtstart, limit))
        .unwrap_or_else(|_| "[]".to_string())
}
