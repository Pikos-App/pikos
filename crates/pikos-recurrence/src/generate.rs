//! Occurrence generation for a parsed rule.
//!
//! Classic period-expansion design: walk candidate periods (day / week /
//! month / year) from DTSTART with the rule's INTERVAL stride, expand each
//! period's matching calendar dates via the BY* parts, apply BYSETPOS, then
//! stream results in order while honoring DTSTART, COUNT and UNTIL. All
//! datetimes are naive wall-clock; each occurrence carries DTSTART's
//! time-of-day.
//!
//! Correctness is pinned two ways: the unit suite ported from the historical
//! rrule.js-backed TS tests, and golden fixtures generated from rrule.js
//! itself (tests/rrule_js_goldens.rs).

use std::collections::VecDeque;

use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime};

use crate::rule::{ByDay, ParsedRule, RuleFreq};

/// Consecutive candidate periods allowed to produce no occurrence before the
/// iterator declares the rule dry (e.g. FREQ=MONTHLY;BYMONTHDAY=30;BYMONTH=2).
const MAX_EMPTY_PERIODS: u32 = 1000;

fn weekday_index(date: NaiveDate) -> u8 {
    date.weekday().num_days_from_monday() as u8
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let next = if month == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(year, month + 1, 1)
    };
    next.and_then(|d| d.pred_opt())
        .map(|d| d.day())
        .unwrap_or(30)
}

/// Resolves a possibly-negative month day (-1 = last day) for a month.
/// Returns None when the day doesn't exist (e.g. 30 in February).
fn resolve_monthday(year: i32, month: u32, day: i32) -> Option<NaiveDate> {
    let last = days_in_month(year, month) as i32;
    let resolved = if day > 0 { day } else { last + day + 1 };
    if resolved < 1 || resolved > last {
        return None;
    }
    NaiveDate::from_ymd_opt(year, month, resolved as u32)
}

/// All dates in `month` matching a BYDAY entry (ordinal-aware).
fn expand_byday_in_month(year: i32, month: u32, byday: &ByDay) -> Vec<NaiveDate> {
    let last = days_in_month(year, month);
    let matching: Vec<NaiveDate> = (1..=last)
        .filter_map(|d| NaiveDate::from_ymd_opt(year, month, d))
        .filter(|d| weekday_index(*d) == byday.weekday)
        .collect();
    select_ordinal(matching, byday.ordinal)
}

/// All dates in `year` matching a BYDAY entry (ordinal counted over the year).
fn expand_byday_in_year(year: i32, byday: &ByDay) -> Vec<NaiveDate> {
    let start = match NaiveDate::from_ymd_opt(year, 1, 1) {
        Some(d) => d,
        None => return Vec::new(),
    };
    let matching: Vec<NaiveDate> = start
        .iter_days()
        .take_while(|d| d.year() == year)
        .filter(|d| weekday_index(*d) == byday.weekday)
        .collect();
    select_ordinal(matching, byday.ordinal)
}

fn select_ordinal(matching: Vec<NaiveDate>, ordinal: Option<i32>) -> Vec<NaiveDate> {
    match ordinal {
        None => matching,
        Some(n) if n > 0 => matching.get((n - 1) as usize).copied().into_iter().collect(),
        Some(n) => {
            let idx = matching.len() as i32 + n;
            if idx < 0 {
                Vec::new()
            } else {
                matching.get(idx as usize).copied().into_iter().collect()
            }
        }
    }
}

/// Candidate dates a single month contributes under the rule's BY* parts
/// (shared by MONTHLY periods and YEARLY periods with BYMONTH).
fn month_candidates(rule: &ParsedRule, year: i32, month: u32, anchor_day: u32) -> Vec<NaiveDate> {
    let mut days: Vec<NaiveDate> = if !rule.byday.is_empty() {
        let mut expanded: Vec<NaiveDate> = rule
            .byday
            .iter()
            .flat_map(|bd| expand_byday_in_month(year, month, bd))
            .collect();
        if !rule.bymonthday.is_empty() {
            // Both present → intersection (RFC 5545: BYMONTHDAY limits BYDAY).
            let monthdays: Vec<NaiveDate> = rule
                .bymonthday
                .iter()
                .filter_map(|&d| resolve_monthday(year, month, d))
                .collect();
            expanded.retain(|d| monthdays.contains(d));
        }
        expanded
    } else if !rule.bymonthday.is_empty() {
        rule.bymonthday
            .iter()
            .filter_map(|&d| resolve_monthday(year, month, d))
            .collect()
    } else {
        NaiveDate::from_ymd_opt(year, month, anchor_day)
            .into_iter()
            .collect()
    };
    days.sort_unstable();
    days.dedup();
    days
}

fn apply_bysetpos(mut dates: Vec<NaiveDate>, bysetpos: &[i32]) -> Vec<NaiveDate> {
    if bysetpos.is_empty() || dates.is_empty() {
        return dates;
    }
    let len = dates.len() as i32;
    let mut selected: Vec<NaiveDate> = bysetpos
        .iter()
        .filter_map(|&pos| {
            let idx = if pos > 0 { pos - 1 } else { len + pos };
            if (0..len).contains(&idx) {
                Some(dates[idx as usize])
            } else {
                None
            }
        })
        .collect();
    selected.sort_unstable();
    selected.dedup();
    dates = selected;
    dates
}

fn month_allowed(rule: &ParsedRule, month: u32) -> bool {
    rule.bymonth.is_empty() || rule.bymonth.contains(&month)
}

