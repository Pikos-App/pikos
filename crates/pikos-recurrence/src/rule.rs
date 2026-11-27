//! RRULE parsing and building.
//!
//! Two layers share this file:
//!   - [`RecurrenceOptions`] + [`parse_rrule`]/[`build_rrule`] mirror the
//!     editor round-trip in `recurrence.ts`.
//!   - [`ParsedRule`] is the fuller internal parse the enumerator needs; it keeps
//!     the raw `UNTIL` instant that [`RecurrenceOptions`] reduces to a date.

use chrono::NaiveDateTime;
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RecurrenceError {
    #[error("unparseable RRULE: {0}")]
    Parse(String),
    /// A well-formed RRULE outside this engine's envelope. Distinct from `Parse` so
    /// callers can fall back loudly rather than silently mis-enumerate.
    #[error("unsupported RRULE feature: {0}")]
    Unsupported(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Freq {
    #[serde(rename = "DAILY")]
    Daily,
    #[serde(rename = "WEEKLY")]
    Weekly,
    #[serde(rename = "MONTHLY")]
    Monthly,
    #[serde(rename = "YEARLY")]
    Yearly,
}

impl Freq {
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "DAILY" => Some(Freq::Daily),
            "WEEKLY" => Some(Freq::Weekly),
            "MONTHLY" => Some(Freq::Monthly),
            "YEARLY" => Some(Freq::Yearly),
            _ => None,
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            Freq::Daily => "DAILY",
            Freq::Weekly => "WEEKLY",
            Freq::Monthly => "MONTHLY",
            Freq::Yearly => "YEARLY",
        }
    }
}

const WEEKDAY_CODES: [&str; 7] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

fn weekday_from_code(code: &str) -> Option<u8> {
    WEEKDAY_CODES
        .iter()
        .position(|c| *c == code)
        .map(|i| i as u8)
}

/// Field presence matches the TS `parseRrule` output; the serde shape is the wasm
/// boundary's JSON contract.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurrenceOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub freq: Option<Freq>,
    pub interval: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byweekday: Option<Vec<u8>>,
    /// BYDAY ordinals (`1` in `1MO`, `-1` in `-1FR`) positionally aligned with
    /// `byweekday`; `None` per entry for a bare weekday. Set only when the rule
    /// carried at least one, so anything rewriting `byweekday` must clear it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byweekday_ordinals: Option<Vec<Option<i32>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bysetpos: Option<Vec<i32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bymonthday: Option<Vec<i32>>,
    /// Months 1–12. Range-filtered like the enumerator, so an out-of-range month
    /// fails the round-trip rather than silently widening the rule to every month.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bymonth: Option<Vec<u32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wkst: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
}

fn parts(rrule: &str) -> impl Iterator<Item = (&str, &str)> {
    rrule.split(';').filter_map(|p| p.split_once('='))
}

/// `None` (not an error) on unparseable input or unsupported FREQ, matching `parseRrule`.
pub fn parse_rrule(rrule: &str) -> Option<RecurrenceOptions> {
    let mut opts = RecurrenceOptions {
        interval: 1,
        ..Default::default()
    };
    let mut saw_freq = false;
    for (key, value) in parts(rrule) {
        match key {
            "FREQ" => {
                opts.freq = Freq::from_str(value);
                opts.freq?;
                saw_freq = true;
            }
            "INTERVAL" => opts.interval = value.parse().ok()?,
            "BYDAY" => {
                let (days, ordinals) = parse_byday(value);
                if !days.is_empty() {
                    opts.byweekday = Some(days);
                    if ordinals.iter().any(Option::is_some) {
                        opts.byweekday_ordinals = Some(ordinals);
                    }
                }
            }
            "BYSETPOS" => opts.bysetpos = parse_int_list(value),
            "BYMONTHDAY" => opts.bymonthday = parse_int_list(value),
            "BYMONTH" => opts.bymonth = parse_month_list(value),
            "WKST" => opts.wkst = weekday_from_code(value),
            "COUNT" => opts.count = value.parse().ok(),
            "UNTIL" => {
                opts.until = parse_until(value).map(|dt| dt.date().format("%Y-%m-%d").to_string())
            }
            _ => {}
        }
    }
    if !saw_freq {
        return None;
    }
    Some(opts)
}

