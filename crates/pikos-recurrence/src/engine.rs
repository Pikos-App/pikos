//! Occurrence enumeration and the operations mirrored from `recurrence.ts`.
//!
//! The core is [`OccurrenceIter`], a lazy generator of rule-matching wall-clock
//! *dates* (`>=` the anchor date, honoring COUNT then UNTIL). Callers layer on
//! the anchor's time-of-day, exclusion sets, and range bounds. COUNT is applied
//! to the generated sequence *before* exclusions — matching rrule.js, where
//! EXDATEs remove from an already-counted set.

use std::collections::HashSet;

use chrono::{Datelike, Days, NaiveDate, NaiveDateTime, NaiveTime};

use crate::rule::{build_rrule, parse_rrule, ByDay, Freq, ParsedRule, RecurrenceError};
use crate::WallClock;

/// One expanded occurrence, wall-clock strings throughout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Occurrence {
    pub original_date: String,
    pub scheduled_start: String,
    pub scheduled_end: Option<String>,
}

/// A far-open series would scan forever if a rule can never match (e.g. an
/// impossible BYMONTHDAY); bail after this many consecutive empty periods.
const MAX_EMPTY_PERIODS: u32 = 1200;

struct OccurrenceIter<'a> {
    rule: &'a ParsedRule,
    dtstart: NaiveDate,
    /// Anchor time-of-day; drives the datetime used for UNTIL comparison.
    anchor_time: NaiveTime,
    period: i64,
    buffer: std::collections::VecDeque<NaiveDate>,
    emitted: u32,
    empty_periods: u32,
    done: bool,
}

impl<'a> OccurrenceIter<'a> {
    fn new(rule: &'a ParsedRule, dtstart: NaiveDate, anchor_time: NaiveTime) -> Self {
        OccurrenceIter {
            rule,
            dtstart,
            anchor_time,
            period: 0,
            buffer: std::collections::VecDeque::new(),
            emitted: 0,
            empty_periods: 0,
            done: false,
        }
    }

    /// Fast-forwards near `target` so far-future queries don't scan every period
    /// from the anchor. Only safe without COUNT (COUNT needs the running total),
    /// so callers guard on that.
    fn seek_near(&mut self, target: NaiveDate) {
        let approx = match self.rule.freq {
            Freq::Daily => days_between(self.dtstart, target) / self.rule.interval as i64,
            Freq::Weekly => {
                let w0 = start_of_week(self.dtstart, self.rule.wkst);
                days_between(w0, target) / (self.rule.interval as i64 * 7)
            }
            Freq::Monthly => months_between(self.dtstart, target) / self.rule.interval as i64,
            Freq::Yearly => {
                (target.year() - self.dtstart.year()) as i64 / self.rule.interval as i64
            }
        };
        self.period = (approx - 2).max(0);
    }

    fn fill(&mut self) {
        while self.buffer.is_empty() && !self.done {
            let mut candidates = candidates_for(self.rule, self.dtstart, self.period);
            self.period += 1;
            candidates.retain(|d| *d >= self.dtstart);
            candidates.sort_unstable();
            candidates.dedup();
            if candidates.is_empty() {
                self.empty_periods += 1;
                if self.empty_periods >= MAX_EMPTY_PERIODS {
                    self.done = true;
                }
                continue;
            }
            self.empty_periods = 0;
            self.buffer.extend(candidates);
        }
    }
}

impl Iterator for OccurrenceIter<'_> {
    type Item = NaiveDate;

    fn next(&mut self) -> Option<NaiveDate> {
        if let Some(count) = self.rule.count {
            if self.emitted >= count {
                return None;
            }
        }
        self.fill();
        let date = self.buffer.pop_front()?;
        if let Some(until) = self.rule.until {
            if date.and_time(self.anchor_time) > until {
                self.done = true;
                return None;
            }
        }
        self.emitted += 1;
        Some(date)
    }
}

/// Rule-matching dates within period index `m`, unfiltered by the `>= dtstart`
/// / COUNT / UNTIL constraints the iterator applies.
fn candidates_for(rule: &ParsedRule, dtstart: NaiveDate, m: i64) -> Vec<NaiveDate> {
    match rule.freq {
        Freq::Daily => daily_candidates(rule, dtstart, m),
        Freq::Weekly => weekly_candidates(rule, dtstart, m),
        Freq::Monthly => monthly_candidates(rule, dtstart, m),
        Freq::Yearly => yearly_candidates(rule, dtstart, m),
    }
}

