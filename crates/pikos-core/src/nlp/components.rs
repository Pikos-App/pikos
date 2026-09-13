//! Parsing components: the known/implied split that produces certainty flags.
//!
//! Every parser fills in some fields and leaves the rest to be guessed from the
//! reference time. chrono-node keeps the two apart — `assign` for what the text
//! said, `imply` for what was filled in — and the quick-add parser branches on
//! the difference ("did the user give a time, or am I defaulting to noon?").
//! That split is the whole reason this is a port rather than a thin wrapper
//! over a date library.

use super::jsdate::JsDate;

/// Fields a parser can fill in. `Meridiem` is internal bookkeeping — it decides
/// whether a bare hour means morning or afternoon — and is never reported.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Component {
    Year,
    Month,
    Day,
    Hour,
    Minute,
    Second,
    Millisecond,
    Weekday,
    Meridiem,
    /// Minutes east of UTC, when the text named one.
    ///
    /// Pikos has no timezone concept — see `nlp`'s module docs — so this is
    /// never reported to the caller and never stored. It exists because the
    /// reference *applies* an offset it finds, shifting the wall-clock result,
    /// and a port that ignored it would disagree on any line where one appears.
    TimezoneOffset,
}

impl Component {
    const ALL: [Component; 10] = [
        Component::Year,
        Component::Month,
        Component::Day,
        Component::Hour,
        Component::Minute,
        Component::Second,
        Component::Millisecond,
        Component::Weekday,
        Component::Meridiem,
        Component::TimezoneOffset,
    ];

    fn index(self) -> usize {
        self as usize
    }
}

pub const MERIDIEM_AM: i64 = 0;
pub const MERIDIEM_PM: i64 = 1;

/// The instant a parse is relative to. Pikos parses wall-clock text against a
/// wall-clock reference and stores wall-clock results, so — unlike chrono-node
/// — there is no timezone here at all. See `nlp::mod` for what that gives up.
#[derive(Clone, Copy, Debug)]
pub struct Reference {
    pub instant: JsDate,
}

impl Reference {
    pub fn new(instant: JsDate) -> Self {
        Self { instant }
    }
}

#[derive(Clone, Debug)]
pub struct ParsingComponents {
    known: [Option<i64>; 10],
    implied: [Option<i64>; 10],
}

impl ParsingComponents {
    /// A fresh set of components, pre-filled the way chrono-node pre-fills
    /// them: the reference's date, and midday with zeroed sub-hour fields.
    pub fn new(reference: Reference) -> Self {
        let mut components = Self {
            known: [None; 10],
            implied: [None; 10],
        };
        let date = reference.instant;
        components.imply(Component::Day, date.day());
        components.imply(Component::Month, date.month0() + 1);
        components.imply(Component::Year, date.year());
        components.imply(Component::Hour, 12);
        components.imply(Component::Minute, 0);
        components.imply(Component::Second, 0);
        components.imply(Component::Millisecond, 0);
        components
    }

    pub fn get(&self, component: Component) -> Option<i64> {
        self.known[component.index()].or(self.implied[component.index()])
    }

    /// What the text actually said, as opposed to what was filled in for it.
    pub fn is_certain(&self, component: Component) -> bool {
        self.known[component.index()].is_some()
    }

    pub fn certain_components(&self) -> Vec<Component> {
        Component::ALL
            .into_iter()
            .filter(|c| self.is_certain(*c))
            .collect()
    }

    /// Fill in a field, unless the text already settled it.
    pub fn imply(&mut self, component: Component, value: i64) -> &mut Self {
        if self.known[component.index()].is_some() {
            return self;
        }
        self.implied[component.index()] = Some(value);
        self
    }

    /// Record what the text said, overriding anything filled in for it.
    pub fn assign(&mut self, component: Component, value: i64) -> &mut Self {
        self.known[component.index()] = Some(value);
        self.implied[component.index()] = None;
        self
    }

