import PikosCore
import PikosSupport
import SwiftUI
import WidgetKit

/// The Calendar widget's home-screen sizes: a header, today's all-day pages, then a window of hours
/// from the current one with the timed pages in it.
///
/// The hours are laid out by the app's own code: the Rust assigns each block its column and
/// `CalendarGeometry` places the blocks in lanes, so a day reads the same here as on the
/// calendar. Only the drawing is the widget's, at a size that fits a window of a few hours.
struct CalendarDay: View {
    let entry: NowEntry
    /// How many hours the window shows.
    let hours: Int
    /// How many all-day pages get a row before the rest fold into a count.
    let allDayRows: Int
    /// The small size: no hour labels and no summary, so a title has the width to be read.
    var isNarrow = false

    private var allDay: [PageSummary] { entry.untimed }

    private var firstHour: Int {
        let hour = Calendar.current.component(.hour, from: entry.date)
        return min(hour, 24 - hours)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            header
            if entry.failure != nil {
                WidgetNote(text: "Can't read your pages")
                Spacer(minLength: 0)
            } else {
                if !allDay.isEmpty { allDaySection }
                CalendarHours(entry: entry, firstHour: firstHour, hours: hours, showsLabels: !isNarrow)
            }
        }
        .widgetURL(URL(string: "pikos://calendar"))
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text("Today")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(WidgetInk.primary)
            if !isNarrow, let summary {
                Text(summary)
                    .font(.footnote)
                    .foregroundStyle(WidgetInk.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            NowAddButton(hour: nil)
        }
    }

    /// When the next page starts, or that nothing timed is left.
    private var summary: String? {
        guard entry.failure == nil else { return nil }
        if let next = entry.timed.first(where: { (timeOfDay($0) ?? .distantPast) > entry.date }),
            let start = timeOfDay(next)
        {
            return String(localized: "next at \(ClockTime.string(start))")
        }
        return entry.timed.isEmpty && allDay.isEmpty ? String(localized: "nothing left") : nil
    }

    private var allDaySection: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(allDay.prefix(allDayRows), id: \.id) { page in
                CalendarBlockMark(
                    page: page, tint: blockTint(page, in: entry), time: nil, height: CalendarBlockMark.rowHeight)
                    .frame(height: CalendarBlockMark.rowHeight)
            }
            if allDay.count > allDayRows {
                Text("+\(allDay.count - allDayRows) more all day")
                    .font(.caption2)
                    .foregroundStyle(WidgetInk.secondary)
            }
        }
    }
}

/// The window of hours: an hour line and label for each, the blocks laid over them, and the now
/// line. Each hour's empty space opens quick add at that hour.
private struct CalendarHours: View {
    let entry: NowEntry
    let firstHour: Int
    let hours: Int
    let showsLabels: Bool

    private var gutterWidth: CGFloat { showsLabels ? 40 : 0 }

    var body: some View {
        GeometryReader { proxy in
            let hourHeight = proxy.size.height / CGFloat(hours)
            let columnWidth = max(proxy.size.width - gutterWidth, 1)
            let metrics = CalendarGeometry.Metrics(hourHeight: hourHeight, minBlockHeight: 18)
            let windowTop = CGFloat(firstHour) * hourHeight

            ZStack(alignment: .topLeading) {
                ForEach(0..<hours, id: \.self) { offset in
                    hourRow(firstHour + offset, height: hourHeight)
                        .offset(y: CGFloat(offset) * hourHeight)
                }

                // Under the blocks, so it never strikes through a title.
                if let now = CalendarGeometry.nowOffset(
                    now: WidgetClock.now(entry.date), on: DayLabel.today(now: entry.date), metrics: metrics)
                {
                    nowLine.offset(x: max(gutterWidth - 3, 0), y: now - windowTop - 3)
                }
                blocks(metrics: metrics, columnWidth: columnWidth, windowTop: windowTop)
                    .offset(x: gutterWidth)

            }
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
            .clipped()
        }
    }