fn daily_candidates(rule: &ParsedRule, dtstart: NaiveDate, m: i64) -> Vec<NaiveDate> {
    add_days_signed(dtstart, m * rule.interval as i64)
        .into_iter()
        .collect()
}

fn weekly_candidates(rule: &ParsedRule, dtstart: NaiveDate, m: i64) -> Vec<NaiveDate> {
    let week0 = start_of_week(dtstart, rule.wkst);
    let Some(week_start) = add_days_signed(week0, m * rule.interval as i64 * 7) else {
        return vec![];
    };
    let weekdays: Vec<u8> = if rule.byday.is_empty() {
        vec![weekday_index(dtstart)]
    } else {
        rule.byday.iter().map(|b| b.weekday).collect()
    };
    weekdays
        .iter()
        .filter_map(|&wd| {
            let offset = (wd + 7 - rule.wkst) % 7;
            add_days_signed(week_start, offset as i64)
        })
        .collect()
}

fn monthly_candidates(rule: &ParsedRule, dtstart: NaiveDate, m: i64) -> Vec<NaiveDate> {
    let (year, month) = add_months(dtstart.year(), dtstart.month(), m * rule.interval as i64);
    let mut dates: Vec<NaiveDate> = if !rule.bymonthday.is_empty() {
        rule.bymonthday
            .iter()
            .filter_map(|&md| resolve_monthday(year, month, md))
            .collect()
    } else if !rule.byday.is_empty() {
        rule.byday
            .iter()
            .flat_map(|b| byday_in_month(year, month, b))
            .collect()
    } else {
        resolve_monthday(year, month, dtstart.day() as i32)
            .into_iter()
            .collect()
    };
    dates.sort_unstable();
    dates.dedup();
    if !rule.bysetpos.is_empty() {
        dates = apply_setpos(&dates, &rule.bysetpos);
    }
    dates
}

fn yearly_candidates(rule: &ParsedRule, dtstart: NaiveDate, m: i64) -> Vec<NaiveDate> {
    let year = dtstart.year() + (m * rule.interval as i64) as i32;
    NaiveDate::from_ymd_opt(year, dtstart.month(), dtstart.day())
        .into_iter()
        .collect()
}

/// Picks BYSETPOS positions (1-based; negative from the end) out of the sorted
/// period candidates.
fn apply_setpos(sorted: &[NaiveDate], setpos: &[i32]) -> Vec<NaiveDate> {
    let len = sorted.len() as i32;
    let mut picked: Vec<NaiveDate> = setpos
        .iter()
        .filter_map(|&pos| {
            let idx = if pos > 0 { pos - 1 } else { len + pos };
            (idx >= 0 && idx < len).then(|| sorted[idx as usize])
        })
        .collect();
    picked.sort_unstable();
    picked.dedup();
    picked
}

/// All dates in `(year, month)` whose weekday matches `b`, filtered to the
/// ordinal if one is set (`1MO` = first Monday, `-1FR` = last Friday).
fn byday_in_month(year: i32, month: u32, b: &ByDay) -> Vec<NaiveDate> {
    let mut all = Vec::new();
    let mut day = NaiveDate::from_ymd_opt(year, month, 1).unwrap();
    while day.month() == month {
        if weekday_index(day) == b.weekday {
            all.push(day);
        }
        let Some(next) = day.checked_add_days(Days::new(1)) else {
            break;
        };
        day = next;
    }
    match b.ordinal {
        None => all,
        Some(n) if n > 0 => all.get((n - 1) as usize).copied().into_iter().collect(),
        Some(n) => {
            let idx = all.len() as i32 + n;
            (idx >= 0)
                .then(|| all.get(idx as usize).copied())
                .flatten()
                .into_iter()
                .collect()
        }
    }
}

fn resolve_monthday(year: i32, month: u32, md: i32) -> Option<NaiveDate> {
    let dim = days_in_month(year, month) as i32;
    let day = if md > 0 { md } else { dim + md + 1 };
    (day >= 1 && day <= dim)
        .then(|| NaiveDate::from_ymd_opt(year, month, day as u32))
        .flatten()
}

// ─── Public operations (mirrors of recurrence.ts) ────────────────────────────