    pub fn delete(&mut self, component: Component) {
        self.known[component.index()] = None;
        self.implied[component.index()] = None;
    }

    pub fn assign_similar_date(&mut self, target: JsDate) {
        self.assign(Component::Day, target.day());
        self.assign(Component::Month, target.month0() + 1);
        self.assign(Component::Year, target.year());
    }

    pub fn imply_similar_date(&mut self, target: JsDate) {
        self.imply(Component::Day, target.day());
        self.imply(Component::Month, target.month0() + 1);
        self.imply(Component::Year, target.year());
    }

    pub fn assign_similar_time(&mut self, target: JsDate) {
        self.assign(Component::Hour, target.hour());
        self.assign(Component::Minute, target.minute());
        self.assign(Component::Second, target.second());
        self.assign(Component::Millisecond, target.millisecond());
        self.assign(Component::Meridiem, meridiem_of(target.hour()));
    }

    pub fn imply_similar_time(&mut self, target: JsDate) {
        self.imply(Component::Hour, target.hour());
        self.imply(Component::Minute, target.minute());
        self.imply(Component::Second, target.second());
        self.imply(Component::Millisecond, target.millisecond());
        self.imply(Component::Meridiem, meridiem_of(target.hour()));
    }

    /// Shift by a duration and mark everything it touched as implied — used for
    /// "this/next <weekday>", where the *weekday* is what the text said and the
    /// resulting calendar date is merely a consequence.
    pub fn add_duration_as_implied(&mut self, duration: &Duration) -> Option<&mut Self> {
        let current = self.naive()?;
        let date = add_duration(current, duration)?;
        if duration.has_date_part() {
            for component in [
                Component::Day,
                Component::Weekday,
                Component::Month,
                Component::Year,
            ] {
                self.delete(component);
            }
            self.imply(Component::Day, date.day());
            self.imply(Component::Weekday, date.weekday());
            self.imply(Component::Month, date.month0() + 1);
            self.imply(Component::Year, date.year());
        }
        if duration.has_time_part() {
            for component in [Component::Second, Component::Minute, Component::Hour] {
                self.delete(component);
            }
            self.imply(Component::Second, date.second());
            self.imply(Component::Minute, date.minute());
            self.imply(Component::Hour, date.hour());
        }
        Some(self)
    }

    pub fn is_only_date(&self) -> bool {
        !self.is_certain(Component::Hour)
            && !self.is_certain(Component::Minute)
            && !self.is_certain(Component::Second)
    }

    pub fn is_only_time(&self) -> bool {
        !self.is_certain(Component::Weekday)
            && !self.is_certain(Component::Day)
            && !self.is_certain(Component::Month)
            && !self.is_certain(Component::Year)
    }

    pub fn is_only_weekday_component(&self) -> bool {
        self.is_certain(Component::Weekday)
            && !self.is_certain(Component::Day)
            && !self.is_certain(Component::Month)
    }

    pub fn is_date_with_unknown_year(&self) -> bool {
        self.is_certain(Component::Month) && !self.is_certain(Component::Year)
    }

    /// Whether the fields describe a date that exists. Building 31 February
    /// normalises to 3 March, so reading the fields back and finding they moved
    /// is how an impossible date gets rejected.
    pub fn is_valid_date(&self) -> bool {
        // Validity is about the fields themselves, so it asks the unadjusted
        // date — an offset moving 1 March back to 28 February must not make
        // "31 February" look real.
        let Some(date) = self.naive() else {
            return false;
        };
        if Some(date.year()) != self.get(Component::Year) {
            return false;
        }
        if Some(date.month0()) != self.get(Component::Month).map(|m| m - 1) {
            return false;
        }
        if Some(date.day()) != self.get(Component::Day) {
            return false;
        }
        if let Some(hour) = self.get(Component::Hour) {
            if date.hour() != hour {
                return false;
            }
        }
        if let Some(minute) = self.get(Component::Minute) {
            if date.minute() != minute {
                return false;
            }
        }
        true
    }