    private func hourRow(_ hour: Int, height: CGFloat) -> some View {
        HStack(alignment: .top, spacing: showsLabels ? 4 : 0) {
            if showsLabels {
                Text(hourLabel(hour))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(WidgetInk.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .frame(width: gutterWidth - 4, alignment: .trailing)
                    .offset(y: -1)
            }
            VStack(spacing: 0) {
                Rectangle().fill(WidgetInk.rule).frame(height: 0.5)
                if let add = NowLink.add(atHour: hour) {
                    Link(destination: add) {
                        Color.clear.contentShape(Rectangle())
                    }
                    .accessibilityLabel("New page at \(hourLabel(hour))")
                }
            }
        }
        .frame(height: height, alignment: .top)
    }

    @ViewBuilder
    private func blocks(metrics: CalendarGeometry.Metrics, columnWidth: CGFloat, windowTop: CGFloat) -> some View {
        let day = DayLabel.today(now: entry.date)
        let timed = entry.timed
        let laidOut =
            timed.isEmpty
            ? []
            : layoutTimedDay(
                pages: timed.map {
                    LayoutPage(
                        id: $0.id, createdAt: $0.createdAt,
                        scheduledStart: $0.scheduledStart ?? "", scheduledEnd: $0.scheduledEnd)
                },
                day: day, shortestBlockMinutes: metrics.shortestBlockMinutes)
        let placements = laidOut.map { block in
            timed.first { $0.id == block.pageId }.flatMap { page in
                page.scheduledStart.flatMap {
                    CalendarGeometry.placement(start: $0, end: page.scheduledEnd, on: day, metrics: metrics)
                }
            }
        }
        let slots = CalendarGeometry.slots(
            for: zip(laidOut, placements).map { block, placed in
                CalendarGeometry.SlotInput(
                    depth: Int(block.cascadeDepth), top: placed?.top ?? 0, height: placed?.height ?? 0)
            },
            columnWidth: columnWidth)

        ForEach(Array(laidOut.enumerated()), id: \.element.pageId) { index, block in
            if let page = timed.first(where: { $0.id == block.pageId }), let placed = placements[index] {
                CalendarBlockMark(
                    page: page, tint: blockTint(page, in: entry),
                    time: page.scheduledStart.flatMap {
                        CalendarBlockMark.timeLabel(start: $0, end: page.scheduledEnd)
                    },
                    height: placed.height)
                    .frame(width: max(slots[index].width - 2, 1), height: placed.height)
                    .offset(x: slots[index].x, y: placed.top - windowTop)
            }
        }
    }

    private var nowLine: some View {
        HStack(spacing: 0) {
            Circle().fill(Brand.accent).frame(width: 6, height: 6)
            Rectangle().fill(Brand.accent).frame(height: 1)
        }
    }

    private func hourLabel(_ hour: Int) -> String {
        let date = Calendar.current.date(bySettingHour: hour, minute: 0, second: 0, of: entry.date) ?? entry.date
        return date.formatted(.dateTime.hour())
    }
}

/// One page drawn as the calendar draws a block: its folder colour blended into the ground, a
/// full-strength stripe at the leading edge, and a box that completes it.
struct CalendarBlockMark: View {
    let page: PageSummary
    let tint: Color
    let time: String?
    let height: CGFloat

    /// An all-day row's height, and the shortest block that shows its time under the title.
    static let rowHeight: CGFloat = 22
    private static let timeLineHeight: CGFloat = 34

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let isDone = page.status == "done"
        let shape = RoundedRectangle(cornerRadius: 4, style: .continuous)
        HStack(alignment: .top, spacing: 5) {
            Button(intent: CompletePageIntent(pageId: page.id, done: !isDone)) {
                Image(systemName: isDone ? "checkmark.square.fill" : "square")
                    .font(.caption)
                    .foregroundStyle(tint)
                    .invalidatableContent()
                    .frame(width: 16, height: 16)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isDone ? "Reopen" : "Mark as done")

            VStack(alignment: .leading, spacing: 0) {
                Text(displayTitle(page))
                    .font(.caption.weight(.medium))
                    .foregroundStyle(WidgetInk.primary)
                    .lineLimit(1)
                if height >= Self.timeLineHeight, let time {
                    Text(time)
                        .font(.caption2)
                        .foregroundStyle(WidgetInk.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.leading, 6)
        .padding(.trailing, 3)
        .padding(.top, 3)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background {
            shape.fill(WidgetGround.style)
            shape.fill(tint.opacity(colorScheme == .dark ? 0.24 : 0.2))
        }
        .overlay(alignment: .leading) {
            Rectangle().fill(tint).frame(width: 2)
        }
        .clipShape(shape)
        .opacity(isDone ? 0.5 : 1)
    }

    static func timeLabel(start: String, end: String?) -> String? {
        guard start.contains("T"), let startDate = StorageTimestamp.wallClock(start) else { return nil }
        guard let end, let endDate = StorageTimestamp.wallClock(end), endDate > startDate else {
            return ClockTime.string(startDate)
        }
        return "\(ClockTime.string(startDate)) – \(ClockTime.string(endDate))"
    }
}

/// A page's folder colour, or the calendar's blue for a page in no coloured folder.
func blockTint(_ page: PageSummary, in entry: NowEntry) -> Color {
    page.folderId.flatMap { entry.folderColors[$0] }.flatMap { Color(hex: $0) } ?? Color(PikosToken.blue500)
}
