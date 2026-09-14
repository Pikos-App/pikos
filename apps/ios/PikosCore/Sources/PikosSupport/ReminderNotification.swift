import Foundation

/// What a reminder says and when the OS should show it, from the fields the
/// workspace hands over.
///
/// Here rather than in the app so it runs under `swift test` on the host: the
/// interesting cases are the wall-clock-to-components mapping — which must
/// not pass through a `Date` and back, or a device on a non-Gregorian
/// calendar writes a year that never arrives — and the wording's boundaries,
/// "Today", "Tomorrow", a weekday, a date with a year.
public enum ReminderNotification {
    /// The calendar components a `UNCalendarNotificationTrigger` fires on, from
    /// a `YYYY-MM-DDTHH:MM:SS` wall clock on the device's own zone.
    ///
    /// Built field by field rather than through a `Date`. The trigger matches
    /// components against the device's current calendar, which for a phone set
    /// to the Buddhist or Japanese calendar numbers the year differently; the
    /// components carry an explicit Gregorian calendar so the match is on the
    /// digits the workspace wrote. Seconds are kept — the workspace places a
    /// fire to the second, and dropping them would fire up to a minute early.
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
    /// Relative to the day the reminder *fires* rather than to the moment the
    /// notification was planned — a reminder planned on Monday for a Thursday
    /// meeting says "Today at 3:00 PM" when it lands on Thursday, because that
    /// is when it is read. `fireAt` is the same wall-clock string the trigger
    /// was built from; `scheduledStart` is the page's own start, which for a
    /// page a calendar owns is in its source zone and is worded as written
    /// rather than converted, since the words are the event's, not the phone's.
    public static func body(
        scheduledStart: String, fireAt: String, calendar: Calendar = .current
    ) -> String {
        let gregorian = DayLabel.gregorian(like: calendar)
        guard let start = StorageTimestamp.wallClock(scheduledStart, in: calendar),
            let fire = StorageTimestamp.wallClock(fireAt, in: calendar)
        else { return scheduledStart }

        let isAllDay = !scheduledStart.contains("T")
        // The reader's locale and zone, the Gregorian calendar: how every date
        // in the app is shown, so a notification reads like the list does.
        let style = Date.FormatStyle(
            locale: calendar.locale ?? .autoupdatingCurrent,
            calendar: gregorian,
            timeZone: calendar.timeZone)
        let time = start.formatted(style.hour().minute())

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
    /// iOS keeps the sixty-four soonest pending requests and drops the rest
    /// silently. Planning fewer than that leaves room for the ones another
    /// part of the app might add, and makes the drop — if it ever happens —
    /// ours to notice rather than the OS's to hide.
    public static let planningLimit = 60

    /// How far ahead the phone plans. Fourteen days is well past how long a
    /// phone goes without the app being opened or a background refresh
    /// landing, and short enough that the sixty-slot budget is rarely the
    /// binding constraint.
    public static let horizonDays = 14
}