/// Expands a rule into occurrences within `[range_start, range_end)`, skipping
/// `exdates`. Mirrors `expandRecurrenceForRange`.
pub fn expand_range(
    rrule: &str,
    start: &str,
    end: Option<&str>,
    range_start: &str,
    range_end: &str,
    exdates: &[String],
) -> Result<Vec<Occurrence>, RecurrenceError> {
    let rule = ParsedRule::parse(rrule)?;
    let anchor =
        WallClock::parse(start).ok_or_else(|| RecurrenceError::Parse(start.to_string()))?;
    let range_start = parse_dt(range_start)?;
    let range_end = parse_dt(range_end)?;
    let duration = timed_duration(&anchor, end);
    let excluded: HashSet<&str> = exdates.iter().map(String::as_str).collect();

    let anchor_time = anchor.time.unwrap_or(NaiveTime::MIN);
    let mut out = Vec::new();
    for date in OccurrenceIter::new(&rule, anchor.date, anchor_time) {
        let occ = occ_wallclock(&anchor, date);
        let dt = occ.as_datetime();
        if dt >= range_end {
            break;
        }
        if dt < range_start {
            continue;
        }
        let date_str = date.format("%Y-%m-%d").to_string();
        if excluded.contains(date_str.as_str()) {
            continue;
        }
        out.push(Occurrence {
            scheduled_end: duration.map(|mins| occ_end(&occ, mins)),
            scheduled_start: occ.format(),
            original_date: date_str,
        });
    }
    Ok(out)
}

/// Next occurrence strictly after the end of `after`'s day, skipping `exdates`.
/// Mirrors `nextOccurrenceAfter` (which always returns a null end).
pub fn next_occurrence_after(
    rrule: &str,
    start: &str,
    after: &str,
    exdates: &[String],
) -> Result<Option<(String, Option<String>)>, RecurrenceError> {
    let rule = ParsedRule::parse(rrule)?;
    let anchor =
        WallClock::parse(start).ok_or_else(|| RecurrenceError::Parse(start.to_string()))?;
    let after_date = parse_dt(after)?.date();
    let cursor = after_date.and_hms_opt(23, 59, 59).unwrap();
    let excluded: HashSet<&str> = exdates.iter().map(String::as_str).collect();

    let occ = seek_after(&rule, &anchor, cursor, false, &excluded);
    Ok(occ.map(|o| (o.format(), None)))
}

/// Snaps `anchor` to the first occurrence the rule permits on or after it,
/// preserving the anchor's time. Mirrors `snapAnchorToRule`.
pub fn snap_anchor_to_rule(rrule: &str, anchor: &str) -> String {
    let (Ok(rule), Some(wc)) = (ParsedRule::parse(rrule), WallClock::parse(anchor)) else {
        return anchor.to_string();
    };
    let cursor = wc.as_datetime();
    match seek_after(&rule, &wc, cursor, true, &HashSet::new()) {
        Some(o) => o.format(),
        None => anchor.to_string(),
    }
}

/// Realigns a single-BYDAY weekly rule's weekday to a moved anchor. Mirrors
/// `alignWeeklyRuleToAnchor` — returns the input verbatim when not applicable.
pub fn align_weekly_rule_to_anchor(rrule: &str, anchor_start: &str) -> String {
    let Some(opts) = parse_rrule(rrule) else {
        return rrule.to_string();
    };
    if opts.freq != Some(Freq::Weekly) {
        return rrule.to_string();
    }
    let byweekday = match &opts.byweekday {
        Some(days) if days.len() == 1 => days[0],
        _ => return rrule.to_string(),
    };
    let Some(wc) = WallClock::parse(anchor_start) else {
        return rrule.to_string();
    };
    let anchor_weekday = weekday_index(wc.date);
    if byweekday == anchor_weekday {
        return rrule.to_string();
    }
    build_rrule(&crate::rule::RecurrenceOptions {
        byweekday: Some(vec![anchor_weekday]),
        ..opts
    })
}

