import PikosCore
import PikosSupport
import SwiftUI

/// The day columns: an all-day band at the top, an hour grid below.
///
/// Takes entries already resolved for the range — real pages and the
/// occurrences projected from recurrence rules, indistinguishable by the time
/// they get here, which is the point. Structure comes from the shared Rust;
/// this turns it into points.
///
/// One grid for one day or seven. A phone is the narrow case of the same view,
/// not a different one, which is what makes the iPad build a matter of handing
/// it more days.
struct CalendarGrid: View {
    let days: [String]
    let entries: [CalendarEntry]
    let now: String
    let onOpen: (String) -> Void

    /// Scales the hour height with the reader's text size. A calendar whose
    /// rows stay 64pt while its labels grow is how a block ends up with its
    /// title clipped at the accessibility sizes.
    @ScaledMetric(relativeTo: .body) private var hourHeight: CGFloat = 64
    @State private var allDayExpanded = false

    private var metrics: CalendarGeometry.Metrics {
        CalendarGeometry.Metrics(hourHeight: hourHeight)
    }

    /// The all-day band is capped so a week with a fortnight-long holiday in it
    /// does not push the hour grid off the screen entirely.
    private static let collapsedAllDayRows = 2

    var body: some View {
        VStack(spacing: 0) {
            dayHeader
            allDaySection
            Divider()
            ScrollViewReader { proxy in
                ScrollView(.vertical) {
                    timedSection
                }
                .onAppear {
                    // Land on the working day rather than at midnight, which is
                    // eight hours of empty grid.
                    proxy.scrollTo(Self.openingHourAnchor, anchor: .top)
                }
            }
        }
    }

    // MARK: - Header

    private var dayHeader: some View {
        HStack(spacing: 0) {
            Color.clear.frame(width: Self.gutterWidth + Self.gutterGap)
            ForEach(days, id: \.self) { day in
                VStack(spacing: 1) {
                    Text(Self.weekdayLabel(day))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(Self.dayNumber(day))
                        .font(.subheadline.weight(isToday(day) ? .bold : .regular))
                        .foregroundStyle(isToday(day) ? Color.accentColor : Color.primary)
                }
                .frame(maxWidth: .infinity)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(Self.accessibleDayLabel(day))
            }
        }
        .padding(.vertical, 6)
    }

    // MARK: - All day

    /// Bars come back with a column, a span and a row already assigned, stable
    /// across the whole visible range — so a Monday-to-Wednesday event is one
    /// bar rather than three, and keeps its row as the user pages through
    /// weeks.
    private var allDayBars: [AllDayBar] {
        // Keyed by page id, not by occurrence: the row packer identifies a span
        // by id and relies on every occurrence of a series sharing one, so that
        // a Mon/Wed/Fri series claims three separate days in a single row
        // instead of a contiguous block through Tuesday and Thursday.
        let pages = entries
            .filter { CalendarGeometry.isAllDay($0.scheduledStart) }
            .map {
                LayoutPage(
                    id: $0.pageId, createdAt: $0.createdAt,
                    scheduledStart: $0.scheduledStart, scheduledEnd: $0.scheduledEnd)
            }
        guard !pages.isEmpty else { return [] }
        return layoutAllDay(pages: pages, days: days)
    }

