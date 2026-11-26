import Foundation

/// What a `YYYY-MM-DD` day is called in a list, and how to produce one.
///
/// The shared Rust stops at the date, so the naming happens here against the
/// reader's own locale instead of a second locale implementation there.
///
/// A `YYYY-MM-DD` in this app is always a proleptic Gregorian date, because
/// that is what SQLite holds and what the Rust compares. The reader's calendar
/// decides how a date is shown, never how one is parsed or written: a device
/// on the Buddhist calendar numbers 2026 as 2569, and a key built from that
/// matches no row and empties the view with nothing logged. Hence
/// [`gregorian(like:)`], which borrows only the time zone from the caller's calendar.
public enum DayLabel {
    /// "Today", "Tomorrow", or a short date in the reader's locale.
    ///
    /// `today` is passed in, not read from the clock, so a list can't disagree
    /// with itself across midnight and a test can stand on both sides of it.
    ///
    /// Falls back to the raw date for anything it cannot read: a stamp shown as
    /// itself is a visible fault, and a plausible wrong date is not.
    public static func relative(
        _ date: String, today: String, calendar: Calendar = .current
    ) -> String {
        if date == today { return "Today" }
        guard let day = self.date(from: date, in: calendar) else { return date }

        let arithmetic = gregorian(like: calendar)
        if let todayDate = self.date(from: today, in: calendar),
            let tomorrow = arithmetic.date(byAdding: .day, value: 1, to: todayDate),
            arithmetic.isDate(day, inSameDayAs: tomorrow)
        {
            return "Tomorrow"
        }

        // The one place that should follow a non-Gregorian device setting.
        return day.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
    }

    /// A bare day for listing several at once, in the reader's locale order.
    ///
    /// Never relative: in a list of missed days "Today" would read as a mistake.
    /// Falls back to the raw date, like [`relative`].
    public static func short(_ date: String, calendar: Calendar = .current) -> String {
        guard let day = self.date(from: date, in: calendar) else { return date }
        return day.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
    }

    /// Today, as the `YYYY-MM-DD` key the shared Rust compares against.
    ///
    /// Built by hand, not through a `DateFormatter`, which would write the
    /// device calendar's Buddhist or Japanese year into a storage key.
    public static func today(_ calendar: Calendar = .current, now: Date = Date()) -> String {
        let parts = gregorian(like: calendar).dateComponents([.year, .month, .day], from: now)
        guard let year = parts.year, let month = parts.month, let day = parts.day else { return "" }
        return String(format: "%04d-%02d-%02d", year, month, day)
    }

    /// A `YYYY-MM-DD` string as noon on that day, in the caller's time zone.
    ///
    /// Noon, not midnight: a zone that springs forward at 00:00 has no midnight
    /// on that date, and asking for it yields nil or the previous day.
    public static func date(from day: String, in calendar: Calendar = .current) -> Date? {
        let parts = day.split(separator: "-")
        guard parts.count == 3,
            let year = Int(parts[0]), let month = Int(parts[1]), let dayOfMonth = Int(parts[2]),
            (1...12).contains(month), (1...31).contains(dayOfMonth)
        else { return nil }
        let arithmetic = gregorian(like: calendar)
        return arithmetic.date(
            from: DateComponents(
                calendar: arithmetic, timeZone: arithmetic.timeZone,
                year: year, month: month, day: dayOfMonth, hour: 12))
    }

    /// A Gregorian calendar in the same time zone as `calendar`.
    ///
    /// Internal, not private, so `StorageTimestamp.wallClock` shares the one
    /// "force Gregorian, keep the zone" rather than keeping a copy.
    ///
    /// The time zone is the caller's; the numbering system is not, since the
    /// database has one answer.
    static func gregorian(like calendar: Calendar) -> Calendar {
        if calendar.identifier == .gregorian { return calendar }
        var copy = Calendar(identifier: .gregorian)
        copy.timeZone = calendar.timeZone
        copy.locale = calendar.locale
        return copy
    }
}