/// `YYYY-MM-DD` for every occurrence strictly after `after` and strictly before
/// `before`, skipping `exdates`. Mirrors `missedOccurrencesBetween`.
pub fn missed_occurrences_between(
    rrule: &str,
    start: &str,
    after: &str,
    before: &str,
    exdates: &[String],
) -> Result<Vec<String>, RecurrenceError> {
    let after_dt = parse_dt(after)?;
    let before_dt = parse_dt(before)?;
    if before_dt <= after_dt {
        return Ok(vec![]);
    }
    let rule = ParsedRule::parse(rrule)?;
    let anchor =
        WallClock::parse(start).ok_or_else(|| RecurrenceError::Parse(start.to_string()))?;
    let excluded: HashSet<&str> = exdates.iter().map(String::as_str).collect();
    let anchor_time = anchor.time.unwrap_or(NaiveTime::MIN);

    let mut iter = OccurrenceIter::new(&rule, anchor.date, anchor_time);
    if rule.count.is_none() {
        iter.seek_near(after_dt.date());
    }
    let mut out = Vec::new();
    for date in iter {
        let occ = occ_wallclock(&anchor, date);
        let dt = occ.as_datetime();
        if dt <= after_dt {
            continue;
        }
        if dt >= before_dt {
            break;
        }
        let date_str = date.format("%Y-%m-%d").to_string();
        if !excluded.contains(date_str.as_str()) {
            out.push(date_str);
        }
    }
    Ok(out)
}

/// First occurrence from the anchor whose date is not in `exclusions`. `None`
/// once a finite series is exhausted (its terminal state). Enumeration starts at
/// the base and walks forward, so it may land in the past (an overdue head) — the
/// exclusion set, not `now`, decides where the head sits. Excludes by date-only
/// key (a rule yields at most one occurrence per date), so a timed exclusion
/// string still matches.
pub fn oldest_open_occurrence(
    rrule: &str,
    start: &str,
    end: Option<&str>,
    exclusions: &[String],
) -> Result<Option<Occurrence>, RecurrenceError> {
    let rule = ParsedRule::parse(rrule)?;
    let anchor =
        WallClock::parse(start).ok_or_else(|| RecurrenceError::Parse(start.to_string()))?;
    let duration = timed_duration(&anchor, end);
    let excluded: HashSet<&str> = exclusions.iter().map(|s| date_key(s)).collect();
    let anchor_time = anchor.time.unwrap_or(NaiveTime::MIN);

    for date in OccurrenceIter::new(&rule, anchor.date, anchor_time) {
        let date_str = date.format("%Y-%m-%d").to_string();
        if excluded.contains(date_str.as_str()) {
            continue;
        }
        let occ = occ_wallclock(&anchor, date);
        return Ok(Some(Occurrence {
            scheduled_end: duration.map(|mins| occ_end(&occ, mins)),
            scheduled_start: occ.format(),
            original_date: date_str,
        }));
    }
    Ok(None)
}

/// Occurrences whose start wall-clock lands in the inclusive `[lo, hi]` range,
/// skipping `exclusions`. Unlike [`expand_range`], this **seeks near `lo`** (no
/// COUNT to preserve) so a pinned-base series whose anchor is far in the past
/// doesn't scan every period from the anchor — the reminder window sits near
/// `now`, arbitrarily far from a synced series' base. Runs to COUNT/UNTIL, so a
/// far-future occurrence inside the window is never dropped by a cap.
pub fn occurrences_in_window(
    rrule: &str,
    start: &str,
    end: Option<&str>,
    lo: &str,
    hi: &str,
    exclusions: &[String],
) -> Result<Vec<Occurrence>, RecurrenceError> {
    let rule = ParsedRule::parse(rrule)?;
    let anchor =
        WallClock::parse(start).ok_or_else(|| RecurrenceError::Parse(start.to_string()))?;
    let lo_dt = parse_dt(lo)?;
    let hi_dt = parse_dt(hi)?;
    let duration = timed_duration(&anchor, end);
    let excluded: HashSet<&str> = exclusions.iter().map(|s| date_key(s)).collect();
    let anchor_time = anchor.time.unwrap_or(NaiveTime::MIN);

    let mut iter = OccurrenceIter::new(&rule, anchor.date, anchor_time);
    if rule.count.is_none() {
        iter.seek_near(lo_dt.date());
    }
    let mut out = Vec::new();
    for date in iter {
        let occ = occ_wallclock(&anchor, date);
        let dt = occ.as_datetime();
        if dt < lo_dt {
            continue;
        }
        if dt > hi_dt {
            break;
        }
        let date_str = date.format("%Y-%m-%d").to_string();
        if excluded.contains(date_str.as_str()) {
            continue;
        }
        out.push(Occurrence {
            scheduled_end: duration.map(|mins| occ_end(&occ, mins)),
            scheduled_start: occ.format(),
            original_date: date_str,
        });
    }
    Ok(out)
}

/// The `YYYY-MM-DD` prefix of an occurrence key. Exclusion sets store either a
/// date (`original_date`) or a timed wall-clock (`completed_set`); both key on the
/// day, since a rule yields one occurrence per date.
fn date_key(s: &str) -> &str {
    &s[..s.len().min(10)]
}

