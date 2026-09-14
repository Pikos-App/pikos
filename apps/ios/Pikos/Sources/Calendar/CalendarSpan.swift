import Foundation

/// How many days the calendar shows at once, and which days those are.
///
/// The same grid draws one day or seven; a phone is simply the narrow case. All
/// three spans are offered on every device rather than being decided by screen
/// size, because the useful default and the useful *option* are different
/// questions — a week is unreadable as a default on a phone and entirely
/// reasonable when someone deliberately asks for it, and an iPad in a narrow
/// split view is a phone-shaped screen on a large device.
///
/// Pure value logic, kept apart from the views so the date arithmetic — which
/// is the part that can be wrong across a month boundary or a DST weekend — can
/// be read on its own.
enum CalendarSpan: String, CaseIterable, Identifiable, Hashable {
    case day
    case threeDays
    case week

    var id: String { rawValue }

    var dayCount: Int {
        switch self {
        case .day: return 1
        case .threeDays: return 3
        case .week: return 7
        }
    }

    var label: String {
        switch self {
        case .day: return String(localized: "Day")
        case .threeDays: return String(localized: "3 Days")
        case .week: return String(localized: "Week")
        }
    }

    /// The default for a width class: a single day where a column would
    /// otherwise be a few characters wide, a week where there is room for one.
    ///
    /// Takes the raw flag rather than SwiftUI's `UserInterfaceSizeClass` so it
    /// stays free of a UI framework and testable.
    static func `default`(isCompactWidth: Bool) -> CalendarSpan {
        isCompactWidth ? .day : .week
    }

    /// The days to show, given the day the user is anchored on.
    ///
    /// A week starts on the user's own first weekday — Sunday in the US, Monday
    /// across most of Europe — which `Calendar.current` already knows. Shorter
    /// spans start on the anchor itself: someone who has navigated to Thursday
    /// and asked for three days means Thursday onwards, not the Thursday of
    /// some enclosing block.
    func days(anchoredOn anchor: Date, calendar: Calendar = .current) -> [Date] {
        let start: Date
        switch self {
        case .week:
            start =
                calendar.dateInterval(of: .weekOfYear, for: anchor)?.start
                ?? calendar.startOfDay(for: anchor)
        case .day, .threeDays:
            start = calendar.startOfDay(for: anchor)
        }
        return (0..<dayCount).compactMap {
            calendar.date(byAdding: .day, value: $0, to: start)
        }
    }

    /// Move the anchor one span forwards or backwards.
    func step(_ anchor: Date, by spans: Int, calendar: Calendar = .current) -> Date {
        calendar.date(byAdding: .day, value: spans * dayCount, to: anchor) ?? anchor
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