    @ViewBuilder
    private var allDaySection: some View {
        let bars = allDayBars
        if !bars.isEmpty {
            let rowCount = Int(bars.map(\.row).max() ?? 0) + 1
            let shown = allDayExpanded ? rowCount : min(rowCount, Self.collapsedAllDayRows)
            let hidden = rowCount - shown

            HStack(alignment: .top, spacing: 0) {
                Text("all-day")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .frame(width: Self.gutterWidth, alignment: .trailing)
                    .padding(.trailing, Self.gutterGap)

                GeometryReader { geometry in
                    let columnWidth = geometry.size.width / CGFloat(max(days.count, 1))
                    ForEach(bars.filter { Int($0.row) < shown }, id: \.self) { bar in
                        allDayBar(bar, columnWidth: columnWidth)
                    }
                }
                .frame(height: CGFloat(shown) * metrics.allDayRowHeight)
            }
            .padding(.vertical, 3)

            if hidden > 0 || allDayExpanded {
                Button(allDayExpanded ? "Show less" : "\(hidden) more") {
                    withAnimation(.snappy) { allDayExpanded.toggle() }
                }
                .font(.caption2)
                .padding(.leading, Self.gutterWidth + Self.gutterGap)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func allDayBar(_ bar: AllDayBar, columnWidth: CGFloat) -> some View {
        let entry = entries.first { $0.pageId == bar.pageId }
        // Square off whichever edge runs past the visible range, so a bar that
        // continues reads as continuing rather than as ending on Sunday.
        let corners = RoundedCornerStyle(
            leading: !bar.continuesLeft, trailing: !bar.continuesRight)

        return Text(entry.map { $0.title.isEmpty ? "Untitled" : $0.title } ?? "")
            .font(.caption2)
            .lineLimit(1)
            .padding(.horizontal, 5)
            .frame(
                width: max(columnWidth * CGFloat(bar.span) - 3, 1),
                height: metrics.allDayRowHeight - 3,
                alignment: .leading)
            .background(Color.accentColor.opacity(0.22), in: corners.shape)
            .offset(
                x: columnWidth * CGFloat(bar.startCol) + 1.5,
                y: CGFloat(bar.row) * metrics.allDayRowHeight)
            .onTapGesture { if let entry { onOpen(entry.pageId) } }
            .accessibilityAddTraits(.isButton)
    }

    // MARK: - Timed

    private var timedSection: some View {
        HStack(alignment: .top, spacing: 0) {
            hourGutter
            GeometryReader { geometry in
                let columnWidth = geometry.size.width / CGFloat(max(days.count, 1))
                ZStack(alignment: .topLeading) {
                    hourLines
                    ForEach(Array(days.enumerated()), id: \.element) { index, day in
                        dayColumn(day, index: index, columnWidth: columnWidth)
                    }
                }
            }
            .frame(height: metrics.dayHeight)
        }
    }

    private var hourGutter: some View {
        VStack(alignment: .trailing, spacing: 0) {
            ForEach(0..<24, id: \.self) { hour in
                Text(Self.hourLabel(hour))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    // Aligned to the top of its hour, offset up by half a line
                    // so the label straddles the rule rather than sitting under
                    // it.
                    .frame(height: hourHeight, alignment: .top)
            }
        }
        .frame(width: Self.gutterWidth)
        .padding(.trailing, Self.gutterGap)
    }

    private var hourLines: some View {
        VStack(spacing: 0) {
            ForEach(0..<24, id: \.self) { hour in
                Divider().frame(height: hourHeight, alignment: .top)
                    .id(hour == Self.openingHour ? Self.openingHourAnchor : "hour-\(hour)")
            }
        }
    }

    /// The timed entries, keyed by occurrence rather than by page.
    ///
    /// Two occurrences of one series can fall on the same day, and giving them
    /// a single id would leave the layout unable to tell them apart. Exactly
    /// the opposite of what the all-day packer wants, and for the opposite
    /// reason — see `allDayBars`.
    private var timedEntries: [CalendarEntry] {
        entries.filter { !CalendarGeometry.isAllDay($0.scheduledStart) }
    }

    private func dayColumn(_ day: String, index: Int, columnWidth: CGFloat) -> some View {
        let timed = timedEntries
        let pages = timed.map {
            LayoutPage(
                id: $0.key, createdAt: $0.createdAt,
                scheduledStart: $0.scheduledStart, scheduledEnd: $0.scheduledEnd)
        }
        let blocks = pages.isEmpty ? [] : layoutTimedDay(pages: pages, day: day)

        return ZStack(alignment: .topLeading) {
            ForEach(blocks, id: \.pageId) { block in
                if let entry = timed.first(where: { $0.key == block.pageId }),
                    let placed = CalendarGeometry.placement(
                        start: entry.scheduledStart, end: entry.scheduledEnd,
                        on: day, metrics: metrics)
                {
                    let inset = CalendarGeometry.cascadeInset(
                        depth: Int(block.cascadeDepth), columnWidth: columnWidth)
                    CalendarBlock(entry: entry, height: placed.height, block: block)
                        .frame(width: max(columnWidth - inset - 3, 1), height: placed.height)
                        .offset(x: inset + 1.5, y: placed.top)
                        .onTapGesture { onOpen(entry.pageId) }
                }
            }

            if let offset = CalendarGeometry.nowOffset(now: now, on: day, metrics: metrics) {
                nowIndicator.offset(y: offset)
            }
        }
        .frame(width: columnWidth, height: metrics.dayHeight, alignment: .topLeading)
        .offset(x: columnWidth * CGFloat(index))
    }

    private var nowIndicator: some View {
        Rectangle()
            .fill(Color.red)
            .frame(height: 1.5)
            .overlay(alignment: .leading) {
                Circle().fill(Color.red).frame(width: 6, height: 6).offset(x: -2)
            }
            .accessibilityHidden(true)
    }

    // MARK: - Constants and labels

    /// Wide enough for "12 AM" at the larger Dynamic Type sizes.
    private static let gutterWidth: CGFloat = 46
    /// Between the hour labels and the first column. Shared so the day header
    /// lines up with the grid under it — they are separate views, and a header
    /// four points out is the kind of thing that reads as "slightly wrong" long
    /// before anyone works out why.
    private static let gutterGap: CGFloat = 4
    /// Where the grid opens, rather than at midnight.
    private static let openingHour = 7
    private static let openingHourAnchor = "calendar-opening-hour"

    private func isToday(_ day: String) -> Bool {
        CalendarGeometry.day(of: now) == day
    }

    private static func dayNumber(_ day: String) -> String {
        // The last two characters of a `YYYY-MM-DD`, without a leading zero.
        let number = day.suffix(2)
        return number.first == "0" ? String(number.dropFirst()) : String(number)
    }

    private static func weekdayLabel(_ day: String) -> String {
        guard let date = date(from: day) else { return "" }
        return date.formatted(.dateTime.weekday(.abbreviated))
    }

    private static func accessibleDayLabel(_ day: String) -> String {
        guard let date = date(from: day) else { return day }
        return date.formatted(.dateTime.weekday(.wide).month(.wide).day())
    }

    /// Formatted in the reader's own convention — 24-hour where that is the
    /// norm, "1 PM" where it is not. Built by stepping from a real midnight
    /// rather than from a bare hour component, which has no date to be an hour
    /// of and formats unpredictably.
    private static func hourLabel(_ hour: Int) -> String {
        guard hour > 0 else { return "" }
        let calendar = Calendar.current
        let midnight = calendar.startOfDay(for: .now)
        guard let date = calendar.date(byAdding: .hour, value: hour, to: midnight) else {
            return ""
        }
        return date.formatted(.dateTime.hour())
    }

    /// A `YYYY-MM-DD` back into a `Date`, for the reader's own formatting.
    private static func date(from day: String) -> Date? {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar.date(
            from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }
}

/// One block on the grid.
private struct CalendarBlock: View {
    let entry: CalendarEntry
    let height: CGFloat
    let block: TimedBlock

    /// Below this, there is no room for a second line and the time is dropped
    /// rather than clipped.
    private var isCompact: Bool { height < 34 }

    private var isDone: Bool { entry.status == "done" }

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(entry.title.isEmpty ? "Untitled" : entry.title)
                .font(.caption2.weight(.medium))
                .strikethrough(isDone, color: .secondary)
                .lineLimit(isCompact ? 1 : 2)
            if !isCompact, let time = startTime {
                Text(time)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(.horizontal, 4)
        .padding(.vertical, 2)
        .background(Color.accentColor.opacity(isDone ? 0.10 : 0.20))
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(Color.accentColor.opacity(isDone ? 0.4 : 1))
                .frame(width: 2)
        }
        .clipShape(RoundedRectangle(cornerRadius: 4))
        .opacity(isDone ? 0.65 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibleLabel)
        .accessibilityAddTraits(.isButton)
    }

    private var startTime: String? {
        guard let minutes = CalendarGeometry.minutesIntoDay(entry.scheduledStart) else {
            return nil
        }
        let calendar = Calendar.current
        let midnight = calendar.startOfDay(for: .now)
        guard let date = calendar.date(byAdding: .minute, value: minutes, to: midnight) else {
            return nil
        }
        return date.formatted(.dateTime.hour().minute())
    }

    private var accessibleLabel: String {
        var parts = [entry.title.isEmpty ? "Untitled" : entry.title]
        if let startTime { parts.append(startTime) }
        if block.isContinuationBefore { parts.append("continued from the previous day") }
        if block.isContinuationAfter { parts.append("continues into the next day") }
        if entry.isVirtual { parts.append("repeating") }
        if isDone { parts.append("done") }
        return parts.joined(separator: ", ")
    }
}

/// Rounded on the ends that are real, square on the ends that are cut.
private struct RoundedCornerStyle {
    let leading: Bool
    let trailing: Bool

    var shape: UnevenRoundedRectangle {
        UnevenRoundedRectangle(
            topLeadingRadius: leading ? 4 : 0,
            bottomLeadingRadius: leading ? 4 : 0,
            bottomTrailingRadius: trailing ? 4 : 0,
            topTrailingRadius: trailing ? 4 : 0)
    }
}