/// Applies the base occurrence's duration to `next_start`, rolling an overnight
/// end to the following day. Mirrors `computeNextEnd`; `None` for all-day.
pub fn compute_next_end(base_end: &str, next_start: &str) -> Option<String> {
    let base = WallClock::parse(base_end)?;
    let next = WallClock::parse(next_start)?;
    let (base_time, next_time) = (base.time?, next.time?);
    let mut end = next.date.and_time(base_time);
    if end <= next.date.and_time(next_time) {
        end = end.checked_add_days(Days::new(1))?;
    }
    Some(
        WallClock {
            date: end.date(),
            time: Some(end.time()),
        }
        .format(),
    )
}

// ─── Enumeration helpers ─────────────────────────────────────────────────────

/// First occurrence whose datetime is `>`/`>=` (per `inclusive`) `cursor`,
/// skipping `excluded`. Seeks near the cursor when there's no COUNT to preserve.
fn seek_after(
    rule: &ParsedRule,
    anchor: &WallClock,
    cursor: NaiveDateTime,
    inclusive: bool,
    excluded: &HashSet<&str>,
) -> Option<WallClock> {
    let anchor_time = anchor.time.unwrap_or(NaiveTime::MIN);
    let mut iter = OccurrenceIter::new(rule, anchor.date, anchor_time);
    if rule.count.is_none() {
        iter.seek_near(cursor.date());
    }
    for date in iter {
        let occ = occ_wallclock(anchor, date);
        let dt = occ.as_datetime();
        let past = if inclusive { dt >= cursor } else { dt > cursor };
        if !past {
            continue;
        }
        if excluded.contains(date.format("%Y-%m-%d").to_string().as_str()) {
            continue;
        }
        return Some(occ);
    }
    None
}

/// The occurrence on `date` carrying the anchor's time (or all-day when the
/// anchor is date-only).
fn occ_wallclock(anchor: &WallClock, date: NaiveDate) -> WallClock {
    WallClock {
        date,
        time: anchor.time,
    }
}

/// Duration in minutes for a timed anchor with an end; `None` for all-day or
/// when no end is set.
fn timed_duration(anchor: &WallClock, end: Option<&str>) -> Option<i64> {
    if anchor.is_all_day() {
        return None;
    }
    let end = WallClock::parse(end?)?;
    Some((end.as_datetime() - anchor.as_datetime()).num_minutes())
}

fn occ_end(start: &WallClock, minutes: i64) -> String {
    let end = start.as_datetime() + chrono::Duration::minutes(minutes);
    WallClock {
        date: end.date(),
        time: Some(end.time()),
    }
    .format()
}

fn parse_dt(s: &str) -> Result<NaiveDateTime, RecurrenceError> {
    WallClock::parse(s)
        .map(|w| w.as_datetime())
        .ok_or_else(|| RecurrenceError::Parse(s.to_string()))
}

// ─── Date arithmetic (rrule.js weekday convention: 0 = Monday) ───────────────

fn weekday_index(date: NaiveDate) -> u8 {
    date.weekday().num_days_from_monday() as u8
}

fn start_of_week(date: NaiveDate, wkst: u8) -> NaiveDate {
    let offset = (weekday_index(date) + 7 - wkst) % 7;
    date - Days::new(offset as u64)
}

fn add_days_signed(date: NaiveDate, days: i64) -> Option<NaiveDate> {
    if days >= 0 {
        date.checked_add_days(Days::new(days as u64))
    } else {
        date.checked_sub_days(Days::new((-days) as u64))
    }
}

fn days_between(from: NaiveDate, to: NaiveDate) -> i64 {
    (to - from).num_days()
}

fn months_between(from: NaiveDate, to: NaiveDate) -> i64 {
    (to.year() - from.year()) as i64 * 12 + (to.month() as i64 - from.month() as i64)
}

fn add_months(year: i32, month: u32, delta: i64) -> (i32, u32) {
    let zero_based = (year as i64) * 12 + (month as i64 - 1) + delta;
    let y = zero_based.div_euclid(12) as i32;
    let m = zero_based.rem_euclid(12) as u32 + 1;
    (y, m)
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let (ny, nm) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    let first_next = NaiveDate::from_ymd_opt(ny, nm, 1).unwrap();
    first_next.pred_opt().unwrap().day()
}
