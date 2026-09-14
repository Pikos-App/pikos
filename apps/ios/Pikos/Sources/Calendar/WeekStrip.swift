import SwiftUI

/// Seven days across the top of the day view, one tap each.
///
/// The day view's answer to "what about Thursday": a swipe reaches the next
/// day, but a tap on a strip reaches any day of the week without paging
/// through the ones between, and shows at a glance which days hold anything.
/// Apple's Calendar draws exactly this above its day column; Fantastical's
/// DayTicker and Todoist's Upcoming are the same idea.
///
/// The strip follows the reader's week — Sunday-first or Monday-first from
/// the same setting the grid uses — and re-anchors to whichever week the
/// selected day is in, so paging off the end of one week lands on the start
/// of the next with the strip already showing it.
///
/// A dot under a day says something is scheduled on it; the count is in the
/// accessibility label, since a dot cannot carry one. The selected day is a
/// filled circle, today is the accent colour, and the two combine — today
/// selected is a filled accent circle — so neither has to be found by
/// hunting.
struct WeekStrip: View {
    /// The week, as `YYYY-MM-DD` keys in display order.
    let days: [String]
    let selected: String
    let today: String
    /// How many entries each day holds. Absent means none.
    let counts: [String: Int]
    let onSelect: (String) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 0) {
            ForEach(days, id: \.self) { day in
                cell(day)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
        // A light tick as the selection moves, the same the system's own
        // segmented controls give.
        .sensoryFeedback(.selection, trigger: selected)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Week")
    }

    private func cell(_ day: String) -> some View {
        let isSelected = day == selected
        let isToday = day == today
        let count = counts[day] ?? 0
        return Button {
            onSelect(day)
        } label: {
            VStack(spacing: 3) {
                Text(Self.weekdayLetter(day))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(Self.dayNumber(day))
                    .font(.subheadline.weight(isSelected || isToday ? .semibold : .regular))
                    .monospacedDigit()
                    .foregroundStyle(
                        isSelected ? Color.white : (isToday ? Color.accentColor : Color.primary)
                    )
                    .frame(width: 32, height: 32)
                    .background {
                        if isSelected {
                            Circle().fill(Color.accentColor)
                        }
                    }
                Circle()
                    .fill(count > 0 ? (isToday ? Color.accentColor : Color.secondary) : Color.clear)
                    .frame(width: 4, height: 4)
            }
            .frame(maxWidth: .infinity)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .animation(reduceMotion ? nil : .snappy, value: selected)
        .accessibilityLabel(Self.accessibleLabel(day, count: count, isToday: isToday))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    // MARK: - Labels

    private static func dayNumber(_ day: String) -> String {
        let number = day.suffix(2)
        return number.first == "0" ? String(number.dropFirst()) : String(number)
    }

    /// "M", "T", "W" — one letter, because seven abbreviations do not fit
    /// beside each other at the larger text sizes and the full name is in
    /// the accessibility label anyway.
    private static func weekdayLetter(_ day: String) -> String {
        guard let date = date(from: day) else { return "" }
        return date.formatted(.dateTime.weekday(.narrow))
    }

    private static func accessibleLabel(_ day: String, count: Int, isToday: Bool) -> String {
        guard let date = date(from: day) else { return day }
        var parts = [date.formatted(.dateTime.weekday(.wide).month(.wide).day())]
        if isToday { parts.append(String(localized: "today")) }
        switch count {
        case 0: parts.append(String(localized: "nothing scheduled"))
        case 1: parts.append(String(localized: "1 page"))
        default: parts.append(String(localized: "\(count) pages"))
        }
        return parts.joined(separator: ", ")
    }

    private static func date(from day: String) -> Date? {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar.date(
            from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
    }
}