    /// The fields as written, with no offset applied.
    ///
    /// Distinct from [`Self::date`] and not interchangeable with it: validity
    /// is a question about the fields ("is there a 31st of February?"), so it
    /// is asked of this one, while every comparison between two results is
    /// asked of the adjusted one.
    pub fn naive(&self) -> Option<JsDate> {
        JsDate::from_parts(
            self.get(Component::Year)?,
            self.get(Component::Month)? - 1,
            self.get(Component::Day)?,
            self.get(Component::Hour)?,
            self.get(Component::Minute)?,
            self.get(Component::Second)?,
            self.get(Component::Millisecond)?,
        )
    }

    /// The instant these components describe, with any named offset applied.
    ///
    /// The reference converts into the *system* zone, which for a wall-clock
    /// app read against a wall-clock reference is UTC — so the whole conversion
    /// collapses to subtracting the offset the text named, and to nothing at
    /// all when it named none.
    pub fn date(&self) -> Option<JsDate> {
        let naive = self.naive()?;
        let Some(offset) = self.get(Component::TimezoneOffset) else {
            return Some(naive);
        };
        naive.add_minutes(-offset)
    }

    /// Components for a point a fixed duration from the reference — "in 3
    /// days", "next week". Which fields come out certain depends on the
    /// coarsest unit in the duration, which is why "in 3 days" is certain about
    /// the weekday and "in 2 weeks" is not.
    pub fn relative_from_reference(reference: Reference, duration: &Duration) -> Option<Self> {
        let date = add_duration(reference.instant, duration)?;
        let mut components = Self::new(reference);

        if duration.has_time_part() {
            components.assign_similar_time(date);
            components.assign_similar_date(date);
            // The reference stamps its own offset here, which is zero for a
            // wall-clock reference. The value changes nothing; its *certainty*
            // does, because a certain offset overrides an uncertain one when
            // a date and a time are merged.
            components.assign(Component::TimezoneOffset, 0);
            return Some(components);
        }

        components.imply_similar_time(date);
        components.imply(Component::TimezoneOffset, 0);
        if duration.day.is_some() {
            components.assign(Component::Day, date.day());
            components.assign(Component::Month, date.month0() + 1);
            components.assign(Component::Year, date.year());
            components.assign(Component::Weekday, date.weekday());
        } else if duration.week.is_some() {
            components.assign(Component::Day, date.day());
            components.assign(Component::Month, date.month0() + 1);
            components.assign(Component::Year, date.year());
            components.imply(Component::Weekday, date.weekday());
        } else {
            components.imply(Component::Day, date.day());
            if duration.month.is_some() {
                components.assign(Component::Month, date.month0() + 1);
                components.assign(Component::Year, date.year());
            } else {
                components.imply(Component::Month, date.month0() + 1);
                if duration.year.is_some() {
                    components.assign(Component::Year, date.year());
                } else {
                    components.imply(Component::Year, date.year());
                }
            }
        }
        Some(components)
    }
}

pub fn meridiem_of(hour: i64) -> i64 {
    if hour < 12 {
        MERIDIEM_AM
    } else {
        MERIDIEM_PM
    }
}

/// A signed offset expressed in calendar units. Kept as separate fields rather
/// than a single span because the units are applied in order and each can carry
/// into the next, exactly as `addDuration` does.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Duration {
    pub year: Option<f64>,
    pub quarter: Option<f64>,
    pub month: Option<f64>,
    pub week: Option<f64>,
    pub day: Option<f64>,
    pub hour: Option<f64>,
    pub minute: Option<f64>,
    pub second: Option<f64>,
    pub millisecond: Option<f64>,
}

impl Duration {
    pub fn days(n: f64) -> Self {
        Self {
            day: Some(n),
            ..Default::default()
        }
    }