/// Builds an RRULE string from typed options. Never emits `DTSTART`. Field order
/// is fixed (the wrapper's `alignWeeklyRuleToAnchor` depends on
/// `FREQ;INTERVAL;BYDAY`); it is not required to match rrule.js byte-for-byte.
pub fn build_rrule(opts: &RecurrenceOptions) -> String {
    let mut segs = Vec::new();
    if let Some(freq) = opts.freq {
        segs.push(format!("FREQ={}", freq.as_str()));
    }
    segs.push(format!("INTERVAL={}", opts.interval.max(1)));
    if let Some(days) = opts.byweekday.as_ref().filter(|d| !d.is_empty()) {
        let ordinals = opts.byweekday_ordinals.as_deref().unwrap_or_default();
        let codes: Vec<String> = days
            .iter()
            .enumerate()
            .map(|(i, &d)| {
                let code = WEEKDAY_CODES[d as usize];
                match ordinals.get(i).copied().flatten() {
                    Some(n) => format!("{n}{code}"),
                    None => code.to_string(),
                }
            })
            .collect();
        segs.push(format!("BYDAY={}", codes.join(",")));
    }
    if let Some(list) = opts.bymonthday.as_ref().filter(|l| !l.is_empty()) {
        segs.push(format!("BYMONTHDAY={}", join_ints(list)));
    }
    if let Some(list) = opts.bymonth.as_ref().filter(|l| !l.is_empty()) {
        segs.push(format!("BYMONTH={}", join_ints(list)));
    }
    if let Some(list) = opts.bysetpos.as_ref().filter(|l| !l.is_empty()) {
        segs.push(format!("BYSETPOS={}", join_ints(list)));
    }
    if let Some(wkst) = opts.wkst {
        segs.push(format!("WKST={}", WEEKDAY_CODES[wkst as usize]));
    }
    if let Some(count) = opts.count {
        segs.push(format!("COUNT={count}"));
    } else if let Some(until) = &opts.until {
        // End-of-day so the final date's occurrence is included, and floating because
        // every other instant in the rule is wall-clock — a `Z` mixes the two bases.
        let compact = until.replace('-', "");
        segs.push(format!("UNTIL={compact}T235959"));
    }
    segs.join(";")
}

fn strip_ordinal(byday: &str) -> &str {
    let ordinal_prefix = byday.trim_end_matches(|c: char| c.is_ascii_alphabetic());
    &byday[ordinal_prefix.len()..]
}

fn parse_byday(value: &str) -> (Vec<u8>, Vec<Option<i32>>) {
    let mut days = Vec::new();
    let mut ordinals = Vec::new();
    for term in value.split(',') {
        let code = strip_ordinal(term);
        let Some(weekday) = weekday_from_code(code) else {
            continue;
        };
        days.push(weekday);
        ordinals.push(parse_ordinal(&term[..term.len() - code.len()]));
    }
    (days, ordinals)
}

fn parse_ordinal(prefix: &str) -> Option<i32> {
    prefix.trim_start_matches('+').parse().ok()
}

fn parse_int_list(value: &str) -> Option<Vec<i32>> {
    let list: Vec<i32> = value.split(',').filter_map(|v| v.parse().ok()).collect();
    (!list.is_empty()).then_some(list)
}

fn parse_month_list(value: &str) -> Option<Vec<u32>> {
    let list: Vec<u32> = value
        .split(',')
        .filter_map(|v| v.parse().ok())
        .filter(|m| (1..=12).contains(m))
        .collect();
    (!list.is_empty()).then_some(list)
}

fn join_ints<T: std::fmt::Display>(list: &[T]) -> String {
    list.iter()
        .map(|n| n.to_string())
        .collect::<Vec<_>>()
        .join(",")
}

/// Parses an RRULE `UNTIL` token (`YYYYMMDD` or `YYYYMMDDTHHMMSS[Z]`) as a naive
/// wall-clock instant — the `Z` is dropped because enumeration compares against
/// the occurrence's own wall-clock, matching rrule.js's fake-UTC handling.
fn parse_until(value: &str) -> Option<NaiveDateTime> {
    let v = value.trim_end_matches('Z');
    if let Some((d, t)) = v.split_once('T') {
        let date = chrono::NaiveDate::parse_from_str(d, "%Y%m%d").ok()?;
        let time = chrono::NaiveTime::parse_from_str(t, "%H%M%S").ok()?;
        Some(date.and_time(time))
    } else {
        chrono::NaiveDate::parse_from_str(v, "%Y%m%d")
            .ok()
            .map(|d| d.and_hms_opt(0, 0, 0).unwrap())
    }
}

