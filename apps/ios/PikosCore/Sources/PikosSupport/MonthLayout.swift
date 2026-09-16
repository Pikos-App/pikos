import Foundation

/// The month view's arithmetic: which days a month grid shows, and what lands on each.
public enum MonthLayout {
    /// The month holding `anchor`, padded back to the calendar's first weekday and forward to
    /// the end of its last week, so every row is a whole week.
    public static func days(around anchor: Date, calendar: Calendar) -> [Date] {
        guard let month = calendar.dateInterval(of: .month, for: anchor),
            let firstWeek = calendar.dateInterval(of: .weekOfYear, for: month.start),
            let lastDay = calendar.date(byAdding: .day, value: -1, to: month.end),
            let lastWeek = calendar.dateInterval(of: .weekOfYear, for: lastDay)
        else { return [] }
        let count = calendar.dateComponents([.day], from: firstWeek.start, to: lastWeek.end).day ?? 0
        return (0..<count).compactMap { calendar.date(byAdding: .day, value: $0, to: firstWeek.start) }
    }

    /// The items touching each day, in their given order.
    ///
    /// A span counts on every day it covers, as the desktop's month cells list it. A timed end at
    /// midnight does not claim the day it ends on, since nothing happens in it.
    public static func byDay<Item>(
        _ items: [Item], days: [String], start: (Item) -> String, end: (Item) -> String?
    ) -> [String: [Item]] {
        var out: [String: [Item]] = [:]
        for item in items {
            let startValue = start(item)
            let first = String(startValue.prefix(10))
            let endValue = end(item) ?? startValue
            let last = String(endValue.prefix(10))
            let endsAtMidnight = endValue.hasSuffix("T00:00:00") && last > first
            for day in days where day >= first && (endsAtMidnight ? day < last : day <= last) {
                out[day, default: []].append(item)
            }
        }
        return out
    }
}