    pub fn years(n: f64) -> Self {
        Self {
            year: Some(n),
            ..Default::default()
        }
    }

    pub fn has_date_part(&self) -> bool {
        self.day.is_some() || self.week.is_some() || self.month.is_some() || self.year.is_some()
    }

    pub fn has_time_part(&self) -> bool {
        self.hour.is_some()
            || self.minute.is_some()
            || self.second.is_some()
            || self.millisecond.is_some()
    }

    pub fn reversed(&self) -> Self {
        let flip = |v: Option<f64>| v.map(|n| -n);
        Self {
            year: flip(self.year),
            quarter: flip(self.quarter),
            month: flip(self.month),
            week: flip(self.week),
            day: flip(self.day),
            hour: flip(self.hour),
            minute: flip(self.minute),
            second: flip(self.second),
            millisecond: flip(self.millisecond),
        }
    }
}

/// Apply a duration, unit by unit, largest first. A fractional part of one unit
/// spills into the next — "half a day" becomes 12 hours — and each step uses
/// JS setter semantics, so adding a month to 31 January lands in March.
pub fn add_duration(reference: JsDate, duration: &Duration) -> Option<JsDate> {
    let mut date = reference;
    let mut duration = duration.clone();

    if let Some(years) = duration.year {
        let floor = years.floor();
        date = date.set_year(date.year() + floor as i64)?;
        let remainder = years - floor;
        if remainder > 0.0 {
            duration.month = Some(duration.month.unwrap_or(0.0) + remainder * 12.0);
        }
    }
    if let Some(quarters) = duration.quarter {
        date = date.set_month0(date.month0() + quarters.floor() as i64)?;
    }
    if let Some(months) = duration.month {
        let floor = months.floor();
        date = date.set_month0(date.month0() + floor as i64)?;
        let remainder = months - floor;
        if remainder > 0.0 {
            duration.week = Some(duration.week.unwrap_or(0.0) + remainder * 4.0);
        }
    }
    if let Some(weeks) = duration.week {
        let floor = weeks.floor();
        date = date.set_day(date.day() + floor as i64 * 7)?;
        let remainder = weeks - floor;
        if remainder > 0.0 {
            duration.day = Some(duration.day.unwrap_or(0.0) + (remainder * 7.0).round());
        }
    }
    if let Some(days) = duration.day {
        let floor = days.floor();
        date = date.set_day(date.day() + floor as i64)?;
        let remainder = days - floor;
        if remainder > 0.0 {
            duration.hour = Some(duration.hour.unwrap_or(0.0) + (remainder * 24.0).round());
        }
    }
    if let Some(hours) = duration.hour {
        let floor = hours.floor();
        date = date.set_hour(date.hour() + floor as i64)?;
        let remainder = hours - floor;
        if remainder > 0.0 {
            duration.minute = Some(duration.minute.unwrap_or(0.0) + (remainder * 60.0).round());
        }
    }
    if let Some(minutes) = duration.minute {
        let floor = minutes.floor();
        date = date.set_minute(date.minute() + floor as i64)?;
        let remainder = minutes - floor;
        if remainder > 0.0 {
            duration.second = Some(duration.second.unwrap_or(0.0) + (remainder * 60.0).round());
        }
    }
    if let Some(seconds) = duration.second {
        let floor = seconds.floor();
        date = date.set_second(date.second() + floor as i64)?;
        let remainder = seconds - floor;
        if remainder > 0.0 {
            duration.millisecond =
                Some(duration.millisecond.unwrap_or(0.0) + (remainder * 1000.0).round());
        }
    }
    if let Some(milliseconds) = duration.millisecond {
        date = date.set_millisecond(date.millisecond() + milliseconds.floor() as i64)?;
    }
    Some(date)
}