/// A `UNTIL` token reduced to the one form the editor rebuilds: floating
/// end-of-day.
///
/// Two inputs collapse to it losslessly. A trailing `Z` is syntactic — the
/// engine reads every instant as a wall clock — and a date-only `UNTIL` pairs
/// with an all-day start whose final occurrence sits at midnight. Any other
/// time of day is the provider's own cut-off, and rebuilding it as end-of-day
/// would gain the occurrence it excluded.
fn normalized_until(value: &str) -> String {
    let stamp = value.trim().to_ascii_uppercase();
    let stamp = stamp.strip_suffix('Z').unwrap_or(&stamp);
    if stamp.contains('T') {
        stamp.to_string()
    } else {
        format!("{stamp}T235959")
    }
}

/// Canonical form of a comma-separated term, so `BYDAY=TU,MO` and `BYDAY=mo,+tu`
/// compare equal. The sort is defensive: `parse_rrule` and `build_rrule` preserve order, so both
/// sides of the comparison already agree. It stays so a builder that canonicalises
/// order doesn't start reporting every list rule as un-editable.
fn normalized_list(value: &str) -> String {
    let mut tokens: Vec<String> = value
        .split(',')
        .map(|token| {
            let token = token.trim().to_ascii_uppercase();
            token.strip_prefix('+').unwrap_or(&token).to_string()
        })
        .collect();
    tokens.sort();
    tokens.join(",")
}

/// Every term an RRULE states, with the two the builder always emits defaulted in.
fn rule_terms(rrule: &str) -> std::collections::BTreeMap<String, String> {
    let mut terms = std::collections::BTreeMap::from([
        ("INTERVAL".to_string(), "1".to_string()),
        ("WKST".to_string(), "MO".to_string()),
    ]);
    // Providers spell the optional prefix both ways.
    let body = match rrule.get(..6) {
        Some(prefix) if prefix.eq_ignore_ascii_case("RRULE:") => &rrule[6..],
        _ => rrule,
    };
    for part in body.split(';') {
        let Some((key, value)) = part.split_once('=') else {
            continue;
        };
        let term = key.trim().to_ascii_uppercase();
        let value = if term == "UNTIL" {
            normalized_until(value)
        } else {
            normalized_list(value)
        };
        terms.insert(term, value);
    }
    terms
}

/// True when saving the rule back through a structured editor would change which
/// occurrences it yields: a term outside the envelope (`BYWEEKNO`, `BYYEARDAY`,
/// `BYHOUR`) or a rule that does not parse.
///
/// Derived from the round-trip rather than a list of lossy terms, because such a
/// list is only as complete as the last person to notice a gap ("15 March,
/// annually" slipped through the TypeScript's).
pub fn rrule_edit_would_degrade(rrule: &str) -> bool {
    let Some(options) = parse_rrule(rrule) else {
        return true;
    };
    rule_terms(rrule) != rule_terms(&build_rrule(&options))
}

/// The `UNTIL` instant of an RRULE, FREQ-agnostic: the token is parsed without
/// validating the envelope. Use this, not [`parse_rrule`], to ask "is this series
/// bounded?": `parse_rrule` returns `None` on an out-of-envelope FREQ (e.g.
/// `FREQ=HOURLY`), misreading a bounded rule as unbounded.
pub fn extract_until(rrule: &str) -> Option<NaiveDateTime> {
    rrule
        .split(';')
        .find_map(|part| {
            let (key, value) = part.split_once('=')?;
            key.eq_ignore_ascii_case("UNTIL").then_some(value)
        })
        .and_then(parse_until)
}

/// Rewrite an RRULE's `UNTIL` value in place, leaving every other field byte-for
/// byte intact: a round-trip through [`parse_rrule`]/[`build_rrule`] drops the
/// fields those options don't carry (BYSETPOS, BYMONTHDAY, ...). `f` receives the
/// raw `UNTIL` value and returns its replacement, or `None` to leave it as it
/// stands (date-only, floating and unparseable shapes are already in the frame the
/// caller wants).
pub fn rewrite_until_with<F>(rrule: &str, mut f: F) -> String
where
    F: FnMut(&str) -> Option<String>,
{
    rrule
        .split(';')
        .map(|part| match part.split_once('=') {
            Some((key, value)) if key.eq_ignore_ascii_case("UNTIL") => match f(value) {
                Some(rewritten) => format!("{key}={rewritten}"),
                None => part.to_string(),
            },
            _ => part.to_string(),
        })
        .collect::<Vec<_>>()
        .join(";")
}

