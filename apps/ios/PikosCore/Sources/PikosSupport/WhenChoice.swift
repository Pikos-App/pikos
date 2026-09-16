import Foundation

/// The days a page can be sent to in one tap, wherever a date is changed.
///
/// One list for the menu, the swipe, select mode and quick add, so "This Weekend" cannot mean
/// Saturday in one place and Sunday in another.
public enum WhenChoice: String, CaseIterable, Sendable {
    case today
    case tomorrow
    case thisWeekend
    case nextWeek

    /// The `YYYY-MM-DD` this choice lands on, seen from `now`.
    ///
    /// This Weekend is the coming Saturday, or today once the weekend has started. Next Week is
    /// the Monday after this one whatever the reader's first weekday is: a Sunday-first week
    /// would otherwise put "next week" on a day most people count as the weekend.
    public func day(from now: Date = Date(), calendar: Calendar = .current) -> String {
        let arithmetic = DayLabel.gregorian(like: calendar)
        let start = arithmetic.startOfDay(for: now)
        let weekday = arithmetic.component(.weekday, from: start)
        let offset: Int
        switch self {
        case .today:
            offset = 0
        case .tomorrow:
            offset = 1
        case .thisWeekend:
            offset = weekday == 1 || weekday == 7 ? 0 : 7 - weekday
        case .nextWeek:
            offset = (9 - weekday) % 7 == 0 ? 7 : (9 - weekday) % 7
        }
        let target = arithmetic.date(byAdding: .day, value: offset, to: start) ?? start
        return DayLabel.today(calendar, now: target)
    }
}

/// A page's schedule carried to another day with its shape intact.
public enum ScheduleShift {
    /// The start and end a page gets when it is sent to `day`.
    ///
    /// A timed page keeps its time and length, so a 3pm call moved to tomorrow is still at 3pm.
    /// An all-day range keeps how many days it spans. An unscheduled page becomes all-day.
    public static func move(start: String?, end: String?, toDay day: String) -> (start: String, end: String?) {
        guard let start else { return (day, nil) }
        let startDay = String(start.prefix(10))
        let time = start.count > 10 ? String(start.dropFirst(10)) : ""
        guard let end, let delta = days(from: startDay, to: day) else { return (day + time, nil) }
        let endDay = String(end.prefix(10))
        let endTime = end.count > 10 ? String(end.dropFirst(10)) : ""
        guard let shifted = adding(delta, to: endDay) else { return (day + time, nil) }
        return (day + time, shifted + endTime)
    }

    private static let utc: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .current
        return calendar
    }()

    private static func days(from: String, to: String) -> Int? {
        guard let a = DayLabel.date(from: from, in: utc), let b = DayLabel.date(from: to, in: utc) else {
            return nil
        }
        return utc.dateComponents([.day], from: a, to: b).day
    }

    private static func adding(_ days: Int, to day: String) -> String? {
        guard let date = DayLabel.date(from: day, in: utc),
            let moved = utc.date(byAdding: .day, value: days, to: date)
        else { return nil }
        return DayLabel.today(utc, now: moved)
    }
}

/// How the phone's Today splits what the workspace reports as late.
public enum TodayGrouping {
    /// Whether a late page belongs under Overdue: only when its day is before today.
    ///
    /// The workspace calls a timed page late the moment its time passes. Grouping that under
    /// Overdue put a meeting in progress beside last week's backlog, and Move to today, which
    /// only moves earlier days, then left most of the section where it was.
    public static func isFromAnEarlierDay(_ scheduledStart: String?, today: String) -> Bool {
        guard let scheduledStart else { return false }
        return String(scheduledStart.prefix(10)) < today
    }
}
