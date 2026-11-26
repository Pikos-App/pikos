import Foundation

/// What a reminder says and when the OS should show it, from the fields the
/// workspace hands over.
///
public enum ReminderNotification {
    /// The calendar components a `UNCalendarNotificationTrigger` fires on, from
    /// a `YYYY-MM-DDTHH:MM:SS` wall clock on the device's own zone.
    ///
    /// Built field by field, not through a `Date`: the trigger matches against
    /// the device calendar, which numbers the year differently on a Buddhist or
    /// Japanese calendar, so the components carry an explicit Gregorian one.
    /// Seconds are kept, or the fire would come up to a minute early.
    public static func fireComponents(_ wallClock: String, timeZone: TimeZone = .current)
        -> DateComponents?
    {
        let halves = wallClock.split(separator: "T", maxSplits: 1, omittingEmptySubsequences: false)
        guard halves.count == 2 else { return nil }
        let date = halves[0].split(separator: "-")
        let time = halves[1].split(separator: ":")
        guard date.count == 3, time.count >= 2,
            let year = Int(date[0]), let month = Int(date[1]), let day = Int(date[2]),
            let hour = Int(time[0]), let minute = Int(time[1]),
            (1...12).contains(month), (1...31).contains(day),
            (0...23).contains(hour), (0...59).contains(minute)
        else { return nil }
        let second = time.count > 2 ? Int(time[2]) ?? 0 : 0

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        var components = DateComponents()
        components.calendar = calendar
        components.timeZone = timeZone
        components.year = year
        components.month = month
        components.day = day
        components.hour = hour
        components.minute = minute
        components.second = second
        return components
    }

    /// The notification's body: when the page is.
    ///
    /// Relative to the day the reminder fires, not when it was planned: planned
    /// Monday for Thursday, it says "Today at 3:00 PM" when it lands. `fireAt` is
    /// the wall clock the trigger was built from. `scheduledStart` is worded as
    /// written, not converted to the phone's zone, since the words are the event's.
    public static func body(
        scheduledStart: String, fireAt: String, calendar: Calendar = .current
    ) -> String {
        let gregorian = DayLabel.gregorian(like: calendar)
        guard let start = StorageTimestamp.wallClock(scheduledStart, in: calendar),
            let fire = StorageTimestamp.wallClock(fireAt, in: calendar)
        else { return scheduledStart }

        let isAllDay = !scheduledStart.contains("T")
        let style = Date.FormatStyle(
            locale: calendar.locale ?? .autoupdatingCurrent,
            calendar: gregorian,
            timeZone: calendar.timeZone)
        let time = ClockTime.string(start, calendar: gregorian)

        let daysAway = gregorian.dateComponents(
            [.day], from: gregorian.startOfDay(for: fire), to: gregorian.startOfDay(for: start)
        ).day ?? 0
        let day: String
        switch daysAway {
        case 0: day = "Today"
        case 1: day = "Tomorrow"
        case 2...6:
            day = start.formatted(style.weekday(.wide))
        default:
            let sameYear = gregorian.isDate(start, equalTo: fire, toGranularity: .year)
            day =
                sameYear
                ? start.formatted(style.weekday(.abbreviated).day().month(.abbreviated))
                : start.formatted(style.day().month(.abbreviated).year())
        }
        return isAllDay ? "\(day), all day" : "\(day) at \(time)"
    }

    /// The most notifications the phone plans at once.
    ///
    /// iOS keeps the 64 soonest pending requests and drops the rest silently.
    /// Planning fewer leaves room for others the app adds and makes any drop ours to notice.
    public static let planningLimit = 60

    /// How far ahead the phone plans: well past how long it goes without the app
    /// opening or a background refresh, and short of exhausting `planningLimit`.
    public static let horizonDays = 14
}