/// The keys of the parts whose values the engine can't read and so ignores, as rrule.js does:
/// a `COUNT=abc` or a bad `UNTIL` repeats without end, an `INTERVAL=x` every period. Parsing
/// stays lenient so a synced calendar's series still show; this lets a caller say so.
pub fn unread_parts(rrule: &str) -> Vec<&str> {
    parts(rrule)
        .filter(|&(key, value)| match key {
            "INTERVAL" | "COUNT" => value.parse::<u32>().is_err(),
            "UNTIL" => parse_until(value).is_none(),
            "BYMONTHDAY" | "BYSETPOS" => parse_int_list(value).is_none(),
            "BYMONTH" => parse_month_list(value).is_none(),
            "WKST" => weekday_from_code(value).is_none(),
            _ => false,
        })
        .map(|(key, _)| key)
        .collect()
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ByDay {
    pub ordinal: Option<i32>,
    pub weekday: u8,
}

#[derive(Debug, Clone)]
pub(crate) struct ParsedRule {
    pub freq: Freq,
    pub interval: u32,
    pub byday: Vec<ByDay>,
    pub bymonthday: Vec<i32>,
    pub bymonth: Vec<u32>,
    pub bysetpos: Vec<i32>,
    pub wkst: u8,
    pub count: Option<u32>,
    pub until: Option<NaiveDateTime>,
}

impl ParsedRule {
    /// Rejection is reserved for parts the enumerator does not implement (sub-daily
    /// FREQ, BYWEEKNO, BYYEARDAY, BYHOUR/BYMINUTE/BYSECOND); there is no fallback
    /// engine, so a rejected rule renders nowhere. Two shapes rrule.js tolerates are
    /// normalized as it does: a WEEKLY BYDAY ordinal reads as the bare weekday, and
    /// COUNT+UNTIL together run to the tighter bound.
    pub fn parse(rrule: &str) -> Result<Self, RecurrenceError> {
        let mut freq = None;
        let mut interval = 1u32;
        let mut byday = Vec::new();
        let mut bymonthday = Vec::new();
        let mut bymonth = Vec::new();
        let mut bysetpos = Vec::new();
        let mut wkst = 0u8;
        let mut count = None;
        let mut until = None;
        for (key, value) in parts(rrule) {
            match key {
                "FREQ" => {
                    freq =
                        Some(Freq::from_str(value).ok_or_else(|| {
                            RecurrenceError::Unsupported(format!("FREQ={value}"))
                        })?);
                }
                "INTERVAL" => interval = value.parse().unwrap_or(1),
                "BYDAY" | "BYWEEKDAY" => {
                    let (days, ordinals) = parse_byday(value);
                    byday = days
                        .into_iter()
                        .zip(ordinals)
                        .map(|(weekday, ordinal)| ByDay { ordinal, weekday })
                        .collect();
                }
                "BYMONTHDAY" => bymonthday = parse_int_list(value).unwrap_or_default(),
                "BYMONTH" => bymonth = parse_month_list(value).unwrap_or_default(),
                "BYSETPOS" => bysetpos = parse_int_list(value).unwrap_or_default(),
                "WKST" => wkst = weekday_from_code(value).unwrap_or(0),
                "COUNT" => count = value.parse().ok(),
                "UNTIL" => until = parse_until(value),
                other => return Err(RecurrenceError::Unsupported(other.to_string())),
            }
        }
        let freq = freq.ok_or_else(|| RecurrenceError::Parse(rrule.to_string()))?;
        // WEEKLY BYMONTHDAY has no rrule.js-defined meaning worth mimicking
        // (RFC 5545 forbids the combination) — stay loud rather than guess.
        if freq == Freq::Weekly && !bymonthday.is_empty() {
            return Err(RecurrenceError::Unsupported(
                "BYMONTHDAY for FREQ=WEEKLY".into(),
            ));
        }
        Ok(ParsedRule {
            freq,
            interval: interval.max(1),
            byday,
            bymonthday,
            bymonth,
            bysetpos,
            wkst,
            count,
            until,
        })
    }
}
