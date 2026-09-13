import Foundation

/// What a `YYYY-MM-DD` day is called in a list, and how to produce one.
///
/// The shared Rust deliberately stops at the date. Building "Today" /
/// "Tomorrow" / "Thu, 27 Aug" there would mean a second locale implementation,
/// and a phone that says "Thu, Aug 27" to a reader whose every other app says
/// "Thu 27 Aug" reads as a port rather than as an app. So the date crosses the
/// boundary and the naming happens here, against the reader's own locale.
///
/// A `YYYY-MM-DD` in this app is always a **proleptic Gregorian** date, because
/// that is what SQLite holds and what the Rust compares. The reader's calendar
/// decides how a date is *shown*, never how one is parsed or written — a device
/// set to the Buddhist calendar numbers 2026 as 2569, and a key built from its
/// components matches no row in the database and empties the view with nothing
/// logged. Hence [`gregorian(like:)`]: every arithmetic path below borrows only
/// the time zone from the caller's calendar.
///
/// In `PikosSupport` rather than in a view so it can be tested on the host: the
/// interesting cases are the two relative words, the boundary between them and
/// the calendar trap, and none of that needs a simulator.
public enum DayLabel {
    /// "Today", "Tomorrow", or a short date in the reader's locale.
    ///
    /// `today` is passed in rather than read from the clock because it is a
    /// boundary — a list rendered at 23:59:59 and asked again a second later
    /// must not disagree with itself about which day is "Today", and a test has
    /// to be able to stand on both sides of midnight.
    ///
    /// Falls back to the raw date for anything it cannot read, which is the
    /// same choice the rest of the app makes: a stamp shown as itself is a
    /// visible fault, and a plausible wrong date is not.
    public static func relative(
        _ date: String, today: String, calendar: Calendar = .current
    ) -> String {
        if date == today { return "Today" }
        guard let day = self.date(from: date, in: calendar) else { return date }

        // Compared as dates rather than as strings, so the day after the 31st
        // and the day after a leap February both land where they should.
        let arithmetic = gregorian(like: calendar)
        if let todayDate = self.date(from: today, in: calendar),
            let tomorrow = arithmetic.date(byAdding: .day, value: 1, to: todayDate),
            arithmetic.isDate(day, inSameDayAs: tomorrow)
        {
            return "Tomorrow"
        }

        // Formatted through the reader's own locale, which is the one thing
        // here that *should* follow a non-Gregorian device setting.
        return day.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
    }

    /// Today, as the `YYYY-MM-DD` key the shared Rust compares against.
    ///
    /// Built by hand from Gregorian components rather than through a
    /// `DateFormatter`: this is a storage key, not something a reader sees, and
    /// a formatter carrying the device's calendar would write a Buddhist or
    /// Japanese year that matches nothing.
    public static func today(_ calendar: Calendar = .current, now: Date = Date()) -> String {
        let parts = gregorian(like: calendar).dateComponents([.year, .month, .day], from: now)
        guard let year = parts.year, let month = parts.month, let day = parts.day else { return "" }
        return String(format: "%04d-%02d-%02d", year, month, day)
    }

    /// A `YYYY-MM-DD` string as noon on that day, in the caller's time zone.
    ///
    /// Noon rather than midnight on purpose. These are wall-clock days with no
    /// zone, and midnight is the one instant a DST transition can delete — in a
    /// zone that springs forward at 00:00, midnight on that date does not
    /// exist, and asking for it yields either nil or the previous day. Noon is
    /// never in a gap, and nothing here reads the time.
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
    /// The time zone is the caller's business — which instant "2026-09-13 noon"
    /// is depends on where they are. Which *numbering system* names that day is
    /// not: the database has exactly one answer.
    private static func gregorian(like calendar: Calendar) -> Calendar {
        if calendar.identifier == .gregorian { return calendar }
        var copy = Calendar(identifier: .gregorian)
        copy.timeZone = calendar.timeZone
        copy.locale = calendar.locale
        return copy
    }
}