/// One match: where it was found, what it claimed, and the components it
/// resolved to. `end` is present only for ranges.
#[derive(Clone, Debug)]
pub struct ParsingResult {
    /// Byte offset into the parsed text — not a character or UTF-16 index.
    pub index: usize,
    pub text: String,
    pub start: ParsingComponents,
    pub end: Option<ParsingComponents>,
}

impl ParsingResult {
    pub fn new(index: usize, text: String, start: ParsingComponents) -> Self {
        Self {
            index,
            text,
            start,
            end: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference() -> Reference {
        Reference::new(JsDate::from_parts(2026, 2, 15, 12, 0, 0, 0).expect("representable"))
    }

    #[test]
    fn imply_does_not_overwrite_what_the_text_said() {
        let mut components = ParsingComponents::new(reference());
        components.assign(Component::Hour, 9);
        components.imply(Component::Hour, 18);
        assert_eq!(components.get(Component::Hour), Some(9));
        assert!(components.is_certain(Component::Hour));
    }

    #[test]
    fn assign_overrides_a_previously_implied_value() {
        let mut components = ParsingComponents::new(reference());
        // `new` implies midday; a parsed time must win.
        assert_eq!(components.get(Component::Hour), Some(12));
        assert!(!components.is_certain(Component::Hour));
        components.assign(Component::Hour, 9);
        assert_eq!(components.get(Component::Hour), Some(9));
        assert!(components.is_certain(Component::Hour));
    }

    #[test]
    fn a_date_that_never_existed_is_rejected() {
        let mut components = ParsingComponents::new(reference());
        components.assign(Component::Year, 2026);
        components.assign(Component::Month, 2);
        components.assign(Component::Day, 29);
        // 2026 is not a leap year.
        assert!(!components.is_valid_date());

        let mut leap = ParsingComponents::new(reference());
        leap.assign(Component::Year, 2024);
        leap.assign(Component::Month, 2);
        leap.assign(Component::Day, 29);
        assert!(leap.is_valid_date());
    }

    #[test]
    fn a_day_offset_is_certain_about_the_weekday_but_a_week_offset_is_not() {
        // The quirk that makes "in 3 days" and "in 2 weeks" report different
        // certainty despite both being plain day arithmetic.
        let days = ParsingComponents::relative_from_reference(reference(), &Duration::days(3.0))
            .expect("representable");
        assert!(days.is_certain(Component::Weekday));

        let weeks = ParsingComponents::relative_from_reference(
            reference(),
            &Duration {
                week: Some(2.0),
                ..Default::default()
            },
        )
        .expect("representable");
        assert!(!weeks.is_certain(Component::Weekday));
        assert!(weeks.is_certain(Component::Day));
    }

    #[test]
    fn an_hour_offset_makes_every_field_certain() {
        let components = ParsingComponents::relative_from_reference(
            reference(),
            &Duration {
                hour: Some(1.0),
                ..Default::default()
            },
        )
        .expect("representable");
        for component in [
            Component::Year,
            Component::Month,
            Component::Day,
            Component::Hour,
            Component::Minute,
            Component::Second,
        ] {
            assert!(components.is_certain(component), "{component:?}");
        }
        assert_eq!(components.get(Component::Hour), Some(13));
    }

    #[test]
    fn a_month_offset_lands_where_js_lands() {
        let jan31 = JsDate::from_parts(2026, 0, 31, 0, 0, 0, 0).expect("representable");
        let shifted = add_duration(
            jan31,
            &Duration {
                month: Some(1.0),
                ..Default::default()
            },
        )
        .expect("representable");
        assert_eq!((shifted.month0(), shifted.day()), (2, 3));
    }

    #[test]
    fn a_fractional_unit_spills_into_the_next() {
        let noon = JsDate::from_parts(2026, 2, 15, 12, 0, 0, 0).expect("representable");
        let shifted = add_duration(
            noon,
            &Duration {
                day: Some(0.5),
                ..Default::default()
            },
        )
        .expect("representable");
        assert_eq!((shifted.day(), shifted.hour()), (16, 0));
    }
}
