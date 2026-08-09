//! RRULE string parsing into a fully-specified rule ready for iteration.
//!
//! Supports the RFC 5545 subset a calendar product actually meets: the four
//! calendar frequencies with INTERVAL, BYDAY (plain and ordinal), BYMONTHDAY
//! (incl. negatives), BYMONTH, BYSETPOS, WKST, COUNT and UNTIL. Sub-daily
//! frequencies and the exotic BY* parts (BYYEARDAY, BYWEEKNO, BYHOUR, …) are
//! rejected — callers treat unparseable rules as invalid and degrade the same
//! way they would for a syntax error.

use chrono::{NaiveDate, NaiveDateTime};

use crate::options::{strip_prefix, WEEKDAY_CODES};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleFreq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

/// A BYDAY entry: optional ordinal (e.g. 2 in "2MO", -1 in "-1FR") plus
/// weekday index (0 = Monday … 6 = Sunday).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByDay {
    pub ordinal: Option<i32>,
    pub weekday: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedRule {
    pub freq: RuleFreq,
    pub interval: u32,
    pub count: Option<u32>,
    /// Inclusive end bound, naive wall-clock (Z suffixes are stripped — the
    /// whole engine lives in fake-UTC space).
    pub until: Option<NaiveDateTime>,
    pub byday: Vec<ByDay>,
    /// 1..=31 or -31..=-1 (from month end).
    pub bymonthday: Vec<i32>,
    /// 1..=12.
    pub bymonth: Vec<u32>,
    /// 1-based positions into each period's candidate set; negatives from end.
    pub bysetpos: Vec<i32>,
    /// Week start (0 = Monday … 6 = Sunday). Default Monday, matching
    /// rrule.js.
    pub wkst: u8,
}

fn parse_byday(value: &str) -> Option<Vec<ByDay>> {
    let mut days = Vec::new();
    for part in value.split(',') {
        let split_at = part
            .find(|c: char| c.is_ascii_alphabetic())
            .filter(|&i| i + 2 == part.len())?;
        let (num, code) = part.split_at(split_at);
        let ordinal = if num.is_empty() {
            None
        } else {
            let n = num.parse::<i32>().ok()?;
            if n == 0 || n.abs() > 53 {
                return None;
            }
            Some(n)
        };
        let weekday = WEEKDAY_CODES
            .iter()
            .position(|c| code.eq_ignore_ascii_case(c))? as u8;
        days.push(ByDay { ordinal, weekday });
    }
    Some(days)
}

fn parse_until(value: &str) -> Option<NaiveDateTime> {
    let value = value.strip_suffix(['Z', 'z']).unwrap_or(value);
    if let Some((date, time)) = value.split_once(['T', 't']) {
        let d = NaiveDate::parse_from_str(date, "%Y%m%d").ok()?;
        let t = chrono::NaiveTime::parse_from_str(time, "%H%M%S").ok()?;
        Some(d.and_time(t))
    } else {
        NaiveDate::parse_from_str(value, "%Y%m%d")
            .ok()?
            .and_hms_opt(0, 0, 0)
    }
}

fn parse_int_list<T: std::str::FromStr>(
    value: &str,
    valid: impl Fn(&T) -> bool,
) -> Option<Vec<T>> {
    let mut out = Vec::new();
    for part in value.split(',') {
        let n = part.parse::<T>().ok()?;
        if !valid(&n) {
            return None;
        }
        out.push(n);
    }
    Some(out)
}

/// Parses an RRULE string (with or without "RRULE:" prefix). Returns None on
/// syntax errors, unsupported frequencies, or unsupported BY* parts.
pub fn parse_rule(rrule: &str) -> Option<ParsedRule> {
    let body = strip_prefix(rrule.trim());
    if body.is_empty() {
        return None;
    }

    let mut freq: Option<RuleFreq> = None;
    let mut rule = ParsedRule {
        freq: RuleFreq::Daily, // placeholder until FREQ parses
        interval: 1,
        count: None,
        until: None,
        byday: Vec::new(),
        bymonthday: Vec::new(),
        bymonth: Vec::new(),
        bysetpos: Vec::new(),
        wkst: 0,
    };

    for part in body.split(';') {
        if part.is_empty() {
            continue;
        }
        let (key, value) = part.split_once('=')?;
        match key.to_ascii_uppercase().as_str() {
            "FREQ" => {
                freq = Some(match value.to_ascii_uppercase().as_str() {
                    "DAILY" => RuleFreq::Daily,
                    "WEEKLY" => RuleFreq::Weekly,
                    "MONTHLY" => RuleFreq::Monthly,
                    "YEARLY" => RuleFreq::Yearly,
                    _ => return None, // sub-daily frequencies unsupported
                });
            }
            "INTERVAL" => rule.interval = value.parse::<u32>().ok().filter(|&i| i >= 1)?,
            "COUNT" => rule.count = Some(value.parse::<u32>().ok()?),
            "UNTIL" => rule.until = Some(parse_until(value)?),
            "BYDAY" | "BYWEEKDAY" => rule.byday = parse_byday(value)?,
            "BYMONTHDAY" => {
                rule.bymonthday =
                    parse_int_list::<i32>(value, |&n| (1..=31).contains(&n.abs()))?
            }
            "BYMONTH" => {
                rule.bymonth = parse_int_list::<u32>(value, |&n| (1..=12).contains(&n))?
            }
            "BYSETPOS" => {
                rule.bysetpos =
                    parse_int_list::<i32>(value, |&n| n != 0 && (1..=366).contains(&n.abs()))?
            }
            "WKST" => {
                rule.wkst = WEEKDAY_CODES
                    .iter()
                    .position(|c| value.eq_ignore_ascii_case(c))? as u8
            }
            // DTSTART never appears in stored rules (the anchor lives on the
            // page); anything else is an unsupported part.
            _ => return None,
        }
    }

    rule.freq = freq?;
    Some(rule)
}
