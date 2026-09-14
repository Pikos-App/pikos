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
    /// Points per hour before Dynamic Type is applied — the reader's calendar
    /// density setting.
    let hourHeightBase: CGFloat
    /// Folder colours by folder id. A block in a coloured folder draws in
    /// that colour, which is how the desktop tells a work meeting from a
    /// dentist at a glance; anything else draws in the accent.
    let folderColors: [String: Color]
    /// The sheets a block's page menu can open, owned by the screen.
    @Binding var actions: PageActionState
    let onOpen: (String) -> Void
    /// Tick or untick a one-off block, which *is* its page.
    let onToggleDone: (CalendarEntry) -> Void
    /// Finish the occurrence this block is, rather than the one the series
    /// owes next. See `WorkspaceStore.completeOccurrence`.
    let onComplete: (CalendarEntry) -> Void
    /// Drop this occurrence and let the series carry on.
    let onSkip: (CalendarEntry) -> Void
    /// Re-time this occurrence, leaving the rest of the series alone.
    let onMove: (CalendarEntry) -> Void

    /// Scales the hour height with the reader's text size. A calendar whose
    /// rows stay put while its labels grow is how a block ends up with its
    /// title clipped at the accessibility sizes.
    ///
    /// A percentage rather than the height itself, because `@ScaledMetric`
    /// takes its base from a literal and the base is now a setting. Scaling a
    /// nominal 100 and multiplying gives the same curve from whichever height
    /// the reader chose.
    @ScaledMetric(relativeTo: .body) private var typeScale: CGFloat = 100
    @State private var allDayExpanded = false

    private var hourHeight: CGFloat { hourHeightBase * typeScale / 100 }

    private var metrics: CalendarGeometry.Metrics {
        CalendarGeometry.Metrics(hourHeight: hourHeight)
    }

    /// The all-day band is capped so a week with a fortnight-long holiday in it
    /// does not push the hour grid off the screen entirely.
    private static let collapsedAllDayRows = 2

    var body: some View {
        VStack(spacing: 0) {
            // A header over one column repeats the title above it; over
            // several it is the only thing telling the columns apart.
            if days.count > 1 {
                dayHeader
            }
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
                // Seven columns at the accessibility text sizes do not fit
                // their abbreviations; the day number shrinks before it wraps,
                // and the whole label is read out in full anyway.
                .minimumScaleFactor(0.6)
                .lineLimit(1)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(Self.accessibleDayLabel(day))
                .accessibilityAddTraits(isToday(day) ? [.isHeader, .isSelected] : .isHeader)
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

        let tint = entry.map(color(for:)) ?? Color.accentColor
        let done = entry?.status == "done"

        return Text(entry.map { $0.title.isEmpty ? "Untitled" : $0.title } ?? "")
            .font(.caption2.weight(.medium))
            .strikethrough(done, color: .secondary)
            .lineLimit(1)
            .padding(.horizontal, 5)
            .frame(
                width: max(columnWidth * CGFloat(bar.span) - 3, 1),
                height: metrics.allDayRowHeight - 3,
                alignment: .leading)
            .background(tint.opacity(done ? 0.12 : 0.22), in: corners.shape)
            .opacity(done ? 0.7 : 1)
            .offset(
                x: columnWidth * CGFloat(bar.startCol) + 1.5,
                y: CGFloat(bar.row) * metrics.allDayRowHeight)
            .onTapGesture { if let entry { onOpen(entry.pageId) } }
            .accessibilityAddTraits(.isButton)
            .contextMenu { if let entry { occurrenceMenu(entry) } }
            .accessibilityActions { if let entry { occurrenceActions(entry) } }
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
        // Twenty-three labels a screen reader would otherwise step through
        // before reaching the first event. Every block already says its own
        // time, so the gutter carries nothing VoiceOver needs.
        .accessibilityHidden(true)
    }

    private var hourLines: some View {
        VStack(spacing: 0) {
            ForEach(0..<24, id: \.self) { hour in
                Divider().frame(height: hourHeight, alignment: .top)
                    .id(hour == Self.openingHour ? Self.openingHourAnchor : "hour-\(hour)")
            }
        }
        .accessibilityHidden(true)
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
                    CalendarBlock(
                        entry: entry, height: placed.height, block: block, tint: color(for: entry))
                        .frame(width: max(columnWidth - inset - 3, 1), height: placed.height)
                        .offset(x: inset + 1.5, y: placed.top)
                        .onTapGesture { onOpen(entry.pageId) }
                        .contextMenu { occurrenceMenu(entry) }
                        .accessibilityActions { occurrenceActions(entry) }
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

    // MARK: - What can be done to one block

    /// What a long press on a block offers.
    ///
    /// Two kinds of block, two menus. A one-off page *is* its block, so it
    /// gets a checkbox's worth of verbs and then everything the list's long
    /// press offers — rename, date, folder, tags, delete — because a meeting
    /// seen on the calendar is the one most likely to need moving, and going
    /// to the list to find it again is the round trip the menu exists to save.
    ///
    /// A repeating page's block is one occurrence of many, and its verbs are
    /// about *this one*: complete it, move it, skip it. What is deliberately
    /// absent there is a delete. Deleting a block of a series has no meaning
    /// short of deleting the series, which is the whole thing — every
    /// occurrence behind this one and every one ahead — and offering that from
    /// a single Tuesday is how people lose a year of a habit. Skip is the
    /// operation they actually want, and it is undoable.
    @ViewBuilder
    private func occurrenceMenu(_ entry: CalendarEntry) -> some View {
        Button {
            onOpen(entry.pageId)
        } label: {
            Label("Open", systemImage: "doc.text")
        }

        if entry.isRecurring {
            if entry.status != "done" {
                if canComplete(entry) {
                    Button {
                        onComplete(entry)
                    } label: {
                        Label("Complete this one", systemImage: "checkmark.circle")
                    }
                }
                if canMove(entry) {
                    Button {
                        onMove(entry)
                    } label: {
                        Label("Move this one…", systemImage: "calendar.badge.clock")
                    }
                }
                Button {
                    onSkip(entry)
                } label: {
                    Label("Skip this one", systemImage: "calendar.badge.minus")
                }
            }
        } else {
            let done = entry.status == "done"
            Button {
                onToggleDone(entry)
            } label: {
                Label(
                    done ? "Reopen" : "Complete",
                    systemImage: done ? "arrow.uturn.backward" : "checkmark.circle")
            }
            Divider()
            PageActionsMenu(page: PageFacts(entry), state: $actions)
        }
    }

    /// The same verbs as the long-press menu, as VoiceOver actions.
    ///
    /// A long press is a gesture VoiceOver users do not have; the rotor's
    /// actions list is where they expect a block's verbs. The page-wide menu
    /// is deliberately not mirrored here — rename, tags, folder and the rest
    /// are on the page itself once it is open, which "Open" reaches.
    @ViewBuilder
    private func occurrenceActions(_ entry: CalendarEntry) -> some View {
        Button("Open") { onOpen(entry.pageId) }
        if entry.isRecurring {
            if entry.status != "done" {
                if canComplete(entry) {
                    Button("Complete this one") { onComplete(entry) }
                }
                if canMove(entry) {
                    Button("Move this one") { onMove(entry) }
                }
                Button("Skip this one") { onSkip(entry) }
            }
        } else {
            Button(entry.status == "done" ? "Reopen" : "Complete") { onToggleDone(entry) }
        }
    }

    /// The colour a block draws in: its folder's, or the accent when the
    /// folder has none or the page is in the Inbox.
    private func color(for entry: CalendarEntry) -> Color {
        entry.folderId.flatMap { folderColors[$0] } ?? Color.accentColor
    }

    /// Whether *this* occurrence is a thing that can be finished on its own.
    ///
    /// The same rule the desktop draws its checkbox by
    /// (`useRecurringActions.showsCheckbox`), and it turns on where the series
    /// came from rather than on whether it is still mirrored. An occurrence of
    /// an imported calendar is resolved on the day it names — a birthday is
    /// done on the birthday — so every one of them can be completed. A native
    /// task series funnels to whichever occurrence is next due instead, and
    /// that one is its head: a real block, not a projection. Offering "complete
    /// this one" on a native occurrence three weeks out would mint a finished
    /// page for work nobody has done.
    ///
    /// Skip is offered either way, because dropping a date is meaningful for
    /// both and says nothing about whether the work happened.
    private func canComplete(_ entry: CalendarEntry) -> Bool {
        entry.isSyncedOrigin || !entry.isVirtual
    }

    /// Whether this occurrence can be re-timed on its own.
    ///
    /// Two conditions, both structural. It has to be a projection, because a
    /// real block is a row and a row is moved by changing the page's own
    /// schedule — the list already offers that. And the series must not be an
    /// active mirror: those times belong to the calendar they came from, and
    /// the workspace refuses the write. Better to leave the entry out than to
    /// offer it and explain the refusal afterwards.
    private func canMove(_ entry: CalendarEntry) -> Bool {
        entry.isVirtual && entry.ruleId != nil && !entry.scheduleLocked
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
    let tint: Color

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
        .background(tint.opacity(isDone ? 0.10 : 0.20))
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(tint.opacity(isDone ? 0.4 : 1))
                .frame(width: 3)
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
