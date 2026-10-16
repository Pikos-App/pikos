import Foundation
import PikosSupport

/// How many days the calendar shows at once, and which days those are.
///
/// The same grid draws one day or seven. A seven-column grid is offered only in the three-panel
/// split: on a phone each column is a few points wide and titles wrap a letter to a line, so it
/// showed only colour, which the month already shows better, and Upcoming answers "what is this
/// week". A phone turned sideways has the width but about 400 points of height, and its calendar
/// is half the screen beside the list.
///
/// Pure value logic, kept apart from the views so the date arithmetic — which
/// is the part that can be wrong across a month boundary or a DST weekend — can
/// be read on its own.
enum CalendarSpan: String, CaseIterable, Identifiable, Hashable {
    case day
    case threeDays
    case week
    case month

    var id: String { rawValue }

    var label: String {
        switch self {
        case .day: return String(localized: "Day")
        case .threeDays: return String(localized: "3 Days")
        case .week: return String(localized: "Week")
        case .month: return String(localized: "Month")
        }
    }

    /// One day on a phone, where three columns leave a title a few characters wide, and a week
    /// where there is room for one.
    static func `default`(in layout: ShellLayout) -> CalendarSpan {
        layout == .split ? .week : .day
    }

    static func offered(in layout: ShellLayout) -> [CalendarSpan] {
        layout == .split ? allCases : [.day, .threeDays, .month]
    }

    /// The days to show, given the day the user is anchored on.
    ///
    /// A week starts on the user's own first weekday — Sunday in the US, Monday
    /// across most of Europe — which `Calendar.current` already knows. Shorter
    /// spans start on the anchor itself: someone who has navigated to Thursday
    /// and asked for three days means Thursday onwards, not the Thursday of
    /// some enclosing block.
    /// A month is the whole month padded to whole weeks.
    func days(anchoredOn anchor: Date, calendar: Calendar = .current) -> [Date] {
        let start: Date
        let count: Int
        switch self {
        case .month:
            return MonthLayout.days(around: anchor, calendar: calendar)
        case .week:
            start =
                calendar.dateInterval(of: .weekOfYear, for: anchor)?.start
                ?? calendar.startOfDay(for: anchor)
            count = 7
        case .threeDays:
            start = calendar.startOfDay(for: anchor)
            count = 3
        case .day:
            start = calendar.startOfDay(for: anchor)
            count = 1
        }
        return (0..<count).compactMap {
            calendar.date(byAdding: .day, value: $0, to: start)
        }
    }

    /// Move the anchor one span forwards or backwards.
    func step(_ anchor: Date, by spans: Int, calendar: Calendar = .current) -> Date {
        let (component, size): (Calendar.Component, Int) =
            switch self {
            case .day: (.day, 1)
            case .threeDays: (.day, 3)
            case .week: (.day, 7)
            case .month: (.month, 1)
            }
        return calendar.date(byAdding: component, value: spans * size, to: anchor) ?? anchor
    }
}

/// A `Date` as the wall-clock string the workspace speaks.
///
/// Built from date components rather than a `DateFormatter`, for three reasons
/// that all point the same way. A formatter is a reference type, so holding one
/// in a `static let` is shared mutable state the compiler is right to object
/// to. It costs about a hundred microseconds to construct. And it formats in
/// the reader's own calendar unless told otherwise — a device set to the
/// Buddhist calendar would write year 2569 into a column that only ever holds
/// Gregorian dates.
///
/// No time zone conversion in either direction: the stored value is a wall
/// clock, and the user's current zone is the one their day is happening in.
enum WallClockDay {
    private static var gregorian: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        return calendar
    }

    /// `YYYY-MM-DD`, which is how a calendar column is addressed.
    static func string(from date: Date) -> String {
        let parts = gregorian.dateComponents([.year, .month, .day], from: date)
        return String(
            format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// `YYYY-MM-DDTHH:MM:SS`, for the current-time indicator.
    static func instant(from date: Date) -> String {
        let parts = gregorian.dateComponents(
            [.year, .month, .day, .hour, .minute, .second], from: date)
        return String(
            format: "%04d-%02d-%02dT%02d:%02d:%02d",
            parts.year ?? 0, parts.month ?? 0, parts.day ?? 0,
            parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0)
    }
}
