//! JavaScript `Date` arithmetic, reproduced exactly.
//!
//! The date engine is a port of chrono-node, which is written against JS
//! `Date`. Two of its behaviours are load-bearing and differ from
//! `chrono::NaiveDate`:
//!
//! 1. **Out-of-range fields normalise rather than fail.** `new Date(2026, 1, 31)`
//!    is 3 March, not an error. chrono-node relies on this to *reject* invalid
//!    dates: `isValidDate()` builds the date, reads the fields back, and drops
//!    the result if they moved. Returning `None` for 31 February instead would
//!    change which results survive.
//! 2. **Field setters are sequential and lossy.** `setMonth(getMonth() + 1)` on
//!    31 January gives 3 March, because the day is applied to the new month
//!    without clamping. `addDuration` is a chain of such setters, so month and
//!    year offsets inherit that.
//!
//! So this models a JS date the way the spec does — MakeDay + MakeTime over an
//! integer day number — rather than wrapping `NaiveDate` and hoping the edges
//! agree. Milliseconds are kept because chrono-node assigns and compares them.

use chrono::{Datelike, Days, NaiveDate, NaiveDateTime, TimeDelta, Timelike};

/// A JS `Date` value: an instant with no timezone, to millisecond resolution.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct JsDate(NaiveDateTime);

/// The widest span the engine can represent. JS clamps to ±8.64e15 ms from the
/// epoch; chrono's `NaiveDate` is narrower, and a date that lands outside it is
/// a parse that should be thrown away rather than panicked over.
fn make_day(year: i64, month0: i64, day: i64) -> Option<NaiveDate> {
    let total_months = year.checked_mul(12)?.checked_add(month0)?;
    let y = i32::try_from(total_months.div_euclid(12)).ok()?;
    let m = u32::try_from(total_months.rem_euclid(12)).ok()? + 1;
    let first = NaiveDate::from_ymd_opt(y, m, 1)?;
    let offset = day.checked_sub(1)?;
    if offset >= 0 {
        first.checked_add_days(Days::new(u64::try_from(offset).ok()?))
    } else {
        first.checked_sub_days(Days::new(u64::try_from(-offset).ok()?))
    }
}

impl JsDate {
    /// `new Date(year, month0, day, hour, minute, second, millisecond)`, with
    /// every field allowed out of range and normalised the way JS normalises.
    ///
    /// Returns `None` only when the result falls outside the representable
    /// range — JS would give `Invalid Date`, and every caller here treats that
    /// as "no result", which is what chrono-node's validity filter does anyway.
    #[allow(clippy::too_many_arguments)]
    pub fn from_parts(
        year: i64,
        month0: i64,
        day: i64,
        hour: i64,
        minute: i64,
        second: i64,
        millisecond: i64,
    ) -> Option<Self> {
        let date = make_day(year, month0, day)?;
        let ms = hour
            .checked_mul(3_600_000)?
            .checked_add(minute.checked_mul(60_000)?)?
            .checked_add(second.checked_mul(1_000)?)?
            .checked_add(millisecond)?;
        let delta = TimeDelta::try_milliseconds(ms)?;
        Some(Self(
            date.and_time(Default::default())
                .checked_add_signed(delta)?,
        ))
    }

    pub fn from_naive(dt: NaiveDateTime) -> Self {
        Self(dt)
    }

    pub fn naive(self) -> NaiveDateTime {
        self.0
    }

    pub fn year(self) -> i64 {
        i64::from(self.0.year())
    }

    /// Zero-based, like `Date.prototype.getMonth`.
    pub fn month0(self) -> i64 {
        i64::from(self.0.month0())
    }

    pub fn day(self) -> i64 {
        i64::from(self.0.day())
    }

    /// Sunday = 0, like `Date.prototype.getDay`.
    pub fn weekday(self) -> i64 {
        i64::from(self.0.weekday().num_days_from_sunday())
    }

    pub fn hour(self) -> i64 {
        i64::from(self.0.hour())
    }

    pub fn minute(self) -> i64 {
        i64::from(self.0.minute())
    }

    pub fn second(self) -> i64 {
        i64::from(self.0.second())
    }

    pub fn millisecond(self) -> i64 {
        i64::from(self.0.and_utc().timestamp_subsec_millis())
    }

