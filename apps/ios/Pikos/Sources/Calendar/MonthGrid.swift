import PikosCore
import PikosSupport
import SwiftUI

/// A month, a week to a row, as the desktop's month view lays it out.
///
/// A phone column is too narrow for the desktop's title chips, so each day shows what it holds
/// as up to three bars in their folders' colours and a count past that. Tapping a day opens it in
/// the day view, which is where every path out of the desktop's month lands too.
struct MonthGrid: View {
    /// The padded month, as `YYYY-MM-DD` keys, a whole number of weeks.
    let days: [String]
    /// `YYYY-MM`, so days padded in from either side can be drawn quieter.
    let month: String
    let today: String
    let entries: [CalendarEntry]
    let folderColors: [String: Color]
    let calendar: Calendar
    let onOpenDay: (String) -> Void

    private static let barLimit = 3

    var body: some View {
        let placed = MonthLayout.byDay(
            entries, days: days, start: \.scheduledStart, end: \.scheduledEnd)
        let weeks = stride(from: 0, to: days.count, by: 7).map { Array(days[$0..<min($0 + 7, days.count)]) }

        VStack(spacing: 0) {
            weekdayHeader
            GeometryReader { geometry in
                let rowHeight = max(64, geometry.size.height / CGFloat(max(weeks.count, 1)))
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(weeks, id: \.first) { week in
                            HStack(spacing: 0) {
                                ForEach(week, id: \.self) { day in
                                    cell(day, entries: placed[day] ?? [])
                                }
                            }
                            .frame(height: rowHeight)
                            .overlay(alignment: .top) {
                                Rectangle().fill(.borderSecondary).frame(height: 1)
                            }
                        }
                    }
                }
                .scrollDisabled(rowHeight * CGFloat(weeks.count) <= geometry.size.height + 1)
            }
            .padding(.bottom, ShellBar.clearance)
        }
        .background(.surfacePrimary)
    }

    private var weekdayHeader: some View {
        let symbols = calendar.shortStandaloneWeekdaySymbols
        let ordered = (0..<7).map { symbols[($0 + calendar.firstWeekday - 1) % 7] }
        return HStack(spacing: 0) {
            ForEach(Array(ordered.enumerated()), id: \.offset) { _, symbol in
                Text(symbol)
                    .sectionLabelStyle()
                    .frame(maxWidth: .infinity)
            }
        }
        .padding(.vertical, 6)
        .accessibilityHidden(true)
    }

    private func cell(_ day: String, entries: [CalendarEntry]) -> some View {
        let isToday = day == today
        let inMonth = day.hasPrefix(month)
        return Button {
            onOpenDay(day)
        } label: {
            VStack(spacing: 4) {
                Text(Self.dayNumber(day))
                    .font(.system(.subheadline, weight: isToday ? .semibold : .regular))
                    .monospacedDigit()
                    .foregroundStyle(
                        isToday ? Color.textInverse : (inMonth ? Color.textPrimary : Color.textDisabled)
                    )
                    .frame(width: 28, height: 28)
                    .background {
                        if isToday { Circle().fill(.textAction) }
                    }
                VStack(spacing: 3) {
                    ForEach(entries.prefix(Self.barLimit), id: \.key) { entry in
                        Capsule()
                            .fill(CalendarPalette.tint(folderId: entry.folderId, colors: folderColors))
                            .opacity(entry.status == "done" || !inMonth ? 0.4 : 1)
                            .frame(height: 4)
                    }
                    if entries.count > Self.barLimit {
                        Text("+\(entries.count - Self.barLimit)")
                            .font(.pkUISm)
                            .monospacedDigit()
                            .foregroundStyle(.textTertiary)
                    }
                }
                .padding(.horizontal, 6)
                Spacer(minLength: 0)
            }
            .padding(.top, 4)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableRowStyle())
        .accessibilityLabel(Self.accessibleLabel(day, count: entries.count, isToday: isToday))
    }

    private static func dayNumber(_ day: String) -> String {
        let number = day.suffix(2)
        return number.first == "0" ? String(number.dropFirst()) : String(number)
    }

    private static func accessibleLabel(_ day: String, count: Int, isToday: Bool) -> String {
        guard let date = StorageTimestamp.wallClock(day) else { return day }
        var parts = [date.formatted(.dateTime.weekday(.wide).month(.wide).day())]
        if isToday { parts.append(String(localized: "today")) }
        switch count {
        case 0: parts.append(String(localized: "nothing scheduled"))
        case 1: parts.append(String(localized: "1 page"))
        default: parts.append(String(localized: "\(count) pages"))
        }
        return parts.joined(separator: ", ")
    }
}