/// Start of the week containing `date` for a given week start (0 = Monday).
fn start_of_week(date: NaiveDate, wkst: u8) -> NaiveDate {
    let offset = (7 + weekday_index(date) as i64 - wkst as i64) % 7;
    date - Duration::days(offset)
}

fn add_months(year: i32, month: u32, delta: u32) -> (i32, u32) {
    let zero_based = (year as i64) * 12 + (month as i64 - 1) + delta as i64;
    ((zero_based / 12) as i32, (zero_based % 12 + 1) as u32)
}

/// Streaming occurrence iterator. Monotonic; terminates on COUNT, UNTIL, or
/// a dry stretch of `MAX_EMPTY_PERIODS` candidate periods.
pub struct Occurrences<'r> {
    rule: &'r ParsedRule,
    dtstart: NaiveDateTime,
    time: NaiveTime,
    period: u64,
    buffer: VecDeque<NaiveDateTime>,
    emitted: u32,
    empty_streak: u32,
    done: bool,
}

impl<'r> Occurrences<'r> {
    pub fn new(rule: &'r ParsedRule, dtstart: NaiveDateTime) -> Self {
        Occurrences {
            rule,
            dtstart,
            time: dtstart.time(),
            period: 0,
            buffer: VecDeque::new(),
            emitted: 0,
            empty_streak: 0,
            done: false,
        }
    }

    /// Candidate dates for period `k` (already BYSETPOS-filtered, sorted).
    fn period_dates(&self, k: u64) -> Option<Vec<NaiveDate>> {
        let rule = self.rule;
        let stride = rule.interval as u64;
        let start_date = self.dtstart.date();

        let dates = match rule.freq {
            RuleFreq::Daily => {
                let date = start_date.checked_add_signed(Duration::days((k * stride) as i64))?;
                let mut ok = month_allowed(rule, date.month());
                if ok && !rule.byday.is_empty() {
                    ok = rule.byday.iter().any(|bd| bd.weekday == weekday_index(date));
                }
                if ok && !rule.bymonthday.is_empty() {
                    ok = rule
                        .bymonthday
                        .iter()
                        .any(|&d| resolve_monthday(date.year(), date.month(), d) == Some(date));
                }
                if ok {
                    vec![date]
                } else {
                    Vec::new()
                }
            }
            RuleFreq::Weekly => {
                let week0 = start_of_week(start_date, rule.wkst);
                let week_start =
                    week0.checked_add_signed(Duration::days((k * stride * 7) as i64))?;
                let weekdays: Vec<u8> = if rule.byday.is_empty() {
                    vec![weekday_index(start_date)]
                } else {
                    rule.byday.iter().map(|bd| bd.weekday).collect()
                };
                (0..7)
                    .filter_map(|d| week_start.checked_add_signed(Duration::days(d)))
                    .filter(|d| weekdays.contains(&weekday_index(*d)))
                    .filter(|d| month_allowed(rule, d.month()))
                    .collect()
            }
            RuleFreq::Monthly => {
                let (year, month) =
                    add_months(start_date.year(), start_date.month(), (k * stride) as u32);
                if !month_allowed(rule, month) {
                    Vec::new()
                } else {
                    month_candidates(rule, year, month, start_date.day())
                }
            }
            RuleFreq::Yearly => {
                let year = start_date.year() + (k * stride) as i32;
                let mut days: Vec<NaiveDate> = if !rule.byday.is_empty() && rule.bymonth.is_empty()
                {
                    // BYDAY over the whole year (e.g. "last Sunday of the year"),
                    // optionally limited by BYMONTHDAY.
                    let mut expanded: Vec<NaiveDate> = rule
                        .byday
                        .iter()
                        .flat_map(|bd| expand_byday_in_year(year, bd))
                        .collect();
                    if !rule.bymonthday.is_empty() {
                        expanded.retain(|d| {
                            rule.bymonthday.iter().any(|&md| {
                                resolve_monthday(d.year(), d.month(), md) == Some(*d)
                            })
                        });
                    }
                    expanded
                } else {
                    let months: Vec<u32> = if rule.bymonth.is_empty() {
                        vec![start_date.month()]
                    } else {
                        rule.bymonth.clone()
                    };
                    months
                        .iter()
                        .flat_map(|&m| month_candidates(rule, year, m, start_date.day()))
                        .collect()
                };
                days.sort_unstable();
                days.dedup();
                days
            }
        };
        Some(apply_bysetpos(dates, &rule.bysetpos))
    }

    fn refill(&mut self) -> bool {
        loop {
            if self.done {
                return false;
            }
            let Some(dates) = self.period_dates(self.period) else {
                self.done = true;
                return false;
            };
            self.period += 1;

            self.buffer = dates
                .into_iter()
                .map(|d| d.and_time(self.time))
                .filter(|dt| *dt >= self.dtstart)
                .collect();

            if self.buffer.is_empty() {
                self.empty_streak += 1;
                if self.empty_streak > MAX_EMPTY_PERIODS {
                    self.done = true;
                    return false;
                }
                continue;
            }
            self.empty_streak = 0;
            return true;
        }
    }
}

impl Iterator for Occurrences<'_> {
    type Item = NaiveDateTime;

    fn next(&mut self) -> Option<NaiveDateTime> {
        if self.done {
            return None;
        }
        if let Some(count) = self.rule.count {
            if self.emitted >= count {
                self.done = true;
                return None;
            }
        }
        loop {
            let Some(next) = self.buffer.pop_front() else {
                if !self.refill() {
                    return None;
                }
                continue;
            };
            if let Some(until) = self.rule.until {
                if next > until {
                    self.done = true;
                    return None;
                }
            }
            self.emitted += 1;
            return Some(next);
        }
    }
}