    /// Rebuild with one field replaced, leaving the rest as they are — the
    /// shape every `setX` call in chrono-node takes. Out-of-range values
    /// normalise, so `with_day(self.day() + 40)` rolls into the next month.
    fn with(self, field: Field, value: i64) -> Option<Self> {
        let (mut y, mut mo, mut d) = (self.year(), self.month0(), self.day());
        let (mut h, mut mi, mut s, mut ms) = (
            self.hour(),
            self.minute(),
            self.second(),
            self.millisecond(),
        );
        match field {
            Field::Year => y = value,
            Field::Month => mo = value,
            Field::Day => d = value,
            Field::Hour => h = value,
            Field::Minute => mi = value,
            Field::Second => s = value,
            Field::Millisecond => ms = value,
        }
        Self::from_parts(y, mo, d, h, mi, s, ms)
    }

    pub fn set_year(self, year: i64) -> Option<Self> {
        self.with(Field::Year, year)
    }

    pub fn set_month0(self, month0: i64) -> Option<Self> {
        self.with(Field::Month, month0)
    }

    pub fn set_day(self, day: i64) -> Option<Self> {
        self.with(Field::Day, day)
    }

    pub fn set_hour(self, hour: i64) -> Option<Self> {
        self.with(Field::Hour, hour)
    }

    pub fn set_minute(self, minute: i64) -> Option<Self> {
        self.with(Field::Minute, minute)
    }

    pub fn set_second(self, second: i64) -> Option<Self> {
        self.with(Field::Second, second)
    }

    pub fn set_millisecond(self, millisecond: i64) -> Option<Self> {
        self.with(Field::Millisecond, millisecond)
    }

    pub fn add_days(self, days: i64) -> Option<Self> {
        self.set_day(self.day() + days)
    }

    pub fn add_minutes(self, minutes: i64) -> Option<Self> {
        self.set_minute(self.minute() + minutes)
    }
}

enum Field {
    Year,
    Month,
    Day,
    Hour,
    Minute,
    Second,
    Millisecond,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i64, m0: i64, day: i64) -> JsDate {
        JsDate::from_parts(y, m0, day, 0, 0, 0, 0).expect("representable")
    }

    #[test]
    fn out_of_range_day_rolls_into_the_next_month() {
        // new Date(2026, 1, 31) === 2026-03-03 in JS.
        let rolled = d(2026, 1, 31);
        assert_eq!(rolled.year(), 2026);
        assert_eq!(rolled.month0(), 2);
        assert_eq!(rolled.day(), 3);
    }

    #[test]
    fn setting_a_month_carries_an_overlong_day() {
        // Jan 31 + 1 month is March 3, not February 28 — the behaviour
        // addDuration inherits for month and year offsets.
        let jan31 = d(2026, 0, 31);
        let shifted = jan31.set_month0(jan31.month0() + 1).expect("representable");
        assert_eq!((shifted.month0(), shifted.day()), (2, 3));
    }

    #[test]
    fn month_underflow_and_overflow_move_the_year() {
        assert_eq!(d(2026, -1, 15).year(), 2025);
        assert_eq!(d(2026, -1, 15).month0(), 11);
        assert_eq!(d(2026, 12, 15).year(), 2027);
        assert_eq!(d(2026, 12, 15).month0(), 0);
    }

    #[test]
    fn day_zero_is_the_last_day_of_the_previous_month() {
        let last = d(2026, 3, 0);
        assert_eq!((last.month0(), last.day()), (2, 31));
    }

    #[test]
    fn leap_day_survives_and_the_following_year_does_not() {
        assert_eq!(d(2024, 1, 29).day(), 29);
        // 2026 is not a leap year, so Feb 29 normalises to March 1 — which is
        // how `isValidDate` notices the date was never real.
        let normalised = d(2026, 1, 29);
        assert_eq!((normalised.month0(), normalised.day()), (2, 1));
    }

    #[test]
    fn time_fields_carry_into_the_day() {
        let late = JsDate::from_parts(2026, 2, 15, 25, 0, 0, 0).expect("representable");
        assert_eq!((late.day(), late.hour()), (16, 1));
    }

    #[test]
    fn weekday_is_sunday_zero() {
        // 2026-03-15 is a Sunday.
        assert_eq!(d(2026, 2, 15).weekday(), 0);
        assert_eq!(d(2026, 2, 16).weekday(), 1);
        assert_eq!(d(2026, 2, 21).weekday(), 6);
    }

    #[test]
    fn an_unrepresentable_date_is_none_rather_than_a_panic() {
        assert!(JsDate::from_parts(i64::MAX, 0, 1, 0, 0, 0, 0).is_none());
        assert!(JsDate::from_parts(2026, i64::MIN, 1, 0, 0, 0, 0).is_none());
    }
}
