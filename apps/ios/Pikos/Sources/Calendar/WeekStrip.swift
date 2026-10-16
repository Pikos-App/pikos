import SwiftUI

/// Seven days across the top of the day view, one tap each.
///
/// The day view's answer to "what about Thursday": a swipe reaches the next day, but a tap on the
/// strip reaches any day of the week without paging through the ones between. Under each day sit
/// the month view's bars in folder colours, so the strip is a one-row month that says what kind of
/// day Thursday is and not only that something is on it.
///
/// The strip follows the reader's week, Sunday-first or Monday-first from the setting the grid
/// uses, and re-anchors to whichever week the selected day is in. The selected day is a filled
/// circle and today is the accent colour; today selected is a filled accent circle.
struct WeekStrip: View {
    /// The week, as `YYYY-MM-DD` keys in display order.
    let days: [String]
    let selected: String
    let today: String
    /// The folder colour of each thing on a day. Absent means none.
    let bars: [String: [Color]]
    let onSelect: (String) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let barLimit = 3

    var body: some View {
        HStack(spacing: 0) {
            ForEach(days, id: \.self) { day in
                cell(day)
            }
        }
        .padding(.horizontal, 8)
        .padding(.top, 2)
        .padding(.bottom, 6)
        .background(.surfacePrimary)
        .overlay(alignment: .bottom) {
            Rectangle().fill(.borderSecondary).frame(height: 1)
        }
        .sensoryFeedback(.selection, trigger: selected)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Week")
    }

    private func cell(_ day: String) -> some View {
        let isSelected = day == selected
        let isToday = day == today
        let colors = bars[day] ?? []
        return Button {
            onSelect(day)
        } label: {
            VStack(spacing: 3) {
                Text(Self.weekdayLetter(day))
                    .sectionLabelStyle(isToday ? .textAction : .textTertiary)
                Text(Self.dayNumber(day))
                    .font(.system(.subheadline, weight: isSelected || isToday ? .semibold : .regular))
                    .monospacedDigit()
                    .foregroundStyle(
                        isSelected ? Color.textInverse : (isToday ? Color.textAction : Color.textPrimary)
                    )
                    .frame(width: 32, height: 32)
                    .background {
                        if isSelected {
                            Circle().fill(isToday ? Color.textAction : Color.textPrimary)
                        }
                    }
                HStack(spacing: 2) {
                    ForEach(Array(colors.prefix(Self.barLimit).enumerated()), id: \.offset) { _, color in
                        Capsule().fill(color).frame(width: 7, height: 3)
                    }
                }
                .frame(height: 3)
            }
            .frame(maxWidth: .infinity)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .animation(reduceMotion ? nil : .pkQuick, value: selected)
        .accessibilityLabel(Self.accessibleLabel(day, count: colors.count, isToday: isToday))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    // MARK: - Labels

    private static func dayNumber(_ day: String) -> String {
        let number = day.suffix(2)
        return number.first == "0" ? String(number.dropFirst()) : String(number)
    }

    /// One letter, because seven abbreviations do not fit side by side at the larger text sizes and
    /// the full name is in the accessibility label anyway.
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
